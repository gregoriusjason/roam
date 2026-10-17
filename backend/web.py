import base64
import binascii
import json
import os
import re
import secrets
import sqlite3
import time
from collections import defaultdict, deque
from datetime import datetime, timezone
from pathlib import Path
from uuid import uuid4

from flask import Flask, g, jsonify, redirect, render_template, request, session, url_for
from werkzeug.security import check_password_hash, generate_password_hash

from .integrations import (get_user, integration_status, openai_configured,
                           preview_reply, request_chat_completion, sign_in, sign_up)
from .places import PLACES, LOCATIONS
from .routing import plan_route, search_places, validate_location
from .storage import db, close_db, memories_for, journeys_for, migrate_guest
from .todo import todos

PROJECT_ROOT = Path(__file__).resolve().parent.parent
app = Flask(__name__, template_folder=str(PROJECT_ROOT / "templates"), static_folder=str(PROJECT_ROOT / "static"))
instance = PROJECT_ROOT / "instance"
instance.mkdir(exist_ok=True)
secret_file = instance / ".session-secret"
if not os.getenv("FLASK_SECRET_KEY") and not secret_file.exists():
    secret_file.write_text(secrets.token_hex(32))
    secret_file.chmod(0o600)
app.config.update(SECRET_KEY=os.getenv("FLASK_SECRET_KEY") or secret_file.read_text(),
    DATABASE=os.getenv("DATABASE_PATH", str(instance / "roam.sqlite3")),
    MAX_CONTENT_LENGTH=3 * 1024 * 1024, SESSION_COOKIE_HTTPONLY=True,
    SESSION_COOKIE_SAMESITE="Lax", SESSION_COOKIE_SECURE=os.getenv("COOKIE_SECURE", "false").lower() == "true")
app.teardown_appcontext(close_db)
_limits = defaultdict(deque)


def throttled(key, limit=20, window=600):
    if app.testing:
        return False
    now = time.monotonic()
    queue = _limits[key]
    while queue and queue[0] < now - window:
        queue.popleft()
    if len(queue) >= limit:
        return True
    queue.append(now)
    return False


@app.before_request
def load_user():
    if request.path.startswith("/static/"):
        return
    session.setdefault("csrf", secrets.token_urlsafe(24))
    session.setdefault("guest", "guest:" + str(uuid4()))
    g.user = None
    if session.get("user_id"):
        row = db().execute("SELECT id, full_name, email FROM users WHERE id=?", (session["user_id"],)).fetchone()
        g.user = dict(row) if row else None
    elif session.get("supabase_access_token"):
        try:
            user = get_user(session["supabase_access_token"])
            g.user = {"id": "supabase:" + user.id, "email": user.email,
                      "full_name": (user.user_metadata or {}).get("full_name", "Explorer")}
        except Exception:
            session.pop("supabase_access_token", None)
    g.owner = g.user["id"] if g.user else session["guest"]
    if request.method in ("POST", "PUT", "DELETE", "PATCH"):
        token = request.headers.get("X-CSRF-Token") or request.form.get("csrf_token", "")
        if not secrets.compare_digest(token, session["csrf"]):
            if request.path.startswith("/api/"):
                return jsonify(error="Your session changed. Refresh the page and try again."), 403
            return "Your session changed. Please refresh this page.", 403


@app.after_request
def response_headers(response):
    response.headers["X-Content-Type-Options"] = "nosniff"
    response.headers["Referrer-Policy"] = "strict-origin-when-cross-origin"
    response.headers["X-Frame-Options"] = "SAMEORIGIN"
    if not request.path.startswith("/static/"):
        response.headers["Cache-Control"] = "no-store"
    return response


@app.errorhandler(413)
def too_large(_error):
    return jsonify(error="That photo is too large. Choose a smaller image."), 413


def json_body():
    body = request.get_json(silent=True)
    if not isinstance(body, dict):
        raise ValueError("Send a JSON object.")
    return body


def validate_photo(value):
    """Validate a compressed data URL before it reaches storage or OpenAI."""
    if value is None:
        return None
    if not isinstance(value, str) or not re.match(r"^data:image/(jpeg|png|webp);base64,", value) or len(value) > 1800000:
        raise ValueError("Choose a JPEG, PNG, or WebP photo smaller than 1.3 MB.")
    try:
        raw = base64.b64decode(value.split(",", 1)[1], validate=True)
    except (ValueError, binascii.Error):
        raise ValueError("That photo couldn't be read.")
    if not (raw.startswith(b'\xff\xd8\xff') or raw.startswith(b'\x89PNG\r\n\x1a\n') or raw.startswith(b'RIFF') and raw[8:12] == b'WEBP'):
        raise ValueError("That photo couldn't be read.")
    return value


def auth_error_message(error):
    msg = str(error).lower()
    if "email not confirmed" in msg:
        return "Please confirm your email before logging in."
    if "already registered" in msg or "unique" in msg:
        return "That email already has an account. Try logging in."
    if "invalid login" in msg:
        return "The email or password is incorrect."
    return "We couldn't complete that request. Please try again."


@app.get("/")
@app.get("/welcome")
def welcome():
    return render_template("welcome.html", places=PLACES, locations=LOCATIONS,
                           ai_ready=openai_configured())


@app.get("/todos")
def homepage():
    return render_template("index.html", todos=[])


@app.route("/login", methods=["GET", "POST"])
def login():
    if request.method == "GET":
        return render_template("login.html", mode="login")
    if throttled(("auth", request.remote_addr), 12):
        return render_template("login.html", mode="login", error="Too many attempts. Try again in 10 minutes."), 429
    email = request.form.get("email", "").strip().lower()
    password = request.form.get("password", "")
    old_owner = g.owner
    try:
        if os.getenv("AUTH_PROVIDER", "local") == "supabase":
            result = sign_in(email, password)
            session["supabase_access_token"] = result.session.access_token
            owner = "supabase:" + result.user.id
        else:
            row = db().execute("SELECT * FROM users WHERE email=?", (email,)).fetchone()
            if not row or not check_password_hash(row["password_hash"], password):
                raise ValueError("invalid login")
            session["user_id"] = owner = row["id"]
        migrate_guest(old_owner, owner)
        session["csrf"] = secrets.token_urlsafe(24)
        return redirect(url_for("welcome"))
    except Exception as error:
        return render_template("login.html", mode="login", error=auth_error_message(error)), 401


@app.route("/register", methods=["GET", "POST"])
def register():
    if request.method == "GET":
        return render_template("login.html", mode="register")
    if throttled(("auth", request.remote_addr), 12):
        return render_template("login.html", mode="register", error="Too many attempts. Try again in 10 minutes."), 429
    email, password = request.form.get("email", "").strip().lower(), request.form.get("password", "")
    full_name = request.form.get("full_name", "").strip()
    if not 2 <= len(full_name) <= 100 or not re.fullmatch(r"[^\s@]+@[^\s@]+\.[^\s@]+", email) or len(email) > 254 or not 8 <= len(password) <= 256:
        return render_template("login.html", mode="register", error="Enter your full name, a valid email, and a password with 8–256 characters."), 400
    old_owner = g.owner
    try:
        if os.getenv("AUTH_PROVIDER", "local") == "supabase":
            result = sign_up(email, password, full_name)
            if not result.session:
                return render_template("login.html", mode="register", message="Your account is ready. Check your email to confirm it, then log in.")
            session["supabase_access_token"] = result.session.access_token
            owner = "supabase:" + result.user.id
        else:
            owner = str(uuid4())
            db().execute("INSERT INTO users(id, full_name, email, password_hash) VALUES(?,?,?,?)",
                         (owner, full_name, email, generate_password_hash(password)))
            db().commit()
            session["user_id"] = owner
        migrate_guest(old_owner, owner)
        session["csrf"] = secrets.token_urlsafe(24)
        return redirect(url_for("welcome"))
    except Exception as error:
        return render_template("login.html", mode="register", error=auth_error_message(error)), 400


@app.post("/logout")
def logout():
    session.clear()
    return redirect(url_for("welcome"))


@app.post("/search")
def search_todo():
    term = request.form.get("search", "")
    return render_template("todo.html", todos=[t for t in todos if term in t["title"]] if term else [])


@app.get("/api/health/integrations")
def integrations_health():
    return jsonify(integration_status())


@app.get("/api/state")
def state():
    return jsonify(user=g.user, memories=memories_for(g.owner), journeys=journeys_for(g.owner),
                   ai_ready=openai_configured())


@app.get("/api/places")
def places_search():
    query = request.args.get("q", "").strip()
    if not 2 <= len(query) <= 160:
        return jsonify(error="Enter a place name with 2–160 characters."), 400
    if throttled(("search", g.owner), 30):
        return jsonify(error="Please wait a moment before searching again."), 429
    try:
        return jsonify(places=search_places(query))
    except RuntimeError as error:
        return jsonify(error=str(error)), 503


@app.post("/api/routes")
def routes():
    try:
        body = json_body()
        origin, destination = validate_location(body.get("origin")), validate_location(body.get("destination"))
        arrival = datetime.fromisoformat(str(body.get("arrival_at", "")).replace("Z", "+00:00"))
        if arrival.tzinfo is None:
            raise ValueError("Choose an arrival time with a timezone.")
        minutes = int((arrival - datetime.now(timezone.utc)).total_seconds() / 60)
        if not 5 <= minutes <= 240:
            raise ValueError("Choose an arrival time between 5 minutes and 4 hours from now.")
        interests = body.get("interests", [])
        allowed = {"History", "Nature", "Arts & culture", "Hidden gems", "Local life"}
        if not isinstance(interests, list) or any(not isinstance(x, str) or x not in allowed for x in interests):
            raise ValueError("Choose interests from the available options.")
        if throttled(("route", g.owner), 10):
            return jsonify(error="A few too many detours at once. Try again in 10 minutes."), 429
        visited = {m["checkpoint_id"] for m in memories_for(g.owner)}
        for journey in journeys_for(g.owner):
            visited.update(journey["completed_stops"])
        route_photo = validate_photo(body.get("photo"))
        route = plan_route(origin, destination, minutes, interests, visited,
                           body.get("fresh_only", True) is not False,
                           use_ai=openai_configured(), photo=route_photo)
        route["arrival_at"] = arrival.isoformat()
        route["id"] = str(uuid4())
        db().execute("INSERT INTO journeys(id,owner,route,status) VALUES(?,?,?,?)", (route["id"], g.owner, json.dumps(route), "draft"))
        db().commit()
        return jsonify(route=route)
    except (ValueError, TypeError) as error:
        return jsonify(error=str(error) or "Check your trip details."), 400
    except RuntimeError as error:
        return jsonify(error=str(error)), 503


@app.post("/api/journeys/<journey_id>")
def journey_action(journey_id):
    row = db().execute("SELECT * FROM journeys WHERE id=? AND owner=?", (journey_id, g.owner)).fetchone()
    if not row:
        return jsonify(error="That journey wasn't found."), 404
    try:
        body = json_body()
        action, route = body.get("action"), json.loads(row["route"])
        completed = json.loads(row["completed_stops"])
        if action == "start" and row["status"] != "draft":
            raise ValueError("This walk has already started. Resume it from My journeys.")
        if action == "resume" and row["status"] not in ("paused", "active"):
            raise ValueError("Completed walks are kept in your journal. Plan a new walk to revisit them.")
        if action == "start":
            arrival = datetime.fromisoformat(route["arrival_at"])
            remaining = (arrival - datetime.now(timezone.utc)).total_seconds() / 60
            if remaining < route["total_minutes"] + 5:
                raise ValueError("That arrival time is now too close. Choose a later time and find a fresh route.")
        if action in ("start", "resume"):
            db().execute("UPDATE journeys SET status='paused' WHERE owner=? AND status='active'", (g.owner,))
            db().execute("UPDATE journeys SET status='active', ended_at=NULL WHERE id=? AND owner=?", (journey_id, g.owner))
        elif action == "visit":
            checkpoint_id = body.get("checkpoint_id")
            if checkpoint_id not in [p["id"] for p in route["checkpoints"]] or row["status"] != "active":
                raise ValueError("Start this journey and select one of its checkpoints first.")
            if checkpoint_id not in completed:
                completed.append(checkpoint_id)
            db().execute("UPDATE journeys SET completed_stops=? WHERE id=? AND owner=?", (json.dumps(completed), journey_id, g.owner))
        elif action == "finish" and row["status"] in ("active", "paused"):
            db().execute("UPDATE journeys SET status='completed', ended_at=CURRENT_TIMESTAMP WHERE id=? AND owner=?", (journey_id, g.owner))
        else:
            raise ValueError("Choose a valid journey action.")
        db().commit()
        return jsonify(ok=True, completed_stops=completed)
    except ValueError as error:
        return jsonify(error=str(error)), 400


@app.post("/api/chat")
def chat():
    try:
        body = json_body()
        message = body.get("message", "")
        if not isinstance(message, str) or not 1 <= len(message.strip()) <= 4000:
            raise ValueError("Write a note with 1–4,000 characters.")
        message = message.strip()
        checkpoint = validate_location(body.get("checkpoint"))
        photo = validate_photo(body.get("photo"))
        journey_id = body.get("journey_id")
        if journey_id:
            row = db().execute("SELECT route FROM journeys WHERE id=? AND owner=?", (journey_id, g.owner)).fetchone()
            if not row or checkpoint["id"] not in [p["id"] for p in json.loads(row["route"])["checkpoints"]]:
                raise ValueError("This checkpoint isn't part of that journey.")
        if throttled(("chat", g.owner), 25):
            return jsonify(error="Let's pause for a moment. You can save more notes in 10 minutes."), 429
        memories = memories_for(g.owner, checkpoint["id"])
        history = [dict(r) for r in db().execute("SELECT role,content FROM messages WHERE owner=? AND checkpoint_id=? ORDER BY id DESC LIMIT 10", (g.owner, checkpoint["id"])).fetchall()][::-1]
        memory_id = str(uuid4())
        db().execute("INSERT INTO memories(id,owner,checkpoint_id,checkpoint,content,photo,journey_id) VALUES(?,?,?,?,?,?,?)",
                     (memory_id, g.owner, checkpoint["id"], json.dumps(checkpoint), message, photo, journey_id))
        db().execute("INSERT INTO messages(owner,checkpoint_id,role,content) VALUES(?,?,?,?)", (g.owner, checkpoint["id"], "user", message))
        db().commit()
        mode = "preview"
        reply = preview_reply(message, checkpoint, memories)
        if openai_configured():
            try:
                reply = request_chat_completion(message, checkpoint, memories, history, photo)
                mode = "ai"
            except Exception:
                # Never expose upstream exception strings: they may contain credentials.
                reply = "Your note is saved. Pip couldn't connect just now. Please try another message in a moment."
                mode = "unavailable"
        if mode == "ai":
            db().execute("INSERT INTO messages(owner,checkpoint_id,role,content) VALUES(?,?,?,?)", (g.owner, checkpoint["id"], "assistant", reply))
            db().commit()
        return jsonify(reply=reply, mode=mode, memory_id=memory_id)
    except (ValueError, TypeError) as error:
        return jsonify(error=str(error)), 400


@app.delete("/api/memories/<memory_id>")
def delete_memory(memory_id):
    row = db().execute("SELECT checkpoint_id FROM memories WHERE id=? AND owner=?", (memory_id, g.owner)).fetchone()
    if not row:
        return jsonify(error="That memory wasn't found."), 404
    db().execute("DELETE FROM memories WHERE id=? AND owner=?", (memory_id, g.owner))
    # Clear derived conversation so deleted information isn't recalled later.
    db().execute("DELETE FROM messages WHERE checkpoint_id=? AND owner=?", (row["checkpoint_id"], g.owner))
    db().commit()
    return jsonify(ok=True)

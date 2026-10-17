"""Durable, owner-scoped journals and local accounts."""
import json
import sqlite3
from pathlib import Path
from flask import current_app, g


def db():
    if "db" not in g:
        path = current_app.config["DATABASE"]
        Path(path).parent.mkdir(parents=True, exist_ok=True)
        g.db = sqlite3.connect(path, timeout=15)
        g.db.row_factory = sqlite3.Row
        g.db.execute("PRAGMA journal_mode=WAL")
        g.db.executescript("""
            CREATE TABLE IF NOT EXISTS users (
              id TEXT PRIMARY KEY, full_name TEXT NOT NULL, email TEXT UNIQUE NOT NULL,
              password_hash TEXT NOT NULL, created_at TEXT DEFAULT CURRENT_TIMESTAMP);
            CREATE TABLE IF NOT EXISTS journeys (
              id TEXT PRIMARY KEY, owner TEXT NOT NULL, route TEXT NOT NULL,
              completed_stops TEXT DEFAULT '[]', status TEXT DEFAULT 'active',
              created_at TEXT DEFAULT CURRENT_TIMESTAMP, ended_at TEXT);
            CREATE TABLE IF NOT EXISTS memories (
              id TEXT PRIMARY KEY, owner TEXT NOT NULL, checkpoint_id TEXT NOT NULL,
              checkpoint TEXT NOT NULL, content TEXT NOT NULL, photo TEXT,
              journey_id TEXT, created_at TEXT DEFAULT CURRENT_TIMESTAMP);
            CREATE TABLE IF NOT EXISTS messages (
              id INTEGER PRIMARY KEY AUTOINCREMENT, owner TEXT NOT NULL,
              checkpoint_id TEXT NOT NULL, role TEXT NOT NULL, content TEXT NOT NULL,
              created_at TEXT DEFAULT CURRENT_TIMESTAMP);
            CREATE INDEX IF NOT EXISTS memories_owner ON memories(owner, checkpoint_id);
            CREATE INDEX IF NOT EXISTS journeys_owner ON journeys(owner);
            CREATE INDEX IF NOT EXISTS messages_owner ON messages(owner, checkpoint_id);
        """)
    return g.db


def close_db(_error=None):
    connection = g.pop("db", None)
    if connection is not None:
        connection.close()


def memories_for(owner, checkpoint_id=None):
    query, args = "SELECT * FROM memories WHERE owner=?", [owner]
    if checkpoint_id:
        query += " AND checkpoint_id=?"
        args.append(checkpoint_id)
    rows = db().execute(query + " ORDER BY created_at, rowid", args).fetchall()
    return [dict(r) | {"checkpoint": json.loads(r["checkpoint"])} for r in rows]


def journeys_for(owner):
    rows = db().execute("SELECT * FROM journeys WHERE owner=? ORDER BY created_at DESC, rowid DESC", (owner,)).fetchall()
    return [dict(r) | {"route": json.loads(r["route"]),
                        "completed_stops": json.loads(r["completed_stops"])} for r in rows]


def migrate_guest(old_owner, new_owner):
    if old_owner and old_owner.startswith("guest:"):
        for table in ("journeys", "memories", "messages"):
            db().execute(f"UPDATE {table} SET owner=? WHERE owner=?", (new_owner, old_owner))
        db().commit()

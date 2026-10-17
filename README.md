# Roam — Reverse Tour Guide

**You explore. You explain. Your AI remembers.**

Roam is a phone-friendly Flask application for discovering new places on the way somewhere. Enter a starting point, destination, and arrival time; choose interests; then take a walking detour with up to three checkpoints. Pip, your curious AI companion, learns from your observations and recalls your earlier notes when you revisit a place.

## Run locally

Python 3.11+ and Node.js 20+ are required. From this checkout:

```sh
python3 -m venv .venv
.venv/bin/python -m pip install -r requirements.txt
npm ci
npm run build
# If .env does not already exist, copy .env.example to .env.
.venv/bin/python app.py
```

Open **http://localhost:5050**. Port 5050 avoids the macOS AirPlay service on port 5000. The server listens on `0.0.0.0` by default; on the same Wi-Fi, open `http://<your-computer-LAN-IP>:5050` on your phone. Set `HOST=127.0.0.1` for a loopback-only server.

The main application is at `/` and `/welcome`. The starter's todo demo remains at `/todos`.

## Add OpenAI when you’re ready

Set `OPENAI_API_KEY` in your existing, ignored `.env`, then restart the Flask server. The default model is `gpt-4.1-mini`, configurable through `OPENAI_MODEL`. Keys are read only by the server and are never sent to the browser or stored in source control.

The integration uses the official [Responses API](https://developers.openai.com/api/reference/python/resources/responses/methods/create) with [text and image inputs](https://developers.openai.com/api/docs/guides/images-vision), `store=False`, short replies, a request timeout, and limited retries. Notes and earlier conversations are supplied as context so Pip can recall what the user taught it. Route personalisation ranks only places supplied by the map data; an LLM never invents walking geometry.

Without a key, **notebook mode** still supports account creation, real walking routes, interest selection, new-place filtering, progress, photos, memory recall, and journey summaries. The interface explicitly labels its scripted introduction and saved-note acknowledgements. With a key, guests can try live Pip chat immediately; logging in keeps those memories across devices. OpenAI-dependent code is covered with mocked responses; live AI replies have not been tested without a key.

## What works

- Full-name, email, and password registration; login; logout; password hashing; CSRF checks; signed HTTP-only sessions.
- Local accounts work without an external auth service. Set `AUTH_PROVIDER=supabase` to use the retained Supabase integration and its `SUPABASE_URL` / `SUPABASE_KEY` values. New Supabase registrations include the full name in user metadata. Email confirmation is respected.
- Guests can explore and save notes. Guest records migrate to the account when the guest registers or logs in. Clearing the browser session loses access to unclaimed guest records.
- A Leaflet/OpenStreetMap map with checkpoints, pedestrian route geometry, pan/zoom, fit controls, and optional current-location capture with permission, HTTPS, timeout, and accuracy feedback.
- An Edinburgh-first starter collection with sourced landmarks, Photon location search, and OpenStreetMap walking routes. The planner is intentionally tuned around Edinburgh for this first feature pass; small category lookups retain partial results during outages, with an attributed Wikipedia geosearch fallback for service failures. Searches run on explicit submission, not on every keystroke. Lookups are cached and throttled.
- Novelty filtering uses the signed-in user's visited checkpoints and saved memories. If no new stops fit, the app says so and offers a direct route. Select more time or switch off the new-places filter to revisit familiar stops.
- Arrival estimates include walking time, **five minutes per checkpoint**, and a **five-minute buffer**. The planner removes stops if the actual pedestrian route would overrun the budget. Starting an expired route is rejected. These are estimates, not guarantees or live turn-by-turn navigation.
- Manually mark a checkpoint when you arrive. The app does not claim GPS-verified visits or continuously track location.
- Camera/file input, compressed photo attachments, a visual clue attached to the detour planner, typed observations, browser speech-to-text, and opt-in browser text-to-speech. On desktop, Pip opens as a map-side conversation panel; on phones it becomes a full-height chat. Unsupported or denied permissions have a text-input fallback.
- Persistent, owner-scoped SQLite journeys, memories, photos, and conversation context; account isolation; revisit recall; memory search/deletion; Markdown notebook export; journey summaries.

## Phone browsers

The layout supports 320px-wide screens, bottom navigation, native time inputs, large primary controls, 16px editable text, and a map-side companion panel that becomes a full-height phone chat. Voice recording and geolocation require a **secure context**: use HTTPS for a phone deployment. For a quick local phone test, run `FLASK_SSL_ADHOC=true python app.py` and accept the certificate warning, or provide `FLASK_SSL_CERT` and `FLASK_SSL_KEY`. Plain HTTP over a LAN can preview the app, but mobile browsers may block those capabilities; the location control explains this and keeps search available. Browser speech recognition support varies; typed notes remain available. Photos and notes are sent to OpenAI only when AI is configured.

## Data, services, and deployment

Application data lives in ignored `instance/roam.sqlite3`; the generated local session secret lives in ignored `instance/.session-secret`. Back up the database to preserve accounts and stories. SQLite is suitable for a small, single-server prototype; this is not a stateless deployment.

Use an HTTPS-enabled Python/WSGI host with persistent storage for deployment, set a strong stable `FLASK_SECRET_KEY`, and set `COOKIE_SECURE=true`. This checkout remains a Flask app and has not been published to Sites, whose hosting runtime uses JavaScript/Cloudflare Workers. The development server is for local previews.

Before operating at scale, provide production geocoding/routing infrastructure and shared rate limits; the prototype’s rate limiter is in-process. Public map services have availability and usage limits. Relevant documentation: [OpenStreetMap tile usage](https://operations.osmfoundation.org/policies/tiles/), [Photon demo service](https://github.com/komoot/photon#demo-server), [OSRM API](https://project-osrm.org/docs/v5.5.1/api/). The app does not use the restricted public Nominatim search API. Place facts link to their sources; photo credits are in `static/images/credits.json` and the app’s credits dialog.

## Verify

```sh
npm run build
.venv/bin/python -m pip check
.venv/bin/python -m unittest discover -s tests -v
npx playwright install chromium webkit
npm run test:browser
```

Backend tests cover account/guest isolation, hashed passwords, CSRF, photos, memory persistence and deletion, prior-context injection, missing/unavailable AI, journey progress, visited-place avoidance, and arrival budgets. Browser tests use a temporary database and cover responsive widths, image loading, a live walking route, photo/note persistence, revisit recall, journey summaries, and registration. Screenshots are generated in ignored `test-results/`.

## Structure

```text
backend/web.py           Flask pages, auth, and JSON API
backend/routing.py       Geocoding, checkpoint selection, and pedestrian routes
backend/integrations.py  OpenAI Responses API and optional Supabase auth
backend/storage.py       SQLite records, owner scoping, guest migration
backend/places.py        Sourced Edinburgh starter places
templates/              Jinja application and authentication pages
static/src/             Styles and browser interactions
static/images/          Local landmark photographs and credits
tests/                  Backend and browser integration tests
```

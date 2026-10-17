"""Development entry point for the Flask application.

Keep this file at the repository root so `python app.py` remains the simplest
way to start the app. The implementation lives in the backend package.
"""

import os
from backend.web import app


if __name__ == "__main__":
    ssl_context = None
    if os.getenv("FLASK_SSL_CERT") and os.getenv("FLASK_SSL_KEY"):
        ssl_context = (os.environ["FLASK_SSL_CERT"], os.environ["FLASK_SSL_KEY"])
    elif os.getenv("FLASK_SSL_ADHOC", "").lower() in {"1", "true", "yes", "adhoc"}:
        ssl_context = "adhoc"
    app.run(host=os.getenv("HOST", "0.0.0.0"), port=int(os.getenv("PORT", "5050")),
            debug=os.getenv("FLASK_DEBUG", "false").lower() == "true", ssl_context=ssl_context)

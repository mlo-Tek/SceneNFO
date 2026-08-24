from __future__ import annotations

from .db import connection, utcnow
from .secrets import decrypt, encrypt

SECRET_KEYS = {"crowdnfo_api_key", "radarr_api_key", "sonarr_api_key"}


def get_setting(key: str, default: str = "") -> str:
    with connection() as conn:
        row = conn.execute("SELECT value,secret FROM settings WHERE key=?", (key,)).fetchone()
    if not row:
        return default
    return decrypt(row["value"]) if row["secret"] else row["value"]


def set_setting(key: str, value: str) -> None:
    is_secret = key in SECRET_KEYS
    stored = encrypt(value) if is_secret and value else value
    with connection() as conn:
        conn.execute(
            """
            INSERT INTO settings(key,value,secret,updated_at) VALUES(?,?,?,?)
            ON CONFLICT(key) DO UPDATE SET value=excluded.value,secret=excluded.secret,updated_at=excluded.updated_at
            """,
            (key, stored, int(is_secret), utcnow()),
        )


def public_settings() -> dict:
    with connection() as conn:
        rows = conn.execute("SELECT key,value,secret FROM settings ORDER BY key").fetchall()
    result = {}
    for row in rows:
        if row["secret"]:
            result[row["key"]] = {"configured": bool(row["value"]), "value": "••••••••" if row["value"] else ""}
        else:
            result[row["key"]] = row["value"]
    return result

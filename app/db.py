from __future__ import annotations

import sqlite3
from contextlib import contextmanager
from datetime import datetime, timezone
from typing import Iterable

from .config import DB_PATH, DEFAULTS

SCHEMA = """
PRAGMA journal_mode=WAL;
PRAGMA foreign_keys=ON;

CREATE TABLE IF NOT EXISTS settings (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL,
    secret INTEGER NOT NULL DEFAULT 0,
    updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS groups (
    name TEXT NOT NULL,
    classification TEXT NOT NULL CHECK(classification IN ('scene','p2p')),
    active TEXT,
    origin TEXT,
    distribution_type TEXT,
    aliases TEXT,
    source TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    PRIMARY KEY(name, classification)
);

CREATE TABLE IF NOT EXISTS library_items (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    library TEXT NOT NULL CHECK(library IN ('movies','tv')),
    media_path TEXT NOT NULL UNIQUE,
    title TEXT,
    release_name TEXT NOT NULL,
    classification TEXT NOT NULL CHECK(classification IN ('scene','p2p')),
    release_group TEXT,
    predb_id INTEGER,
    nfo_path TEXT,
    nfo_source TEXT,
    nfo_present INTEGER NOT NULL DEFAULT 0,
    last_result TEXT,
    last_checked_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_library_items_library ON library_items(library);
CREATE INDEX IF NOT EXISTS idx_library_items_classification ON library_items(classification);
CREATE INDEX IF NOT EXISTS idx_library_items_group ON library_items(release_group);

CREATE TABLE IF NOT EXISTS runs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    kind TEXT NOT NULL,
    library TEXT,
    mode TEXT NOT NULL,
    trigger TEXT NOT NULL,
    status TEXT NOT NULL,
    started_at TEXT NOT NULL,
    finished_at TEXT,
    scanned INTEGER NOT NULL DEFAULT 0,
    scene INTEGER NOT NULL DEFAULT 0,
    p2p INTEGER NOT NULL DEFAULT 0,
    created INTEGER NOT NULL DEFAULT 0,
    replaced INTEGER NOT NULL DEFAULT 0,
    errors INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS run_events (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    run_id INTEGER NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
    ts TEXT NOT NULL,
    level TEXT NOT NULL,
    event TEXT NOT NULL,
    message TEXT NOT NULL,
    payload TEXT
);

CREATE INDEX IF NOT EXISTS idx_run_events_run_id ON run_events(run_id, id);
"""


def utcnow() -> str:
    return datetime.now(timezone.utc).isoformat()


@contextmanager
def connection():
    conn = sqlite3.connect(DB_PATH)
    conn.row_factory = sqlite3.Row
    try:
        yield conn
        conn.commit()
    finally:
        conn.close()


def init_db() -> None:
    with connection() as conn:
        conn.executescript(SCHEMA)
        now = utcnow()
        for key, value in DEFAULTS.items():
            conn.execute(
                "INSERT OR IGNORE INTO settings(key,value,secret,updated_at) VALUES(?,?,0,?)",
                (key, value, now),
            )


def fetchall(sql: str, params: Iterable = ()) -> list[dict]:
    with connection() as conn:
        return [dict(row) for row in conn.execute(sql, tuple(params)).fetchall()]


def fetchone(sql: str, params: Iterable = ()) -> dict | None:
    with connection() as conn:
        row = conn.execute(sql, tuple(params)).fetchone()
        return dict(row) if row else None

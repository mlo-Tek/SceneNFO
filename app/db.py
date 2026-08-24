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

CREATE TABLE IF NOT EXISTS libraries (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL UNIQUE,
    kind TEXT NOT NULL CHECK(kind IN ('movies','tv')),
    path TEXT NOT NULL UNIQUE,
    enabled INTEGER NOT NULL DEFAULT 1,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
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

CREATE TABLE IF NOT EXISTS schedules (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    cron TEXT NOT NULL,
    enabled INTEGER NOT NULL DEFAULT 0,
    apply_changes INTEGER NOT NULL DEFAULT 0,
    nfo_policy TEXT NOT NULL DEFAULT 'missing_only' CHECK(nfo_policy IN ('replace_all','missing_only')),
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS schedule_libraries (
    schedule_id INTEGER NOT NULL REFERENCES schedules(id) ON DELETE CASCADE,
    library_id INTEGER NOT NULL REFERENCES libraries(id) ON DELETE CASCADE,
    PRIMARY KEY(schedule_id, library_id)
);
"""


def utcnow() -> str:
    return datetime.now(timezone.utc).isoformat()


@contextmanager
def connection():
    conn = sqlite3.connect(DB_PATH)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA foreign_keys=ON")
    try:
        yield conn
        conn.commit()
    finally:
        conn.close()


def _has_column(conn: sqlite3.Connection, table: str, column: str) -> bool:
    return any(row[1] == column for row in conn.execute(f"PRAGMA table_info({table})").fetchall())


def _migrate(conn: sqlite3.Connection) -> None:
    # Keep the legacy 'library' column as the media kind (movies/tv) and attach
    # an optional configured library ID. This upgrades existing databases without
    # rebuilding the old CHECK-constrained table.
    if not _has_column(conn, "library_items", "library_id"):
        conn.execute("ALTER TABLE library_items ADD COLUMN library_id INTEGER REFERENCES libraries(id) ON DELETE SET NULL")
    if not _has_column(conn, "runs", "library_id"):
        conn.execute("ALTER TABLE runs ADD COLUMN library_id INTEGER REFERENCES libraries(id) ON DELETE SET NULL")
    if not _has_column(conn, "runs", "library_name"):
        conn.execute("ALTER TABLE runs ADD COLUMN library_name TEXT")
    if not _has_column(conn, "runs", "nfo_policy"):
        conn.execute("ALTER TABLE runs ADD COLUMN nfo_policy TEXT")
    conn.execute("CREATE INDEX IF NOT EXISTS idx_library_items_library_id ON library_items(library_id)")
    conn.execute("CREATE INDEX IF NOT EXISTS idx_runs_library_id ON runs(library_id)")


def _seed_default_libraries(conn: sqlite3.Connection) -> None:
    seeded = conn.execute("SELECT value FROM settings WHERE key='libraries_seeded_v1'").fetchone()
    if seeded:
        return

    now = utcnow()
    movie_path = conn.execute("SELECT value FROM settings WHERE key='movies_path'").fetchone()
    tv_path = conn.execute("SELECT value FROM settings WHERE key='tv_path'").fetchone()
    defaults = [
        ("Movies", "movies", movie_path[0] if movie_path else "/data/media/movies"),
        ("TV Shows", "tv", tv_path[0] if tv_path else "/data/media/tv"),
        ("Kids Movies", "movies", "/data/media/movies-kids"),
        ("Kids TV", "tv", "/data/media/tv-kids"),
    ]
    for name, kind, path in defaults:
        conn.execute(
            "INSERT OR IGNORE INTO libraries(name,kind,path,enabled,created_at,updated_at) VALUES(?,?,?,1,?,?)",
            (name, kind, path, now, now),
        )
    conn.execute(
        "INSERT OR REPLACE INTO settings(key,value,secret,updated_at) VALUES('libraries_seeded_v1','true',0,?)",
        (now,),
    )


def init_db() -> None:
    with connection() as conn:
        conn.executescript(SCHEMA)
        now = utcnow()
        for key, value in DEFAULTS.items():
            conn.execute(
                "INSERT OR IGNORE INTO settings(key,value,secret,updated_at) VALUES(?,?,0,?)",
                (key, value, now),
            )
        _migrate(conn)
        _seed_default_libraries(conn)


def fetchall(sql: str, params: Iterable = ()) -> list[dict]:
    with connection() as conn:
        return [dict(row) for row in conn.execute(sql, tuple(params)).fetchall()]


def fetchone(sql: str, params: Iterable = ()) -> dict | None:
    with connection() as conn:
        row = conn.execute(sql, tuple(params)).fetchone()
        return dict(row) if row else None

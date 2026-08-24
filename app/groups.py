from __future__ import annotations

import json
from pathlib import Path

from .db import connection, utcnow
from .services.predb import PreDBClient
from .settings import get_setting

DATA_FILE = Path(__file__).parent / "data" / "p2p_groups.json"


def seed_p2p_groups() -> int:
    groups = json.loads(DATA_FILE.read_text(encoding="utf-8"))
    now = utcnow()
    with connection() as conn:
        for g in groups:
            conn.execute(
                """
                INSERT INTO groups(name,classification,active,origin,distribution_type,aliases,source,updated_at)
                VALUES(?,?,?,?,?,?,?,?)
                ON CONFLICT(name,classification) DO UPDATE SET
                  active=excluded.active,origin=excluded.origin,distribution_type=excluded.distribution_type,
                  aliases=excluded.aliases,source=excluded.source,updated_at=excluded.updated_at
                """,
                (
                    g["name"], "p2p", g.get("active"), g.get("origin"), g.get("type"),
                    ",".join(g.get("aliases") or []), "curated-screenshot", now,
                ),
            )
    return len(groups)


async def sync_scene_groups() -> int:
    client = PreDBClient(get_setting("predb_base_url", "https://predb.club"))
    rows = await client.teams()
    now = utcnow()
    with connection() as conn:
        conn.execute("DELETE FROM groups WHERE classification='scene' AND source='predb.club'")
        for row in rows:
            name = str(row.get("team") or row.get("name") or "").strip()
            if not name:
                continue
            conn.execute(
                """
                INSERT OR REPLACE INTO groups(name,classification,active,origin,distribution_type,aliases,source,updated_at)
                VALUES(?, 'scene', NULL, NULL, NULL, NULL, 'predb.club', ?)
                """,
                (name, now),
            )
    return len(rows)

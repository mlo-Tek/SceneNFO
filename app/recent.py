from __future__ import annotations

import re
from pathlib import Path

from fastapi import APIRouter

from .db import fetchall

router = APIRouter(prefix="/api")

EP_RE = re.compile(r"(?i)\bS(\d{1,2})E(\d{1,3})(?:[-_. ]?E?(\d{1,3}))?")


def _episode_key(value: str | None) -> str | None:
    match = EP_RE.search(value or "")
    if not match:
        return None
    season = int(match.group(1))
    first = int(match.group(2))
    second = match.group(3)
    key = f"S{season:02d}E{first:02d}"
    if second:
        key += f"E{int(second):02d}"
    return key


def _recent_items(library: str, limit: int) -> list[dict]:
    rows = fetchall(
        """
        SELECT
          li.id,
          li.library,
          li.title,
          li.release_name,
          li.classification,
          li.release_group,
          li.nfo_present,
          li.nfo_source,
          li.last_checked_at,
          li.media_path,
          l.name AS configured_library
        FROM library_items li
        LEFT JOIN libraries l ON l.id=li.library_id
        WHERE li.library=?
        ORDER BY li.last_checked_at DESC, li.id DESC
        LIMIT ?
        """,
        (library, limit),
    )

    for row in rows:
        row["nfo_present"] = bool(row.get("nfo_present"))
        row["display_title"] = row.get("title") or row.get("release_name") or "Unknown"
        row["updated_at"] = row.get("last_checked_at")
        if library == "tv":
            row["episode"] = _episode_key(row.get("release_name")) or _episode_key(
                Path(row.get("media_path") or "").name
            )
        else:
            row["episode"] = None
    return rows


@router.get("/dashboard/recent")
def dashboard_recent(limit: int = 10):
    limit = min(max(int(limit), 1), 12)
    return {
        "movies": _recent_items("movies", limit),
        "tv": _recent_items("tv", limit),
        "limit": limit,
    }

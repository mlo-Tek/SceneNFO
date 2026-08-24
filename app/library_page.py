from __future__ import annotations

import math

from fastapi import APIRouter, HTTPException

from .db import connection, fetchall

router = APIRouter(prefix="/api")

SORT_COLUMNS = {
    "title": "li.title COLLATE NOCASE",
    "group": "COALESCE(li.release_group, '') COLLATE NOCASE",
    "classification": "COALESCE(li.classification, '') COLLATE NOCASE",
    "nfo": "li.nfo_present",
    "result": "COALESCE(li.last_result, '') COLLATE NOCASE",
    "library": "COALESCE(l.name, '') COLLATE NOCASE",
    "release": "li.release_name COLLATE NOCASE",
}


@router.get("/library/{library}/page")
def library_page(
    library: str,
    library_id: int | None = None,
    classification: str | None = None,
    group: str | None = None,
    nfo: str | None = None,
    q: str | None = None,
    sort: str = "title",
    direction: str = "asc",
    limit: int = 100,
    offset: int = 0,
):
    """Return one stable, paginated inventory page for Movies or TV.

    Filtering and sorting happen in SQLite so pagination always represents the
    complete matching inventory, not merely the currently rendered browser page.
    """
    if library not in {"movies", "tv"}:
        raise HTTPException(400, "library must be movies or tv")
    if classification and classification not in {"scene", "p2p"}:
        raise HTTPException(400, "classification must be scene or p2p")
    if nfo and nfo not in {"present", "missing"}:
        raise HTTPException(400, "nfo must be present or missing")
    if sort not in SORT_COLUMNS:
        raise HTTPException(400, f"sort must be one of: {', '.join(SORT_COLUMNS)}")
    if direction not in {"asc", "desc"}:
        raise HTTPException(400, "direction must be asc or desc")

    limit = min(max(int(limit), 1), 200)
    offset = max(int(offset), 0)

    where = ["li.library=?"]
    params: list[object] = [library]

    if library_id is not None:
        where.append("li.library_id=?")
        params.append(library_id)
    if classification:
        where.append("li.classification=?")
        params.append(classification)
    if group:
        where.append("li.release_group=?")
        params.append(group)
    if nfo == "present":
        where.append("li.nfo_present=1")
    elif nfo == "missing":
        where.append("li.nfo_present=0")
    if q:
        q = q.strip()
        if q:
            where.append("(li.title LIKE ? OR li.release_name LIKE ? OR li.release_group LIKE ?)")
            needle = f"%{q}%"
            params.extend([needle, needle, needle])

    clause = " AND ".join(where)
    with connection() as conn:
        total = conn.execute(
            f"SELECT COUNT(*) FROM library_items li WHERE {clause}",
            tuple(params),
        ).fetchone()[0]

    if total and offset >= total:
        offset = ((total - 1) // limit) * limit

    sort_expression = SORT_COLUMNS[sort]
    sql_direction = direction.upper()
    items = fetchall(
        f"""
        SELECT li.*,l.name AS configured_library
        FROM library_items li
        LEFT JOIN libraries l ON l.id=li.library_id
        WHERE {clause}
        ORDER BY {sort_expression} {sql_direction}, li.title COLLATE NOCASE ASC, li.id ASC
        LIMIT ? OFFSET ?
        """,
        [*params, limit, offset],
    )

    page = (offset // limit) + 1 if total else 1
    pages = max(1, math.ceil(total / limit))
    return {
        "items": items,
        "total": total,
        "limit": limit,
        "offset": offset,
        "page": page,
        "pages": pages,
        "sort": sort,
        "direction": direction,
    }

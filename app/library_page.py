from __future__ import annotations

import math

from fastapi import APIRouter, HTTPException

from .db import connection, fetchall

router = APIRouter(prefix="/api")


@router.get("/library/{library}/page")
def library_page(
    library: str,
    library_id: int | None = None,
    classification: str | None = None,
    group: str | None = None,
    nfo: str | None = None,
    q: str | None = None,
    limit: int = 100,
    offset: int = 0,
):
    """Return one stable, paginated inventory page for Movies or TV.

    This endpoint intentionally returns a page object instead of thousands of
    rows at once. The WebUI uses it directly and does not post-process the
    resulting table with MutationObservers.
    """
    if library not in {"movies", "tv"}:
        raise HTTPException(400, "library must be movies or tv")
    if classification and classification not in {"scene", "p2p"}:
        raise HTTPException(400, "classification must be scene or p2p")
    if nfo and nfo not in {"present", "missing"}:
        raise HTTPException(400, "nfo must be present or missing")

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

    items = fetchall(
        f"""
        SELECT li.*,l.name AS configured_library
        FROM library_items li
        LEFT JOIN libraries l ON l.id=li.library_id
        WHERE {clause}
        ORDER BY li.title COLLATE NOCASE, li.id
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
    }

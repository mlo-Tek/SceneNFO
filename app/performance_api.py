from __future__ import annotations

from fastapi import APIRouter, HTTPException

from .db import connection, fetchall, fetchone

router = APIRouter(prefix="/api/performance")


def _category_clause(category: str | None) -> tuple[str | None, list[str]]:
    value = (category or "all").strip().lower()
    if value in {"", "all"}:
        return None, []
    if value == "manual":
        return "r.trigger='manual'", []
    if value == "imports":
        return "(r.trigger LIKE 'radarr-%' OR r.trigger LIKE 'sonarr-%')", []
    if value == "schedules":
        return "r.trigger LIKE 'schedule:%'", []
    if value == "review":
        return "r.trigger LIKE 'review-apply:%'", []
    raise HTTPException(400, "category must be all, manual, imports, schedules or review")


@router.get("/history")
def history_page(
    limit: int = 25,
    offset: int = 0,
    category: str = "all",
    library_id: int | None = None,
    status: str | None = None,
    q: str | None = None,
):
    limit = min(max(int(limit), 1), 100)
    offset = max(int(offset), 0)
    where: list[str] = []
    params: list[object] = []

    clause, clause_params = _category_clause(category)
    if clause:
        where.append(clause)
        params.extend(clause_params)
    if library_id is not None:
        where.append("r.library_id=?")
        params.append(library_id)
    if status:
        where.append("r.status=?")
        params.append(status)
    if q:
        term = f"%{q.strip()}%"
        where.append("(r.library_name LIKE ? OR r.trigger LIKE ? OR CAST(r.id AS TEXT) LIKE ?)")
        params.extend([term, term, term])

    sql_where = " WHERE " + " AND ".join(where) if where else ""
    with connection() as conn:
        total = conn.execute(f"SELECT COUNT(*) FROM runs r{sql_where}", tuple(params)).fetchone()[0]
        rows = [dict(row) for row in conn.execute(
            f"""
            SELECT r.*
            FROM runs r
            {sql_where}
            ORDER BY r.id DESC
            LIMIT ? OFFSET ?
            """,
            tuple(params + [limit, offset]),
        ).fetchall()]

        counts = {
            "all": conn.execute("SELECT COUNT(*) FROM runs").fetchone()[0],
            "manual": conn.execute("SELECT COUNT(*) FROM runs WHERE trigger='manual'").fetchone()[0],
            "imports": conn.execute("SELECT COUNT(*) FROM runs WHERE trigger LIKE 'radarr-%' OR trigger LIKE 'sonarr-%'").fetchone()[0],
            "schedules": conn.execute("SELECT COUNT(*) FROM runs WHERE trigger LIKE 'schedule:%'").fetchone()[0],
            "review": conn.execute("SELECT COUNT(*) FROM runs WHERE trigger LIKE 'review-apply:%'").fetchone()[0],
        }

    return {
        "total": int(total),
        "limit": limit,
        "offset": offset,
        "items": rows,
        "counts": counts,
    }


@router.get("/runs/{run_id}")
def run_summary(run_id: int):
    row = fetchone("SELECT * FROM runs WHERE id=?", (run_id,))
    if not row:
        raise HTTPException(404, "run not found")
    return row


@router.get("/runs/{run_id}/events")
def run_events_page(
    run_id: int,
    limit: int = 200,
    offset: int = 0,
    order: str = "desc",
    event_type: str | None = None,
    errors_only: bool = False,
    q: str | None = None,
):
    if not fetchone("SELECT id FROM runs WHERE id=?", (run_id,)):
        raise HTTPException(404, "run not found")

    limit = min(max(int(limit), 1), 500)
    offset = max(int(offset), 0)
    direction = "ASC" if order.lower() == "asc" else "DESC"
    where = ["run_id=?"]
    params: list[object] = [run_id]

    if event_type and event_type != "all":
        where.append("event=?")
        params.append(event_type)
    if errors_only:
        where.append("(lower(level)='error' OR event LIKE '%error%' OR event='fatal')")
    if q:
        term = f"%{q.strip()}%"
        where.append("(message LIKE ? OR payload LIKE ? OR event LIKE ?)")
        params.extend([term, term, term])

    sql_where = " WHERE " + " AND ".join(where)
    with connection() as conn:
        total = conn.execute(f"SELECT COUNT(*) FROM run_events{sql_where}", tuple(params)).fetchone()[0]
        rows = [dict(row) for row in conn.execute(
            f"""
            SELECT id,run_id,ts,level,event,message,payload
            FROM run_events
            {sql_where}
            ORDER BY id {direction}
            LIMIT ? OFFSET ?
            """,
            tuple(params + [limit, offset]),
        ).fetchall()]
        kinds = [row[0] for row in conn.execute(
            "SELECT DISTINCT event FROM run_events WHERE run_id=? ORDER BY event COLLATE NOCASE",
            (run_id,),
        ).fetchall() if row[0]]
        absolute_total = conn.execute("SELECT COUNT(*) FROM run_events WHERE run_id=?", (run_id,)).fetchone()[0]

    return {
        "total": int(total),
        "absolute_total": int(absolute_total),
        "limit": limit,
        "offset": offset,
        "order": direction.lower(),
        "event_types": kinds,
        "items": rows,
    }

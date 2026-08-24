from __future__ import annotations

import httpx
from apscheduler.triggers.cron import CronTrigger
from fastapi import APIRouter, HTTPException, Request
from fastapi.responses import StreamingResponse
from pydantic import BaseModel

from .db import connection, fetchall, fetchone, utcnow
from .groups import seed_p2p_groups, sync_scene_groups
from .scanner import scan_manager
from .scheduler import refresh_schedule
from .settings import get_setting, public_settings, set_setting

router = APIRouter(prefix="/api")
VERSION = "0.3.3"
SCAN_SCOPES = {"incremental", "full"}
NFO_POLICIES = {"replace_all", "missing_only"}


class ScanRequest(BaseModel):
    library_id: int | None = None
    library: str | None = None
    path: str | None = None
    apply: bool = False
    nfo_policy: str = "replace_all"
    scan_scope: str = "incremental"


class LibraryBody(BaseModel):
    name: str
    kind: str
    path: str
    enabled: bool = True


class ScheduleBody(BaseModel):
    name: str
    cron: str
    enabled: bool = False
    apply_changes: bool = False
    nfo_policy: str = "missing_only"
    scan_scope: str = "incremental"
    library_ids: list[int] = []


class SettingsUpdate(BaseModel):
    values: dict[str, str]


def _library_or_404(library_id: int) -> dict:
    lib = fetchone("SELECT * FROM libraries WHERE id=?", (library_id,))
    if not lib:
        raise HTTPException(404, "library not found")
    return lib


def _validate_library(body: LibraryBody) -> tuple[str, str, str]:
    name = body.name.strip()
    path = body.path.strip().rstrip("/") or "/"
    kind = body.kind.strip().lower()
    if not name:
        raise HTTPException(400, "library name is required")
    if kind not in {"movies", "tv"}:
        raise HTTPException(400, "library kind must be movies or tv")
    if not path.startswith("/"):
        raise HTTPException(400, "library path must be an absolute container path")
    return name, kind, path


def _validate_schedule(body: ScheduleBody) -> None:
    if not body.name.strip():
        raise HTTPException(400, "schedule name is required")
    if body.nfo_policy not in NFO_POLICIES:
        raise HTTPException(400, "nfo_policy must be replace_all or missing_only")
    if body.scan_scope not in SCAN_SCOPES:
        raise HTTPException(400, "scan_scope must be incremental or full")
    try:
        CronTrigger.from_crontab(body.cron.strip())
    except ValueError as exc:
        raise HTTPException(400, f"invalid cron expression: {exc}") from exc
    if not body.library_ids:
        raise HTTPException(400, "select at least one library")
    placeholders = ",".join("?" for _ in body.library_ids)
    found = fetchall(
        f"SELECT id FROM libraries WHERE id IN ({placeholders})", body.library_ids
    )
    if len(found) != len(set(body.library_ids)):
        raise HTTPException(400, "one or more selected libraries do not exist")


def _schedule_dict(schedule_id: int) -> dict | None:
    sched = fetchone("SELECT * FROM schedules WHERE id=?", (schedule_id,))
    if not sched:
        return None
    sched["enabled"] = bool(sched["enabled"])
    sched["apply_changes"] = bool(sched["apply_changes"])
    sched["library_ids"] = [
        row["library_id"]
        for row in fetchall(
            "SELECT library_id FROM schedule_libraries WHERE schedule_id=? ORDER BY library_id",
            (schedule_id,),
        )
    ]
    return sched


def _match_library(kind: str, path: str | None) -> dict | None:
    libs = fetchall(
        "SELECT * FROM libraries WHERE kind=? AND enabled=1 ORDER BY length(path) DESC, id",
        (kind,),
    )
    if path:
        clean = path.rstrip("/")
        for lib in libs:
            root = lib["path"].rstrip("/")
            if clean == root or clean.startswith(root + "/"):
                return lib
    return libs[0] if len(libs) == 1 else None


@router.get("/health")
def health():
    return {"ok": True, "version": VERSION}


@router.get("/dashboard")
def dashboard():
    with connection() as conn:
        movies = conn.execute(
            "SELECT COUNT(*) FROM library_items WHERE library='movies'"
        ).fetchone()[0]
        tv = conn.execute(
            "SELECT COUNT(*) FROM library_items WHERE library='tv'"
        ).fetchone()[0]
        scene = conn.execute(
            "SELECT COUNT(*) FROM library_items WHERE classification='scene'"
        ).fetchone()[0]
        p2p = conn.execute(
            "SELECT COUNT(*) FROM library_items WHERE classification='p2p'"
        ).fetchone()[0]
        nfo = conn.execute(
            "SELECT COUNT(*) FROM library_items WHERE nfo_present=1"
        ).fetchone()[0]
        libraries = conn.execute(
            "SELECT COUNT(*) FROM libraries WHERE enabled=1"
        ).fetchone()[0]
    return {
        "movies": movies,
        "tv": tv,
        "scene": scene,
        "p2p": p2p,
        "nfo": nfo,
        "libraries": libraries,
    }


@router.get("/libraries")
def libraries(kind: str | None = None):
    if kind and kind not in {"movies", "tv"}:
        raise HTTPException(400, "kind must be movies or tv")
    if kind:
        return fetchall(
            "SELECT * FROM libraries WHERE kind=? ORDER BY name COLLATE NOCASE",
            (kind,),
        )
    return fetchall("SELECT * FROM libraries ORDER BY kind,name COLLATE NOCASE")


@router.post("/libraries")
def create_library(body: LibraryBody):
    name, kind, path = _validate_library(body)
    now = utcnow()
    try:
        with connection() as conn:
            cur = conn.execute(
                "INSERT INTO libraries(name,kind,path,enabled,created_at,updated_at) VALUES(?,?,?,?,?,?)",
                (name, kind, path, int(body.enabled), now, now),
            )
            library_id = cur.lastrowid
    except Exception as exc:
        if "UNIQUE constraint" in str(exc):
            raise HTTPException(409, "library name or path already exists") from exc
        raise
    refresh_schedule()
    return _library_or_404(library_id)


@router.put("/libraries/{library_id}")
def update_library(library_id: int, body: LibraryBody):
    _library_or_404(library_id)
    name, kind, path = _validate_library(body)
    try:
        with connection() as conn:
            conn.execute(
                "UPDATE libraries SET name=?,kind=?,path=?,enabled=?,updated_at=? WHERE id=?",
                (name, kind, path, int(body.enabled), utcnow(), library_id),
            )
    except Exception as exc:
        if "UNIQUE constraint" in str(exc):
            raise HTTPException(409, "library name or path already exists") from exc
        raise
    refresh_schedule()
    return _library_or_404(library_id)


@router.delete("/libraries/{library_id}")
def delete_library(library_id: int):
    lib = _library_or_404(library_id)
    with connection() as conn:
        conn.execute("DELETE FROM libraries WHERE id=?", (library_id,))
    refresh_schedule()
    return {"deleted": True, "library": lib["name"]}


@router.post("/scans")
async def start_scan(body: ScanRequest):
    if body.nfo_policy not in NFO_POLICIES:
        raise HTTPException(400, "nfo_policy must be replace_all or missing_only")
    if body.scan_scope not in SCAN_SCOPES:
        raise HTTPException(400, "scan_scope must be incremental or full")

    if body.library_id is not None:
        lib = _library_or_404(body.library_id)
        job_id = scan_manager.create(
            lib["kind"],
            lib["path"],
            "manual",
            body.apply,
            body.nfo_policy,
            lib["id"],
            lib["name"],
            body.scan_scope,
        )
        return {"job_id": job_id}

    library = body.library or "movies"
    if library not in {"movies", "tv"}:
        raise HTTPException(400, "library must be movies or tv")
    job_id = scan_manager.create(
        library,
        body.path,
        "manual",
        body.apply,
        body.nfo_policy,
        scan_scope=body.scan_scope,
    )
    return {"job_id": job_id}


@router.post("/scans/{job_id}/stop")
def stop_scan(job_id: str):
    if job_id not in scan_manager.jobs:
        raise HTTPException(404, "job not found")
    scan_manager.stop(job_id)
    return {"ok": True}


@router.get("/scans/{job_id}/events")
def scan_events(job_id: str):
    if job_id not in scan_manager.jobs:
        raise HTTPException(404, "job not found")
    return StreamingResponse(
        scan_manager.events(job_id),
        media_type="text/event-stream",
        headers={"Cache-Control": "no-cache"},
    )


@router.get("/library/{library}")
def library_items(
    library: str,
    library_id: str | None = None,
    classification: str | None = None,
    group: str | None = None,
    nfo: str | None = None,
    q: str | None = None,
    limit: int = 500,
):
    """Return library inventory.

    library_id intentionally accepts a string so an older cached frontend that
    sends `library_id=` does not fail FastAPI validation with HTTP 422. Empty
    means no configured-library filter; a non-empty value is parsed here.
    """
    if library not in {"movies", "tv"}:
        raise HTTPException(400, "library must be movies or tv")

    parsed_library_id: int | None = None
    if library_id not in {None, ""}:
        try:
            parsed_library_id = int(library_id)
        except (TypeError, ValueError) as exc:
            raise HTTPException(400, "library_id must be an integer") from exc

    where = ["li.library=?"]
    params: list = [library]
    if parsed_library_id is not None:
        where.append("li.library_id=?")
        params.append(parsed_library_id)
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
        where.append(
            "(li.title LIKE ? OR li.release_name LIKE ? OR li.release_group LIKE ?)"
        )
        params.extend([f"%{q}%", f"%{q}%", f"%{q}%"])
    params.append(min(max(limit, 1), 5000))
    return fetchall(
        f"""
        SELECT li.*,l.name AS configured_library
        FROM library_items li
        LEFT JOIN libraries l ON l.id=li.library_id
        WHERE {' AND '.join(where)}
        ORDER BY li.title COLLATE NOCASE LIMIT ?
        """,
        params,
    )


@router.get("/schedules")
def schedules():
    rows = fetchall("SELECT id FROM schedules ORDER BY id")
    return [_schedule_dict(row["id"]) for row in rows]


@router.post("/schedules")
def create_schedule(body: ScheduleBody):
    _validate_schedule(body)
    now = utcnow()
    with connection() as conn:
        cur = conn.execute(
            """
            INSERT INTO schedules(
                name,cron,enabled,apply_changes,nfo_policy,scan_scope,created_at,updated_at
            ) VALUES(?,?,?,?,?,?,?,?)
            """,
            (
                body.name.strip(),
                body.cron.strip(),
                int(body.enabled),
                int(body.apply_changes),
                body.nfo_policy,
                body.scan_scope,
                now,
                now,
            ),
        )
        schedule_id = cur.lastrowid
        conn.executemany(
            "INSERT INTO schedule_libraries(schedule_id,library_id) VALUES(?,?)",
            [(schedule_id, lib_id) for lib_id in sorted(set(body.library_ids))],
        )
    refresh_schedule()
    return _schedule_dict(schedule_id)


@router.put("/schedules/{schedule_id}")
def update_schedule(schedule_id: int, body: ScheduleBody):
    if not _schedule_dict(schedule_id):
        raise HTTPException(404, "schedule not found")
    _validate_schedule(body)
    with connection() as conn:
        conn.execute(
            """
            UPDATE schedules
            SET name=?,cron=?,enabled=?,apply_changes=?,nfo_policy=?,scan_scope=?,updated_at=?
            WHERE id=?
            """,
            (
                body.name.strip(),
                body.cron.strip(),
                int(body.enabled),
                int(body.apply_changes),
                body.nfo_policy,
                body.scan_scope,
                utcnow(),
                schedule_id,
            ),
        )
        conn.execute("DELETE FROM schedule_libraries WHERE schedule_id=?", (schedule_id,))
        conn.executemany(
            "INSERT INTO schedule_libraries(schedule_id,library_id) VALUES(?,?)",
            [(schedule_id, lib_id) for lib_id in sorted(set(body.library_ids))],
        )
    refresh_schedule()
    return _schedule_dict(schedule_id)


@router.delete("/schedules/{schedule_id}")
def delete_schedule(schedule_id: int):
    if not _schedule_dict(schedule_id):
        raise HTTPException(404, "schedule not found")
    with connection() as conn:
        conn.execute("DELETE FROM schedules WHERE id=?", (schedule_id,))
    refresh_schedule()
    return {"deleted": True}


@router.get("/groups")
def groups(classification: str | None = None, q: str | None = None):
    where = []
    params = []
    if classification:
        where.append("classification=?")
        params.append(classification)
    if q:
        where.append("(name LIKE ? OR aliases LIKE ? OR origin LIKE ?)")
        params.extend([f"%{q}%", f"%{q}%", f"%{q}%"])
    clause = " WHERE " + " AND ".join(where) if where else ""
    return fetchall(
        f"SELECT * FROM groups{clause} ORDER BY classification,name COLLATE NOCASE",
        params,
    )


@router.post("/groups/sync-scene")
async def sync_groups():
    count = await sync_scene_groups()
    return {"synced": count}


@router.post("/groups/reseed-p2p")
def reseed_p2p():
    return {"seeded": seed_p2p_groups()}


@router.get("/settings")
def settings():
    return public_settings()


@router.put("/settings")
def update_settings(body: SettingsUpdate):
    for key, value in body.values.items():
        if value == "••••••••":
            continue
        set_setting(key, str(value))
    return public_settings()


@router.post("/sources/test")
async def test_sources():
    results = {}
    async with httpx.AsyncClient(timeout=10, follow_redirects=True) as client:
        for key, url in {
            "predb": get_setting("predb_base_url"),
            "srrdb": get_setting("srrdb_base_url"),
            "crowdnfo": get_setting("crowdnfo_base_url"),
        }.items():
            try:
                r = await client.get(url)
                results[key] = {"ok": r.status_code < 500, "status": r.status_code}
            except Exception as exc:
                results[key] = {"ok": False, "error": str(exc)}
    return results


@router.get("/history")
def history(limit: int = 100):
    return fetchall(
        "SELECT * FROM runs ORDER BY id DESC LIMIT ?",
        (min(max(limit, 1), 1000),),
    )


@router.get("/history/{run_id}/events")
def history_events(run_id: int, limit: int = 5000):
    return fetchall(
        "SELECT * FROM run_events WHERE run_id=? ORDER BY id LIMIT ?",
        (run_id, min(max(limit, 1), 10000)),
    )


@router.get("/logs")
def logs(limit: int = 1000):
    return fetchall(
        """
        SELECT e.*,r.library,r.library_name,r.trigger
        FROM run_events e JOIN runs r ON r.id=e.run_id
        ORDER BY e.id DESC LIMIT ?
        """,
        (min(max(limit, 1), 10000),),
    )


@router.post("/webhooks/radarr")
async def radarr_webhook(request: Request):
    payload = await request.json()
    if get_setting("radarr_webhook_enabled", "true").lower() != "true":
        return {"accepted": False, "reason": "disabled"}
    movie = payload.get("movie") or {}
    path = movie.get("folderPath") or movie.get("path")
    apply = get_setting("import_apply", "false").lower() == "true"
    policy = get_setting("import_nfo_policy", "replace_all")
    lib = _match_library("movies", path)
    if lib:
        job = scan_manager.create(
            "movies",
            path or lib["path"],
            "radarr-import",
            apply,
            policy,
            lib["id"],
            lib["name"],
            "incremental",
        )
    else:
        job = scan_manager.create(
            "movies", path, "radarr-import", apply, policy, scan_scope="incremental"
        )
    return {"accepted": True, "job_id": job}


@router.post("/webhooks/sonarr")
async def sonarr_webhook(request: Request):
    payload = await request.json()
    if get_setting("sonarr_webhook_enabled", "true").lower() != "true":
        return {"accepted": False, "reason": "disabled"}
    series = payload.get("series") or {}
    path = series.get("path")
    apply = get_setting("import_apply", "false").lower() == "true"
    policy = get_setting("import_nfo_policy", "replace_all")
    lib = _match_library("tv", path)
    if lib:
        job = scan_manager.create(
            "tv",
            path or lib["path"],
            "sonarr-import-complete",
            apply,
            policy,
            lib["id"],
            lib["name"],
            "incremental",
        )
    else:
        job = scan_manager.create(
            "tv",
            path,
            "sonarr-import-complete",
            apply,
            policy,
            scan_scope="incremental",
        )
    return {"accepted": True, "job_id": job}

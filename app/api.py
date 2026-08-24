from __future__ import annotations

import asyncio
from pathlib import Path

import httpx
from fastapi import APIRouter, HTTPException, Request
from fastapi.responses import StreamingResponse
from pydantic import BaseModel

from .db import connection, fetchall, fetchone
from .groups import seed_p2p_groups, sync_scene_groups
from .scanner import scan_manager
from .scheduler import refresh_schedule
from .settings import get_setting, public_settings, set_setting

router = APIRouter(prefix="/api")


class ScanRequest(BaseModel):
    library: str
    path: str | None = None
    apply: bool = False
    nfo_policy: str = "replace_all"


class SettingsUpdate(BaseModel):
    values: dict[str, str]


@router.get("/health")
def health():
    return {"ok": True, "version": "0.1.0"}


@router.get("/dashboard")
def dashboard():
    with connection() as conn:
        movies = conn.execute("SELECT COUNT(*) FROM library_items WHERE library='movies'").fetchone()[0]
        tv = conn.execute("SELECT COUNT(*) FROM library_items WHERE library='tv'").fetchone()[0]
        scene = conn.execute("SELECT COUNT(*) FROM library_items WHERE classification='scene'").fetchone()[0]
        p2p = conn.execute("SELECT COUNT(*) FROM library_items WHERE classification='p2p'").fetchone()[0]
        nfo = conn.execute("SELECT COUNT(*) FROM library_items WHERE nfo_present=1").fetchone()[0]
    return {"movies": movies, "tv": tv, "scene": scene, "p2p": p2p, "nfo": nfo}


@router.post("/scans")
def start_scan(body: ScanRequest):
    if body.library not in {"movies", "tv"}:
        raise HTTPException(400, "library must be movies or tv")
    if body.nfo_policy not in {"replace_all", "missing_only"}:
        raise HTTPException(400, "nfo_policy must be replace_all or missing_only")
    job_id = scan_manager.create(body.library, body.path, "manual", body.apply, body.nfo_policy)
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
    return StreamingResponse(scan_manager.events(job_id), media_type="text/event-stream", headers={"Cache-Control": "no-cache"})


@router.get("/library/{library}")
def library_items(library: str, classification: str | None = None, group: str | None = None, nfo: str | None = None, q: str | None = None, limit: int = 500):
    where = ["library=?"]
    params: list = [library]
    if classification:
        where.append("classification=?"); params.append(classification)
    if group:
        where.append("release_group=?"); params.append(group)
    if nfo == "present":
        where.append("nfo_present=1")
    elif nfo == "missing":
        where.append("nfo_present=0")
    if q:
        where.append("(title LIKE ? OR release_name LIKE ? OR release_group LIKE ?)")
        params.extend([f"%{q}%", f"%{q}%", f"%{q}%"])
    params.append(min(max(limit, 1), 5000))
    return fetchall(f"SELECT * FROM library_items WHERE {' AND '.join(where)} ORDER BY title COLLATE NOCASE LIMIT ?", params)


@router.get("/groups")
def groups(classification: str | None = None, q: str | None = None):
    where = []
    params = []
    if classification:
        where.append("classification=?"); params.append(classification)
    if q:
        where.append("(name LIKE ? OR aliases LIKE ? OR origin LIKE ?)")
        params.extend([f"%{q}%", f"%{q}%", f"%{q}%"])
    clause = " WHERE " + " AND ".join(where) if where else ""
    return fetchall(f"SELECT * FROM groups{clause} ORDER BY classification,name COLLATE NOCASE", params)


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
    refresh_schedule()
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
    return fetchall("SELECT * FROM runs ORDER BY id DESC LIMIT ?", (min(max(limit, 1), 1000),))


@router.get("/history/{run_id}/events")
def history_events(run_id: int, limit: int = 5000):
    return fetchall("SELECT * FROM run_events WHERE run_id=? ORDER BY id LIMIT ?", (run_id, min(max(limit, 1), 10000)))


@router.get("/logs")
def logs(limit: int = 1000):
    return fetchall("SELECT e.*,r.library,r.trigger FROM run_events e JOIN runs r ON r.id=e.run_id ORDER BY e.id DESC LIMIT ?", (min(max(limit, 1), 10000),))


@router.post("/webhooks/radarr")
async def radarr_webhook(request: Request):
    payload = await request.json()
    if get_setting("radarr_webhook_enabled", "true").lower() != "true":
        return {"accepted": False, "reason": "disabled"}
    movie = payload.get("movie") or {}
    path = movie.get("folderPath") or movie.get("path")
    apply = get_setting("import_apply", "true").lower() == "true"
    policy = get_setting("import_nfo_policy", "replace_all")
    job = scan_manager.create("movies", path, "radarr-import", apply, policy) if path else scan_manager.create("movies", None, "radarr-import", apply, policy)
    return {"accepted": True, "job_id": job}


@router.post("/webhooks/sonarr")
async def sonarr_webhook(request: Request):
    payload = await request.json()
    if get_setting("sonarr_webhook_enabled", "true").lower() != "true":
        return {"accepted": False, "reason": "disabled"}
    series = payload.get("series") or {}
    path = series.get("path")
    apply = get_setting("import_apply", "true").lower() == "true"
    policy = get_setting("import_nfo_policy", "replace_all")
    job = scan_manager.create("tv", path, "sonarr-import-complete", apply, policy) if path else scan_manager.create("tv", None, "sonarr-import-complete", apply, policy)
    return {"accepted": True, "job_id": job}

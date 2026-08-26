from __future__ import annotations

import json
import re
from pathlib import Path

from fastapi import APIRouter

from .db import connection, fetchone, utcnow
from .scanner import ScanManager
from .services.sonarr import SonarrClient
from .settings import get_setting

router = APIRouter(prefix="/api/integrations/sonarr", tags=["sonarr"])

WRITE_ACTIONS = {"CREATED", "REPLACED_IDENTICAL", "REPLACED_CHANGED"}
SEASON_DIR_RE = re.compile(r"^season\s+\d+$", re.IGNORECASE)
_INSTALLED = False


def _sonarr_client() -> SonarrClient:
    base_url = get_setting("sonarr_base_url", get_setting("sonarr_url", ""))
    api_key = get_setting("sonarr_api_key", "")
    return SonarrClient(base_url, api_key)


def _record_refresh_event(run_id: int, level: str, message: str, payload: dict) -> None:
    event = {"type": "sonarr_refresh", "message": message, **payload}
    with connection() as conn:
        conn.execute(
            "INSERT INTO run_events(run_id,ts,level,event,message,payload) VALUES(?,?,?,?,?,?)",
            (
                run_id,
                utcnow(),
                level,
                "sonarr_refresh",
                message,
                json.dumps(event, ensure_ascii=False),
            ),
        )


def _series_folder(media_path: str, library_root: Path | None) -> str:
    media = Path(media_path)
    if library_root is not None:
        try:
            relative = media.relative_to(library_root)
            if len(relative.parts) >= 2:
                return str(library_root / relative.parts[0])
        except ValueError:
            pass

    parent = media.parent
    if SEASON_DIR_RE.match(parent.name):
        return str(parent.parent)
    return str(parent)


def _changed_series_folders(run_id: int) -> set[str]:
    run = fetchone("SELECT library_id FROM runs WHERE id=?", (run_id,)) or {}
    library_root: Path | None = None
    if run.get("library_id") is not None:
        lib = fetchone("SELECT path FROM libraries WHERE id=?", (run["library_id"],))
        if lib and lib.get("path"):
            library_root = Path(lib["path"])

    folders: set[str] = set()
    with connection() as conn:
        rows = conn.execute(
            "SELECT payload FROM run_events WHERE run_id=? AND event='item' ORDER BY id",
            (run_id,),
        ).fetchall()
    for row in rows:
        try:
            payload = json.loads(row["payload"] or "{}")
        except (TypeError, json.JSONDecodeError):
            continue
        if str(payload.get("action") or "") not in WRITE_ACTIONS:
            continue
        media_path = str(payload.get("media_path") or "")
        if media_path:
            folders.add(_series_folder(media_path, library_root))
    return folders


async def _refresh_sonarr_after_run(run_id: int) -> None:
    if get_setting("sonarr_refresh_after_apply", "true").lower() != "true":
        return

    folders = _changed_series_folders(run_id)
    if not folders:
        return

    client = _sonarr_client()
    if not client.configured:
        _record_refresh_event(
            run_id,
            "WARNING",
            "Sonarr refresh skipped: Sonarr URL or API key is not configured",
            {"folders": sorted(folders), "refreshed": 0},
        )
        return

    try:
        series_ids, unmatched = await client.series_ids_for_folders(folders)
        if not series_ids:
            _record_refresh_event(
                run_id,
                "WARNING",
                "Sonarr refresh skipped: no affected series could be matched in Sonarr",
                {"folders": sorted(folders), "unmatched": unmatched, "refreshed": 0},
            )
            return

        result = await client.refresh_series_ids(series_ids)
        _record_refresh_event(
            run_id,
            "INFO",
            f"Queued Sonarr refresh for {len(series_ids)} affected series",
            {
                "series_ids": series_ids,
                "unmatched": unmatched,
                "commands": result.get("commands", []),
                "refreshed": len(series_ids),
            },
        )
    except Exception as exc:
        _record_refresh_event(
            run_id,
            "WARNING",
            f"Sonarr refresh failed: {exc}",
            {"folders": sorted(folders), "refreshed": 0},
        )


def install_sonarr_integration() -> None:
    global _INSTALLED
    if _INSTALLED:
        return
    _INSTALLED = True

    # radarr_integration.py already installs the ownership-aware atomic writer.
    # This wrapper only adds the post-Apply Sonarr refresh for TV runs.
    original_run = ScanManager._run

    async def run_with_sonarr_refresh(
        self,
        job_id,
        library,
        path,
        trigger,
        apply,
        nfo_policy,
        library_id,
        library_name,
        scan_scope,
    ):
        await original_run(
            self,
            job_id,
            library,
            path,
            trigger,
            apply,
            nfo_policy,
            library_id,
            library_name,
            scan_scope,
        )
        job = self.jobs.get(job_id) or {}
        run_id = job.get("run_id")
        if library == "tv" and apply and run_id and job.get("status") == "completed":
            await _refresh_sonarr_after_run(int(run_id))

    ScanManager._run = run_with_sonarr_refresh


@router.get("/test")
async def test_sonarr():
    return await _sonarr_client().test()

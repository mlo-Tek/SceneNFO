from __future__ import annotations

import asyncio
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
BATCH_CHILD_PREFIX = "__sonarr_batch_child__:"
_INSTALLED = False
_BATCH_REFRESH_TASKS: dict[int, asyncio.Task] = {}


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


async def refresh_sonarr_after_run(run_id: int) -> None:
    run = fetchone("SELECT library,mode,status FROM runs WHERE id=?", (run_id,)) or {}
    if run.get("library") != "tv" or run.get("mode") != "apply" or run.get("status") != "completed":
        return
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


async def _wait_for_batch_and_refresh(parent_run_id: int) -> None:
    try:
        deadline = asyncio.get_running_loop().time() + 7200
        while asyncio.get_running_loop().time() < deadline:
            run = fetchone("SELECT status FROM runs WHERE id=?", (parent_run_id,)) or {}
            status = str(run.get("status") or "")
            if status == "completed":
                await refresh_sonarr_after_run(parent_run_id)
                return
            if status in {"failed", "cancelled"}:
                return
            await asyncio.sleep(0.5)
    finally:
        _BATCH_REFRESH_TASKS.pop(parent_run_id, None)


def _schedule_batch_refresh(parent_run_id: int) -> None:
    task = _BATCH_REFRESH_TASKS.get(parent_run_id)
    if task and not task.done():
        return
    _BATCH_REFRESH_TASKS[parent_run_id] = asyncio.create_task(
        _wait_for_batch_and_refresh(parent_run_id)
    )


def install_sonarr_integration() -> None:
    global _INSTALLED
    if _INSTALLED:
        return
    _INSTALLED = True

    # radarr_integration.py already installs the ownership-aware atomic writer.
    # Normal TV Apply runs refresh immediately after completion. Sonarr import
    # batch children register one waiter for their consolidated parent run, so a
    # season pack results in one RefreshSeries per affected series, not per file.
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
        trigger_text = str(trigger or "")

        if trigger_text.startswith(BATCH_CHILD_PREFIX):
            if apply and job.get("status") == "completed":
                try:
                    parent_run_id = int(trigger_text[len(BATCH_CHILD_PREFIX):])
                except ValueError:
                    return
                _schedule_batch_refresh(parent_run_id)
            return

        if library == "tv" and apply and run_id and job.get("status") == "completed":
            await refresh_sonarr_after_run(int(run_id))

    ScanManager._run = run_with_sonarr_refresh


@router.get("/test")
async def test_sonarr():
    return await _sonarr_client().test()

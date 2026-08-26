from __future__ import annotations

import json
import os
import stat
import tempfile
from pathlib import Path

from fastapi import APIRouter

from .db import connection, utcnow
from .scanner import ScanManager
from .services.radarr import RadarrClient
from .settings import get_setting

router = APIRouter(prefix="/api/integrations/radarr", tags=["radarr"])

WRITE_ACTIONS = {"CREATED", "REPLACED_IDENTICAL", "REPLACED_CHANGED"}
_INSTALLED = False


def _radarr_client() -> RadarrClient:
    base_url = get_setting("radarr_base_url", get_setting("radarr_url", ""))
    api_key = get_setting("radarr_api_key", "")
    return RadarrClient(base_url, api_key)


def _reference_for_target(target: Path) -> Path:
    """Find a sibling media file whose ownership/mode should be inherited."""
    try:
        mkvs = sorted(
            [p for p in target.parent.iterdir() if p.is_file() and p.suffix.lower() == ".mkv"],
            key=lambda p: p.name.casefold(),
        )
    except OSError:
        mkvs = []

    target_stem = target.stem.casefold()
    for media in mkvs:
        if media.stem.casefold() == target_stem:
            return media
    if mkvs:
        return mkvs[0]
    return target.parent


def _atomic_write_owned(target: Path, raw: bytes) -> None:
    """Atomically write an NFO while inheriting media ownership and permissions.

    SceneNFO's container commonly runs as root on Unraid. tempfile.mkstemp would
    therefore otherwise create root:root 0600 files, which Radarr may not be able
    to consume. The finished NFO inherits uid/gid and non-executable permission
    bits from a sibling MKV (or the media directory as a fallback).
    """
    target.parent.mkdir(parents=True, exist_ok=True)
    reference = _reference_for_target(target)
    ref_stat = reference.stat()
    mode = stat.S_IMODE(ref_stat.st_mode) & 0o666
    if mode == 0:
        mode = 0o664

    fd, tmp = tempfile.mkstemp(prefix=".scenenfo-", suffix=".tmp", dir=target.parent)
    try:
        with os.fdopen(fd, "wb") as fh:
            fh.write(raw)
            fh.flush()
            os.fsync(fh.fileno())
            try:
                os.fchown(fh.fileno(), ref_stat.st_uid, ref_stat.st_gid)
            except (AttributeError, PermissionError):
                # Rootless containers may be unable to chown. In the regular
                # Unraid image this succeeds and prevents root-owned NFO files.
                pass
            os.fchmod(fh.fileno(), mode)
        os.replace(tmp, target)
    finally:
        if os.path.exists(tmp):
            os.unlink(tmp)


def _record_refresh_event(run_id: int, level: str, message: str, payload: dict) -> None:
    event = {"type": "radarr_refresh", "message": message, **payload}
    with connection() as conn:
        conn.execute(
            "INSERT INTO run_events(run_id,ts,level,event,message,payload) VALUES(?,?,?,?,?,?)",
            (
                run_id,
                utcnow(),
                level,
                "radarr_refresh",
                message,
                json.dumps(event, ensure_ascii=False),
            ),
        )


def _changed_movie_folders(run_id: int) -> set[str]:
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
            folders.add(str(Path(media_path).parent))
    return folders


async def _refresh_radarr_after_run(run_id: int) -> None:
    if get_setting("radarr_refresh_after_apply", "true").lower() != "true":
        return

    folders = _changed_movie_folders(run_id)
    if not folders:
        return

    client = _radarr_client()
    if not client.configured:
        _record_refresh_event(
            run_id,
            "WARNING",
            "Radarr refresh skipped: Radarr URL or API key is not configured",
            {"folders": sorted(folders), "refreshed": 0},
        )
        return

    try:
        movie_ids, unmatched = await client.movie_ids_for_folders(folders)
        if not movie_ids:
            _record_refresh_event(
                run_id,
                "WARNING",
                "Radarr refresh skipped: no affected movie could be matched in Radarr",
                {"folders": sorted(folders), "unmatched": unmatched, "refreshed": 0},
            )
            return

        result = await client.refresh_movie_ids(movie_ids)
        _record_refresh_event(
            run_id,
            "INFO",
            f"Queued Radarr refresh for {len(movie_ids)} affected movie(s)",
            {
                "movie_ids": movie_ids,
                "unmatched": unmatched,
                "command_id": result.get("command_id"),
                "refreshed": len(movie_ids),
            },
        )
    except Exception as exc:
        _record_refresh_event(
            run_id,
            "WARNING",
            f"Radarr refresh failed: {exc}",
            {"folders": sorted(folders), "refreshed": 0},
        )


def install_radarr_integration() -> None:
    global _INSTALLED
    if _INSTALLED:
        return
    _INSTALLED = True

    # Fix ownership/permissions for every scanner NFO write.
    ScanManager._atomic_write = staticmethod(_atomic_write_owned)

    # Run Radarr refresh only after a completed Movies Apply run. This also
    # covers review-apply runs because they use the same ScanManager.
    original_run = ScanManager._run

    async def run_with_radarr_refresh(
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
        if (
            library == "movies"
            and apply
            and run_id
            and job.get("status") == "completed"
        ):
            await _refresh_radarr_after_run(int(run_id))

    ScanManager._run = run_with_radarr_refresh


@router.get("/test")
async def test_radarr():
    return await _radarr_client().test()

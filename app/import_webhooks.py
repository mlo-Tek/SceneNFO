from __future__ import annotations

import asyncio
import json
import os
import time
from pathlib import Path
from uuid import uuid4

from fastapi import APIRouter, Request

from .db import connection, fetchall, utcnow
from .scanner import scan_manager
from .settings import get_setting

router = APIRouter(prefix="/api")


def _enabled(key: str, default: str = "true") -> bool:
    return get_setting(key, default).strip().lower() == "true"


def _int_setting(key: str, default: int, minimum: int, maximum: int) -> int:
    try:
        value = int(get_setting(key, str(default)))
    except (TypeError, ValueError):
        value = default
    return min(max(value, minimum), maximum)


def _match_library(kind: str, path: str | Path | None) -> dict | None:
    if not path:
        return None
    candidate = str(path).rstrip("/")
    libraries = fetchall(
        "SELECT * FROM libraries WHERE kind=? AND enabled=1 ORDER BY length(path) DESC,id",
        (kind,),
    )
    for library in libraries:
        root = str(library["path"]).rstrip("/")
        if candidate == root or candidate.startswith(root + "/"):
            return library
    return None


def _append_path(result: list[Path], seen: set[str], value: object) -> None:
    if not isinstance(value, str) or not value.strip():
        return
    path = Path(value.strip())
    key = str(path)
    if key not in seen:
        seen.add(key)
        result.append(path)


def _file_objects(payload: dict, kind: str) -> list[dict]:
    keys = ("movieFile", "movieFiles") if kind == "movies" else ("episodeFile", "episodeFiles")
    result: list[dict] = []
    for key in keys:
        value = payload.get(key)
        if isinstance(value, dict):
            result.append(value)
        elif isinstance(value, list):
            result.extend(item for item in value if isinstance(item, dict))
    return result


def _affected_roots(payload: dict, kind: str) -> list[Path]:
    result: list[Path] = []
    seen: set[str] = set()
    parent = payload.get("movie") if kind == "movies" else payload.get("series")
    if isinstance(parent, dict):
        for key in ("folderPath", "path"):
            _append_path(result, seen, parent.get(key))
    return result


def _payload_media_paths(payload: dict, kind: str) -> list[Path]:
    result: list[Path] = []
    seen: set[str] = set()
    roots = _affected_roots(payload, kind)
    root = roots[0] if roots else None

    for item in _file_objects(payload, kind):
        _append_path(result, seen, item.get("path"))
        relative = item.get("relativePath")
        if root and isinstance(relative, str) and relative.strip():
            _append_path(result, seen, str(root / relative.strip()))

    # Accept common direct-path fields used by custom scripts / older payloads.
    for key in ("filePath", "importedPath", "destinationPath"):
        _append_path(result, seen, payload.get(key))

    return result


def _usable_exact_files(paths: list[Path], kind: str) -> list[tuple[Path, dict]]:
    result: list[tuple[Path, dict]] = []
    seen: set[str] = set()
    for path in paths:
        try:
            if not path.is_file() or path.suffix.lower() != ".mkv":
                continue
        except OSError:
            continue
        library = _match_library(kind, path)
        if not library:
            continue
        key = str(path)
        if key in seen:
            continue
        seen.add(key)
        result.append((path, library))
    return result


def _recent_files(payload: dict, kind: str) -> list[tuple[Path, dict]]:
    minutes = _int_setting("import_fallback_window_minutes", 10, 1, 120)
    max_files = _int_setting("import_fallback_max_files", 5, 1, 50)
    cutoff = time.time() - minutes * 60
    found: list[tuple[float, Path, dict]] = []
    seen: set[str] = set()

    for root in _affected_roots(payload, kind):
        library = _match_library(kind, root)
        if not library or not root.exists():
            continue
        try:
            for dirpath, _, filenames in os.walk(root):
                for name in filenames:
                    if not name.lower().endswith(".mkv"):
                        continue
                    path = Path(dirpath) / name
                    key = str(path)
                    if key in seen:
                        continue
                    try:
                        mtime = path.stat().st_mtime
                    except OSError:
                        continue
                    if mtime < cutoff:
                        continue
                    seen.add(key)
                    found.append((mtime, path, library))
        except OSError:
            continue

    found.sort(key=lambda row: row[0], reverse=True)
    return [(path, library) for _, path, library in found[:max_files]]


def _event_allowed(payload: dict) -> tuple[bool, str]:
    event_type = str(payload.get("eventType") or "").strip()
    if not event_type:
        # Custom scripts may omit eventType; a valid imported file is enough.
        return True, ""
    if event_type.lower() == "download":
        return True, event_type
    return False, event_type


def _automation_options() -> tuple[bool, str]:
    apply_changes = _enabled("import_apply", "false")
    nfo_policy = get_setting("import_nfo_policy", "replace_all").strip().lower()
    if nfo_policy not in {"replace_all", "missing_only"}:
        nfo_policy = "replace_all"
    return apply_changes, nfo_policy


def _insert_parent_event(run_id: int, event: str, message: str, payload: dict, level: str = "INFO") -> None:
    with connection() as conn:
        conn.execute(
            "INSERT INTO run_events(run_id,ts,level,event,message,payload) VALUES(?,?,?,?,?,?)",
            (run_id, utcnow(), level, event, message, json.dumps(payload, ensure_ascii=False)),
        )


def _create_parent_run(library: dict, trigger: str, apply_changes: bool, nfo_policy: str, files: list[str], subject: str) -> int:
    mode = "apply" if apply_changes else "dry-run"
    with connection() as conn:
        cur = conn.execute(
            """
            INSERT INTO runs(
                kind,library,library_id,library_name,nfo_policy,scan_scope,
                mode,trigger,status,started_at
            ) VALUES('scan','tv',?,?,?,?,?,?, 'running',?)
            """,
            (
                int(library["id"]),
                str(library["name"]),
                nfo_policy,
                "incremental",
                mode,
                trigger,
                utcnow(),
            ),
        )
        run_id = int(cur.lastrowid)
    _insert_parent_event(
        run_id,
        "start",
        f"Sonarr batch: {len(files)} file(s) for {subject}",
        {
            "type": "start",
            "batch": True,
            "source": "sonarr",
            "trigger": trigger,
            "library_id": int(library["id"]),
            "library_name": str(library["name"]),
            "subject": subject,
            "files": files,
            "count": len(files),
            "mode": mode,
            "nfo_policy": nfo_policy,
            "scan_scope": "incremental",
        },
    )
    return run_id


async def _consolidate_batch(parent_run_id: int, child_job_ids: list[str], files: list[str]) -> None:
    deadline = asyncio.get_running_loop().time() + 7200
    while True:
        states = [scan_manager.jobs.get(job_id, {}).get("status") for job_id in child_job_ids]
        if states and all(state in {"completed", "fatal", "cancelled"} for state in states):
            break
        if asyncio.get_running_loop().time() >= deadline:
            with connection() as conn:
                conn.execute(
                    "UPDATE runs SET status='failed',finished_at=?,errors=errors+1 WHERE id=?",
                    (utcnow(), parent_run_id),
                )
            _insert_parent_event(
                parent_run_id,
                "fatal",
                "Sonarr batch timed out while waiting for child scans",
                {"type": "fatal", "batch": True, "files": files},
                "ERROR",
            )
            return
        await asyncio.sleep(0.5)

    child_run_ids = [
        int(scan_manager.jobs[job_id]["run_id"])
        for job_id in child_job_ids
        if scan_manager.jobs.get(job_id, {}).get("run_id") is not None
    ]
    if not child_run_ids:
        with connection() as conn:
            conn.execute(
                "UPDATE runs SET status='failed',finished_at=?,errors=errors+1 WHERE id=?",
                (utcnow(), parent_run_id),
            )
        return

    placeholders = ",".join("?" for _ in child_run_ids)
    with connection() as conn:
        children = conn.execute(
            f"""
            SELECT id,status,scanned,scene,p2p,created,replaced,errors,skipped,removed
            FROM runs WHERE id IN ({placeholders}) ORDER BY id
            """,
            child_run_ids,
        ).fetchall()

        totals = {
            key: sum(int(row[key] or 0) for row in children)
            for key in ("scanned", "scene", "p2p", "created", "replaced", "errors", "skipped", "removed")
        }
        child_statuses = {str(row["status"]) for row in children}
        if "failed" in child_statuses:
            status = "failed"
        elif "cancelled" in child_statuses:
            status = "cancelled"
        else:
            status = "completed"

        events = conn.execute(
            f"""
            SELECT ts,level,event,message,payload
            FROM run_events
            WHERE run_id IN ({placeholders}) AND event IN ('item','item_error')
            ORDER BY ts,id
            """,
            child_run_ids,
        ).fetchall()
        for row in events:
            conn.execute(
                "INSERT INTO run_events(run_id,ts,level,event,message,payload) VALUES(?,?,?,?,?,?)",
                (parent_run_id, row["ts"], row["level"], row["event"], row["message"], row["payload"]),
            )

        conn.execute(
            """
            UPDATE runs SET status=?,finished_at=?,scanned=?,scene=?,p2p=?,created=?,replaced=?,
                errors=?,skipped=?,removed=? WHERE id=?
            """,
            (
                status,
                utcnow(),
                totals["scanned"],
                totals["scene"],
                totals["p2p"],
                totals["created"],
                totals["replaced"],
                totals["errors"],
                totals["skipped"],
                totals["removed"],
                parent_run_id,
            ),
        )

        # Child runs are implementation details. After consolidation only the
        # single human-readable Sonarr batch remains in History/Logs.
        conn.executemany("DELETE FROM runs WHERE id=?", [(run_id,) for run_id in child_run_ids])

    _insert_parent_event(
        parent_run_id,
        "complete" if status == "completed" else status,
        f"Sonarr batch complete: {totals['scanned']} processed from {len(files)} queued file(s)",
        {
            "type": "complete" if status == "completed" else status,
            "batch": True,
            "files": files,
            **totals,
        },
        "INFO" if status == "completed" else "WARNING",
    )


class SonarrImportBatcher:
    """Debounce Sonarr imports per series and consolidate them into one run."""

    def __init__(self) -> None:
        self._pending: dict[str, dict] = {}

    @staticmethod
    def _subject(payload: dict, library: dict) -> tuple[str, str]:
        series = payload.get("series") or {}
        series_id = str(series.get("id") or "").strip()
        series_path = str(series.get("path") or "").strip()
        title = str(series.get("title") or series.get("titleSlug") or Path(series_path).name or "TV import").strip()
        identity = series_id or series_path or title
        return f"{library['id']}:{identity}", title

    async def enqueue(
        self,
        payload: dict,
        targets: list[tuple[Path, dict]],
        trigger: str,
        apply_changes: bool,
        nfo_policy: str,
        fallback_used: bool,
    ) -> dict:
        debounce = _int_setting("sonarr_import_debounce_seconds", 30, 5, 300)
        grouped: dict[int, list[tuple[Path, dict]]] = {}
        for media, library in targets:
            grouped.setdefault(int(library["id"]), []).append((media, library))

        batches = []
        for _, rows in grouped.items():
            library = rows[0][1]
            subject_key, subject_title = self._subject(payload, library)
            key = f"{subject_key}:{trigger}:{int(apply_changes)}:{nfo_policy}"
            state = self._pending.get(key)
            if state is None:
                state = {
                    "batch_id": uuid4().hex,
                    "library": library,
                    "subject": subject_title,
                    "trigger": trigger,
                    "apply": apply_changes,
                    "nfo_policy": nfo_policy,
                    "files": {},
                    "fallback_used": False,
                    "task": None,
                }
                self._pending[key] = state

            for media, _ in rows:
                state["files"][str(media)] = str(media)
            state["fallback_used"] = bool(state["fallback_used"] or fallback_used)

            old_task = state.get("task")
            if old_task and not old_task.done():
                old_task.cancel()
            state["task"] = asyncio.create_task(self._flush_after(key, debounce))

            batches.append(
                {
                    "batch_id": state["batch_id"],
                    "subject": state["subject"],
                    "library": str(library["name"]),
                    "queued_files": len(state["files"]),
                    "debounce_seconds": debounce,
                }
            )

        return {
            "accepted": True,
            "queued": True,
            "source": "sonarr",
            "trigger": trigger,
            "mode": "apply" if apply_changes else "dry-run",
            "nfo_policy": nfo_policy,
            "fallback_used": fallback_used,
            "batches": batches,
        }

    async def _flush_after(self, key: str, debounce: int) -> None:
        try:
            await asyncio.sleep(debounce)
        except asyncio.CancelledError:
            return

        state = self._pending.pop(key, None)
        if not state:
            return

        files = list(state["files"].values())
        library = state["library"]
        parent_run_id = _create_parent_run(
            library,
            state["trigger"] + "-batch",
            bool(state["apply"]),
            str(state["nfo_policy"]),
            files,
            str(state["subject"]),
        )
        _insert_parent_event(
            parent_run_id,
            "inventory",
            f"Batch window closed after {debounce}s; {len(files)} unique MKV(s) queued",
            {
                "type": "inventory",
                "batch": True,
                "debounce_seconds": debounce,
                "discovered": len(files),
                "queued": len(files),
                "skipped": 0,
                "removed": 0,
                "files": files,
            },
        )

        child_jobs = []
        for media in files:
            child_jobs.append(
                scan_manager.create(
                    "tv",
                    media,
                    f"__sonarr_batch_child__:{parent_run_id}",
                    bool(state["apply"]),
                    str(state["nfo_policy"]),
                    int(library["id"]),
                    str(library["name"]),
                    "incremental",
                )
            )
        asyncio.create_task(_consolidate_batch(parent_run_id, child_jobs, files))


sonarr_batcher = SonarrImportBatcher()


async def _handle_import(payload: dict, kind: str, source: str) -> dict:
    enabled_key = "radarr_webhook_enabled" if source == "radarr" else "sonarr_webhook_enabled"
    if not _enabled(enabled_key):
        return {"accepted": False, "reason": "disabled"}

    allowed, event_type = _event_allowed(payload)
    if not allowed:
        return {"accepted": False, "reason": f"ignored eventType {event_type or 'unknown'}"}

    exact = _usable_exact_files(_payload_media_paths(payload, kind), kind)
    fallback_used = False
    targets = exact
    if not targets:
        targets = _recent_files(payload, kind)
        fallback_used = bool(targets)

    if not targets:
        return {
            "accepted": False,
            "reason": "no imported MKV found in a configured library",
            "event_type": event_type or None,
        }

    apply_changes, nfo_policy = _automation_options()
    is_upgrade = bool(payload.get("isUpgrade"))
    trigger = f"{source}-upgrade" if is_upgrade else f"{source}-import"

    if source == "sonarr":
        result = await sonarr_batcher.enqueue(
            payload,
            targets,
            trigger,
            apply_changes,
            nfo_policy,
            fallback_used,
        )
        result["event_type"] = event_type or None
        return result

    # Radarr normally imports one movie at a time, so it can run immediately.
    jobs = []
    files = []
    for media, library in targets:
        job_id = scan_manager.create(
            kind,
            str(media),
            trigger,
            apply_changes,
            nfo_policy,
            int(library["id"]),
            str(library["name"]),
            "incremental",
        )
        jobs.append(job_id)
        files.append(str(media))

    return {
        "accepted": True,
        "jobs": jobs,
        "files": files,
        "count": len(files),
        "trigger": trigger,
        "mode": "apply" if apply_changes else "dry-run",
        "nfo_policy": nfo_policy,
        "fallback_used": fallback_used,
        "event_type": event_type or None,
    }


@router.post("/webhooks/radarr")
async def targeted_radarr_webhook(request: Request):
    payload = await request.json()
    return await _handle_import(payload, "movies", "radarr")


@router.post("/webhooks/sonarr")
async def targeted_sonarr_webhook(request: Request):
    payload = await request.json()
    return await _handle_import(payload, "tv", "sonarr")

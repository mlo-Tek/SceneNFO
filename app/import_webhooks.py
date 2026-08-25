from __future__ import annotations

import os
import time
from pathlib import Path

from fastapi import APIRouter, Request

from .db import fetchall
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

    apply_changes = _enabled("import_apply", "false")
    nfo_policy = get_setting("import_nfo_policy", "replace_all").strip().lower()
    if nfo_policy not in {"replace_all", "missing_only"}:
        nfo_policy = "replace_all"

    is_upgrade = bool(payload.get("isUpgrade"))
    trigger = f"{source}-upgrade" if is_upgrade else f"{source}-import"
    jobs = []
    files = []

    # One exact media file = one tiny SceneNFO run. This keeps history/logs precise
    # and avoids ever walking the complete Radarr/Sonarr library for an import.
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

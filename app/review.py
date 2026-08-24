from __future__ import annotations

import json
from pathlib import Path

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel

from .db import fetchall, fetchone
from .scanner import scan_manager

router = APIRouter(prefix="/api")

WRITE_ACTIONS = {"WOULD_CREATE", "WOULD_REPLACE"}


class ReviewApplyBody(BaseModel):
    media_paths: list[str] = []
    apply_all: bool = False


def _run_or_404(run_id: int) -> dict:
    run = fetchone("SELECT * FROM runs WHERE id=?", (run_id,))
    if not run:
        raise HTTPException(404, "run not found")
    return run


def _candidate_rows(run_id: int) -> list[dict]:
    rows = fetchall(
        "SELECT id,payload FROM run_events WHERE run_id=? AND event='item' ORDER BY id",
        (run_id,),
    )
    candidates: list[dict] = []
    seen: set[str] = set()
    for row in rows:
        try:
            payload = json.loads(row.get("payload") or "{}")
        except json.JSONDecodeError:
            continue
        media_path = str(payload.get("media_path") or "")
        action = str(payload.get("action") or "")
        if not media_path or action not in WRITE_ACTIONS or media_path in seen:
            continue
        seen.add(media_path)
        candidates.append(
            {
                "event_id": row["id"],
                "media_path": media_path,
                "title": payload.get("title") or Path(media_path).parent.name,
                "release": payload.get("release") or Path(media_path).stem,
                "classification": payload.get("classification"),
                "group": payload.get("group"),
                "predb_id": payload.get("predb_id"),
                "action": action,
                "nfo_source": payload.get("nfo_source"),
                "source_status": payload.get("source_status") or {},
                "target": payload.get("target"),
                "nfo_present": bool(payload.get("nfo_present")),
            }
        )
    return candidates


def _inside(path: Path, root: Path) -> bool:
    try:
        path.relative_to(root)
        return True
    except ValueError:
        return path == root


@router.get("/history/{run_id}/candidates")
def review_candidates(run_id: int):
    run = _run_or_404(run_id)
    return {
        "run": run,
        "candidates": _candidate_rows(run_id),
    }


@router.post("/history/{run_id}/apply")
def apply_review_candidates(run_id: int, body: ReviewApplyBody):
    run = _run_or_404(run_id)
    if run.get("mode") != "dry-run":
        raise HTTPException(409, "only dry-run results can be reviewed for apply")

    candidates = _candidate_rows(run_id)
    by_path = {row["media_path"]: row for row in candidates}
    if not by_path:
        raise HTTPException(409, "run has no NFO write candidates")

    if body.apply_all:
        requested = list(by_path)
    else:
        requested = list(dict.fromkeys(str(x) for x in body.media_paths if str(x)))
        if not requested:
            raise HTTPException(400, "select at least one candidate")
        unknown = [path for path in requested if path not in by_path]
        if unknown:
            raise HTTPException(400, "one or more selected files are not candidates from this run")

    if len(requested) > 500:
        raise HTTPException(400, "at most 500 candidates can be applied at once")

    library_id = run.get("library_id")
    library = None
    if library_id is not None:
        library = fetchone("SELECT * FROM libraries WHERE id=?", (library_id,))
    if not library:
        raise HTTPException(409, "source run is not attached to a configured library")

    root = Path(library["path"])
    jobs = []
    missing = []
    for media_path in requested:
        media = Path(media_path)
        if not _inside(media, root):
            raise HTTPException(400, f"candidate is outside configured library: {media_path}")
        if not media.is_file():
            missing.append(media_path)
            continue
        job_id = scan_manager.create(
            run["library"],
            media_path,
            f"review-apply:{run_id}",
            True,
            run.get("nfo_policy") or "replace_all",
            library["id"],
            library["name"],
            "full",
        )
        jobs.append(
            {
                "job_id": job_id,
                "media_path": media_path,
                "title": by_path[media_path]["title"],
                "release": by_path[media_path]["release"],
            }
        )

    if not jobs and missing:
        raise HTTPException(409, "selected media files no longer exist")

    return {
        "source_run_id": run_id,
        "requested": len(requested),
        "started": len(jobs),
        "missing": missing,
        "jobs": jobs,
    }

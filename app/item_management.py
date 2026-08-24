from __future__ import annotations

from pathlib import Path

import httpx
from fastapi import APIRouter, HTTPException
from fastapi.responses import FileResponse, Response
from pydantic import BaseModel

from .db import connection, fetchone, utcnow
from .scanner import GENERIC_NFOS, scan_manager
from .services.crowdnfo import CrowdNFOClient
from .services.predb import PreDBClient
from .services.srrdb import SRRDBClient
from .settings import get_setting

router = APIRouter(prefix="/api")


class ItemNFOActionBody(BaseModel):
    nfo_policy: str = "replace_all"


class DeleteNFOBody(BaseModel):
    names: list[str] = []
    delete_all_managed: bool = False


def _item_or_404(item_id: int) -> dict:
    item = fetchone(
        """
        SELECT li.*,l.name AS configured_library,l.path AS library_path,l.kind AS library_kind
        FROM library_items li
        LEFT JOIN libraries l ON l.id=li.library_id
        WHERE li.id=?
        """,
        (item_id,),
    )
    if not item:
        raise HTTPException(404, "library item not found")
    return item


def _inside(path: Path, root: Path) -> bool:
    try:
        path.relative_to(root)
        return True
    except ValueError:
        return path == root


def _media_or_409(item: dict) -> Path:
    media = Path(item["media_path"])
    if not media.is_file():
        raise HTTPException(409, "media file no longer exists")
    library_path = item.get("library_path")
    if library_path and not _inside(media, Path(library_path)):
        raise HTTPException(409, "media file is outside the configured library")
    return media


def _managed_nfos(item: dict, media: Path) -> list[Path]:
    if item.get("classification") != "scene" or not item.get("release_group"):
        return []
    return scan_manager._replace_candidates(
        media,
        item["release_name"],
        item["release_group"],
        [],
        item.get("library") or item.get("library_kind") or "movies",
    )


def _nfo_entries(item: dict, media: Path) -> list[dict]:
    managed = {str(p) for p in _managed_nfos(item, media)}
    recorded = str(item.get("nfo_path") or "")
    entries = []
    for nfo in scan_manager._all_nfos(media.parent):
        generic = nfo.name.casefold() in GENERIC_NFOS
        entries.append(
            {
                "name": nfo.name,
                "path": str(nfo),
                "size": nfo.stat().st_size,
                "generic": generic,
                "managed": str(nfo) in managed and not generic,
                "recorded": str(nfo) == recorded,
            }
        )
    return entries


def _named_nfo(item: dict, media: Path, name: str) -> Path:
    if not name or Path(name).name != name or Path(name).suffix.lower() != ".nfo":
        raise HTTPException(400, "invalid NFO filename")
    target = media.parent / name
    if not target.is_file():
        raise HTTPException(404, "NFO file not found")
    return target


def _source_label(source: str) -> str:
    return {
        "srrdb": "srrDB",
        "predb": "PreDB.club",
        "crowdnfo": "crowdNFO",
    }.get(source, source)


async def _fresh_nfo(item: dict) -> tuple[bytes, str, str]:
    release = item["release_name"]
    predb = PreDBClient(get_setting("predb_base_url", "https://predb.club"))
    pre = await predb.exact_release(release)
    if not pre:
        raise HTTPException(409, "release is not an exact Scene match in PreDB.club")

    pre_id = pre.get("id")
    if not pre_id:
        raise HTTPException(409, "PreDB match has no release id")

    srrdb = SRRDBClient(get_setting("srrdb_base_url", "https://api.srrdb.com"))
    crowd = CrowdNFOClient(
        get_setting("crowdnfo_base_url", "https://crowdnfo.net"),
        get_setting("crowdnfo_api_key", ""),
    )
    priority = [
        x.strip().lower()
        for x in get_setting("source_priority", "srrdb,predb,crowdnfo").split(",")
        if x.strip()
    ]

    candidates: dict[str, dict | None] = {}
    try:
        candidates["srrdb"] = await srrdb.nfo(release)
    except Exception:
        candidates["srrdb"] = None
    try:
        candidates["predb"] = await predb.nfo(int(pre_id))
    except Exception:
        candidates["predb"] = None
    try:
        candidates["crowdnfo"] = await crowd.nfo(release)
    except Exception:
        candidates["crowdnfo"] = None

    selected_source = None
    selected = None
    for source in priority:
        if candidates.get(source):
            selected_source = source
            selected = candidates[source]
            break
    if not selected_source or not selected or not selected.get("url"):
        raise HTTPException(404, "no NFO source found for this Scene release")

    headers = {"User-Agent": "SceneNFO/0.3"}
    if selected_source == "crowdnfo" and crowd.api_key:
        headers["X-Api-Key"] = crowd.api_key
    async with httpx.AsyncClient(timeout=30, follow_redirects=True) as client:
        response = await client.get(selected["url"], headers=headers)
        response.raise_for_status()
        raw = response.content
    scan_manager._validate_nfo(raw)
    filename = Path(selected.get("filename") or f"{release}.nfo").name
    return raw, filename, selected_source


@router.get("/items/{item_id}")
def item_details(item_id: int):
    item = _item_or_404(item_id)
    media = Path(item["media_path"])
    exists = media.is_file()
    nfos = _nfo_entries(item, media) if exists else []
    return {
        **item,
        "media_exists": exists,
        "nfos": nfos,
        "managed_nfo_count": sum(1 for nfo in nfos if nfo["managed"]),
    }


@router.post("/items/{item_id}/recheck")
async def recheck_item(item_id: int, body: ItemNFOActionBody):
    item = _item_or_404(item_id)
    media = _media_or_409(item)
    if body.nfo_policy not in {"replace_all", "missing_only"}:
        raise HTTPException(400, "invalid nfo_policy")
    if item.get("library_id") is None:
        raise HTTPException(409, "item is not attached to a configured library")

    job_id = scan_manager.create(
        item["library"],
        str(media),
        f"library-item-check:{item_id}",
        False,
        body.nfo_policy,
        item["library_id"],
        item.get("configured_library") or item["library"],
        "full",
    )
    return {"job_id": job_id, "item_id": item_id}


@router.post("/items/{item_id}/nfo/fetch")
async def fetch_item_nfo(item_id: int, body: ItemNFOActionBody):
    item = _item_or_404(item_id)
    media = _media_or_409(item)
    if body.nfo_policy not in {"replace_all", "missing_only"}:
        raise HTTPException(400, "invalid nfo_policy")
    if item.get("classification") != "scene":
        raise HTTPException(409, "NFO writes are only enabled for verified Scene items")
    if item.get("library_id") is None:
        raise HTTPException(409, "item is not attached to a configured library")

    job_id = scan_manager.create(
        item["library"],
        str(media),
        f"library-item-apply:{item_id}",
        True,
        body.nfo_policy,
        item["library_id"],
        item.get("configured_library") or item["library"],
        "full",
    )
    return {"job_id": job_id, "item_id": item_id}


@router.get("/items/{item_id}/nfo/source-download")
async def download_fresh_source_nfo(item_id: int):
    item = _item_or_404(item_id)
    _media_or_409(item)
    raw, filename, source = await _fresh_nfo(item)

    # This endpoint only sends a copy to the browser; it never writes into the
    # media folder. Persist that fact separately from nfo_source so the library
    # can show where the browser copy came from without implying it is installed.
    downloaded_at = utcnow()
    with connection() as conn:
        conn.execute(
            """
            UPDATE library_items
            SET browser_nfo_source=?,browser_nfo_downloaded_at=?
            WHERE id=?
            """,
            (source, downloaded_at, item_id),
        )

    headers = {
        "Content-Disposition": f'attachment; filename="{filename}"',
        "X-SceneNFO-Source": source,
        "X-SceneNFO-Source-Label": _source_label(source),
        "X-SceneNFO-Storage": "browser-only",
    }
    return Response(content=raw, media_type="text/plain; charset=windows-1252", headers=headers)


@router.get("/items/{item_id}/nfo/download")
def download_current_nfo(item_id: int, name: str):
    item = _item_or_404(item_id)
    media = _media_or_409(item)
    target = _named_nfo(item, media, name)
    return FileResponse(target, media_type="text/plain", filename=target.name)


@router.post("/items/{item_id}/nfo/delete")
def delete_current_nfo(item_id: int, body: DeleteNFOBody):
    item = _item_or_404(item_id)
    media = _media_or_409(item)
    if item.get("classification") != "scene":
        raise HTTPException(409, "NFO deletion is only enabled for verified Scene items")

    managed = {p.name: p for p in _managed_nfos(item, media)}
    if body.delete_all_managed:
        requested = list(managed)
    else:
        requested = list(dict.fromkeys(Path(name).name for name in body.names if name))
    if not requested:
        raise HTTPException(400, "select at least one managed NFO")

    unsafe = [name for name in requested if name.casefold() in GENERIC_NFOS or name not in managed]
    if unsafe:
        raise HTTPException(400, "one or more requested NFOs are protected or not managed by SceneNFO")

    deleted = []
    for name in requested:
        target = managed[name]
        if target.is_file():
            target.unlink()
            deleted.append(name)

    remaining = scan_manager._all_nfos(media.parent)
    remaining_managed = _managed_nfos(item, media)
    with connection() as conn:
        conn.execute(
            """
            UPDATE library_items
            SET nfo_path=?,nfo_source=?,nfo_present=?,last_result=?,last_checked_at=?
            WHERE id=?
            """,
            (
                str(remaining_managed[0] if remaining_managed else remaining[0]) if remaining else None,
                item.get("nfo_source") if remaining_managed else None,
                int(bool(remaining)),
                "NFO_DELETED",
                utcnow(),
                item_id,
            ),
        )

    return {"item_id": item_id, "deleted": deleted, "remaining_nfos": len(remaining)}

from __future__ import annotations

from datetime import datetime, timezone
from pathlib import Path

from fastapi import APIRouter, HTTPException

from .db import fetchone

router = APIRouter(prefix="/api")


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


def _browser_root(item: dict, media: Path) -> Path:
    """Return the safe root shown by the web folder browser.

    Movies start in their movie folder. TV starts at the series folder, i.e.
    the first directory below the configured TV library root, so seasons can
    be browsed without exposing unrelated libraries or arbitrary host paths.
    """
    library_path = item.get("library_path")
    kind = item.get("library_kind") or item.get("library")

    if kind == "tv" and library_path:
        library_root = Path(library_path)
        try:
            relative = media.relative_to(library_root)
            if len(relative.parts) >= 2:
                candidate = library_root / relative.parts[0]
                if candidate.is_dir():
                    return candidate
        except ValueError:
            pass

    return media.parent


def _iso_mtime(path: Path) -> str | None:
    try:
        return datetime.fromtimestamp(path.stat().st_mtime, timezone.utc).isoformat()
    except OSError:
        return None


def _entry(path: Path, root: Path) -> dict:
    is_link = path.is_symlink()
    is_dir = path.is_dir() if not is_link else False
    try:
        size = path.stat().st_size if not is_dir else None
    except OSError:
        size = None

    try:
        relative = str(path.relative_to(root))
    except ValueError:
        relative = path.name

    return {
        "name": path.name,
        "relative_path": relative,
        "type": "symlink" if is_link else "directory" if is_dir else "file",
        "size": size,
        "modified_at": _iso_mtime(path),
        "extension": path.suffix.lower() if not is_dir else "",
        "navigable": bool(is_dir and not is_link),
    }


@router.get("/items/{item_id}/folder")
def item_folder(item_id: int, path: str = ""):
    item = _item_or_404(item_id)
    media = Path(item["media_path"])
    if not media.is_file():
        raise HTTPException(409, "media file no longer exists")

    root = _browser_root(item, media)
    if not root.is_dir():
        raise HTTPException(404, "media folder not found")

    root_resolved = root.resolve()
    relative = Path(path or ".")
    if relative.is_absolute() or ".." in relative.parts:
        raise HTTPException(400, "invalid folder path")

    target = (root_resolved / relative).resolve()
    if not _inside(target, root_resolved):
        raise HTTPException(403, "folder is outside the item browser root")
    if not target.is_dir():
        raise HTTPException(404, "folder not found")

    entries = []
    try:
        for child in target.iterdir():
            entries.append(_entry(child, root_resolved))
    except OSError as exc:
        raise HTTPException(500, f"unable to read media folder: {exc}") from exc

    entries.sort(key=lambda row: (row["type"] != "directory", row["name"].casefold()))
    current_relative = "" if target == root_resolved else str(target.relative_to(root_resolved))
    parent_relative = None
    if target != root_resolved:
        parent = target.parent
        parent_relative = "" if parent == root_resolved else str(parent.relative_to(root_resolved))

    return {
        "item_id": item_id,
        "kind": item.get("library_kind") or item.get("library"),
        "configured_library": item.get("configured_library"),
        "root": str(root_resolved),
        "path": current_relative,
        "parent_path": parent_relative,
        "media_path": str(media),
        "entries": entries,
        "count": len(entries),
    }

from __future__ import annotations

import re
from pathlib import Path

from .db import connection

SEASON_DIR_RE = re.compile(r"^season\s+\d+$", re.IGNORECASE)
_INSTALLED = False


def media_title(media: Path, library: str) -> str:
    """Return the user-facing library title for a media file."""
    parent = media.parent
    if library == "tv" and (SEASON_DIR_RE.match(parent.name) or parent.name.casefold() == "specials"):
        return parent.parent.name
    return parent.name


def _parts_casefold(path: Path) -> tuple[str, ...]:
    return tuple(part.casefold() for part in path.parts)


def path_in_root_casefold(path: Path, root: Path) -> bool:
    path_parts = _parts_casefold(path)
    root_parts = _parts_casefold(root)
    return len(path_parts) >= len(root_parts) and path_parts[: len(root_parts)] == root_parts


def resolve_case_insensitive(path: Path) -> Path | None:
    """Resolve an existing path even if one or more stored components changed case.

    Exact matches are preferred. A case-insensitive component is accepted only
    when it resolves to exactly one directory entry, so ambiguous Linux paths
    that differ only by case are never guessed.
    """
    path = Path(path)
    if path.exists():
        return path

    if path.is_absolute():
        current = Path(path.anchor)
        parts = path.parts[1:]
    else:
        current = Path.cwd()
        parts = path.parts

    for part in parts:
        exact = current / part
        if exact.exists():
            current = exact
            continue
        if not current.is_dir():
            return None
        try:
            matches = [child for child in current.iterdir() if child.name.casefold() == part.casefold()]
        except OSError:
            return None
        if len(matches) != 1:
            return None
        current = matches[0]

    return current if current.exists() else None


def _corrected_nfo_path(old_media: Path, new_media: Path, nfo_path: str | None) -> str | None:
    if not nfo_path:
        return nfo_path
    nfo = Path(nfo_path)
    if _parts_casefold(nfo.parent) == _parts_casefold(old_media.parent):
        return str(new_media.parent / nfo.name)
    return nfo_path


def _repair_values(item: dict) -> tuple[Path | None, str | None, str]:
    old_media = Path(item["media_path"])
    media = old_media if old_media.is_file() else resolve_case_insensitive(old_media)
    if media is None or not media.is_file():
        return None, item.get("nfo_path"), item.get("title") or ""

    library_path = item.get("library_path")
    if library_path:
        root = resolve_case_insensitive(Path(library_path)) or Path(library_path)
        if not path_in_root_casefold(media, root):
            return None, item.get("nfo_path"), item.get("title") or ""

    library = item.get("library_kind") or item.get("library") or "movies"
    title = media_title(media, library)
    nfo_path = _corrected_nfo_path(old_media, media, item.get("nfo_path"))
    return media, nfo_path, title


def repair_item_media_path(item: dict) -> Path | None:
    """Resolve a library item's media file and persist corrected casing/title."""
    media, nfo_path, title = _repair_values(item)
    if media is None:
        return None

    changed = (
        str(media) != str(item.get("media_path") or "")
        or nfo_path != item.get("nfo_path")
        or title != (item.get("title") or "")
    )
    if changed and item.get("id") is not None:
        with connection() as conn:
            conflict = conn.execute(
                "SELECT id FROM library_items WHERE media_path=? AND id<>?",
                (str(media), item["id"]),
            ).fetchone()
            if conflict is None:
                conn.execute(
                    "UPDATE library_items SET media_path=?,nfo_path=?,title=? WHERE id=?",
                    (str(media), nfo_path, title, item["id"]),
                )
                item["media_path"] = str(media)
                item["nfo_path"] = nfo_path
                item["title"] = title
    return media


def repair_saved_library_items() -> int:
    """Repair persisted path casing and TV titles on startup without rescanning."""
    repaired = 0
    with connection() as conn:
        rows = [
            dict(row)
            for row in conn.execute(
                """
                SELECT li.*,l.path AS library_path,l.kind AS library_kind
                FROM library_items li
                LEFT JOIN libraries l ON l.id=li.library_id
                """
            ).fetchall()
        ]

        for item in rows:
            media, nfo_path, title = _repair_values(item)
            if media is None:
                continue
            changed = (
                str(media) != str(item.get("media_path") or "")
                or nfo_path != item.get("nfo_path")
                or title != (item.get("title") or "")
            )
            if not changed:
                continue
            conflict = conn.execute(
                "SELECT id FROM library_items WHERE media_path=? AND id<>?",
                (str(media), item["id"]),
            ).fetchone()
            if conflict is not None:
                continue
            conn.execute(
                "UPDATE library_items SET media_path=?,nfo_path=?,title=? WHERE id=?",
                (str(media), nfo_path, title, item["id"]),
            )
            repaired += 1
    return repaired


def install_scanner_path_repair() -> None:
    """Make incremental scans preserve rows when only path casing changed."""
    global _INSTALLED
    if _INSTALLED:
        return
    _INSTALLED = True

    from .scanner import ScanManager

    def scan_candidates(
        self,
        root: Path,
        discovered: list[Path],
        library_id: int | None,
        scan_scope: str,
    ) -> tuple[list[Path], int, int]:
        if library_id is None:
            return discovered, 0, 0

        current_exact = {str(path): path for path in discovered}
        current_folded: dict[str, list[Path]] = {}
        for path in discovered:
            current_folded.setdefault(str(path).casefold(), []).append(path)

        with connection() as conn:
            all_rows = conn.execute(
                """
                SELECT id,library,media_path,title,release_name,nfo_path,file_size,file_mtime_ns
                FROM library_items WHERE library_id=?
                """,
                (library_id,),
            ).fetchall()
            rows = [row for row in all_rows if path_in_root_casefold(Path(row["media_path"]), root)]

            by_path: dict[str, object] = {}
            removed_rows = []
            for row in rows:
                stored = str(row["media_path"])
                actual = current_exact.get(stored)
                if actual is None:
                    folded_matches = current_folded.get(stored.casefold(), [])
                    if len(folded_matches) == 1:
                        actual = folded_matches[0]

                if actual is None:
                    removed_rows.append(row)
                    continue

                if str(actual) != stored:
                    conflict = conn.execute(
                        "SELECT id FROM library_items WHERE media_path=? AND id<>?",
                        (str(actual), row["id"]),
                    ).fetchone()
                    if conflict is not None:
                        removed_rows.append(row)
                        continue

                    corrected_nfo = _corrected_nfo_path(Path(stored), actual, row["nfo_path"])
                    corrected_title = media_title(actual, row["library"])
                    conn.execute(
                        "UPDATE library_items SET media_path=?,nfo_path=?,title=? WHERE id=?",
                        (str(actual), corrected_nfo, corrected_title, row["id"]),
                    )
                    row = dict(row)
                    row["media_path"] = str(actual)
                    row["nfo_path"] = corrected_nfo
                    row["title"] = corrected_title

                by_path[str(actual)] = row

            if removed_rows:
                conn.executemany(
                    "DELETE FROM library_items WHERE id=?",
                    [(row["id"],) for row in removed_rows],
                )

            if scan_scope == "full":
                return discovered, 0, len(removed_rows)

            queued: list[Path] = []
            skipped = 0
            for media in discovered:
                row = by_path.get(str(media))
                if not row:
                    queued.append(media)
                    continue

                release = media.name[:-4]
                try:
                    stat = media.stat()
                except OSError:
                    queued.append(media)
                    continue

                if row["file_size"] is None or row["file_mtime_ns"] is None:
                    if row["release_name"] == release:
                        conn.execute(
                            "UPDATE library_items SET file_size=?,file_mtime_ns=? WHERE id=?",
                            (int(stat.st_size), int(stat.st_mtime_ns), row["id"]),
                        )
                        skipped += 1
                        continue
                    queued.append(media)
                    continue

                unchanged = (
                    row["release_name"] == release
                    and int(row["file_size"]) == int(stat.st_size)
                    and int(row["file_mtime_ns"]) == int(stat.st_mtime_ns)
                )
                if unchanged:
                    skipped += 1
                else:
                    queued.append(media)

        return queued, skipped, len(removed_rows)

    original_emit = ScanManager._emit

    async def emit_with_tv_title(self, job_id: str, run_id: int, event: dict, level: str = "INFO"):
        if event.get("type") == "item" and event.get("media_path"):
            media = Path(str(event["media_path"]))
            with connection() as conn:
                row = conn.execute(
                    "SELECT id,library,title FROM library_items WHERE media_path=?",
                    (str(media),),
                ).fetchone()
                if row:
                    title = media_title(media, row["library"])
                    if title != (row["title"] or ""):
                        conn.execute("UPDATE library_items SET title=? WHERE id=?", (title, row["id"]))
                    event["title"] = title
        await original_emit(self, job_id, run_id, event, level)

    ScanManager._scan_candidates = scan_candidates
    ScanManager._path_in_root = staticmethod(path_in_root_casefold)
    ScanManager._emit = emit_with_tv_title

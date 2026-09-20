from __future__ import annotations

import logging
import os
import re
from pathlib import Path

from .scanner import GENERIC_NFOS, ScanManager
from .settings import get_setting

log = logging.getLogger("scenenfo.usenet_nfo_mirror")

EP_RE = re.compile(r"(?i)\bS(\d{1,2})E(\d{1,3})(?:[-_. ]?E?(\d{1,3}))?")
DEFAULT_USENET_MOVIES = "/data/usenet/movies"
DEFAULT_USENET_TV = "/data/usenet/tv"

_installed = False
_missing_root_warnings: set[str] = set()


def _episode_key(name: str) -> str | None:
    match = EP_RE.search(name or "")
    if not match:
        return None
    season = int(match.group(1))
    first = int(match.group(2))
    second = match.group(3)
    value = f"S{season:02d}E{first:02d}"
    if second:
        value += f"E{int(second):02d}"
    return value


def _select_media_for_nfo(target: Path) -> Path | None:
    """Resolve the media file that owns a newly written NFO.

    Movie folders normally contain one MKV. TV folders may contain many episodes,
    so require an exact episode-key match when more than one MKV is present.
    Ambiguous folders are intentionally skipped.
    """
    try:
        mkvs = sorted(
            [p for p in target.parent.iterdir() if p.is_file() and p.suffix.lower() == ".mkv"],
            key=lambda p: p.name.casefold(),
        )
    except OSError:
        return None

    if len(mkvs) == 1:
        return mkvs[0]

    target_ep = _episode_key(target.name)
    if not target_ep:
        return None

    matches = [p for p in mkvs if _episode_key(p.name) == target_ep]
    return matches[0] if len(matches) == 1 else None


def _configured_usenet_roots() -> list[Path]:
    roots = [
        Path(get_setting("usenet_movies_path", DEFAULT_USENET_MOVIES)),
        Path(get_setting("usenet_tv_path", DEFAULT_USENET_TV)),
    ]
    return [root for root in roots if str(root)]


def _find_hardlink_peer(media: Path, roots: list[Path]) -> Path | None:
    """Find exactly one MKV under the Usenet roots that is the same inode/file."""
    try:
        media_stat = media.stat()
    except OSError:
        return None

    # A link count of one proves there cannot be a hardlink peer.
    if media_stat.st_nlink < 2:
        return None

    matches: list[Path] = []
    for root in roots:
        if not root.exists():
            key = str(root)
            if key not in _missing_root_warnings:
                log.warning(
                    "Usenet NFO mirror root is unavailable: %s. "
                    "Mount the Usenet share into the SceneNFO container to enable mirroring.",
                    root,
                )
                _missing_root_warnings.add(key)
            continue

        for dirpath, dirnames, filenames in os.walk(root):
            dirnames.sort(key=str.casefold)
            for filename in sorted(filenames, key=str.casefold):
                if not filename.lower().endswith(".mkv"):
                    continue
                candidate = Path(dirpath) / filename
                try:
                    st = candidate.stat()
                except OSError:
                    continue
                if (
                    st.st_dev == media_stat.st_dev
                    and st.st_ino == media_stat.st_ino
                    and st.st_size == media_stat.st_size
                ):
                    matches.append(candidate)
                    if len(matches) > 1:
                        log.warning(
                            "Skipping Usenet NFO mirror for %s: multiple hardlink peers found (%s)",
                            media,
                            ", ".join(str(p) for p in matches),
                        )
                        return None

    return matches[0] if len(matches) == 1 else None


def _mirror_scene_nfo(
    target: Path,
    raw: bytes,
    atomic_write,
    roots: list[Path] | None = None,
) -> Path | None:
    """Mirror a Scene NFO next to its original-named Usenet hardlink.

    The destination name is derived from the original MKV itself, never from the
    provider-supplied NFO filename: Original.Release-GROUP.mkv becomes
    Original.Release-GROUP.nfo.
    """
    if target.suffix.lower() != ".nfo" or target.name.casefold() in GENERIC_NFOS:
        return None

    media = _select_media_for_nfo(target)
    if media is None:
        log.warning(
            "Skipping Usenet NFO mirror for %s: media file could not be resolved uniquely",
            target,
        )
        return None

    peer = _find_hardlink_peer(media, roots if roots is not None else _configured_usenet_roots())
    if peer is None:
        log.info("No unique Usenet hardlink peer found for %s", media)
        return None

    mirror_target = peer.with_suffix(".nfo")
    atomic_write(mirror_target, raw)
    log.info("Mirrored Scene NFO to original release path: %s", mirror_target)
    return mirror_target


def install_usenet_nfo_mirror() -> None:
    """Mirror every successful scanner NFO write to its Usenet hardlink folder."""
    global _installed
    if _installed:
        return

    original_atomic_write = ScanManager._atomic_write

    def mirrored_atomic_write(target: Path, raw: bytes) -> None:
        # The media-library write remains authoritative and retains the scanner's
        # existing atomic-write guarantees. A mirror failure must never roll it back.
        original_atomic_write(target, raw)
        try:
            _mirror_scene_nfo(Path(target), raw, original_atomic_write)
        except Exception:
            log.exception("Usenet NFO mirroring failed for %s", target)

    ScanManager._atomic_write = staticmethod(mirrored_atomic_write)
    _installed = True

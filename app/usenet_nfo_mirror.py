from __future__ import annotations

import logging
import os
import re
import time
from pathlib import Path

from .scanner import GENERIC_NFOS, ScanManager
from .services.crowdnfo import CrowdNFOClient
from .services.predb import PreDBClient
from .services.srrdb import SRRDBClient
from .settings import get_setting

log = logging.getLogger("scenenfo.usenet_nfo_mirror")

EP_RE = re.compile(r"(?i)\bS(\d{1,2})E(\d{1,3})(?:[-_. ]?E?(\d{1,3}))?")
DEFAULT_USENET_ROOT = "/data/usenet"
DEFAULT_MEDIA_ROOT = "/data/media"
INDEX_REFRESH_SECONDS = 60.0
FAILED_LOOKUP_REFRESH_SECONDS = 5.0

_installed = False
_missing_root_warnings: set[str] = set()
_usenet_inode_index: dict[tuple[int, int, int], list[Path]] = {}
_release_aliases: dict[str, str | None] = {}
_last_index_refresh = 0.0
_last_alias_refresh = 0.0
_last_failed_lookup_refresh = 0.0


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
    root = Path(get_setting("usenet_root_path", DEFAULT_USENET_ROOT))
    return [root] if str(root) else []


def _configured_media_roots() -> list[Path]:
    configured = [
        Path(get_setting("movies_path", f"{DEFAULT_MEDIA_ROOT}/movies")),
        Path(get_setting("tv_path", f"{DEFAULT_MEDIA_ROOT}/tv")),
    ]
    # Multiple SceneNFO libraries can live below /data/media, including movies-kids,
    # tv-kids, anime and stand-up. Indexing the common mount catches those too.
    common = Path(DEFAULT_MEDIA_ROOT)
    roots = [common] if common.exists() else configured
    return [root for root in roots if str(root)]


def _stat_key(path: Path) -> tuple[int, int, int] | None:
    try:
        st = path.stat()
    except OSError:
        return None
    return int(st.st_dev), int(st.st_ino), int(st.st_size)


def _build_inode_index(roots: list[Path]) -> dict[tuple[int, int, int], list[Path]]:
    index: dict[tuple[int, int, int], list[Path]] = {}
    for root in roots:
        if not root.exists():
            key = str(root)
            if key not in _missing_root_warnings:
                log.warning(
                    "Usenet NFO mirror root is unavailable: %s. "
                    "Mount /mnt/user/data/usenet as /data/usenet in SceneNFO to enable mirroring.",
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
                stat_key = _stat_key(candidate)
                if stat_key is not None:
                    index.setdefault(stat_key, []).append(candidate)
    return index


def _get_usenet_inode_index(force: bool = False) -> dict[tuple[int, int, int], list[Path]]:
    global _usenet_inode_index, _last_index_refresh
    now = time.monotonic()
    if force or not _usenet_inode_index or now - _last_index_refresh >= INDEX_REFRESH_SECONDS:
        _usenet_inode_index = _build_inode_index(_configured_usenet_roots())
        _last_index_refresh = now
    return _usenet_inode_index


def _find_hardlink_peer(media: Path, roots: list[Path] | None = None) -> Path | None:
    """Find exactly one MKV under the Usenet tree that is the same inode/file."""
    try:
        media_stat = media.stat()
    except OSError:
        return None

    if media_stat.st_nlink < 2:
        return None

    stat_key = (int(media_stat.st_dev), int(media_stat.st_ino), int(media_stat.st_size))
    if roots is not None:
        matches = _build_inode_index(roots).get(stat_key, [])
    else:
        matches = _get_usenet_inode_index().get(stat_key, [])

    unique = sorted(set(matches), key=lambda p: str(p).casefold())
    if len(unique) > 1:
        log.warning(
            "Skipping Usenet NFO mirror for %s: multiple hardlink peers found (%s)",
            media,
            ", ".join(str(p) for p in unique),
        )
        return None
    return unique[0] if len(unique) == 1 else None


def _build_release_aliases() -> dict[str, str | None]:
    """Map renamed media-library release stems to original Usenet release stems.

    Only inode-identical pairs are accepted. Duplicate media stems that point to
    different original releases are marked ambiguous and never rewritten.
    """
    inode_index = _get_usenet_inode_index()
    aliases: dict[str, str | None] = {}
    for root in _configured_media_roots():
        if not root.exists():
            continue
        for dirpath, dirnames, filenames in os.walk(root):
            dirnames.sort(key=str.casefold)
            for filename in sorted(filenames, key=str.casefold):
                if not filename.lower().endswith(".mkv"):
                    continue
                media = Path(dirpath) / filename
                stat_key = _stat_key(media)
                if stat_key is None:
                    continue
                peers = sorted(set(inode_index.get(stat_key, [])), key=lambda p: str(p).casefold())
                if len(peers) != 1:
                    continue
                media_release = media.stem
                original_release = peers[0].stem
                if media_release == original_release:
                    continue
                key = media_release.casefold()
                previous = aliases.get(key)
                if previous is None and key in aliases:
                    continue
                if previous is not None and previous.casefold() != original_release.casefold():
                    aliases[key] = None
                else:
                    aliases[key] = original_release
    return aliases


def _resolve_release_alias(release: str, force: bool = False) -> str:
    global _release_aliases, _last_alias_refresh
    now = time.monotonic()
    if force or not _release_aliases or now - _last_alias_refresh >= INDEX_REFRESH_SECONDS:
        if force:
            _get_usenet_inode_index(force=True)
        _release_aliases = _build_release_aliases()
        _last_alias_refresh = now
    mapped = _release_aliases.get((release or "").casefold())
    return mapped or release


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

    peer = _find_hardlink_peer(media, roots)
    if peer is None:
        log.info("No unique Usenet hardlink peer found for %s", media)
        return None

    mirror_target = peer.with_suffix(".nfo")
    atomic_write(mirror_target, raw)
    log.info("Mirrored Scene NFO to original release path: %s", mirror_target)
    return mirror_target


def install_usenet_nfo_mirror() -> None:
    """Use original hardlink release names for lookups and mirror successful NFO writes."""
    global _installed
    if _installed:
        return

    original_atomic_write = ScanManager._atomic_write
    original_predb_exact = PreDBClient.exact_release
    original_srrdb_nfo = SRRDBClient.nfo
    original_crowdnfo_nfo = CrowdNFOClient.nfo

    async def exact_release_with_original_name(client, release: str):
        global _last_failed_lookup_refresh
        mapped = _resolve_release_alias(release)
        result = await original_predb_exact(client, mapped)
        if result or mapped != release:
            if mapped != release:
                log.info("Using original Usenet release name for lookup: %s -> %s", release, mapped)
            return result

        # A hardlink can appear after the cache was built. Retry with a fresh index,
        # but throttle misses so P2P-heavy scans do not repeatedly walk both trees.
        now = time.monotonic()
        if now - _last_failed_lookup_refresh < FAILED_LOOKUP_REFRESH_SECONDS:
            return result
        _last_failed_lookup_refresh = now
        refreshed = _resolve_release_alias(release, force=True)
        if refreshed != release:
            log.info("Using newly indexed Usenet release name for lookup: %s -> %s", release, refreshed)
            return await original_predb_exact(client, refreshed)
        return result

    async def srrdb_nfo_with_original_name(client, release: str):
        return await original_srrdb_nfo(client, _resolve_release_alias(release))

    async def crowdnfo_nfo_with_original_name(client, release: str):
        return await original_crowdnfo_nfo(client, _resolve_release_alias(release))

    def mirrored_atomic_write(target: Path, raw: bytes) -> None:
        # The media-library write remains authoritative and retains the scanner's
        # existing atomic-write guarantees. A mirror failure must never roll it back.
        original_atomic_write(target, raw)
        try:
            _mirror_scene_nfo(Path(target), raw, original_atomic_write)
        except Exception:
            log.exception("Usenet NFO mirroring failed for %s", target)

    PreDBClient.exact_release = exact_release_with_original_name
    SRRDBClient.nfo = srrdb_nfo_with_original_name
    CrowdNFOClient.nfo = crowdnfo_nfo_with_original_name
    ScanManager._atomic_write = staticmethod(mirrored_atomic_write)
    _installed = True

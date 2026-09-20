from __future__ import annotations

import os
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

import app.usenet_nfo_mirror as mirror
from app.usenet_nfo_mirror import (
    _find_hardlink_peer,
    _mirror_scene_nfo,
    _select_media_for_nfo,
)


class UsenetNFOMirrorTests(unittest.TestCase):
    def test_movie_nfo_is_mirrored_with_original_release_name(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            media_dir = root / "media" / "movies" / "Phone Booth (2003)"
            usenet_dir = root / "usenet" / "movies" / "Nicht.auflegen.2002.German.EAC3.DL.1080p.BluRay.x265-VECTOR"
            media_dir.mkdir(parents=True)
            usenet_dir.mkdir(parents=True)

            media = media_dir / "Phone Booth (2003) - [German DL][Bluray-1080p][EAC3 5.1][x265]-VECTOR.mkv"
            media.write_bytes(b"video")
            peer = usenet_dir / "Nicht.auflegen.2002.German.EAC3.DL.1080p.BluRay.x265-VECTOR.mkv"
            os.link(media, peer)

            target = media_dir / "Nicht.auflegen.2002.German.EAC3.DL.1080p.BluRay.x265-VECTOR.nfo"
            target.write_bytes(b"existing media nfo")
            raw = b"This is a valid Scene NFO payload that is comfortably longer than 32 bytes."

            writes = []

            def atomic_write(path: Path, payload: bytes):
                writes.append((path, payload))
                path.write_bytes(payload)

            mirrored = _mirror_scene_nfo(target, raw, atomic_write, [root / "usenet" / "movies"])

            expected = peer.with_suffix(".nfo")
            self.assertEqual(mirrored, expected)
            self.assertEqual(expected.read_bytes(), raw)
            self.assertEqual(writes, [(expected, raw)])

    def test_renamed_radarr_file_maps_to_original_release_for_lookup(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            media_root = root / "media"
            media_dir = media_root / "movies" / "Nicht auflegen! (2003) [tmdb-1817]"
            usenet_root = root / "usenet"
            usenet_dir = usenet_root / "movies" / "Nicht.auflegen.2002.German.EAC3.DL.1080p.BluRay.x265-VECTOR"
            media_dir.mkdir(parents=True)
            usenet_dir.mkdir(parents=True)

            renamed = media_dir / "Phone Booth (2003) [tmdb-1817] - [German DL][Bluray-1080p][EAC3 5.1][x265]-VECTOR.mkv"
            renamed.write_bytes(b"video")
            original = usenet_dir / "Nicht.auflegen.2002.German.EAC3.DL.1080p.BluRay.x265-VECTOR.mkv"
            os.link(renamed, original)

            old_index = mirror._usenet_inode_index
            old_aliases = mirror._release_aliases
            old_index_refresh = mirror._last_index_refresh
            old_alias_refresh = mirror._last_alias_refresh
            try:
                mirror._usenet_inode_index = {}
                mirror._release_aliases = {}
                mirror._last_index_refresh = 0.0
                mirror._last_alias_refresh = 0.0
                with patch.object(mirror, "_configured_usenet_roots", return_value=[usenet_root]), patch.object(
                    mirror, "_configured_media_roots", return_value=[media_root]
                ):
                    resolved = mirror._resolve_release_alias(renamed.stem, force=True)
            finally:
                mirror._usenet_inode_index = old_index
                mirror._release_aliases = old_aliases
                mirror._last_index_refresh = old_index_refresh
                mirror._last_alias_refresh = old_alias_refresh

            self.assertEqual(resolved, original.stem)

    def test_hardlink_peer_requires_same_inode(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            media = root / "media.mkv"
            media.write_bytes(b"same-size")
            usenet = root / "usenet"
            usenet.mkdir()
            unrelated = usenet / "release.mkv"
            unrelated.write_bytes(b"same-size")

            self.assertIsNone(_find_hardlink_peer(media, [usenet]))

    def test_ambiguous_hardlink_peers_are_skipped(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            media = root / "media.mkv"
            media.write_bytes(b"video")
            usenet = root / "usenet"
            (usenet / "a").mkdir(parents=True)
            (usenet / "b").mkdir(parents=True)
            os.link(media, usenet / "a" / "Release-A.mkv")
            os.link(media, usenet / "b" / "Release-B.mkv")

            self.assertIsNone(_find_hardlink_peer(media, [usenet]))

    def test_tv_folder_uses_episode_key_to_resolve_media(self):
        with tempfile.TemporaryDirectory() as tmp:
            folder = Path(tmp)
            ep1 = folder / "Show - S01E01 - Pilot.mkv"
            ep2 = folder / "Show - S01E02 - Next.mkv"
            ep1.write_bytes(b"1")
            ep2.write_bytes(b"2")
            target = folder / "Show.S01E02.German.1080p-WEB.nfo"

            self.assertEqual(_select_media_for_nfo(target), ep2)

    def test_generic_metadata_nfo_is_never_mirrored(self):
        with tempfile.TemporaryDirectory() as tmp:
            folder = Path(tmp)
            media = folder / "Movie.mkv"
            media.write_bytes(b"video")
            target = folder / "movie.nfo"
            writes = []

            mirrored = _mirror_scene_nfo(
                target,
                b"A valid enough NFO payload that should never be written here.",
                lambda path, raw: writes.append((path, raw)),
                [folder],
            )

            self.assertIsNone(mirrored)
            self.assertEqual(writes, [])


if __name__ == "__main__":
    unittest.main()

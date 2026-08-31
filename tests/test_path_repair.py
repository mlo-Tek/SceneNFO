from __future__ import annotations

import os
import tempfile
import unittest
from pathlib import Path

_CONFIG = tempfile.TemporaryDirectory()
os.environ["SCENENFO_CONFIG_DIR"] = _CONFIG.name

from app import db  # noqa: E402
from app.folder_browser import _browser_root  # noqa: E402
from app.path_repair import (  # noqa: E402
    media_title,
    repair_item_media_path,
    resolve_case_insensitive,
)


class PathRepairTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.root = Path(self.temp.name)
        db.DB_PATH = self.root / "scenenfo.db"
        db.init_db()

    def tearDown(self):
        self.temp.cleanup()

    def _insert_item(self, library: str, library_root: Path, media: Path, title: str) -> dict:
        now = db.utcnow()
        stored_root = str(library_root).lower()
        stored_media = str(media).lower()
        stored_nfo = str(media.with_suffix(".nfo")).lower()
        with db.connection() as conn:
            cursor = conn.execute(
                """
                INSERT INTO libraries(name,kind,path,enabled,created_at,updated_at)
                VALUES(?,?,?,?,?,?)
                """,
                (f"Test {library}", library, stored_root, 1, now, now),
            )
            library_id = cursor.lastrowid
            cursor = conn.execute(
                """
                INSERT INTO library_items(
                  library,library_id,media_path,title,release_name,classification,
                  release_group,nfo_path,nfo_present,last_result,last_checked_at
                ) VALUES(?,?,?,?,?,?,?,?,?,?,?)
                """,
                (
                    library,
                    library_id,
                    stored_media,
                    title,
                    media.stem,
                    "scene",
                    "GROUP",
                    stored_nfo,
                    1,
                    "CREATED",
                    now,
                ),
            )
            item_id = cursor.lastrowid

        row = db.fetchone(
            """
            SELECT li.*,l.path AS library_path,l.kind AS library_kind
            FROM library_items li
            LEFT JOIN libraries l ON l.id=li.library_id
            WHERE li.id=?
            """,
            (item_id,),
        )
        assert row is not None
        return row

    def test_movie_path_is_resolved_case_insensitively_and_persisted(self):
        library_root = self.root / "Movies"
        media_dir = library_root / "Movie Name"
        media_dir.mkdir(parents=True)
        media = media_dir / "Release-GROUP.mkv"
        media.write_bytes(b"movie")
        media.with_suffix(".nfo").write_text("nfo")

        item = self._insert_item("movies", library_root, media, "movie name")
        repaired = repair_item_media_path(item)

        self.assertEqual(repaired, media)
        saved = db.fetchone("SELECT media_path,nfo_path,title FROM library_items WHERE id=?", (item["id"],))
        self.assertEqual(saved["media_path"], str(media))
        self.assertEqual(saved["nfo_path"], str(media.with_suffix(".nfo")))
        self.assertEqual(saved["title"], "Movie Name")

    def test_tv_title_uses_series_folder_and_folder_browser_uses_series_root(self):
        library_root = self.root / "TV"
        series = library_root / "Example Series"
        season = series / "Season 02"
        season.mkdir(parents=True)
        media = season / "Example.Series.S02E03-GROUP.mkv"
        media.write_bytes(b"episode")
        media.with_suffix(".nfo").write_text("nfo")

        item = self._insert_item("tv", library_root, media, "Season 02")
        repaired = repair_item_media_path(item)

        self.assertEqual(repaired, media)
        self.assertEqual(media_title(media, "tv"), "Example Series")
        saved = db.fetchone("SELECT media_path,title FROM library_items WHERE id=?", (item["id"],))
        self.assertEqual(saved["media_path"], str(media))
        self.assertEqual(saved["title"], "Example Series")
        self.assertEqual(_browser_root(item, media), series)

    def test_ambiguous_case_insensitive_component_is_not_guessed(self):
        parent = self.root / "ambiguous"
        parent.mkdir()
        (parent / "Folder").mkdir()
        (parent / "FOLDER").mkdir()

        self.assertIsNone(resolve_case_insensitive(parent / "folder"))


if __name__ == "__main__":
    unittest.main()

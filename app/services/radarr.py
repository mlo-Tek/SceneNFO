from __future__ import annotations

import re
from pathlib import Path

import httpx

TMDB_DIR_RE = re.compile(r"\[tmdb-(\d+)\]", re.IGNORECASE)


class RadarrClient:
    def __init__(self, base_url: str, api_key: str):
        self.base_url = (base_url or "").rstrip("/")
        self.api_key = api_key or ""

    @property
    def configured(self) -> bool:
        return bool(self.base_url and self.api_key)

    def _headers(self) -> dict[str, str]:
        return {"X-Api-Key": self.api_key, "User-Agent": "SceneNFO/0.3"}

    async def test(self) -> dict:
        if not self.configured:
            return {"ok": False, "error": "Radarr URL or API key is not configured"}
        try:
            async with httpx.AsyncClient(timeout=10, follow_redirects=True) as client:
                response = await client.get(
                    f"{self.base_url}/api/v3/system/status",
                    headers=self._headers(),
                )
                response.raise_for_status()
                data = response.json()
                return {
                    "ok": True,
                    "version": data.get("version"),
                    "instanceName": data.get("instanceName"),
                }
        except Exception as exc:
            return {"ok": False, "error": str(exc)}

    async def movie_ids_for_folders(self, folders: set[str]) -> tuple[list[int], list[str]]:
        if not folders:
            return [], []
        if not self.configured:
            return [], sorted(folders)

        async with httpx.AsyncClient(timeout=20, follow_redirects=True) as client:
            response = await client.get(
                f"{self.base_url}/api/v3/movie",
                headers=self._headers(),
            )
            response.raise_for_status()
            movies = response.json()

        by_path: dict[str, int] = {}
        by_tmdb: dict[int, int] = {}
        for movie in movies:
            movie_id = movie.get("id")
            if not movie_id:
                continue
            path = str(movie.get("path") or "").rstrip("/")
            if path:
                by_path[path] = int(movie_id)
            tmdb_id = movie.get("tmdbId")
            if tmdb_id:
                by_tmdb[int(tmdb_id)] = int(movie_id)

        ids: set[int] = set()
        unmatched: list[str] = []
        for folder in sorted(folders):
            clean = str(Path(folder)).rstrip("/")
            movie_id = by_path.get(clean)
            if movie_id is None:
                match = TMDB_DIR_RE.search(Path(clean).name)
                if match:
                    movie_id = by_tmdb.get(int(match.group(1)))
            if movie_id is None:
                unmatched.append(folder)
            else:
                ids.add(int(movie_id))
        return sorted(ids), unmatched

    async def refresh_movie_ids(self, movie_ids: list[int]) -> dict:
        ids = sorted({int(movie_id) for movie_id in movie_ids if movie_id})
        if not ids:
            return {"queued": False, "movie_ids": []}
        if not self.configured:
            raise RuntimeError("Radarr URL or API key is not configured")

        async with httpx.AsyncClient(timeout=20, follow_redirects=True) as client:
            response = await client.post(
                f"{self.base_url}/api/v3/command",
                headers=self._headers(),
                json={"name": "RefreshMovie", "movieIds": ids},
            )
            response.raise_for_status()
            data = response.json()
        return {
            "queued": True,
            "movie_ids": ids,
            "command_id": data.get("id"),
            "status": data.get("status"),
        }

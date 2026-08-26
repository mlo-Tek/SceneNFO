from __future__ import annotations

import re
from pathlib import Path

import httpx

TVDB_DIR_RE = re.compile(r"\[tvdb-(\d+)\]", re.IGNORECASE)


class SonarrClient:
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
            return {"ok": False, "error": "Sonarr URL or API key is not configured"}
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

    async def series_ids_for_folders(self, folders: set[str]) -> tuple[list[int], list[str]]:
        if not folders:
            return [], []
        if not self.configured:
            return [], sorted(folders)

        async with httpx.AsyncClient(timeout=20, follow_redirects=True) as client:
            response = await client.get(
                f"{self.base_url}/api/v3/series",
                headers=self._headers(),
            )
            response.raise_for_status()
            series_rows = response.json()

        by_path: dict[str, int] = {}
        by_tvdb: dict[int, int] = {}
        for series in series_rows:
            series_id = series.get("id")
            if not series_id:
                continue
            path = str(series.get("path") or "").rstrip("/")
            if path:
                by_path[path] = int(series_id)
            tvdb_id = series.get("tvdbId")
            if tvdb_id:
                by_tvdb[int(tvdb_id)] = int(series_id)

        ids: set[int] = set()
        unmatched: list[str] = []
        for folder in sorted(folders):
            clean = str(Path(folder)).rstrip("/")
            series_id = by_path.get(clean)
            if series_id is None:
                match = TVDB_DIR_RE.search(Path(clean).name)
                if match:
                    series_id = by_tvdb.get(int(match.group(1)))
            if series_id is None:
                unmatched.append(folder)
            else:
                ids.add(int(series_id))
        return sorted(ids), unmatched

    async def refresh_series_ids(self, series_ids: list[int]) -> dict:
        ids = sorted({int(series_id) for series_id in series_ids if series_id})
        if not ids:
            return {"queued": False, "series_ids": [], "commands": []}
        if not self.configured:
            raise RuntimeError("Sonarr URL or API key is not configured")

        commands: list[dict] = []
        async with httpx.AsyncClient(timeout=20, follow_redirects=True) as client:
            for series_id in ids:
                response = await client.post(
                    f"{self.base_url}/api/v3/command",
                    headers=self._headers(),
                    json={"name": "RefreshSeries", "seriesId": series_id},
                )
                response.raise_for_status()
                data = response.json()
                commands.append(
                    {
                        "series_id": series_id,
                        "command_id": data.get("id"),
                        "status": data.get("status"),
                    }
                )
        return {"queued": True, "series_ids": ids, "commands": commands}

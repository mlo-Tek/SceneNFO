from __future__ import annotations

import httpx


class PreDBClient:
    def __init__(self, base_url: str):
        self.base_url = base_url.rstrip("/")

    async def exact_release(self, release: str) -> dict | None:
        async with httpx.AsyncClient(timeout=30, follow_redirects=True) as client:
            r = await client.get(f"{self.base_url}/api/v1/", params={"q": release}, headers={"Accept": "application/json"})
            r.raise_for_status()
            data = r.json()
        rows = ((data.get("data") or {}).get("rows") or []) if data.get("status") == "success" else []
        for row in rows:
            if str(row.get("name", "")).casefold() == release.casefold():
                return row
        return None

    async def nfo(self, pre_id: int) -> dict | None:
        async with httpx.AsyncClient(timeout=30, follow_redirects=True) as client:
            r = await client.get(f"{self.base_url}/api/v1/releases/{pre_id}/nfo", headers={"Accept": "application/json"})
            if r.status_code == 404:
                return None
            r.raise_for_status()
            data = r.json()
        if data.get("status") != "success":
            return None
        d = data.get("data") or {}
        nfo = d.get("nfo")
        if not nfo:
            return None
        return {
            "url": str(httpx.URL(self.base_url).join(nfo)),
            "img": str(httpx.URL(self.base_url).join(d.get("img") or "")),
        }

    async def teams(self) -> list[dict]:
        async with httpx.AsyncClient(timeout=30, follow_redirects=True) as client:
            r = await client.get(f"{self.base_url}/api/v1/teams", headers={"Accept": "application/json"})
            r.raise_for_status()
            data = r.json()
        if data.get("status") != "success":
            return []
        return (data.get("data") or {}).get("rows") or []

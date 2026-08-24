from __future__ import annotations

import httpx
from urllib.parse import quote


class SRRDBClient:
    def __init__(self, base_url: str):
        self.base_url = base_url.rstrip("/")

    async def nfo(self, release: str) -> dict | None:
        url = f"{self.base_url}/v1/nfo/{quote(release, safe='')}"
        async with httpx.AsyncClient(timeout=30, follow_redirects=True) as client:
            r = await client.get(url, headers={"Accept": "application/json"})
            if r.status_code == 404:
                return None
            r.raise_for_status()
            data = r.json()
        nfos = data.get("nfo") or []
        links = data.get("nfolink") or []
        if isinstance(nfos, str):
            nfos = [nfos]
        if isinstance(links, str):
            links = [links]
        if not nfos:
            return None
        return {"filename": nfos[0], "url": links[0] if links else None}

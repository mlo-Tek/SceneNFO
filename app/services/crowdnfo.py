from __future__ import annotations

import html
import re
import httpx

RELEASE_LINK_RE = re.compile(r'href=["\'](?:https?://crowdnfo\.net)?/release/(\d+)["\']', re.I)


class CrowdNFOClient:
    def __init__(self, base_url: str, api_key: str):
        self.base_url = base_url.rstrip("/")
        self.api_key = api_key

    async def _release_id(self, release: str) -> int | None:
        async with httpx.AsyncClient(timeout=30, follow_redirects=True) as client:
            r = await client.get(f"{self.base_url}/home/search", params={"query": release})
            r.raise_for_status()
            ids = list(dict.fromkeys(RELEASE_LINK_RE.findall(r.text)))
            for rid in ids[:10]:
                rr = await client.get(f"{self.base_url}/release/{rid}")
                if rr.is_success and release.casefold() in html.unescape(rr.text).casefold():
                    return int(rid)
        return None

    async def nfo(self, release: str) -> dict | None:
        if not self.api_key:
            return None
        release_id = await self._release_id(release)
        if not release_id:
            return None
        headers = {"X-Api-Key": self.api_key, "Accept": "application/json"}
        async with httpx.AsyncClient(timeout=30, follow_redirects=True) as client:
            r = await client.get(f"{self.base_url}/api/releases/{release_id}/files", headers=headers)
            r.raise_for_status()
            files = r.json()
        nfos = [x for x in files if str(x.get("fileType", "")).upper() == "NFO"]
        if not nfos:
            return None
        def score(x: dict):
            return (
                1 if str(x.get("status", "")).casefold() == "approved" else 0,
                x.get("cumulativeTrustGrade") or 0,
                x.get("submissionCount") or 0,
            )
        nfo = max(nfos, key=score)
        fid = nfo.get("fileId")
        return {
            "release_id": release_id,
            "file_id": fid,
            "filename": nfo.get("originalFileName") or f"{release}.nfo",
            "status": nfo.get("status"),
            "url": f"{self.base_url}/api/files/{fid}/download" if fid else None,
        }

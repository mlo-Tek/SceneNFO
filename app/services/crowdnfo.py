from __future__ import annotations

import re
from urllib.parse import quote

import httpx


CONTENT_DISPOSITION_FILENAME_RE = re.compile(
    r"filename\*?=(?:UTF-8''|\")?([^\";]+)",
    re.IGNORECASE,
)


class CrowdNFOClient:
    """crowdNFO client using the direct best-file endpoint.

    We intentionally do not enable crowdNFO's ``fallback=true`` option here.
    SceneNFO already manages source priority itself (srrDB -> PreDB.club ->
    crowdNFO by default), so enabling the server-side srrDB fallback would make
    source attribution ambiguous.
    """

    def __init__(self, base_url: str, api_key: str):
        self.base_url = base_url.rstrip("/")
        self.api_key = api_key

    def _best_nfo_url(self, release: str) -> str:
        encoded_release = quote(release, safe="")
        return f"{self.base_url}/api/releases/{encoded_release}/files/best?type=NFO&raw=true"

    async def nfo(self, release: str) -> dict | None:
        if not self.api_key:
            return None

        url = self._best_nfo_url(release)
        headers = {
            "X-Api-Key": self.api_key,
            "Accept": "application/octet-stream,text/plain,*/*",
            "User-Agent": "SceneNFO/0.1",
        }

        # The raw endpoint is both lookup and download. During a scan we make
        # this request to verify that crowdNFO really has an NFO. Apply mode may
        # request the same URL again when crowdNFO is actually selected. This is
        # still far cheaper and more robust than the old HTML-search -> release
        # page -> file-list -> file-id flow.
        async with httpx.AsyncClient(timeout=30, follow_redirects=True) as client:
            response = await client.get(url, headers=headers)

        if response.status_code in (400, 404):
            return None

        response.raise_for_status()

        raw = response.content
        if len(raw) < 32:
            return None

        head = raw[:256].lstrip().lower()
        if (
            head.startswith(b"<html")
            or head.startswith(b"<!doctype")
            or head.startswith(b"{")
            or head.startswith(b"[")
        ):
            return None

        filename = f"{release}.nfo"
        disposition = response.headers.get("content-disposition", "")
        match = CONTENT_DISPOSITION_FILENAME_RE.search(disposition)
        if match:
            candidate = match.group(1).strip().strip('"')
            if candidate:
                filename = candidate

        return {
            "filename": filename,
            "url": url,
            "status": "FOUND",
            "endpoint": "files/best",
        }

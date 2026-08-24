from __future__ import annotations

import asyncio
import time
from email.utils import parsedate_to_datetime

import httpx


class PreDBClient:
    """PreDB.club client with process-wide throttling and 429 recovery.

    Multiple scans can run at the same time, so the limiter is deliberately
    shared by every PreDBClient instance in the SceneNFO process. This avoids
    one library respecting a delay while another library immediately exceeds
    the same upstream rate limit.
    """

    _request_lock = asyncio.Lock()
    _next_request_at = 0.0
    _release_cache: dict[str, tuple[float, dict | None]] = {}
    _nfo_cache: dict[int, tuple[float, dict | None]] = {}
    _teams_cache: tuple[float, list[dict]] | None = None

    # Stay deliberately conservative. A full library scan is background work;
    # correctness is more important than finishing a few minutes sooner.
    MIN_INTERVAL_SECONDS = 1.25
    POSITIVE_CACHE_SECONDS = 6 * 60 * 60
    NEGATIVE_CACHE_SECONDS = 30 * 60
    NFO_CACHE_SECONDS = 6 * 60 * 60
    TEAMS_CACHE_SECONDS = 6 * 60 * 60

    def __init__(self, base_url: str):
        self.base_url = base_url.rstrip("/")

    @classmethod
    async def _wait_for_slot(cls) -> None:
        delay = cls._next_request_at - time.monotonic()
        if delay > 0:
            await asyncio.sleep(delay)

    @staticmethod
    def _retry_after_seconds(response: httpx.Response, attempt: int) -> float:
        retry_after = (response.headers.get("Retry-After") or "").strip()
        if retry_after:
            try:
                return max(1.0, min(float(retry_after), 300.0))
            except ValueError:
                try:
                    dt = parsedate_to_datetime(retry_after)
                    return max(1.0, min(dt.timestamp() - time.time(), 300.0))
                except Exception:
                    pass

        reset = (response.headers.get("X-RateLimit-Reset") or "").strip()
        if reset:
            try:
                return max(1.0, min(float(reset) - time.time(), 300.0))
            except ValueError:
                pass

        # PreDB does not always send Retry-After. Increase the cooldown until
        # the upstream window has definitely had time to recover.
        return min(5.0 * (2 ** min(attempt, 5)), 120.0)

    async def _request(self, path: str, *, params: dict | None = None) -> httpx.Response:
        headers = {
            "Accept": "application/json",
            "User-Agent": "SceneNFO/0.3",
        }

        # Hold the lock for the complete request/backoff cycle. This is
        # intentional: another simultaneous library must not bypass a 429
        # cooldown and continue hammering the same upstream service.
        async with self.__class__._request_lock:
            attempt = 0
            async with httpx.AsyncClient(timeout=30, follow_redirects=True) as client:
                while True:
                    await self.__class__._wait_for_slot()
                    response = await client.get(
                        f"{self.base_url}{path}",
                        params=params,
                        headers=headers,
                    )
                    self.__class__._next_request_at = (
                        time.monotonic() + self.MIN_INTERVAL_SECONDS
                    )

                    if response.status_code != 429:
                        response.raise_for_status()
                        return response

                    cooldown = self._retry_after_seconds(response, attempt)
                    attempt += 1
                    self.__class__._next_request_at = max(
                        self.__class__._next_request_at,
                        time.monotonic() + cooldown,
                    )
                    await asyncio.sleep(cooldown)

    async def exact_release(self, release: str) -> dict | None:
        key = release.casefold()
        cached = self.__class__._release_cache.get(key)
        now = time.monotonic()
        if cached and cached[0] > now:
            return cached[1]

        response = await self._request("/api/v1/", params={"q": release})
        data = response.json()
        rows = (
            ((data.get("data") or {}).get("rows") or [])
            if data.get("status") == "success"
            else []
        )

        match = None
        for row in rows:
            if str(row.get("name", "")).casefold() == key:
                match = row
                break

        ttl = self.POSITIVE_CACHE_SECONDS if match else self.NEGATIVE_CACHE_SECONDS
        self.__class__._release_cache[key] = (now + ttl, match)
        return match

    async def nfo(self, pre_id: int) -> dict | None:
        cached = self.__class__._nfo_cache.get(pre_id)
        now = time.monotonic()
        if cached and cached[0] > now:
            return cached[1]

        response = await self._request(f"/api/v1/releases/{pre_id}/nfo")
        if response.status_code == 404:
            result = None
        else:
            data = response.json()
            if data.get("status") != "success":
                result = None
            else:
                d = data.get("data") or {}
                nfo = d.get("nfo")
                result = (
                    {
                        "url": str(httpx.URL(self.base_url).join(nfo)),
                        "img": str(httpx.URL(self.base_url).join(d.get("img") or "")),
                    }
                    if nfo
                    else None
                )

        self.__class__._nfo_cache[pre_id] = (now + self.NFO_CACHE_SECONDS, result)
        return result

    async def teams(self) -> list[dict]:
        cached = self.__class__._teams_cache
        now = time.monotonic()
        if cached and cached[0] > now:
            return cached[1]

        response = await self._request("/api/v1/teams")
        data = response.json()
        rows = (
            (data.get("data") or {}).get("rows") or []
            if data.get("status") == "success"
            else []
        )
        self.__class__._teams_cache = (now + self.TEAMS_CACHE_SECONDS, rows)
        return rows

from __future__ import annotations

import json
from datetime import datetime, timedelta, timezone
from urllib.parse import urlparse
from zoneinfo import ZoneInfo, ZoneInfoNotFoundError

import httpx
from fastapi import APIRouter, HTTPException

from .db import connection
from .settings import get_setting

router = APIRouter(prefix="/api/integrations/discord", tags=["discord"])


def _enabled(key: str, default: str = "false") -> bool:
    return get_setting(key, default).strip().lower() == "true"


def _timezone() -> ZoneInfo:
    name = get_setting("discord_weekly_timezone", "Europe/Berlin").strip() or "Europe/Berlin"
    try:
        return ZoneInfo(name)
    except ZoneInfoNotFoundError:
        return ZoneInfo("Europe/Berlin")


def _valid_webhook_url(url: str) -> bool:
    try:
        parsed = urlparse(url)
    except Exception:
        return False
    host = (parsed.hostname or "").lower()
    return (
        parsed.scheme == "https"
        and host in {"discord.com", "discordapp.com", "canary.discord.com", "ptb.discord.com"}
        and parsed.path.startswith("/api/webhooks/")
    )


def _event_payloads(run_ids: list[int]) -> dict[int, dict]:
    if not run_ids:
        return {}
    placeholders = ",".join("?" for _ in run_ids)
    with connection() as conn:
        rows = conn.execute(
            f"""
            SELECT run_id,payload
            FROM run_events
            WHERE run_id IN ({placeholders}) AND event='start'
            ORDER BY id
            """,
            run_ids,
        ).fetchall()
    result: dict[int, dict] = {}
    for row in rows:
        if int(row["run_id"]) in result:
            continue
        try:
            result[int(row["run_id"])] = json.loads(row["payload"] or "{}")
        except (TypeError, json.JSONDecodeError):
            result[int(row["run_id"])] = {}
    return result


def _run_download_count(run: dict, start_payload: dict) -> int:
    scanned = max(int(run.get("scanned") or 0), 0)
    trigger = str(run.get("trigger") or "").lower()

    # A Radarr import/upgrade represents one downloaded movie even if the
    # subsequent SceneNFO classification failed or was skipped.
    if trigger.startswith("radarr-"):
        return max(scanned, 1)

    # Sonarr batches can contain many episodes. Prefer the exact file count
    # stored in the parent start event and fall back to the run's scan count.
    if trigger.startswith("sonarr-"):
        candidates = [scanned]
        count = start_payload.get("count")
        if isinstance(count, int):
            candidates.append(max(count, 0))
        files = start_payload.get("files")
        if isinstance(files, list):
            candidates.append(len(files))
        return max(max(candidates, default=0), 1)

    return 0


def weekly_stats(now: datetime | None = None) -> dict:
    tz = _timezone()
    local_end = (now or datetime.now(timezone.utc)).astimezone(tz)
    local_start = local_end - timedelta(days=7)
    start_utc = local_start.astimezone(timezone.utc)
    end_utc = local_end.astimezone(timezone.utc)

    with connection() as conn:
        rows = [
            dict(row)
            for row in conn.execute(
                """
                SELECT * FROM runs
                WHERE started_at>=? AND started_at<?
                  AND (
                    lower(trigger) LIKE 'radarr-import%'
                    OR lower(trigger) LIKE 'radarr-upgrade%'
                    OR lower(trigger) LIKE 'sonarr-import%'
                    OR lower(trigger) LIKE 'sonarr-upgrade%'
                  )
                ORDER BY id
                """,
                (start_utc.isoformat(), end_utc.isoformat()),
            ).fetchall()
        ]

    payloads = _event_payloads([int(row["id"]) for row in rows])

    stats = {
        "period_start": local_start.isoformat(),
        "period_end": local_end.isoformat(),
        "timezone": str(tz),
        "total": 0,
        "movies": 0,
        "movies_new": 0,
        "movies_upgrades": 0,
        "tv": 0,
        "tv_new": 0,
        "tv_upgrades": 0,
        "nfo_created": 0,
        "nfo_replaced": 0,
        "errors": 0,
        "runs": len(rows),
    }

    for run in rows:
        trigger = str(run.get("trigger") or "").lower()
        count = _run_download_count(run, payloads.get(int(run["id"]), {}))
        is_upgrade = "upgrade" in trigger

        if trigger.startswith("radarr-"):
            stats["movies"] += count
            stats["movies_upgrades" if is_upgrade else "movies_new"] += count
        elif trigger.startswith("sonarr-"):
            stats["tv"] += count
            stats["tv_upgrades" if is_upgrade else "tv_new"] += count

        stats["nfo_created"] += max(int(run.get("created") or 0), 0)
        stats["nfo_replaced"] += max(int(run.get("replaced") or 0), 0)
        stats["errors"] += max(int(run.get("errors") or 0), 0)

    stats["total"] = stats["movies"] + stats["tv"]
    return stats


def _discord_payload(stats: dict, test: bool = False) -> dict:
    start = datetime.fromisoformat(stats["period_start"])
    end = datetime.fromisoformat(stats["period_end"])
    period = f"{start:%d.%m.%Y} – {end:%d.%m.%Y}"
    total = int(stats["total"])

    if total:
        description = f"**{total} Downloads** in den letzten 7 Tagen."
        color = 0x2ECC71
    else:
        description = "**Keine Downloads** in den letzten 7 Tagen."
        color = 0x6B7280

    if test:
        description = "**Testnachricht** · " + description

    fields = [
        {
            "name": "🎬 Movies",
            "value": f"**{stats['movies']}**\n{stats['movies_new']} neu · {stats['movies_upgrades']} Upgrades",
            "inline": True,
        },
        {
            "name": "📺 TV Episoden",
            "value": f"**{stats['tv']}**\n{stats['tv_new']} neu · {stats['tv_upgrades']} Upgrades",
            "inline": True,
        },
    ]

    if _enabled("discord_weekly_include_nfo", "true"):
        fields.append(
            {
                "name": "📝 NFO",
                "value": f"{stats['nfo_created']} erstellt · {stats['nfo_replaced']} ersetzt",
                "inline": True,
            }
        )

    if int(stats["errors"]):
        fields.append(
            {
                "name": "⚠️ SceneNFO Fehler",
                "value": str(stats["errors"]),
                "inline": True,
            }
        )

    return {
        "username": "SceneNFO",
        "allowed_mentions": {"parse": []},
        "embeds": [
            {
                "title": "SceneNFO · Weekly Summary",
                "description": description,
                "color": color,
                "fields": fields,
                "footer": {"text": f"{period} · {stats['timezone']}"},
                "timestamp": stats["period_end"],
            }
        ],
    }


async def send_weekly_discord_summary(*, test: bool = False) -> dict:
    webhook_url = get_setting("discord_weekly_webhook_url", "").strip()
    if not webhook_url:
        raise RuntimeError("Discord webhook URL is not configured")
    if not _valid_webhook_url(webhook_url):
        raise RuntimeError("Discord webhook URL is invalid")

    stats = weekly_stats()
    if not test and stats["total"] == 0 and not _enabled("discord_weekly_send_empty", "true"):
        return {"sent": False, "reason": "empty", "stats": stats}

    payload = _discord_payload(stats, test=test)
    async with httpx.AsyncClient(timeout=15, follow_redirects=True) as client:
        response = await client.post(webhook_url, json=payload)
        response.raise_for_status()

    return {"sent": True, "stats": stats}


@router.get("/preview")
def discord_weekly_preview():
    stats = weekly_stats()
    return {"stats": stats, "payload": _discord_payload(stats, test=True)}


@router.post("/test")
async def test_discord_weekly():
    try:
        return await send_weekly_discord_summary(test=True)
    except Exception as exc:
        raise HTTPException(400, str(exc)) from exc

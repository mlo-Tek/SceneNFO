from __future__ import annotations

from zoneinfo import ZoneInfo, ZoneInfoNotFoundError

from apscheduler.schedulers.asyncio import AsyncIOScheduler
from apscheduler.triggers.cron import CronTrigger

from .db import connection
from .discord_summary import send_weekly_discord_summary
from .scanner import scan_manager
from .settings import get_setting

scheduler = AsyncIOScheduler()


def _enabled(key: str, default: str = "false") -> bool:
    return get_setting(key, default).strip().lower() == "true"


def _add_weekly_discord_job() -> None:
    if not _enabled("discord_weekly_enabled", "false"):
        return
    if not get_setting("discord_weekly_webhook_url", "").strip():
        return

    day = get_setting("discord_weekly_day", "sun").strip().lower()
    if day not in {"mon", "tue", "wed", "thu", "fri", "sat", "sun"}:
        day = "sun"

    raw_time = get_setting("discord_weekly_time", "20:00").strip()
    try:
        hour_text, minute_text = raw_time.split(":", 1)
        hour = min(max(int(hour_text), 0), 23)
        minute = min(max(int(minute_text), 0), 59)
    except (ValueError, TypeError):
        hour, minute = 20, 0

    timezone_name = get_setting("discord_weekly_timezone", "Europe/Berlin").strip() or "Europe/Berlin"
    try:
        tz = ZoneInfo(timezone_name)
    except ZoneInfoNotFoundError:
        tz = ZoneInfo("Europe/Berlin")

    scheduler.add_job(
        send_weekly_discord_summary,
        CronTrigger(day_of_week=day, hour=hour, minute=minute, timezone=tz),
        id="discord-weekly-summary",
        replace_existing=True,
        coalesce=True,
        max_instances=1,
        misfire_grace_time=3600,
    )


def refresh_schedule() -> None:
    scheduler.remove_all_jobs()

    with connection() as conn:
        schedules = conn.execute(
            """
            SELECT id,name,cron,enabled,apply_changes,nfo_policy,scan_scope
            FROM schedules WHERE enabled=1 ORDER BY id
            """
        ).fetchall()
        for sched in schedules:
            libraries = conn.execute(
                """
                SELECT l.id,l.name,l.kind,l.path
                FROM schedule_libraries sl
                JOIN libraries l ON l.id=sl.library_id
                WHERE sl.schedule_id=? AND l.enabled=1
                ORDER BY l.name COLLATE NOCASE
                """,
                (sched["id"],),
            ).fetchall()

            try:
                trigger = CronTrigger.from_crontab(sched["cron"])
            except ValueError:
                continue

            for lib in libraries:
                scheduler.add_job(
                    scan_manager.create,
                    trigger,
                    args=[
                        lib["kind"],
                        lib["path"],
                        f"schedule:{sched['name']}",
                        bool(sched["apply_changes"]),
                        sched["nfo_policy"],
                        lib["id"],
                        lib["name"],
                        sched["scan_scope"] or "incremental",
                    ],
                    id=f"schedule-{sched['id']}-library-{lib['id']}",
                    replace_existing=True,
                )

    _add_weekly_discord_job()

from __future__ import annotations

from apscheduler.schedulers.asyncio import AsyncIOScheduler
from apscheduler.triggers.cron import CronTrigger

from .scanner import scan_manager
from .settings import get_setting

scheduler = AsyncIOScheduler()


def refresh_schedule() -> None:
    scheduler.remove_all_jobs()
    if get_setting("schedule_enabled", "false").lower() != "true":
        return
    cron = get_setting("schedule_cron", "0 3 * * *")
    trigger = CronTrigger.from_crontab(cron)
    libs = [x.strip() for x in get_setting("schedule_libraries", "movies,tv").split(",") if x.strip()]
    apply = get_setting("schedule_apply", "false").lower() == "true"
    for library in libs:
        scheduler.add_job(scan_manager.create, trigger, args=[library, None, "schedule", apply], id=f"schedule-{library}", replace_existing=True)

from __future__ import annotations

from apscheduler.schedulers.asyncio import AsyncIOScheduler
from apscheduler.triggers.cron import CronTrigger

from .db import connection
from .scanner import scan_manager

scheduler = AsyncIOScheduler()


def refresh_schedule() -> None:
    scheduler.remove_all_jobs()

    with connection() as conn:
        schedules = conn.execute(
            "SELECT id,name,cron,enabled,apply_changes,nfo_policy FROM schedules WHERE enabled=1 ORDER BY id"
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
                    ],
                    id=f"schedule-{sched['id']}-library-{lib['id']}",
                    replace_existing=True,
                )

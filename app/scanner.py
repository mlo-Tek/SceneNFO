from __future__ import annotations

import asyncio
import hashlib
import json
import os
import re
import tempfile
from pathlib import Path
from uuid import uuid4

import httpx

from .db import connection, utcnow
from .services.crowdnfo import CrowdNFOClient
from .services.predb import PreDBClient
from .services.srrdb import SRRDBClient
from .settings import get_setting

GROUP_RE = re.compile(r"-([A-Za-z0-9][A-Za-z0-9._-]{0,40})$")
EP_RE = re.compile(r"(?i)\bS(\d{1,2})E(\d{1,3})(?:[-_. ]?E?(\d{1,3}))?")
GENERIC_NFOS = {"movie.nfo", "tvshow.nfo", "season.nfo"}
NFO_POLICIES = {"replace_all", "missing_only"}
SCAN_SCOPES = {"incremental", "full"}


class ScanManager:
    def __init__(self):
        self.jobs: dict[str, dict] = {}

    def create(
        self,
        library: str,
        path: str | None = None,
        trigger: str = "manual",
        apply: bool = False,
        nfo_policy: str = "replace_all",
        library_id: int | None = None,
        library_name: str | None = None,
        scan_scope: str = "incremental",
    ) -> str:
        if nfo_policy not in NFO_POLICIES:
            nfo_policy = "replace_all"
        if scan_scope not in SCAN_SCOPES:
            scan_scope = "incremental"
        job_id = uuid4().hex
        queue: asyncio.Queue = asyncio.Queue()
        self.jobs[job_id] = {
            "queue": queue,
            "status": "queued",
            "stop": False,
            "run_id": None,
            "nfo_policy": nfo_policy,
            "scan_scope": scan_scope,
            "library_id": library_id,
            "library_name": library_name,
        }
        asyncio.create_task(
            self._run(
                job_id,
                library,
                path,
                trigger,
                apply,
                nfo_policy,
                library_id,
                library_name,
                scan_scope,
            )
        )
        return job_id

    async def events(self, job_id: str):
        job = self.jobs[job_id]
        while True:
            event = await job["queue"].get()
            yield f"data: {json.dumps(event, ensure_ascii=False)}\n\n"
            if event.get("type") in {"complete", "cancelled", "fatal"}:
                break

    def stop(self, job_id: str):
        if job_id in self.jobs:
            self.jobs[job_id]["stop"] = True

    async def _emit(self, job_id: str, run_id: int, event: dict, level: str = "INFO"):
        await self.jobs[job_id]["queue"].put(event)
        with connection() as conn:
            conn.execute(
                "INSERT INTO run_events(run_id,ts,level,event,message,payload) VALUES(?,?,?,?,?,?)",
                (
                    run_id,
                    utcnow(),
                    level,
                    event.get("type", "event"),
                    event.get("message", ""),
                    json.dumps(event, ensure_ascii=False),
                ),
            )

    async def _run(
        self,
        job_id: str,
        library: str,
        path: str | None,
        trigger: str,
        apply: bool,
        nfo_policy: str,
        library_id: int | None,
        library_name: str | None,
        scan_scope: str,
    ):
        job = self.jobs[job_id]
        job["status"] = "running"
        root = Path(path or get_setting("movies_path" if library == "movies" else "tv_path"))
        display_name = library_name or ("Movies" if library == "movies" else "TV Shows")
        mode = "apply" if apply else "dry-run"

        with connection() as conn:
            cur = conn.execute(
                """
                INSERT INTO runs(
                    kind,library,library_id,library_name,nfo_policy,scan_scope,
                    mode,trigger,status,started_at
                ) VALUES('scan',?,?,?,?,?,?,?,?,?)
                """,
                (
                    library,
                    library_id,
                    display_name,
                    nfo_policy,
                    scan_scope,
                    mode,
                    trigger,
                    "running",
                    utcnow(),
                ),
            )
            run_id = cur.lastrowid
        job["run_id"] = run_id

        await self._emit(
            job_id,
            run_id,
            {
                "type": "start",
                "message": f"Scanning {display_name}",
                "library": library,
                "library_id": library_id,
                "library_name": display_name,
                "path": str(root),
                "mode": mode,
                "nfo_policy": nfo_policy,
                "scan_scope": scan_scope,
            },
        )

        try:
            discovered = self._find_mkvs(root)
            candidates, skipped, removed = self._scan_candidates(
                root, discovered, library_id, scan_scope
            )
            total = len(candidates)
            await self._emit(
                job_id,
                run_id,
                {
                    "type": "inventory",
                    "message": (
                        f"Found {len(discovered)} MKVs; {total} queued, "
                        f"{skipped} unchanged, {removed} removed"
                    ),
                    "total": total,
                    "discovered": len(discovered),
                    "queued": total,
                    "skipped": skipped,
                    "removed": removed,
                    "scan_scope": scan_scope,
                },
            )

            predb = PreDBClient(get_setting("predb_base_url", "https://predb.club"))
            srrdb = SRRDBClient(get_setting("srrdb_base_url", "https://api.srrdb.com"))
            crowd = CrowdNFOClient(
                get_setting("crowdnfo_base_url", "https://crowdnfo.net"),
                get_setting("crowdnfo_api_key", ""),
            )
            priority = [
                x.strip().lower()
                for x in get_setting("source_priority", "srrdb,predb,crowdnfo").split(",")
                if x.strip()
            ]

            scanned = scene = p2p = errors = created = replaced = 0

            for idx, media in enumerate(candidates, 1):
                if job["stop"]:
                    job["status"] = "cancelled"
                    self._finish_run(
                        run_id,
                        "cancelled",
                        scanned,
                        scene,
                        p2p,
                        created,
                        replaced,
                        errors,
                        skipped,
                        removed,
                    )
                    await self._emit(
                        job_id,
                        run_id,
                        {
                            "type": "cancelled",
                            "message": "Scan cancelled",
                            "scanned": scanned,
                            "total": total,
                            "skipped": skipped,
                            "removed": removed,
                        },
                        "WARNING",
                    )
                    return

                release = media.name[:-4]  # intentionally only strip final .mkv
                try:
                    file_stat = media.stat()
                    pre = await predb.exact_release(release)
                    classification = "scene" if pre else "p2p"
                    group = (
                        str(pre.get("team") or "").strip()
                        if pre
                        else self._p2p_group(release)
                    ) or None
                    pre_id = pre.get("id") if pre else None
                    action = "P2P"
                    source_name = None
                    selected = None
                    target = None
                    source_status = {}
                    digest_before = None
                    digest_after = None
                    replace_candidates: list[Path] = []

                    if pre and group:
                        scene += 1

                        # For missing-only runs, local NFO detection is enough to
                        # decide whether upstream NFO sources need to be queried.
                        replace_candidates = self._replace_candidates(
                            media, release, group, [], library
                        )
                        if nfo_policy == "missing_only" and replace_candidates:
                            action = "SKIPPED_PRESENT" if apply else "WOULD_SKIP_PRESENT"
                        else:
                            candidates_by_source = {}
                            try:
                                candidates_by_source["srrdb"] = await srrdb.nfo(release)
                            except Exception as exc:
                                source_status["srrdb"] = f"ERROR: {exc}"
                            try:
                                candidates_by_source["predb"] = await predb.nfo(int(pre_id))
                            except Exception as exc:
                                source_status["predb"] = f"ERROR: {exc}"
                            try:
                                candidates_by_source["crowdnfo"] = await crowd.nfo(release)
                            except Exception as exc:
                                source_status["crowdnfo"] = f"ERROR: {exc}"

                            for key in ("srrdb", "predb", "crowdnfo"):
                                if key not in source_status:
                                    source_status[key] = (
                                        "FOUND" if candidates_by_source.get(key) else "NOT_FOUND"
                                    )

                            for key in priority:
                                if candidates_by_source.get(key):
                                    source_name = key
                                    selected = candidates_by_source[key]
                                    break

                            source_names = [
                                x.get("filename")
                                for x in candidates_by_source.values()
                                if x
                            ]
                            replace_candidates = self._replace_candidates(
                                media, release, group, source_names, library
                            )

                            if selected and selected.get("url"):
                                target_name = selected.get("filename") or f"{release}.nfo"
                                target = media.parent / Path(target_name).name
                                action = (
                                    "WOULD_REPLACE" if replace_candidates else "WOULD_CREATE"
                                )
                                digest_before = (
                                    self._sha256(replace_candidates[0])
                                    if replace_candidates
                                    else None
                                )

                                if apply:
                                    raw = await self._download_nfo(
                                        selected["url"],
                                        crowd.api_key if source_name == "crowdnfo" else "",
                                    )
                                    self._validate_nfo(raw)
                                    digest_after = hashlib.sha256(raw).hexdigest()
                                    self._atomic_write(target, raw)

                                    if nfo_policy == "replace_all":
                                        for old in replace_candidates:
                                            if old != target and old.exists():
                                                old.unlink()

                                    if replace_candidates:
                                        replaced += 1
                                        action = (
                                            "REPLACED_IDENTICAL"
                                            if digest_before and digest_before == digest_after
                                            else "REPLACED_CHANGED"
                                        )
                                    else:
                                        created += 1
                                        action = "CREATED"
                            else:
                                action = "NO_SOURCE"
                    else:
                        p2p += 1

                    scanned += 1
                    nfos_after = self._all_nfos(media.parent)
                    nfo_path = str(
                        target
                        if target and target.exists()
                        else (
                            replace_candidates[0]
                            if replace_candidates
                            else (nfos_after[0] if nfos_after else "")
                        )
                    ) or None
                    nfo_present = bool(replace_candidates or nfos_after)

                    with connection() as conn:
                        previous = conn.execute(
                            "SELECT nfo_source FROM library_items WHERE media_path=?",
                            (str(media),),
                        ).fetchone()
                        recorded_source = (
                            source_name
                            if apply
                            and action
                            in {"CREATED", "REPLACED_IDENTICAL", "REPLACED_CHANGED"}
                            else (previous["nfo_source"] if previous else None)
                        )
                        conn.execute(
                            """
                            INSERT INTO library_items(
                              library,library_id,media_path,title,release_name,classification,
                              release_group,predb_id,nfo_path,nfo_source,nfo_present,last_result,
                              last_checked_at,file_size,file_mtime_ns
                            ) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
                            ON CONFLICT(media_path) DO UPDATE SET
                              library=excluded.library,library_id=excluded.library_id,
                              title=excluded.title,release_name=excluded.release_name,
                              classification=excluded.classification,
                              release_group=excluded.release_group,predb_id=excluded.predb_id,
                              nfo_path=excluded.nfo_path,nfo_source=excluded.nfo_source,
                              nfo_present=excluded.nfo_present,last_result=excluded.last_result,
                              last_checked_at=excluded.last_checked_at,
                              file_size=excluded.file_size,file_mtime_ns=excluded.file_mtime_ns
                            """,
                            (
                                library,
                                library_id,
                                str(media),
                                media.parent.name,
                                release,
                                classification,
                                group,
                                pre_id,
                                nfo_path,
                                recorded_source,
                                int(nfo_present),
                                action,
                                utcnow(),
                                int(file_stat.st_size),
                                int(file_stat.st_mtime_ns),
                            ),
                        )

                    await self._emit(
                        job_id,
                        run_id,
                        {
                            "type": "item",
                            "message": release,
                            "index": idx,
                            "total": total,
                            "media_path": str(media),
                            "title": media.parent.name,
                            "release": release,
                            "classification": classification,
                            "group": group,
                            "predb_id": pre_id,
                            "nfo_present": nfo_present,
                            "nfo_path": nfo_path,
                            "nfo_source": source_name,
                            "source_status": source_status,
                            "action": action,
                            "target": str(target) if target else None,
                            "nfo_policy": nfo_policy,
                            "scan_scope": scan_scope,
                            "library_id": library_id,
                            "library_name": display_name,
                        },
                    )
                except Exception as exc:
                    errors += 1
                    scanned += 1
                    await self._emit(
                        job_id,
                        run_id,
                        {
                            "type": "item_error",
                            "message": str(exc),
                            "index": idx,
                            "total": total,
                            "media_path": str(media),
                            "library_id": library_id,
                            "library_name": display_name,
                        },
                        "ERROR",
                    )

            self._finish_run(
                run_id,
                "completed",
                scanned,
                scene,
                p2p,
                created,
                replaced,
                errors,
                skipped,
                removed,
            )
            job["status"] = "completed"
            await self._emit(
                job_id,
                run_id,
                {
                    "type": "complete",
                    "message": "Scan complete",
                    "scanned": scanned,
                    "scene": scene,
                    "p2p": p2p,
                    "created": created,
                    "replaced": replaced,
                    "errors": errors,
                    "total": total,
                    "discovered": len(discovered),
                    "skipped": skipped,
                    "removed": removed,
                    "nfo_policy": nfo_policy,
                    "scan_scope": scan_scope,
                    "library_id": library_id,
                    "library_name": display_name,
                },
            )
        except Exception as exc:
            job["status"] = "fatal"
            with connection() as conn:
                conn.execute(
                    "UPDATE runs SET status='failed',finished_at=?,errors=errors+1 WHERE id=?",
                    (utcnow(), run_id),
                )
            await self._emit(
                job_id, run_id, {"type": "fatal", "message": str(exc)}, "ERROR"
            )

    def _scan_candidates(
        self,
        root: Path,
        discovered: list[Path],
        library_id: int | None,
        scan_scope: str,
    ) -> tuple[list[Path], int, int]:
        """Return files requiring remote work, unchanged count and removed count.

        Successful legacy rows have no fingerprint yet. On the first incremental
        scan after upgrading, they are backfilled from local stat data and kept
        without another PreDB lookup. Rows that never completed successfully do
        not exist and therefore remain candidates.
        """
        if library_id is None:
            return discovered, 0, 0

        current = {str(p): p for p in discovered}
        rows = []
        with connection() as conn:
            all_rows = conn.execute(
                """
                SELECT id,media_path,release_name,file_size,file_mtime_ns
                FROM library_items WHERE library_id=?
                """,
                (library_id,),
            ).fetchall()
            rows = [row for row in all_rows if self._path_in_root(Path(row["media_path"]), root)]

            removed_rows = [row for row in rows if row["media_path"] not in current]
            if removed_rows:
                conn.executemany(
                    "DELETE FROM library_items WHERE id=?",
                    [(row["id"],) for row in removed_rows],
                )

            if scan_scope == "full":
                return discovered, 0, len(removed_rows)

            by_path = {row["media_path"]: row for row in rows}
            queued: list[Path] = []
            skipped = 0
            for media in discovered:
                row = by_path.get(str(media))
                if not row:
                    queued.append(media)
                    continue

                release = media.name[:-4]
                try:
                    st = media.stat()
                except OSError:
                    queued.append(media)
                    continue

                # One-time migration/backfill for successful pre-0.3.3 rows.
                if row["file_size"] is None or row["file_mtime_ns"] is None:
                    if row["release_name"] == release:
                        conn.execute(
                            """
                            UPDATE library_items
                            SET file_size=?,file_mtime_ns=?
                            WHERE id=?
                            """,
                            (int(st.st_size), int(st.st_mtime_ns), row["id"]),
                        )
                        skipped += 1
                        continue
                    queued.append(media)
                    continue

                unchanged = (
                    row["release_name"] == release
                    and int(row["file_size"]) == int(st.st_size)
                    and int(row["file_mtime_ns"]) == int(st.st_mtime_ns)
                )
                if unchanged:
                    skipped += 1
                else:
                    queued.append(media)

        return queued, skipped, len(removed_rows)

    @staticmethod
    def _path_in_root(path: Path, root: Path) -> bool:
        if root.is_file():
            return path == root
        try:
            path.relative_to(root)
            return True
        except ValueError:
            return False

    @staticmethod
    def _find_mkvs(root: Path) -> list[Path]:
        result = []
        if root.is_file() and root.suffix.lower() == ".mkv":
            return [root]
        if not root.exists():
            raise FileNotFoundError(f"Library path does not exist: {root}")
        for dirpath, dirnames, filenames in os.walk(root):
            dirnames.sort(key=str.casefold)
            for name in sorted(filenames, key=str.casefold):
                if name.lower().endswith(".mkv"):
                    result.append(Path(dirpath) / name)
        return result

    @staticmethod
    def _all_nfos(folder: Path) -> list[Path]:
        return sorted(
            [p for p in folder.iterdir() if p.is_file() and p.suffix.lower() == ".nfo"],
            key=lambda p: p.name.casefold(),
        )

    @staticmethod
    def _p2p_group(release: str) -> str | None:
        m = GROUP_RE.search(release)
        return m.group(1) if m else None

    @staticmethod
    def _episode_key(name: str) -> str | None:
        m = EP_RE.search(name or "")
        if not m:
            return None
        s, e1, e2 = int(m.group(1)), int(m.group(2)), m.group(3)
        return f"S{s:02d}E{e1:02d}" + (f"E{int(e2):02d}" if e2 else "")

    def _replace_candidates(
        self,
        media: Path,
        release: str,
        group: str,
        source_names: list[str | None],
        library: str,
    ) -> list[Path]:
        wanted = {f"{release}.nfo".casefold()}
        wanted.update(Path(x).name.casefold() for x in source_names if x)
        media_ep = self._episode_key(media.name)
        out = []
        for nfo in self._all_nfos(media.parent):
            name_cf = nfo.name.casefold()
            if name_cf in GENERIC_NFOS:
                continue
            if name_cf in wanted:
                out.append(nfo)
                continue
            if library == "movies" and Path(nfo.name).stem.casefold().endswith(
                "-" + group.casefold()
            ):
                out.append(nfo)
                continue
            if library == "tv":
                nfo_ep = self._episode_key(nfo.name)
                if (
                    media_ep
                    and nfo_ep == media_ep
                    and Path(nfo.name).stem.casefold().endswith("-" + group.casefold())
                ):
                    out.append(nfo)
        return out

    @staticmethod
    async def _download_nfo(url: str, api_key: str = "") -> bytes:
        headers = {"User-Agent": "SceneNFO/0.3"}
        if api_key:
            headers["X-Api-Key"] = api_key
        async with httpx.AsyncClient(timeout=30, follow_redirects=True) as client:
            r = await client.get(url, headers=headers)
            r.raise_for_status()
            return r.content

    @staticmethod
    def _validate_nfo(raw: bytes) -> None:
        if len(raw) < 32:
            raise ValueError("Downloaded NFO is too small")
        head = raw[:256].lstrip().lower()
        if (
            head.startswith(b"<html")
            or head.startswith(b"<!doctype")
            or head.startswith(b"{")
            or head.startswith(b"[")
        ):
            raise ValueError("Downloaded content does not look like an NFO")

    @staticmethod
    def _atomic_write(target: Path, raw: bytes) -> None:
        target.parent.mkdir(parents=True, exist_ok=True)
        fd, tmp = tempfile.mkstemp(prefix=".scenenfo-", suffix=".tmp", dir=target.parent)
        try:
            with os.fdopen(fd, "wb") as fh:
                fh.write(raw)
                fh.flush()
                os.fsync(fh.fileno())
            os.replace(tmp, target)
        finally:
            if os.path.exists(tmp):
                os.unlink(tmp)

    @staticmethod
    def _sha256(path: Path) -> str | None:
        try:
            return hashlib.sha256(path.read_bytes()).hexdigest()
        except Exception:
            return None

    @staticmethod
    def _finish_run(
        run_id: int,
        status: str,
        scanned: int,
        scene: int,
        p2p: int,
        created: int,
        replaced: int,
        errors: int,
        skipped: int = 0,
        removed: int = 0,
    ):
        with connection() as conn:
            conn.execute(
                """
                UPDATE runs
                SET status=?,finished_at=?,scanned=?,scene=?,p2p=?,created=?,
                    replaced=?,errors=?,skipped=?,removed=?
                WHERE id=?
                """,
                (
                    status,
                    utcnow(),
                    scanned,
                    scene,
                    p2p,
                    created,
                    replaced,
                    errors,
                    skipped,
                    removed,
                    run_id,
                ),
            )


scan_manager = ScanManager()

from __future__ import annotations

from concurrent.futures import Executor, ThreadPoolExecutor
from dataclasses import replace
from datetime import datetime, timezone
from pathlib import Path
from threading import RLock

from .analyzer import analyze_snapshot
from .models import AnalysisStatus
from .parsers.base import FlpParser
from .repository import StudioRepository, StudioScanJob
from .scanner import (
    FileChangedDuringRead,
    FileObservation,
    discover_flp_files,
    discover_project_assets,
    is_stable,
    observe_file,
    sha256_file,
)


class StudioService:
    def __init__(
        self,
        repository: StudioRepository,
        parser: FlpParser,
        executor: Executor | None = None,
    ) -> None:
        self._repository = repository
        self._parser = parser
        self._executor = (
            executor
            if executor is not None
            else ThreadPoolExecutor(
                max_workers=1,
                thread_name_prefix="studio-scan",
            )
        )
        self._lock = RLock()
        self._jobs: dict[str, StudioScanJob] = {}
        self._active_job_id: str | None = None
        self._closed = False

    def start_scan(self) -> StudioScanJob:
        with self._lock:
            self._ensure_open()
            active = self._active_job()
            if active is not None:
                return active
            job = self._repository.create_scan_job(status="queued")
            self._jobs[job.id] = job
            self._active_job_id = job.id

        try:
            self._executor.submit(self._run_job, job.id)
        except Exception as exc:
            self._update_job(job.id, status="failed", error=str(exc))
            with self._lock:
                if self._active_job_id == job.id:
                    self._active_job_id = None
            raise
        return job

    def run_scan_now(self) -> StudioScanJob:
        with self._lock:
            self._ensure_open()
            active = self._active_job()
            if active is not None:
                return active
            job = self._repository.create_scan_job(status="queued")
            self._jobs[job.id] = job
            self._active_job_id = job.id

        self._run_job(job.id)
        return self.get_scan_job(job.id)

    def get_scan_job(self, job_id: str) -> StudioScanJob:
        with self._lock:
            try:
                return self._jobs[job_id]
            except KeyError:
                raise KeyError(job_id) from None

    def close(self) -> None:
        with self._lock:
            if self._closed:
                return
            self._closed = True
        self._executor.shutdown(wait=False, cancel_futures=True)

    def _run_job(self, job_id: str) -> None:
        counts = {
            "discovered_count": 0,
            "parsed_count": 0,
            "cached_count": 0,
            "failed_count": 0,
        }
        try:
            self._update_job(job_id, status="running")
            roots = [Path(root.path) for root in self._repository.list_roots()]
            discovered_files = discover_flp_files(roots)
            counts["discovered_count"] = len(discovered_files)
            self._update_job(job_id, **counts)

            for discovered in discovered_files:
                modified_at = _modified_ns_to_utc_iso(discovered.modified_ns)
                project = self._repository.upsert_project(
                    discovered.path,
                    display_name=discovered.path.stem,
                    status=AnalysisStatus.DISCOVERED,
                    modified_at=modified_at,
                )
                first_observation = FileObservation(
                    path=discovered.path,
                    size=discovered.size,
                    modified_ns=discovered.modified_ns,
                )
                try:
                    second_observation = observe_file(discovered.path)
                    if not is_stable(first_observation, second_observation):
                        raise FileChangedDuringRead(
                            f"{discovered.path} changed after discovery"
                        )
                    source_hash = sha256_file(
                        discovered.path,
                        expected=second_observation,
                    )
                except (OSError, ValueError, FileChangedDuringRead):
                    self._repository.upsert_project(
                        discovered.path,
                        display_name=discovered.path.stem,
                        status=AnalysisStatus.STALE,
                        modified_at=modified_at,
                    )
                    counts["failed_count"] += 1
                    self._update_job(job_id, **counts)
                    continue

                try:
                    cached = self._repository.find_snapshot_by_hash(
                        project.id,
                        source_hash,
                    )
                except KeyError:
                    cached = None

                if cached is not None:
                    self._repository.upsert_project(
                        discovered.path,
                        display_name=discovered.path.stem,
                        status=cached.snapshot.status,
                        modified_at=modified_at,
                    )
                    counts["cached_count"] += 1
                    self._update_job(job_id, **counts)
                    continue

                try:
                    self._repository.upsert_project(
                        discovered.path,
                        display_name=discovered.path.stem,
                        status=AnalysisStatus.PARSING,
                        modified_at=modified_at,
                    )
                    parsed = self._parser.parse(
                        discovered.path,
                        source_hash=source_hash,
                    )
                    with_assets = replace(
                        parsed,
                        related_assets=discover_project_assets(discovered.path),
                    )
                    analyzed = analyze_snapshot(with_assets)
                    self._repository.save_snapshot(project.id, analyzed)
                except Exception:
                    self._repository.upsert_project(
                        discovered.path,
                        display_name=discovered.path.stem,
                        status=AnalysisStatus.FAILED,
                        modified_at=modified_at,
                    )
                    counts["failed_count"] += 1
                else:
                    counts["parsed_count"] += 1
                self._update_job(job_id, **counts)

            self._update_job(job_id, status="completed", **counts)
        except Exception as exc:
            self._update_job(
                job_id,
                status="failed",
                error=str(exc),
                **counts,
            )
        finally:
            with self._lock:
                if self._active_job_id == job_id:
                    self._active_job_id = None

    def _update_job(self, job_id: str, **updates: object) -> StudioScanJob:
        job = self._repository.update_scan_job(job_id, **updates)
        with self._lock:
            self._jobs[job.id] = job
        return job

    def _active_job(self) -> StudioScanJob | None:
        if self._active_job_id is None:
            return None
        active = self._jobs[self._active_job_id]
        if active.status in {"queued", "running"}:
            return active
        self._active_job_id = None
        return None

    def _ensure_open(self) -> None:
        if self._closed:
            raise RuntimeError("StudioService is closed")


def _modified_ns_to_utc_iso(modified_ns: int) -> str:
    seconds, nanoseconds = divmod(modified_ns, 1_000_000_000)
    return datetime.fromtimestamp(seconds, timezone.utc).replace(
        microsecond=nanoseconds // 1_000
    ).isoformat()

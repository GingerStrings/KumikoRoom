from __future__ import annotations

from concurrent.futures import Executor, Future, ThreadPoolExecutor
from dataclasses import replace
from datetime import datetime, timezone
from pathlib import Path
from threading import RLock

from .analyzer import analyze_snapshot
from .models import AnalysisStatus
from .parsers.base import FlpParseError, FlpParser
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
        self._active_job_id: str | None = None
        self._active_future: Future[object] | None = None
        self._closed = False

    def start_scan(self) -> StudioScanJob:
        with self._lock:
            self._ensure_open()
            active = self._active_job()
            if active is not None:
                return active
            job = self._repository.create_scan_job(status="queued")
            self._active_job_id = job.id

        try:
            future = self._executor.submit(self._run_job, job.id)
        except Exception as exc:
            self._update_job(
                job.id,
                status="failed",
                error=_error_text(exc),
            )
            with self._lock:
                if self._active_job_id == job.id:
                    self._active_job_id = None
                    self._active_future = None
            raise
        with self._lock:
            if self._active_job_id == job.id:
                self._active_future = future
        future.add_done_callback(
            lambda completed, job_id=job.id: self._scan_future_done(
                job_id,
                completed,
            )
        )
        return job

    def run_scan_now(self) -> StudioScanJob:
        with self._lock:
            self._ensure_open()
            active = self._active_job()
            if active is not None:
                return active
            job = self._repository.create_scan_job(status="queued")
            self._active_job_id = job.id
            self._active_future = None

        self._run_job(job.id)
        return self.get_scan_job(job.id)

    def get_scan_job(self, job_id: str) -> StudioScanJob:
        return self._repository.get_scan_job(job_id)

    def close(self) -> None:
        with self._lock:
            if self._closed:
                return
            self._closed = True
            active_future = self._active_future
        if active_future is not None:
            active_future.cancel()
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
                    self._repository.activate_snapshot(
                        project.id,
                        cached.id,
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
                except FlpParseError:
                    self._repository.upsert_project(
                        discovered.path,
                        display_name=discovered.path.stem,
                        status=AnalysisStatus.FAILED,
                        modified_at=modified_at,
                    )
                    counts["failed_count"] += 1
                    self._update_job(job_id, **counts)
                    continue
                except Exception:
                    counts["failed_count"] += 1
                    self._try_mark_project_failed(discovered.path, modified_at)
                    self._update_job(job_id, **counts)
                    raise

                try:
                    with_assets = replace(
                        parsed,
                        related_assets=discover_project_assets(discovered.path),
                    )
                    analyzed = analyze_snapshot(with_assets)
                except Exception:
                    counts["failed_count"] += 1
                    self._try_mark_project_failed(discovered.path, modified_at)
                    self._update_job(job_id, **counts)
                    raise

                try:
                    verified_hash = sha256_file(
                        discovered.path,
                        expected=second_observation,
                    )
                    if verified_hash != source_hash:
                        raise FileChangedDuringRead(
                            f"{discovered.path} changed after hashing"
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
                    self._repository.save_snapshot(project.id, analyzed)
                except Exception:
                    counts["failed_count"] += 1
                    self._try_mark_project_failed(discovered.path, modified_at)
                    self._update_job(job_id, **counts)
                    raise

                counts["parsed_count"] += 1
                self._update_job(job_id, **counts)

            self._update_job(job_id, status="completed", **counts)
        except Exception as exc:
            self._update_job(
                job_id,
                status="failed",
                error=_error_text(exc),
                **counts,
            )
        finally:
            with self._lock:
                if self._active_job_id == job_id:
                    self._active_job_id = None
                    self._active_future = None

    def _try_mark_project_failed(self, path: Path, modified_at: str) -> None:
        try:
            self._repository.upsert_project(
                path,
                display_name=path.stem,
                status=AnalysisStatus.FAILED,
                modified_at=modified_at,
            )
        except Exception:
            pass

    def _update_job(self, job_id: str, **updates: object) -> StudioScanJob:
        return self._repository.update_scan_job(job_id, **updates)

    def _scan_future_done(
        self,
        job_id: str,
        future: Future[object],
    ) -> None:
        failure: str | None = None
        if future.cancelled():
            failure = "Studio scan cancelled before execution"
        else:
            exception = future.exception()
            if exception is not None:
                failure = _error_text(exception)

        if failure is not None:
            try:
                current = self._repository.get_scan_job(job_id)
                if current.status in {"queued", "running"}:
                    self._repository.update_scan_job(
                        job_id,
                        status="failed",
                        error=failure,
                    )
            except Exception:
                pass

        with self._lock:
            if self._active_job_id == job_id:
                self._active_job_id = None
                if self._active_future is future:
                    self._active_future = None

    def _active_job(self) -> StudioScanJob | None:
        if self._active_job_id is None:
            return None
        active = self._repository.get_scan_job(self._active_job_id)
        if active.status in {"queued", "running"}:
            return active
        self._active_job_id = None
        self._active_future = None
        return None

    def _ensure_open(self) -> None:
        if self._closed:
            raise RuntimeError("StudioService is closed")


def _modified_ns_to_utc_iso(modified_ns: int) -> str:
    seconds, nanoseconds = divmod(modified_ns, 1_000_000_000)
    return datetime.fromtimestamp(seconds, timezone.utc).replace(
        microsecond=nanoseconds // 1_000
    ).isoformat()


def _error_text(exc: BaseException) -> str:
    return str(exc) or type(exc).__name__

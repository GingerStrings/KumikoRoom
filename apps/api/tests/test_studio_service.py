from __future__ import annotations

import hashlib
import os
from concurrent.futures import Future, ThreadPoolExecutor
from datetime import datetime, timezone
from pathlib import Path
from threading import Event, current_thread
from typing import Callable

import pytest

from kumikoroom.studio import service as studio_service
from kumikoroom.studio.models import (
    AnalysisStatus,
    FlpAnalysisSnapshot,
    ProjectInfo,
)
from kumikoroom.studio.parsers.base import FlpParseError
from kumikoroom.studio.repository import (
    StudioRepository,
    StudioScanJob,
    StudioSnapshotRecord,
)
from kumikoroom.studio.scanner import FileChangedDuringRead, FileObservation
from kumikoroom.studio.service import StudioService


class InlineExecutor:
    def __init__(self) -> None:
        self.submissions = 0

    def submit(self, function: Callable[..., object], *args: object) -> Future[object]:
        self.submissions += 1
        future: Future[object] = Future()
        try:
            future.set_result(function(*args))
        except BaseException as exc:
            future.set_exception(exc)
        return future

    def shutdown(self, *, wait: bool, cancel_futures: bool) -> None:
        pass


class PausedExecutor:
    def __init__(self) -> None:
        self.tasks: list[
            tuple[Future[object], Callable[..., object], tuple[object, ...]]
        ] = []

    def submit(self, function: Callable[..., object], *args: object) -> Future[object]:
        future: Future[object] = Future()
        self.tasks.append((future, function, args))
        return future

    def run_next(self) -> None:
        future, function, args = self.tasks.pop(0)
        try:
            future.set_result(function(*args))
        except BaseException as exc:
            future.set_exception(exc)

    def shutdown(self, *, wait: bool, cancel_futures: bool) -> None:
        pass


class ShutdownRecordingExecutor(PausedExecutor):
    def __init__(self) -> None:
        super().__init__()
        self.shutdown_calls: list[tuple[bool, bool]] = []

    def shutdown(self, *, wait: bool, cancel_futures: bool) -> None:
        self.shutdown_calls.append((wait, cancel_futures))


class FalseyExecutor(ShutdownRecordingExecutor):
    def __bool__(self) -> bool:
        return False


class RecordingParser:
    def __init__(
        self,
        *,
        failing_names: set[str] | None = None,
        status: AnalysisStatus = AnalysisStatus.READY,
    ) -> None:
        self.failing_names = failing_names or set()
        self.status = status
        self.calls: list[tuple[Path, str]] = []
        self.thread_names: list[str] = []

    def parse(self, path: Path, *, source_hash: str) -> FlpAnalysisSnapshot:
        self.calls.append((path, source_hash))
        self.thread_names.append(current_thread().name)
        if path.name in self.failing_names:
            raise FlpParseError(
                path,
                "parse",
                f"cannot parse {path.name}",
            )
        return FlpAnalysisSnapshot(
            source_path=str(path),
            source_hash=source_hash,
            status=self.status,
            project=ProjectInfo(title=path.stem),
        )


class MetadataRestoringMutatingParser:
    def __init__(self, replacement: bytes) -> None:
        self.replacement = replacement

    def parse(self, path: Path, *, source_hash: str) -> FlpAnalysisSnapshot:
        details = path.stat()
        path.write_bytes(self.replacement)
        os.utime(
            path,
            ns=(details.st_atime_ns, details.st_mtime_ns),
        )
        return FlpAnalysisSnapshot(
            source_path=str(path),
            source_hash=hashlib.sha256(self.replacement).hexdigest(),
            status=AnalysisStatus.READY,
            project=ProjectInfo(title=path.stem),
        )


class DeletingParser(RecordingParser):
    def __init__(self, deleting_name: str) -> None:
        super().__init__()
        self.deleting_name = deleting_name

    def parse(self, path: Path, *, source_hash: str) -> FlpAnalysisSnapshot:
        snapshot = super().parse(path, source_hash=source_hash)
        if path.name == self.deleting_name:
            path.unlink()
        return snapshot


class UnwrappedFailingParser:
    def __init__(self, failing_name: str) -> None:
        self.failing_name = failing_name
        self.calls: list[Path] = []

    def parse(self, path: Path, *, source_hash: str) -> FlpAnalysisSnapshot:
        self.calls.append(path)
        if path.name == self.failing_name:
            raise RuntimeError(f"unexpected parser failure: {path.name}")
        return FlpAnalysisSnapshot(
            source_path=str(path),
            source_hash=source_hash,
            status=AnalysisStatus.READY,
            project=ProjectInfo(title=path.stem),
        )


class UpdateRecordingRepository(StudioRepository):
    def __init__(self, db_path: Path) -> None:
        super().__init__(db_path)
        self.job_updates: list[StudioScanJob] = []

    def update_scan_job(self, job_id: str, **updates: object) -> StudioScanJob:
        job = super().update_scan_job(job_id, **updates)
        self.job_updates.append(job)
        return job


class ToggleSaveRepository(StudioRepository):
    def __init__(self, db_path: Path) -> None:
        super().__init__(db_path)
        self.fail_saves = False

    def save_snapshot(
        self,
        project_id: str,
        snapshot: FlpAnalysisSnapshot,
        *,
        analyzed_at: str | None = None,
    ) -> StudioSnapshotRecord:
        if self.fail_saves:
            raise RuntimeError("snapshot store unavailable")
        return super().save_snapshot(
            project_id,
            snapshot,
            analyzed_at=analyzed_at,
        )


def test_run_scan_now_isolates_failures_and_reuses_successful_hashes(
    tmp_path: Path,
) -> None:
    root = tmp_path / "Projects"
    root.mkdir()
    good = root / "Good.flp"
    broken = root / "Broken.flp"
    good.write_bytes(b"good-project")
    broken.write_bytes(b"broken-project")
    renders = root / "Renders"
    renders.mkdir()
    mix = renders / "Mix.wav"
    mix.write_bytes(b"render")
    repository = StudioRepository(tmp_path / "studio.sqlite3")
    repository.add_root(root)
    parser = RecordingParser(failing_names={"Broken.flp"})
    service = StudioService(repository, parser, executor=InlineExecutor())

    first = service.run_scan_now()
    second = service.run_scan_now()

    assert first.status == "completed"
    assert first.discovered_count == 2
    assert first.parsed_count == 1
    assert first.cached_count == 0
    assert first.failed_count == 1
    assert second.status == "completed"
    assert second.discovered_count == 2
    assert second.parsed_count == 0
    assert second.cached_count == 1
    assert second.failed_count == 1
    projects = {project.display_name: project for project in repository.list_projects()}
    assert set(projects) == {"Good", "Broken"}
    assert projects["Good"].status is AnalysisStatus.READY
    assert projects["Broken"].status is AnalysisStatus.FAILED
    snapshot = repository.get_latest_snapshot(projects["Good"].id).snapshot
    assert snapshot.related_assets[0].path == str(mix.resolve())
    assert parser.calls == [
        (broken.resolve(), hashlib.sha256(b"broken-project").hexdigest()),
        (good.resolve(), hashlib.sha256(b"good-project").hexdigest()),
        (broken.resolve(), hashlib.sha256(b"broken-project").hexdigest()),
    ]


def test_start_scan_deduplicates_active_jobs_and_allows_a_later_job(
    tmp_path: Path,
) -> None:
    repository = StudioRepository(tmp_path / "studio.sqlite3")
    executor = PausedExecutor()
    service = StudioService(repository, RecordingParser(), executor=executor)

    first = service.start_scan()
    duplicate = service.start_scan()
    synchronous_duplicate = service.run_scan_now()

    assert first.status == "queued"
    assert duplicate.id == first.id
    assert synchronous_duplicate.id == first.id
    assert len(executor.tasks) == 1
    assert service.get_scan_job(first.id) == first
    executor.run_next()
    assert service.get_scan_job(first.id).status == "completed"

    later = service.start_scan()

    assert later.id != first.id
    assert len(executor.tasks) == 1
    with pytest.raises(KeyError, match="unknown-job"):
        service.get_scan_job("unknown-job")


def test_start_scan_submits_outside_the_lock_for_inline_execution(
    tmp_path: Path,
) -> None:
    executor = InlineExecutor()
    service = StudioService(
        StudioRepository(tmp_path / "studio.sqlite3"),
        RecordingParser(),
        executor=executor,
    )

    started = service.start_scan()

    assert started.status == "queued"
    assert executor.submissions == 1
    assert service.get_scan_job(started.id).status == "completed"


def test_get_scan_job_uses_persisted_repository_state(tmp_path: Path) -> None:
    repository = StudioRepository(tmp_path / "studio.sqlite3")
    persisted = repository.create_scan_job(status="queued")
    service = StudioService(repository, RecordingParser(), executor=InlineExecutor())

    assert service.get_scan_job(persisted.id) == persisted

    failed = repository.update_scan_job(
        persisted.id,
        status="failed",
        error="persisted failure",
    )

    assert service.get_scan_job(persisted.id) == failed
    with pytest.raises(KeyError, match="unknown-job"):
        service.get_scan_job("unknown-job")


def test_close_is_idempotent_and_rejects_new_scans(tmp_path: Path) -> None:
    executor = ShutdownRecordingExecutor()
    service = StudioService(
        StudioRepository(tmp_path / "studio.sqlite3"),
        RecordingParser(),
        executor=executor,
    )

    service.close()
    service.close()

    assert executor.shutdown_calls == [(False, True)]
    with pytest.raises(RuntimeError, match="closed"):
        service.start_scan()
    with pytest.raises(RuntimeError, match="closed"):
        service.run_scan_now()


def test_close_marks_a_cancelled_queued_scan_failed(tmp_path: Path) -> None:
    executor = ThreadPoolExecutor(max_workers=1)
    worker_started = Event()
    release_worker = Event()

    def occupy_worker() -> None:
        worker_started.set()
        if not release_worker.wait(timeout=10):
            raise TimeoutError("test worker was not released")

    blocker = executor.submit(occupy_worker)
    assert worker_started.wait(timeout=5)
    repository = StudioRepository(tmp_path / "studio.sqlite3")
    service = StudioService(repository, RecordingParser(), executor=executor)
    queued = service.start_scan()
    assert repository.get_scan_job(queued.id).status == "queued"

    try:
        service.close()

        cancelled = service.get_scan_job(queued.id)
        assert cancelled.status == "failed"
        assert cancelled.error == "Studio scan cancelled before execution"
    finally:
        release_worker.set()
        blocker.result(timeout=5)
        executor.shutdown(wait=True, cancel_futures=True)


def test_unstable_file_is_marked_stale_without_parsing(
    monkeypatch: pytest.MonkeyPatch,
    tmp_path: Path,
) -> None:
    root = tmp_path / "Projects"
    root.mkdir()
    source = root / "Changing.flp"
    source.write_bytes(b"changing")
    discovered_details = source.stat()
    repository = StudioRepository(tmp_path / "studio.sqlite3")
    repository.add_root(root)
    parser = RecordingParser()
    service = StudioService(repository, parser, executor=InlineExecutor())

    def changed_observation(path: Path) -> FileObservation:
        return FileObservation(
            path=path.resolve(),
            size=discovered_details.st_size + 1,
            modified_ns=discovered_details.st_mtime_ns,
        )

    monkeypatch.setattr(studio_service, "observe_file", changed_observation)

    job = service.run_scan_now()

    assert job.status == "completed"
    assert job.discovered_count == 1
    assert job.failed_count == 1
    assert job.parsed_count == 0
    assert job.cached_count == 0
    assert parser.calls == []
    project = repository.list_projects()[0]
    assert project.status is AnalysisStatus.STALE
    seconds, nanoseconds = divmod(discovered_details.st_mtime_ns, 1_000_000_000)
    expected_modified_at = datetime.fromtimestamp(seconds, timezone.utc).replace(
        microsecond=nanoseconds // 1_000
    ).isoformat()
    assert project.modified_at == expected_modified_at


def test_failed_reparse_preserves_the_latest_successful_snapshot(
    tmp_path: Path,
) -> None:
    root = tmp_path / "Projects"
    root.mkdir()
    source = root / "History.flp"
    source.write_bytes(b"first revision")
    repository = StudioRepository(tmp_path / "studio.sqlite3")
    repository.add_root(root)
    parser = RecordingParser()
    service = StudioService(repository, parser, executor=InlineExecutor())

    first_job = service.run_scan_now()
    first_project = repository.list_projects()[0]
    first_snapshot = repository.get_latest_snapshot(first_project.id)
    parser.failing_names.add(source.name)
    source.write_bytes(b"second revision that fails")

    failed_job = service.run_scan_now()

    failed_project = repository.get_project(first_project.id)
    latest_snapshot = repository.get_latest_snapshot(first_project.id)
    assert first_job.parsed_count == 1
    assert failed_job.failed_count == 1
    assert failed_project.status is AnalysisStatus.FAILED
    assert failed_project.latest_snapshot_id == first_snapshot.id
    assert latest_snapshot.id == first_snapshot.id
    assert latest_snapshot.source_hash == first_snapshot.source_hash


def test_job_level_discovery_failure_is_terminal_and_releases_active_job(
    tmp_path: Path,
) -> None:
    repository = StudioRepository(tmp_path / "studio.sqlite3")
    missing_root = repository.add_root(tmp_path / "MissingProjects")
    service = StudioService(repository, RecordingParser(), executor=InlineExecutor())

    failed = service.run_scan_now()

    assert failed.status == "failed"
    assert failed.discovered_count == 0
    assert failed.parsed_count == 0
    assert failed.cached_count == 0
    assert failed.failed_count == 0
    assert failed.error is not None
    assert "MissingProjects" in failed.error
    assert "Traceback" not in failed.error

    repository.remove_root(missing_root.id)
    valid_root = tmp_path / "Projects"
    valid_root.mkdir()
    repository.add_root(valid_root)
    completed = service.run_scan_now()

    assert completed.id != failed.id
    assert completed.status == "completed"


def test_each_processed_file_persists_cumulative_job_counts(tmp_path: Path) -> None:
    root = tmp_path / "Projects"
    root.mkdir()
    (root / "Alpha.flp").write_bytes(b"alpha")
    (root / "Beta.flp").write_bytes(b"beta")
    repository = UpdateRecordingRepository(tmp_path / "studio.sqlite3")
    repository.add_root(root)
    service = StudioService(repository, RecordingParser(), executor=InlineExecutor())

    result = service.run_scan_now()

    assert result.parsed_count == 2
    processed_updates = [
        job
        for job in repository.job_updates
        if job.status == "running"
        and job.parsed_count + job.cached_count + job.failed_count > 0
    ]
    assert [
        (job.parsed_count, job.cached_count, job.failed_count)
        for job in processed_updates
    ] == [(1, 0, 0), (2, 0, 0)]


def test_cached_partial_snapshot_restores_partial_project_status(
    tmp_path: Path,
) -> None:
    root = tmp_path / "Projects"
    root.mkdir()
    source = root / "Partial.flp"
    source.write_bytes(b"partial")
    repository = StudioRepository(tmp_path / "studio.sqlite3")
    repository.add_root(root)
    parser = RecordingParser(status=AnalysisStatus.PARTIAL)
    service = StudioService(repository, parser, executor=InlineExecutor())

    first = service.run_scan_now()
    second = service.run_scan_now()

    assert first.parsed_count == 1
    assert second.cached_count == 1
    assert len(parser.calls) == 1
    assert repository.list_projects()[0].status is AnalysisStatus.PARTIAL


def test_cached_history_is_promoted_when_content_returns_to_an_older_hash(
    tmp_path: Path,
) -> None:
    root = tmp_path / "Projects"
    root.mkdir()
    source = root / "Returning.flp"
    content_a = b"revision A"
    content_b = b"revision B is different"
    source.write_bytes(content_a)
    initial_details = source.stat()
    base_modified_ns = initial_details.st_mtime_ns
    repository = StudioRepository(tmp_path / "studio.sqlite3")
    repository.add_root(root)
    parser = RecordingParser()
    service = StudioService(repository, parser, executor=InlineExecutor())

    service.run_scan_now()
    project = repository.list_projects()[0]
    snapshot_a = repository.get_latest_snapshot(project.id)
    source.write_bytes(content_b)
    os.utime(
        source,
        ns=(initial_details.st_atime_ns, base_modified_ns + 1_000_000_000),
    )
    service.run_scan_now()
    snapshot_b = repository.get_latest_snapshot(project.id)
    source.write_bytes(content_a)
    current_modified_ns = base_modified_ns + 2_000_000_000
    os.utime(
        source,
        ns=(initial_details.st_atime_ns, current_modified_ns),
    )

    cached = service.run_scan_now()

    current_project = repository.get_project(project.id)
    assert snapshot_b.id != snapshot_a.id
    assert cached.cached_count == 1
    assert cached.parsed_count == 0
    assert current_project.latest_snapshot_id == snapshot_a.id
    assert repository.get_latest_snapshot(project.id).source_hash == hashlib.sha256(
        content_a
    ).hexdigest()
    seconds, nanoseconds = divmod(current_modified_ns, 1_000_000_000)
    expected_modified_at = datetime.fromtimestamp(seconds, timezone.utc).replace(
        microsecond=nanoseconds // 1_000
    ).isoformat()
    assert current_project.modified_at == expected_modified_at
    assert current_project.status is AnalysisStatus.READY


def test_default_executor_configuration_is_observable_at_construction(
    monkeypatch: pytest.MonkeyPatch,
    tmp_path: Path,
) -> None:
    executor = ShutdownRecordingExecutor()
    constructor_calls: list[dict[str, object]] = []

    def executor_factory(**kwargs: object) -> ShutdownRecordingExecutor:
        constructor_calls.append(kwargs)
        return executor

    monkeypatch.setattr(studio_service, "ThreadPoolExecutor", executor_factory)

    service = StudioService(
        StudioRepository(tmp_path / "studio.sqlite3"),
        RecordingParser(),
    )
    service.close()

    assert constructor_calls == [
        {"max_workers": 1, "thread_name_prefix": "studio-scan"}
    ]
    assert executor.shutdown_calls == [(False, True)]


def test_explicit_falsey_executor_is_used_as_supplied(
    monkeypatch: pytest.MonkeyPatch,
    tmp_path: Path,
) -> None:
    executor = FalseyExecutor()

    def forbidden_default_executor(**kwargs: object) -> object:
        raise AssertionError(f"unexpected default executor: {kwargs}")

    monkeypatch.setattr(
        studio_service,
        "ThreadPoolExecutor",
        forbidden_default_executor,
    )

    service = StudioService(
        StudioRepository(tmp_path / "studio.sqlite3"),
        RecordingParser(),
        executor=executor,
    )
    service.close()

    assert executor.shutdown_calls == [(False, True)]


@pytest.mark.parametrize(
    "hash_error",
    [
        pytest.param(
            FileChangedDuringRead("changed while hashing"),
            id="changed",
        ),
        pytest.param(OSError("unreadable"), id="io-error"),
    ],
)
def test_hash_read_failures_mark_the_project_stale(
    monkeypatch: pytest.MonkeyPatch,
    tmp_path: Path,
    hash_error: Exception,
) -> None:
    root = tmp_path / "Projects"
    root.mkdir()
    source = root / "Hashing.flp"
    source.write_bytes(b"hash me")
    repository = StudioRepository(tmp_path / "studio.sqlite3")
    repository.add_root(root)
    parser = RecordingParser()
    service = StudioService(repository, parser, executor=InlineExecutor())
    expected_observations: list[FileObservation] = []

    def failing_hash(
        path: Path,
        *,
        expected: FileObservation | None = None,
    ) -> str:
        assert path == source.resolve()
        assert expected is not None
        expected_observations.append(expected)
        raise hash_error

    monkeypatch.setattr(studio_service, "sha256_file", failing_hash)

    job = service.run_scan_now()

    assert job.status == "completed"
    assert job.failed_count == 1
    assert len(expected_observations) == 1
    assert parser.calls == []
    assert repository.list_projects()[0].status is AnalysisStatus.STALE


def test_parser_mutation_with_restored_metadata_is_rejected_before_save(
    tmp_path: Path,
) -> None:
    root = tmp_path / "Projects"
    root.mkdir()
    source = root / "Mutating.flp"
    source.write_bytes(b"AAAA")
    repository = StudioRepository(tmp_path / "studio.sqlite3")
    repository.add_root(root)
    service = StudioService(
        repository,
        MetadataRestoringMutatingParser(b"BBBB"),
        executor=InlineExecutor(),
    )

    job = service.run_scan_now()

    project = repository.list_projects()[0]
    assert job.status == "completed"
    assert job.parsed_count == 0
    assert job.failed_count == 1
    assert project.status is AnalysisStatus.STALE
    assert project.latest_snapshot_id is None
    with pytest.raises(KeyError):
        repository.get_latest_snapshot(project.id)
    with pytest.raises(KeyError):
        repository.find_snapshot_by_hash(
            project.id,
            hashlib.sha256(b"BBBB").hexdigest(),
        )


def test_file_deleted_after_parse_is_stale_and_does_not_stop_the_batch(
    tmp_path: Path,
) -> None:
    root = tmp_path / "Projects"
    root.mkdir()
    deleted = root / "Deleted.flp"
    good = root / "Good.flp"
    deleted.write_bytes(b"deleted after parse")
    good.write_bytes(b"good")
    repository = StudioRepository(tmp_path / "studio.sqlite3")
    repository.add_root(root)
    parser = DeletingParser(deleted.name)
    service = StudioService(repository, parser, executor=InlineExecutor())

    job = service.run_scan_now()

    assert job.status == "completed"
    assert job.error is None
    assert job.discovered_count == 2
    assert job.parsed_count == 1
    assert job.failed_count == 1
    projects = {project.display_name: project for project in repository.list_projects()}
    assert set(projects) == {"Deleted", "Good"}
    assert projects["Deleted"].status is AnalysisStatus.STALE
    assert projects["Deleted"].latest_snapshot_id is None
    assert projects["Good"].status is AnalysisStatus.READY
    assert [path for path, _ in parser.calls] == [deleted.resolve(), good.resolve()]
    with pytest.raises(KeyError):
        repository.get_latest_snapshot(projects["Deleted"].id)


def test_analyzer_window_mutation_is_rejected_by_the_final_digest(
    monkeypatch: pytest.MonkeyPatch,
    tmp_path: Path,
) -> None:
    root = tmp_path / "Projects"
    root.mkdir()
    source = root / "Analyzing.flp"
    source.write_bytes(b"AAAA")
    repository = StudioRepository(tmp_path / "studio.sqlite3")
    repository.add_root(root)
    service = StudioService(repository, RecordingParser(), executor=InlineExecutor())
    original_analyzer = studio_service.analyze_snapshot

    def mutating_analyzer(snapshot: FlpAnalysisSnapshot) -> FlpAnalysisSnapshot:
        analyzed = original_analyzer(snapshot)
        details = source.stat()
        source.write_bytes(b"BBBB")
        os.utime(
            source,
            ns=(details.st_atime_ns, details.st_mtime_ns),
        )
        return analyzed

    monkeypatch.setattr(studio_service, "analyze_snapshot", mutating_analyzer)

    job = service.run_scan_now()

    project = repository.list_projects()[0]
    assert job.status == "completed"
    assert job.parsed_count == 0
    assert job.failed_count == 1
    assert project.status is AnalysisStatus.STALE
    assert project.latest_snapshot_id is None


@pytest.mark.parametrize("failure_stage", ["analyze", "save"])
def test_pipeline_failures_fail_the_job_and_preserve_the_latest_snapshot(
    monkeypatch: pytest.MonkeyPatch,
    tmp_path: Path,
    failure_stage: str,
) -> None:
    root = tmp_path / "Projects"
    root.mkdir()
    source = root / "Pipeline.flp"
    source.write_bytes(b"working revision")
    repository = ToggleSaveRepository(tmp_path / "studio.sqlite3")
    repository.add_root(root)
    parser = RecordingParser()
    service = StudioService(repository, parser, executor=InlineExecutor())
    first = service.run_scan_now()
    project = repository.list_projects()[0]
    successful_snapshot = repository.get_latest_snapshot(project.id)
    source.write_bytes(b"new revision for failing pipeline")

    if failure_stage == "analyze":

        def failing_analyzer(snapshot: FlpAnalysisSnapshot) -> FlpAnalysisSnapshot:
            raise RuntimeError(f"cannot analyze {snapshot.source_hash}")

        monkeypatch.setattr(studio_service, "analyze_snapshot", failing_analyzer)
    else:
        repository.fail_saves = True

    failed = service.run_scan_now()

    failed_project = repository.get_project(project.id)
    assert first.parsed_count == 1
    assert failed.status == "failed"
    assert failed.failed_count == 1
    assert failed.error is not None
    assert (
        "cannot analyze" in failed.error
        if failure_stage == "analyze"
        else "snapshot store unavailable" in failed.error
    )
    assert failed_project.status is AnalysisStatus.FAILED
    assert failed_project.latest_snapshot_id == successful_snapshot.id
    assert repository.get_latest_snapshot(project.id) == successful_snapshot


def test_unwrapped_parser_failure_stops_the_batch_and_fails_the_job(
    tmp_path: Path,
) -> None:
    root = tmp_path / "Projects"
    root.mkdir()
    broken = root / "Broken.flp"
    later = root / "Later.flp"
    broken.write_bytes(b"broken")
    later.write_bytes(b"later")
    repository = StudioRepository(tmp_path / "studio.sqlite3")
    repository.add_root(root)
    parser = UnwrappedFailingParser(broken.name)
    service = StudioService(repository, parser, executor=InlineExecutor())

    job = service.run_scan_now()

    assert job.status == "failed"
    assert job.discovered_count == 2
    assert job.parsed_count == 0
    assert job.failed_count == 1
    assert job.error == f"unexpected parser failure: {broken.name}"
    assert parser.calls == [broken.resolve()]
    projects = repository.list_projects()
    assert len(projects) == 1
    assert projects[0].status is AnalysisStatus.FAILED

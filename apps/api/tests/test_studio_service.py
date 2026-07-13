from __future__ import annotations

import hashlib
from concurrent.futures import Future
from datetime import datetime, timezone
from pathlib import Path
from threading import current_thread
from typing import Callable

import pytest

from kumikoroom.studio import service as studio_service
from kumikoroom.studio.models import (
    AnalysisStatus,
    FlpAnalysisSnapshot,
    ProjectInfo,
)
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
            raise RuntimeError(f"cannot parse {path.name}")
        return FlpAnalysisSnapshot(
            source_path=str(path),
            source_hash=source_hash,
            status=self.status,
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


@pytest.mark.parametrize("failure_stage", ["analyze", "save"])
def test_pipeline_failures_are_isolated_and_preserve_the_latest_snapshot(
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
    assert failed.status == "completed"
    assert failed.failed_count == 1
    assert failed_project.status is AnalysisStatus.FAILED
    assert failed_project.latest_snapshot_id == successful_snapshot.id
    assert repository.get_latest_snapshot(project.id) == successful_snapshot

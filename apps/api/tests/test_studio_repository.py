import os
import sqlite3
from concurrent.futures import ThreadPoolExecutor
from dataclasses import FrozenInstanceError
from datetime import datetime
from pathlib import Path

import pytest

from kumikoroom.studio.models import (
    AnalysisStatus,
    FlpAnalysisSnapshot,
    ProjectInfo,
)
from kumikoroom.studio.repository import (
    StudioRepository,
    StudioRoot,
    StudioScanJob,
    StudioSnapshotRecord,
)


def _snapshot(
    source_path: Path,
    source_hash: str = "sha256:first",
    status: AnalysisStatus = AnalysisStatus.READY,
) -> FlpAnalysisSnapshot:
    return FlpAnalysisSnapshot(
        source_path=str(source_path),
        source_hash=source_hash,
        status=status,
        project=ProjectInfo(title="Night Drive", tempo=128.0),
    )


def _assert_utc_iso(value: str) -> None:
    parsed = datetime.fromisoformat(value)
    assert parsed.utcoffset() is not None
    assert parsed.utcoffset().total_seconds() == 0


def test_repository_creates_parent_directory_and_persists_roots(tmp_path: Path) -> None:
    db_path = tmp_path / "nested" / "studio.sqlite3"
    root_path = tmp_path / "projects" / ".." / "projects"

    first_repository = StudioRepository(db_path)
    first = first_repository.add_root(root_path)
    duplicate = first_repository.add_root(root_path)
    second_repository = StudioRepository(db_path)

    assert db_path.exists()
    assert isinstance(first, StudioRoot)
    assert first == duplicate
    assert first.path == str(root_path.resolve())
    _assert_utc_iso(first.created_at)
    assert second_repository.list_roots() == [first]
    with pytest.raises(FrozenInstanceError):
        first.path = "changed"  # type: ignore[misc]


@pytest.mark.skipif(os.name != "nt", reason="Windows path identity contract")
def test_root_identity_is_case_insensitive_on_windows(tmp_path: Path) -> None:
    repository = StudioRepository(tmp_path / "studio.sqlite3")
    root_path = tmp_path / "Projects"
    case_variant = Path(str(root_path).swapcase())

    first = repository.add_root(root_path)
    duplicate = repository.add_root(case_variant)

    assert duplicate == first
    assert first.path == str(root_path.resolve())
    assert repository.list_roots() == [first]


def test_remove_root_does_not_delete_files_or_projects(tmp_path: Path) -> None:
    repository = StudioRepository(tmp_path / "studio.sqlite3")
    root_path = tmp_path / "projects"
    project_path = root_path / "song.flp"
    project_path.parent.mkdir()
    project_path.write_bytes(b"FLhd")
    root = repository.add_root(root_path)
    project = repository.upsert_project(
        project_path,
        display_name="Song",
        status=AnalysisStatus.DISCOVERED,
    )

    repository.remove_root(root.id)

    assert repository.list_roots() == []
    assert repository.get_project(project.id) == project
    assert project_path.read_bytes() == b"FLhd"
    with pytest.raises(KeyError):
        repository.remove_root(root.id)


def test_upsert_project_preserves_id_and_updates_mutable_fields(tmp_path: Path) -> None:
    repository = StudioRepository(tmp_path / "studio.sqlite3")
    project_path = tmp_path / "songs" / "demo.flp"
    first_modified_at = "2026-07-12T10:00:00+00:00"
    second_modified_at = "2026-07-13T11:30:00+00:00"

    first = repository.upsert_project(
        project_path,
        display_name="Demo",
        status=AnalysisStatus.DISCOVERED,
        modified_at=first_modified_at,
    )
    second = repository.upsert_project(
        project_path,
        display_name="Night Drive",
        status=AnalysisStatus.QUEUED,
        modified_at=second_modified_at,
    )

    assert second.id == first.id
    assert second.canonical_path == str(project_path.resolve())
    assert second.display_name == "Night Drive"
    assert second.status is AnalysisStatus.QUEUED
    assert second.modified_at == second_modified_at
    assert second.created_at == first.created_at
    assert second.updated_at >= first.updated_at
    assert repository.list_projects() == [second]
    assert repository.get_project(first.id) == second
    with pytest.raises(KeyError):
        repository.get_project("missing-project")


@pytest.mark.skipif(os.name != "nt", reason="Windows path identity contract")
def test_project_identity_is_case_insensitive_on_windows(tmp_path: Path) -> None:
    repository = StudioRepository(tmp_path / "studio.sqlite3")
    project_path = tmp_path / "Songs" / "Demo.flp"
    case_variant = Path(str(project_path).swapcase())

    first = repository.upsert_project(
        project_path,
        display_name="Demo",
        status=AnalysisStatus.DISCOVERED,
    )
    updated = repository.upsert_project(
        case_variant,
        display_name="Updated Demo",
        status=AnalysisStatus.QUEUED,
    )

    assert updated.id == first.id
    assert updated.canonical_path == str(project_path.resolve())
    assert updated.display_name == "Updated Demo"
    assert repository.list_projects() == [updated]


def test_project_display_name_schema_is_not_null(tmp_path: Path) -> None:
    repository = StudioRepository(tmp_path / "studio.sqlite3")
    connection = sqlite3.connect(repository.db_path)
    try:
        columns = {
            row[1]: row
            for row in connection.execute("PRAGMA table_info(studio_projects)")
        }
    finally:
        connection.close()

    assert columns["display_name"][3] == 1


@pytest.mark.parametrize("display_name", ["", "   ", "\t\n"])
def test_upsert_project_rejects_blank_display_name(
    tmp_path: Path,
    display_name: str,
) -> None:
    repository = StudioRepository(tmp_path / "studio.sqlite3")

    with pytest.raises(ValueError, match="display_name"):
        repository.upsert_project(
            tmp_path / "blank.flp",
            display_name=display_name,
        )


def test_snapshot_round_trip_latest_hash_lookup_and_idempotency(tmp_path: Path) -> None:
    repository = StudioRepository(tmp_path / "studio.sqlite3")
    source_path = tmp_path / "songs" / "night-drive.flp"
    project = repository.upsert_project(
        source_path,
        display_name="Night Drive",
        status=AnalysisStatus.PARSING,
    )
    snapshot = _snapshot(source_path)

    first = repository.save_snapshot(project.id, snapshot)
    duplicate = repository.save_snapshot(project.id, snapshot)

    assert isinstance(first, StudioSnapshotRecord)
    assert duplicate == first
    assert first.source_path == str(source_path.resolve())
    assert first.payload_json == snapshot.to_json()
    assert first.snapshot == snapshot
    _assert_utc_iso(first.analyzed_at)
    assert repository.get_latest_snapshot(project.id) == first
    assert repository.find_snapshot_by_hash(project.id, snapshot.source_hash) == first
    updated_project = repository.get_project(project.id)
    assert updated_project.latest_snapshot_id == first.id
    assert updated_project.status is AnalysisStatus.READY

    with sqlite3.connect(repository.db_path) as connection:
        count = connection.execute(
            "SELECT COUNT(*) FROM studio_snapshots WHERE project_id = ?",
            (project.id,),
        ).fetchone()[0]
    assert count == 1
    with pytest.raises(KeyError):
        repository.find_snapshot_by_hash(project.id, "missing-hash")


def test_list_latest_snapshots_returns_only_each_projects_active_record(
    tmp_path: Path,
) -> None:
    repository = StudioRepository(tmp_path / "studio.sqlite3")
    first_path = tmp_path / "first.flp"
    second_path = tmp_path / "second.flp"
    empty_path = tmp_path / "empty.flp"
    first_project = repository.upsert_project(first_path, display_name="First")
    second_project = repository.upsert_project(second_path, display_name="Second")
    empty_project = repository.upsert_project(empty_path, display_name="Empty")
    first_history = repository.save_snapshot(
        first_project.id,
        _snapshot(first_path, "sha256:first-history"),
    )
    first_latest = repository.save_snapshot(
        first_project.id,
        _snapshot(first_path, "sha256:first-latest"),
    )
    second_latest = repository.save_snapshot(
        second_project.id,
        _snapshot(second_path, "sha256:second-latest"),
    )
    with sqlite3.connect(repository.db_path) as connection:
        connection.execute(
            "UPDATE studio_snapshots SET payload_json = ? WHERE id = ?",
            ("{malformed", second_latest.id),
        )

    records = repository.list_latest_snapshots()

    assert records == {
        first_project.id: first_latest,
        second_project.id: StudioSnapshotRecord(
            id=second_latest.id,
            project_id=second_latest.project_id,
            source_path=second_latest.source_path,
            source_hash=second_latest.source_hash,
            analyzed_at=second_latest.analyzed_at,
            payload_json="{malformed",
        ),
    }
    assert first_history not in records.values()
    assert empty_project.id not in records


def test_duplicate_snapshot_hash_does_not_change_project_or_payload(
    tmp_path: Path,
) -> None:
    repository = StudioRepository(tmp_path / "studio.sqlite3")
    source_path = tmp_path / "immutable-cache.flp"
    project = repository.upsert_project(
        source_path,
        display_name="Immutable Cache",
        status=AnalysisStatus.PARSING,
    )
    first_snapshot = _snapshot(source_path, "sha256:stable")
    first_record = repository.save_snapshot(project.id, first_snapshot)
    project_after_first_save = repository.get_project(project.id)
    conflicting_snapshot = FlpAnalysisSnapshot(
        source_path=str(source_path),
        source_hash=first_snapshot.source_hash,
        status=AnalysisStatus.FAILED,
        project=ProjectInfo(title="Conflicting payload", tempo=60.0),
    )

    duplicate = repository.save_snapshot(project.id, conflicting_snapshot)

    assert duplicate == first_record
    assert duplicate.snapshot == first_snapshot
    assert repository.get_project(project.id) == project_after_first_save


def test_activate_snapshot_promotes_cached_history_atomically(tmp_path: Path) -> None:
    repository = StudioRepository(tmp_path / "studio.sqlite3")
    source_path = tmp_path / "history.flp"
    project = repository.upsert_project(
        source_path,
        display_name="History",
        status=AnalysisStatus.PARSING,
    )
    first = repository.save_snapshot(
        project.id,
        _snapshot(source_path, "sha256:first", AnalysisStatus.READY),
    )
    second = repository.save_snapshot(
        project.id,
        _snapshot(source_path, "sha256:second", AnalysisStatus.PARTIAL),
    )
    assert repository.get_project(project.id).latest_snapshot_id == second.id

    activated = repository.activate_snapshot(
        project.id,
        first.id,
        modified_at="2026-07-13T20:00:00+08:00",
    )

    assert activated.latest_snapshot_id == first.id
    assert activated.status is AnalysisStatus.READY
    assert activated.modified_at == "2026-07-13T12:00:00+00:00"
    assert repository.get_project(project.id) == activated
    assert repository.get_latest_snapshot(project.id) == first


def test_activate_snapshot_validates_project_and_snapshot_ownership(
    tmp_path: Path,
) -> None:
    repository = StudioRepository(tmp_path / "studio.sqlite3")
    first_path = tmp_path / "first.flp"
    second_path = tmp_path / "second.flp"
    first_project = repository.upsert_project(
        first_path,
        display_name="First",
    )
    second_project = repository.upsert_project(
        second_path,
        display_name="Second",
        modified_at="2026-07-13T00:00:00+00:00",
    )
    first_snapshot = repository.save_snapshot(
        first_project.id,
        _snapshot(first_path),
    )

    with pytest.raises(KeyError, match="missing-project"):
        repository.activate_snapshot("missing-project", first_snapshot.id)
    with pytest.raises(KeyError, match="missing-snapshot"):
        repository.activate_snapshot(first_project.id, "missing-snapshot")
    with pytest.raises(ValueError, match="belong"):
        repository.activate_snapshot(second_project.id, first_snapshot.id)

    unchanged = repository.get_project(second_project.id)
    assert unchanged.latest_snapshot_id is None
    assert unchanged.modified_at == "2026-07-13T00:00:00+00:00"


def test_snapshot_normalizes_relative_path_in_record_and_json(tmp_path: Path) -> None:
    repository = StudioRepository(tmp_path / "studio.sqlite3")
    relative_path = Path("relative") / "song.flp"
    project = repository.upsert_project(
        relative_path,
        display_name="Relative",
        status=AnalysisStatus.PARSING,
    )

    record = repository.save_snapshot(project.id, _snapshot(relative_path))

    expected_path = str(relative_path.resolve())
    assert record.source_path == expected_path
    assert record.snapshot.source_path == expected_path


def test_repository_normalizes_supplied_times_to_utc_iso(tmp_path: Path) -> None:
    repository = StudioRepository(tmp_path / "studio.sqlite3")
    source_path = tmp_path / "timed.flp"
    project = repository.upsert_project(
        source_path,
        display_name="Timed",
        status=AnalysisStatus.PARSING,
        modified_at="2026-07-13T20:00:00+08:00",
    )
    record = repository.save_snapshot(
        project.id,
        _snapshot(source_path),
        analyzed_at="2026-07-13T21:30:00+08:00",
    )

    assert project.modified_at == "2026-07-13T12:00:00+00:00"
    assert record.analyzed_at == "2026-07-13T13:30:00+00:00"
    with pytest.raises(ValueError, match="UTC ISO"):
        repository.upsert_project(
            tmp_path / "invalid.flp",
            display_name="Invalid",
            modified_at="not-a-date",
        )
    with pytest.raises(ValueError, match="UTC ISO"):
        repository.save_snapshot(
            project.id,
            _snapshot(source_path),
            analyzed_at="naive",
        )


def test_concurrent_snapshot_saves_are_idempotent(tmp_path: Path) -> None:
    repository = StudioRepository(tmp_path / "studio.sqlite3")
    source_path = tmp_path / "concurrent.flp"
    project = repository.upsert_project(
        source_path,
        display_name="Concurrent",
        status=AnalysisStatus.PARSING,
    )
    snapshot = _snapshot(source_path, "sha256:concurrent")

    with ThreadPoolExecutor(max_workers=8) as executor:
        records = list(
            executor.map(
                lambda _: repository.save_snapshot(project.id, snapshot),
                range(16),
            )
        )

    assert len({record.id for record in records}) == 1


def test_snapshot_queries_raise_key_error_for_missing_entities(tmp_path: Path) -> None:
    repository = StudioRepository(tmp_path / "studio.sqlite3")
    project = repository.upsert_project(
        tmp_path / "empty.flp",
        display_name="Empty",
        status=AnalysisStatus.DISCOVERED,
    )

    with pytest.raises(KeyError):
        repository.get_latest_snapshot(project.id)
    with pytest.raises(KeyError):
        repository.get_latest_snapshot("missing-project")
    with pytest.raises(KeyError):
        repository.save_snapshot("missing-project", _snapshot(tmp_path / "x.flp"))


def test_snapshot_source_path_must_match_project_without_side_effects(
    tmp_path: Path,
) -> None:
    repository = StudioRepository(tmp_path / "studio.sqlite3")
    project_path = tmp_path / "project.flp"
    other_path = tmp_path / "other.flp"
    project = repository.upsert_project(
        project_path,
        display_name="Project",
        status=AnalysisStatus.PARSING,
    )
    project_before = repository.get_project(project.id)

    with pytest.raises(ValueError, match="source_path"):
        repository.save_snapshot(
            project.id,
            _snapshot(other_path, "sha256:wrong-project"),
        )

    assert repository.get_project(project.id) == project_before
    with pytest.raises(KeyError):
        repository.find_snapshot_by_hash(project.id, "sha256:wrong-project")
    connection = sqlite3.connect(repository.db_path)
    try:
        count = connection.execute(
            "SELECT COUNT(*) FROM studio_snapshots WHERE project_id = ?",
            (project.id,),
        ).fetchone()[0]
    finally:
        connection.close()
    assert count == 0


def test_create_and_update_scan_job_counts(tmp_path: Path) -> None:
    repository = StudioRepository(tmp_path / "studio.sqlite3")

    created = repository.create_scan_job(status="running")
    updated = repository.update_scan_job(
        created.id,
        status="completed",
        discovered_count=8,
        parsed_count=5,
        cached_count=2,
        failed_count=1,
        error=None,
    )

    assert isinstance(created, StudioScanJob)
    assert created.discovered_count == 0
    assert created.parsed_count == 0
    assert created.cached_count == 0
    assert created.failed_count == 0
    _assert_utc_iso(created.created_at)
    assert updated.id == created.id
    assert updated.status == "completed"
    assert updated.discovered_count == 8
    assert updated.parsed_count == 5
    assert updated.cached_count == 2
    assert updated.failed_count == 1
    assert updated.error is None
    assert updated.created_at == created.created_at
    assert updated.updated_at >= created.updated_at
    with pytest.raises(KeyError):
        repository.update_scan_job("missing-job", status="failed")
    with pytest.raises(ValueError, match="status"):
        repository.update_scan_job(created.id, status="unknown")
    with pytest.raises(ValueError, match="non-negative"):
        repository.update_scan_job(created.id, parsed_count=-1)
    with pytest.raises(TypeError, match="unexpected"):
        repository.update_scan_job(created.id, unexpected_count=2)


def test_get_scan_job_reads_persisted_jobs_and_rejects_unknown_ids(
    tmp_path: Path,
) -> None:
    db_path = tmp_path / "studio.sqlite3"
    repository = StudioRepository(db_path)
    created = repository.create_scan_job(status="queued")
    completed = repository.update_scan_job(
        created.id,
        status="completed",
        discovered_count=3,
        parsed_count=2,
        cached_count=1,
    )

    reopened = StudioRepository(db_path)

    assert reopened.get_scan_job(created.id) == completed
    with pytest.raises(KeyError, match="missing-job"):
        reopened.get_scan_job("missing-job")


def test_scan_job_count_columns_default_to_zero(tmp_path: Path) -> None:
    repository = StudioRepository(tmp_path / "studio.sqlite3")
    connection = sqlite3.connect(repository.db_path)
    try:
        connection.execute(
            """
            INSERT INTO studio_scan_jobs (id, status, created_at, updated_at)
            VALUES (?, ?, ?, ?)
            """,
            (
                "database-defaults",
                "queued",
                "2026-07-13T00:00:00+00:00",
                "2026-07-13T00:00:00+00:00",
            ),
        )
        counts = connection.execute(
            """
            SELECT discovered_count, parsed_count, cached_count, failed_count
            FROM studio_scan_jobs
            WHERE id = ?
            """,
            ("database-defaults",),
        ).fetchone()
    finally:
        connection.close()

    assert counts == (0, 0, 0, 0)


def test_database_rejects_invalid_project_and_scan_job_statuses(
    tmp_path: Path,
) -> None:
    repository = StudioRepository(tmp_path / "studio.sqlite3")
    connection = sqlite3.connect(repository.db_path)
    try:
        with pytest.raises(sqlite3.IntegrityError):
            connection.execute(
                """
                INSERT INTO studio_projects (
                    id, canonical_path, canonical_path_identity, display_name,
                    status, created_at, updated_at
                )
                VALUES (?, ?, ?, ?, ?, ?, ?)
                """,
                (
                    "invalid-project-status",
                    str((tmp_path / "invalid.flp").resolve()),
                    os.path.normcase(str((tmp_path / "invalid.flp").resolve())),
                    "Invalid",
                    "bogus",
                    "2026-07-13T00:00:00+00:00",
                    "2026-07-13T00:00:00+00:00",
                ),
            )
        with pytest.raises(sqlite3.IntegrityError):
            connection.execute(
                """
                INSERT INTO studio_scan_jobs (id, status, created_at, updated_at)
                VALUES (?, ?, ?, ?)
                """,
                (
                    "invalid-scan-status",
                    "bogus",
                    "2026-07-13T00:00:00+00:00",
                    "2026-07-13T00:00:00+00:00",
                ),
            )
    finally:
        connection.close()


@pytest.mark.parametrize(
    "count_column",
    ["discovered_count", "parsed_count", "cached_count", "failed_count"],
)
def test_database_rejects_negative_scan_job_counts(
    tmp_path: Path,
    count_column: str,
) -> None:
    repository = StudioRepository(tmp_path / "studio.sqlite3")
    connection = sqlite3.connect(repository.db_path)
    try:
        with pytest.raises(sqlite3.IntegrityError):
            connection.execute(
                f"""
                INSERT INTO studio_scan_jobs (
                    id, status, {count_column}, created_at, updated_at
                )
                VALUES (?, ?, ?, ?, ?)
                """,
                (
                    f"negative-{count_column}",
                    "queued",
                    -1,
                    "2026-07-13T00:00:00+00:00",
                    "2026-07-13T00:00:00+00:00",
                ),
            )
    finally:
        connection.close()


def test_snapshot_foreign_key_cascades_when_project_is_deleted(tmp_path: Path) -> None:
    repository = StudioRepository(tmp_path / "studio.sqlite3")
    source_path = tmp_path / "cascade.flp"
    project = repository.upsert_project(
        source_path,
        display_name="Cascade",
        status=AnalysisStatus.PARSING,
    )
    snapshot = repository.save_snapshot(project.id, _snapshot(source_path))

    with sqlite3.connect(repository.db_path) as connection:
        connection.execute("PRAGMA foreign_keys = ON")
        connection.execute(
            "DELETE FROM studio_projects WHERE id = ?",
            (project.id,),
        )
        connection.commit()
        remaining = connection.execute(
            "SELECT COUNT(*) FROM studio_snapshots WHERE id = ?",
            (snapshot.id,),
        ).fetchone()[0]

    assert remaining == 0

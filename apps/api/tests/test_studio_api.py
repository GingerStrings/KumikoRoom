import json
import sqlite3
from concurrent.futures import Future, ThreadPoolExecutor
from pathlib import Path
from threading import Barrier, BrokenBarrierError
from typing import Callable

import pytest
from fastapi.testclient import TestClient

from kumikoroom.config import load_settings
from kumikoroom.main import app
from kumikoroom.routers import studio
from kumikoroom.studio.models import (
    AnalysisDiagnostic,
    AnalysisStatus,
    DependencyReference,
    FlpAnalysisSnapshot,
    MusicalFingerprint,
    NoteSummary,
    PatternSummary,
    ProjectInfo,
)
from kumikoroom.studio.repository import StudioRepository
from kumikoroom.studio.service import StudioService


class InlineExecutor:
    def submit(
        self,
        function: Callable[..., object],
        *args: object,
    ) -> Future[object]:
        future: Future[object] = Future()
        try:
            future.set_result(function(*args))
        except BaseException as exc:
            future.set_exception(exc)
        return future

    def shutdown(self, *, wait: bool, cancel_futures: bool) -> None:
        pass


class RecordingParser:
    def __init__(self, *, status: AnalysisStatus = AnalysisStatus.PARTIAL) -> None:
        self.status = status
        self.calls: list[Path] = []

    def parse(self, path: Path, *, source_hash: str) -> FlpAnalysisSnapshot:
        self.calls.append(path)
        return analysis_snapshot(
            path,
            source_hash=source_hash,
            status=self.status,
        )


def analysis_snapshot(
    path: Path,
    *,
    source_hash: str = "snapshot-hash",
    status: AnalysisStatus = AnalysisStatus.PARTIAL,
) -> FlpAnalysisSnapshot:
    return FlpAnalysisSnapshot(
        source_path=str(path),
        source_hash=source_hash,
        status=status,
        project=ProjectInfo(title=path.stem, tempo=128.0, ppq=96),
        patterns=[
            PatternSummary(
                id="pattern-1",
                name="Verse",
                notes=[
                    NoteSummary(
                        key=60,
                        position=0,
                        length=96,
                        velocity=100,
                        channel_id="channel-1",
                    )
                ],
                used_in_playlist=True,
            )
        ],
        fingerprint=MusicalFingerprint(inferred_key="A minor"),
        diagnostics=[
            AnalysisDiagnostic(
                code="parser_warning",
                severity="warning",
                message="A recoverable section was skipped.",
            ),
            AnalysisDiagnostic(
                code="parser_error",
                severity="error",
                message="A plugin state could not be decoded.",
            ),
            AnalysisDiagnostic(
                code="parser_notice",
                severity="notice",
                message="Legacy metadata was normalized.",
            ),
        ],
        unknown_event_count=2,
    )


def install_inline_studio_service(parser: RecordingParser) -> StudioService:
    service = StudioService(
        StudioRepository(load_settings().studio_db_path),
        parser,
        InlineExecutor(),
    )
    app.dependency_overrides[studio.studio_service] = lambda: service
    return service


def uninstall_inline_studio_service(service: StudioService) -> None:
    app.dependency_overrides.pop(studio.studio_service, None)
    service.close()


def test_list_studio_roots_starts_empty(client: TestClient) -> None:
    response = client.get("/api/studio/roots")

    assert response.status_code == 200
    assert response.json() == []


def test_create_root_resolves_path_and_returns_201(
    client: TestClient,
    tmp_path: Path,
) -> None:
    root = tmp_path / "songs"
    root.mkdir()

    response = client.post("/api/studio/roots", json={"path": str(root)})

    assert response.status_code == 201
    assert response.json()["path"] == str(root.resolve())
    assert response.json()["id"]
    assert response.json()["created_at"]
    assert client.get("/api/studio/roots").json() == [response.json()]


def test_create_duplicate_root_returns_existing_row_and_200(
    client: TestClient,
    tmp_path: Path,
) -> None:
    root = tmp_path / "songs"
    root.mkdir()
    first = client.post("/api/studio/roots", json={"path": str(root)})

    duplicate = client.post(
        "/api/studio/roots",
        json={"path": str(root / ".")},
    )

    assert duplicate.status_code == 200
    assert duplicate.json() == first.json()
    assert client.get("/api/studio/roots").json() == [first.json()]


def test_concurrent_duplicate_roots_return_one_201_and_one_200(
    client: TestClient,
    tmp_path: Path,
) -> None:
    root = tmp_path / "songs"
    root.mkdir()
    repository = StudioRepository(load_settings().studio_db_path)
    list_barrier = Barrier(2)

    class CoordinatedRepository:
        def list_roots(self):
            roots = repository.list_roots()
            try:
                list_barrier.wait(timeout=1)
            except BrokenBarrierError:
                pass
            return roots

        def add_root(self, path: Path):
            return repository.add_root(path)

    coordinated = CoordinatedRepository()
    app.dependency_overrides[studio.studio_repository] = lambda: coordinated
    try:
        with ThreadPoolExecutor(max_workers=2) as executor:
            responses = list(
                executor.map(
                    lambda _: client.post(
                        "/api/studio/roots",
                        json={"path": str(root)},
                    ),
                    range(2),
                )
            )
    finally:
        app.dependency_overrides.pop(studio.studio_repository, None)

    assert sorted(response.status_code for response in responses) == [200, 201]
    assert responses[0].json()["id"] == responses[1].json()["id"]
    assert len(repository.list_roots()) == 1


def test_create_root_rejects_blank_missing_and_file_paths(
    client: TestClient,
    tmp_path: Path,
) -> None:
    blank = client.post("/api/studio/roots", json={"path": "   "})
    missing = client.post(
        "/api/studio/roots",
        json={"path": str(tmp_path / "missing")},
    )
    regular_file = tmp_path / "project.flp"
    regular_file.write_bytes(b"FLhd")
    file_response = client.post(
        "/api/studio/roots",
        json={"path": str(regular_file)},
    )

    assert blank.status_code == 400
    assert missing.status_code == 400
    assert file_response.status_code == 400


def test_create_root_rejects_an_unreadable_directory(
    client: TestClient,
    monkeypatch: pytest.MonkeyPatch,
    tmp_path: Path,
) -> None:
    root = tmp_path / "unreadable"
    root.mkdir()
    monkeypatch.setattr(studio.os, "access", lambda path, mode: False)

    response = client.post("/api/studio/roots", json={"path": str(root)})

    assert response.status_code == 400


def test_delete_root_removes_only_database_row(
    client: TestClient,
    tmp_path: Path,
) -> None:
    root = tmp_path / "songs"
    root.mkdir()
    project_file = root / "kept.flp"
    project_file.write_bytes(b"kept")
    created = client.post("/api/studio/roots", json={"path": str(root)}).json()

    response = client.delete(f"/api/studio/roots/{created['id']}")

    assert response.status_code == 204
    assert response.content == b""
    assert root.is_dir()
    assert project_file.read_bytes() == b"kept"
    assert client.get("/api/studio/roots").json() == []


def test_delete_missing_root_returns_404(client: TestClient) -> None:
    response = client.delete("/api/studio/roots/missing-root")

    assert response.status_code == 404


def test_add_root_scan_and_return_partial_project_analysis(
    client: TestClient,
    tmp_path: Path,
) -> None:
    root = tmp_path / "songs"
    root.mkdir()
    project_file = root / "Blue Hour.flp"
    project_file.write_bytes(b"fake flp bytes")
    parser = RecordingParser()
    service = install_inline_studio_service(parser)
    try:
        root_response = client.post(
            "/api/studio/roots",
            json={"path": str(root)},
        )
        scan_response = client.post("/api/studio/scans")
        scan = client.get(f"/api/studio/scans/{scan_response.json()['id']}")
        projects_response = client.get("/api/studio/projects")
    finally:
        uninstall_inline_studio_service(service)

    assert root_response.status_code == 201
    assert scan_response.status_code == 202
    assert scan_response.json()["status"] == "queued"
    assert scan.status_code == 200
    assert scan.json()["status"] == "completed"
    assert scan.json()["discovered_count"] == 1
    assert scan.json()["parsed_count"] == 1
    assert parser.calls == [project_file.resolve()]

    assert projects_response.status_code == 200
    projects = projects_response.json()
    assert len(projects) == 1
    project = projects[0]
    assert project["canonical_path"] == str(project_file.resolve())
    assert project["display_name"] == "Blue Hour"
    assert project["status"] == "partial"
    assert project["tempo"] == 128.0
    assert project["pattern_count"] == 1
    assert project["warning_count"] == 1
    assert project["error_count"] == 1
    assert project["diagnostic_count"] >= 3
    assert "inferred_key" in project

    detail = client.get(f"/api/studio/projects/{project['id']}")
    analysis = client.get(f"/api/studio/projects/{project['id']}/analysis")

    assert detail.status_code == 200
    assert detail.json()["id"] == project["id"]
    assert detail.json()["latest_snapshot_id"] == project["latest_snapshot_id"]
    assert detail.json()["latest_snapshot_source_hash"]
    assert detail.json()["latest_snapshot_analyzed_at"]
    assert analysis.status_code == 200
    assert analysis.json()["status"] == "partial"
    assert analysis.json()["project"]["tempo"] == 128.0
    assert analysis.json()["patterns"][0]["notes"][0]["key"] == 60
    assert analysis.json()["diagnostics"][0]["severity"] == "warning"
    assert analysis.json()["unknown_event_count"] == 2


def test_missing_scan_project_and_analysis_return_404(client: TestClient) -> None:
    assert client.get("/api/studio/scans/missing-scan").status_code == 404
    assert client.get("/api/studio/projects/missing-project").status_code == 404
    assert (
        client.get("/api/studio/projects/missing-project/analysis").status_code
        == 404
    )


def test_project_without_latest_snapshot_has_no_analysis(
    client: TestClient,
    tmp_path: Path,
) -> None:
    path = tmp_path / "unparsed.flp"
    repository = StudioRepository(load_settings().studio_db_path)
    project = repository.upsert_project(
        path,
        display_name="unparsed",
        status=AnalysisStatus.DISCOVERED,
    )

    response = client.get(f"/api/studio/projects/{project.id}/analysis")

    assert response.status_code == 404


@pytest.mark.parametrize("snapshot_status", [AnalysisStatus.READY, AnalysisStatus.PARTIAL])
def test_analysis_returns_ready_and_partial_snapshots(
    client: TestClient,
    tmp_path: Path,
    snapshot_status: AnalysisStatus,
) -> None:
    path = tmp_path / f"{snapshot_status.value}.flp"
    repository = StudioRepository(load_settings().studio_db_path)
    project = repository.upsert_project(path, display_name=path.stem)
    repository.save_snapshot(
        project.id,
        analysis_snapshot(path, status=snapshot_status),
    )

    response = client.get(f"/api/studio/projects/{project.id}/analysis")

    assert response.status_code == 200
    assert response.json()["status"] == snapshot_status.value


def test_failed_project_keeps_latest_successful_analysis_and_metrics(
    client: TestClient,
    tmp_path: Path,
) -> None:
    path = tmp_path / "fragile.flp"
    repository = StudioRepository(load_settings().studio_db_path)
    project = repository.upsert_project(path, display_name="fragile")
    snapshot_record = repository.save_snapshot(
        project.id,
        analysis_snapshot(path, status=AnalysisStatus.READY),
    )
    repository.upsert_project(
        path,
        display_name="fragile",
        status=AnalysisStatus.FAILED,
    )

    summary = client.get("/api/studio/projects").json()[0]
    analysis = client.get(f"/api/studio/projects/{project.id}/analysis")

    assert summary["status"] == "failed"
    assert summary["latest_snapshot_id"] == snapshot_record.id
    assert summary["tempo"] == 128.0
    assert summary["warning_count"] == 1
    assert analysis.status_code == 200
    assert analysis.json()["status"] == "ready"


def test_project_list_locally_degrades_a_corrupt_snapshot(
    client: TestClient,
    tmp_path: Path,
) -> None:
    good_path = tmp_path / "good.flp"
    corrupt_path = tmp_path / "corrupt.flp"
    repository = StudioRepository(load_settings().studio_db_path)
    good_project = repository.upsert_project(good_path, display_name="good")
    corrupt_project = repository.upsert_project(
        corrupt_path,
        display_name="corrupt",
    )
    repository.save_snapshot(good_project.id, analysis_snapshot(good_path))
    corrupt_snapshot = repository.save_snapshot(
        corrupt_project.id,
        analysis_snapshot(corrupt_path),
    )
    repository.upsert_project(
        corrupt_path,
        display_name="corrupt",
        status=AnalysisStatus.FAILED,
    )
    with repository._connect() as connection:
        connection.execute(
            "UPDATE studio_snapshots SET payload_json = ? WHERE id = ?",
            ("{malformed", corrupt_snapshot.id),
        )

    response = client.get("/api/studio/projects")

    assert response.status_code == 200
    projects = {project["display_name"]: project for project in response.json()}
    assert set(projects) == {"good", "corrupt"}
    assert projects["good"]["tempo"] == 128.0
    assert projects["corrupt"]["status"] == "failed"
    assert projects["corrupt"]["tempo"] is None
    assert projects["corrupt"]["pattern_count"] == 0
    assert projects["corrupt"]["warning_count"] == 0


def test_project_list_fetches_latest_snapshots_in_one_batch(
    client: TestClient,
    tmp_path: Path,
) -> None:
    class CountingRepository(StudioRepository):
        def __init__(self, db_path: Path) -> None:
            super().__init__(db_path)
            self.atomic_list_calls = 0
            self.get_latest_snapshot_calls = 0

        def list_projects(self):
            raise AssertionError("project list must use the atomic repository query")

        def list_latest_snapshots(self):
            raise AssertionError("project list must use the atomic repository query")

        def list_projects_with_latest_snapshots(self):
            self.atomic_list_calls += 1
            return super().list_projects_with_latest_snapshots()

        def get_latest_snapshot(self, project_id: str):
            self.get_latest_snapshot_calls += 1
            return super().get_latest_snapshot(project_id)

    repository = CountingRepository(load_settings().studio_db_path)
    for index in range(5):
        path = tmp_path / f"project-{index}.flp"
        project = repository.upsert_project(path, display_name=path.stem)
        repository.save_snapshot(
            project.id,
            analysis_snapshot(path, source_hash=f"hash-{index}"),
        )
    app.dependency_overrides[studio.studio_repository] = lambda: repository
    try:
        response = client.get("/api/studio/projects")
    finally:
        app.dependency_overrides.pop(studio.studio_repository, None)

    assert response.status_code == 200
    assert len(response.json()) == 5
    assert repository.atomic_list_calls == 1
    assert repository.get_latest_snapshot_calls == 0


def test_corrupt_latest_analysis_returns_stable_409_without_payload_details(
    tmp_path: Path,
) -> None:
    path = tmp_path / "corrupt-analysis.flp"
    repository = StudioRepository(load_settings().studio_db_path)
    project = repository.upsert_project(path, display_name="corrupt-analysis")
    record = repository.save_snapshot(project.id, analysis_snapshot(path))
    with repository._connect() as connection:
        connection.execute(
            "UPDATE studio_snapshots SET payload_json = ? WHERE id = ?",
            ("{malformed-secret-payload", record.id),
        )

    with TestClient(app, raise_server_exceptions=False) as error_client:
        list_response = error_client.get("/api/studio/projects")
        analysis_response = error_client.get(
            f"/api/studio/projects/{project.id}/analysis"
        )

    assert list_response.status_code == 200
    assert list_response.json()[0]["tempo"] is None
    assert analysis_response.status_code == 409
    assert analysis_response.json() == {
        "detail": "Stored analysis is invalid; rescan the project."
    }
    assert "malformed-secret-payload" not in analysis_response.text


def test_open_project_and_folder_use_registered_project_path(
    client: TestClient,
    tmp_path: Path,
) -> None:
    project_path = tmp_path / "songs" / "Safe Project.flp"
    project_path.parent.mkdir()
    project_path.write_bytes(b"FLhd")
    repository = StudioRepository(load_settings().studio_db_path)
    project = repository.upsert_project(project_path, display_name="Safe Project")

    class RecordingOpener:
        def __init__(self) -> None:
            self.targets: list[Path] = []

        def open(self, target: Path) -> None:
            self.targets.append(target)

    opener = RecordingOpener()
    app.dependency_overrides[studio.local_opener] = lambda: opener
    try:
        project_response = client.post(
            f"/api/studio/projects/{project.id}/open",
            json={"kind": "project"},
        )
        folder_response = client.post(
            f"/api/studio/projects/{project.id}/open",
            json={"kind": "folder"},
        )
    finally:
        app.dependency_overrides.pop(studio.local_opener, None)

    assert project_response.status_code == 204
    assert folder_response.status_code == 204
    assert opener.targets == [project_path.resolve(), project_path.parent.resolve()]


def test_open_dependency_uses_opaque_id_from_current_snapshot(
    client: TestClient,
    tmp_path: Path,
) -> None:
    project_path = tmp_path / "songs" / "Safe Project.flp"
    dependency_path = tmp_path / "samples" / "kick.wav"
    project_path.parent.mkdir()
    dependency_path.parent.mkdir()
    project_path.write_bytes(b"FLhd")
    dependency_path.write_bytes(b"RIFF")
    repository = StudioRepository(load_settings().studio_db_path)
    project = repository.upsert_project(project_path, display_name="Safe Project")
    snapshot = analysis_snapshot(project_path)
    repository.save_snapshot(
        project.id,
        FlpAnalysisSnapshot(
            **{
                **snapshot.__dict__,
                "dependencies": [
                    DependencyReference(
                        path=str(dependency_path), kind="audio", exists=True
                    )
                ],
            }
        ),
    )
    dependency = client.get(
        f"/api/studio/projects/{project.id}/analysis"
    ).json()["dependencies"][0]

    class RecordingOpener:
        def __init__(self) -> None:
            self.targets: list[Path] = []

        def open(self, target: Path) -> None:
            self.targets.append(target)

    opener = RecordingOpener()
    app.dependency_overrides[studio.local_opener] = lambda: opener
    try:
        response = client.post(
            f"/api/studio/projects/{project.id}/open",
            json={"kind": "dependency", "entity_id": dependency["entity_id"]},
        )
    finally:
        app.dependency_overrides.pop(studio.local_opener, None)

    assert dependency["entity_id"].startswith("dependency_")
    assert str(dependency_path) not in dependency["entity_id"]
    assert response.status_code == 204
    assert opener.targets == [dependency_path.parent.resolve()]


def test_get_analysis_builds_large_dependency_ids_without_filesystem_io(
    monkeypatch: pytest.MonkeyPatch,
    tmp_path: Path,
) -> None:
    project_path = tmp_path / "pure-read.flp"
    project_path.write_bytes(b"FLhd")
    repository = StudioRepository(load_settings().studio_db_path)
    project = repository.upsert_project(project_path, display_name="pure read")
    snapshot = analysis_snapshot(project_path)
    dependency_count = 5_000
    record = repository.save_snapshot(
        project.id,
        FlpAnalysisSnapshot(
            **{
                **snapshot.__dict__,
                "dependencies": [
                    DependencyReference(
                        path=f"//offline.invalid/share/sample-{index}.wav",
                        kind="audio",
                        exists=False,
                    )
                    for index in range(dependency_count)
                ],
            }
        ),
    )
    persisted_payload = json.loads(record.payload_json)
    for index, dependency in enumerate(persisted_payload["dependencies"]):
        dependency["exists"] = True
        dependency["open_identity"] = {
            "canonical_path_identity": f"//offline.invalid/share/sample-{index}.wav",
            "file_dev": 1,
            "file_ino": index + 1,
            "size": 4,
            "modified_ns": 100 + index,
        }
    with sqlite3.connect(repository.db_path) as connection:
        connection.execute(
            "UPDATE studio_snapshots SET payload_json = ? WHERE id = ?",
            (json.dumps(persisted_payload), record.id),
        )

    def filesystem_bomb(*_args: object, **_kwargs: object) -> object:
        raise AssertionError("analysis reads must not resolve or stat dependencies")

    with monkeypatch.context() as filesystem_guard:
        filesystem_guard.setattr(Path, "resolve", filesystem_bomb)
        filesystem_guard.setattr(Path, "stat", filesystem_bomb)
        response = studio.get_project_analysis(project.id, repository)

    assert len(response.dependencies) == dependency_count
    assert response.dependencies[0].entity_id.startswith("dependency_")
    assert response.dependencies[-1].entity_id.startswith("dependency_")


def test_legacy_dependency_without_persisted_identity_is_not_openable(
    client: TestClient,
    tmp_path: Path,
) -> None:
    project_path = tmp_path / "legacy-dependency.flp"
    dependency_path = tmp_path / "legacy.wav"
    project_path.write_bytes(b"FLhd")
    dependency_path.write_bytes(b"RIFF")
    repository = StudioRepository(load_settings().studio_db_path)
    project = repository.upsert_project(project_path, display_name="legacy")
    snapshot = analysis_snapshot(project_path)
    record = repository.save_snapshot(
        project.id,
        FlpAnalysisSnapshot(
            **{
                **snapshot.__dict__,
                "dependencies": [
                    DependencyReference(str(dependency_path), "audio", True)
                ],
            }
        ),
    )
    legacy_payload = json.loads(record.payload_json)
    legacy_payload["dependencies"][0].pop("open_identity", None)
    with sqlite3.connect(repository.db_path) as connection:
        connection.execute(
            "UPDATE studio_snapshots SET payload_json = ? WHERE id = ?",
            (json.dumps(legacy_payload), record.id),
        )

    entity_id = client.get(
        f"/api/studio/projects/{project.id}/analysis"
    ).json()["dependencies"][0]["entity_id"]

    assert entity_id is None


def test_open_action_rejects_paths_unknown_entities_and_cross_project_ids(
    client: TestClient,
    tmp_path: Path,
) -> None:
    repository = StudioRepository(load_settings().studio_db_path)
    project_ids: list[str] = []
    entity_ids: list[str] = []
    for name in ("first", "second"):
        project_path = tmp_path / name / f"{name}.flp"
        dependency_path = project_path.parent / f"{name}.wav"
        project_path.parent.mkdir()
        project_path.write_bytes(b"FLhd")
        dependency_path.write_bytes(b"RIFF")
        project = repository.upsert_project(project_path, display_name=name)
        snapshot = analysis_snapshot(project_path, source_hash=f"hash-{name}")
        repository.save_snapshot(
            project.id,
            FlpAnalysisSnapshot(
                **{
                    **snapshot.__dict__,
                    "dependencies": [
                        DependencyReference(
                            path=str(dependency_path), kind="audio", exists=True
                        )
                    ],
                }
            ),
        )
        project_ids.append(project.id)
        entity_ids.append(
            client.get(f"/api/studio/projects/{project.id}/analysis").json()[
                "dependencies"
            ][0]["entity_id"]
        )

    arbitrary_path = client.post(
        f"/api/studio/projects/{project_ids[0]}/open",
        json={"kind": "dependency", "target": str(tmp_path / "outside.exe")},
    )
    unknown = client.post(
        f"/api/studio/projects/{project_ids[0]}/open",
        json={"kind": "dependency", "entity_id": "dependency_unknown"},
    )
    cross_project = client.post(
        f"/api/studio/projects/{project_ids[0]}/open",
        json={"kind": "dependency", "entity_id": entity_ids[1]},
    )

    assert arbitrary_path.status_code == 422
    assert unknown.status_code == 404
    assert cross_project.status_code == 404


def test_missing_dependency_is_not_issued_an_open_entity_id(
    client: TestClient,
    tmp_path: Path,
) -> None:
    project_path = tmp_path / "missing-dependency.flp"
    project_path.write_bytes(b"FLhd")
    missing_path = tmp_path / "gone.wav"
    repository = StudioRepository(load_settings().studio_db_path)
    project = repository.upsert_project(project_path, display_name=project_path.stem)
    snapshot = analysis_snapshot(project_path)
    repository.save_snapshot(
        project.id,
        FlpAnalysisSnapshot(
            **{
                **snapshot.__dict__,
                "dependencies": [
                    DependencyReference(
                        path=str(missing_path), kind="audio", exists=False
                    )
                ],
            }
        ),
    )
    entity_id = client.get(
        f"/api/studio/projects/{project.id}/analysis"
    ).json()["dependencies"][0]["entity_id"]

    assert entity_id is None


def test_open_dependency_rejects_a_target_replaced_after_entity_id_was_issued(
    client: TestClient,
    tmp_path: Path,
) -> None:
    project_path = tmp_path / "identity.flp"
    dependency_path = tmp_path / "identity.wav"
    project_path.write_bytes(b"FLhd")
    dependency_path.write_bytes(b"first-version")
    repository = StudioRepository(load_settings().studio_db_path)
    project = repository.upsert_project(project_path, display_name="identity")
    snapshot = analysis_snapshot(project_path)
    repository.save_snapshot(
        project.id,
        FlpAnalysisSnapshot(
            **{
                **snapshot.__dict__,
                "dependencies": [
                    DependencyReference(
                        path=str(dependency_path), kind="audio", exists=True
                    )
                ],
            }
        ),
    )
    entity_id = client.get(
        f"/api/studio/projects/{project.id}/analysis"
    ).json()["dependencies"][0]["entity_id"]
    dependency_path.unlink()
    dependency_path.write_bytes(b"replacement-with-new-identity")

    class ForbiddenOpener:
        def open(self, target: Path) -> None:
            raise AssertionError(f"must not open replaced target: {target}")

    app.dependency_overrides[studio.local_opener] = lambda: ForbiddenOpener()
    try:
        response = client.post(
            f"/api/studio/projects/{project.id}/open",
            json={"kind": "dependency", "entity_id": entity_id},
        )
    finally:
        app.dependency_overrides.pop(studio.local_opener, None)

    assert response.status_code == 409


def test_open_backup_requires_project_owned_association(
    client: TestClient,
    tmp_path: Path,
) -> None:
    repository = StudioRepository(load_settings().studio_db_path)
    main_path = tmp_path / "song.flp"
    other_path = tmp_path / "other.flp"
    backup_path = tmp_path / "Backups" / "song_2026.flp"
    backup_path.parent.mkdir()
    for path in (main_path, other_path, backup_path):
        path.write_bytes(b"FLhd")
    main = repository.upsert_project(main_path, display_name="song")
    other = repository.upsert_project(other_path, display_name="other")
    backup = repository.upsert_project(backup_path, display_name="song_2026")
    backup_snapshot = repository.save_snapshot(
        backup.id, analysis_snapshot(backup_path, source_hash="backup-hash")
    )
    association = repository.save_backup_association(
        main.id, backup.id, backup_snapshot.id, score=0.9, confirmed=True
    )

    class RecordingOpener:
        def __init__(self) -> None:
            self.targets: list[Path] = []

        def open(self, target: Path) -> None:
            self.targets.append(target)

    opener = RecordingOpener()
    app.dependency_overrides[studio.local_opener] = lambda: opener
    try:
        owned = client.post(
            f"/api/studio/projects/{main.id}/open",
            json={"kind": "backup", "entity_id": association.id},
        )
        cross_project = client.post(
            f"/api/studio/projects/{other.id}/open",
            json={"kind": "backup", "entity_id": association.id},
        )
    finally:
        app.dependency_overrides.pop(studio.local_opener, None)

    assert owned.status_code == 204
    assert opener.targets == [backup_path.parent.resolve()]
    assert cross_project.status_code == 404


def test_open_backup_requires_a_confirmed_association(
    client: TestClient,
    tmp_path: Path,
) -> None:
    repository = StudioRepository(load_settings().studio_db_path)
    main_path = tmp_path / "song.flp"
    backup_path = tmp_path / "Backups" / "candidate.flp"
    backup_path.parent.mkdir()
    main_path.write_bytes(b"FLhd-main")
    backup_path.write_bytes(b"FLhd-candidate")
    main = repository.upsert_project(main_path, display_name="song")
    candidate = repository.upsert_project(backup_path, display_name="candidate")
    candidate_snapshot = repository.save_snapshot(
        candidate.id,
        analysis_snapshot(backup_path, source_hash="candidate-hash"),
    )
    association = repository.save_backup_association(
        main.id,
        candidate.id,
        candidate_snapshot.id,
        score=0.72,
        confirmed=False,
    )

    class RecordingOpener:
        def __init__(self) -> None:
            self.targets: list[Path] = []

        def open(self, target: Path) -> None:
            self.targets.append(target)

    opener = RecordingOpener()
    app.dependency_overrides[studio.local_opener] = lambda: opener
    try:
        response = client.post(
            f"/api/studio/projects/{main.id}/open",
            json={"kind": "backup", "entity_id": association.id},
        )
    finally:
        app.dependency_overrides.pop(studio.local_opener, None)

    assert response.status_code == 404
    assert opener.targets == []


@pytest.mark.parametrize("kind", ["project", "folder"])
def test_open_offline_legacy_project_without_migrated_identity_returns_conflict(
    client: TestClient,
    tmp_path: Path,
    kind: str,
) -> None:
    db_path = load_settings().studio_db_path
    project_folder = tmp_path / "legacy-project"
    project_folder.mkdir()
    project_path = project_folder / "offline.flp"
    project_path.write_bytes(b"FLhd")
    repository = StudioRepository(db_path)
    project = repository.upsert_project(project_path, display_name="offline")

    with sqlite3.connect(db_path) as connection:
        connection.execute("DROP TABLE studio_project_open_identities")
    project_path.unlink()

    migrated_repository = StudioRepository(db_path)
    with pytest.raises(KeyError):
        migrated_repository.get_project_open_identity(project.id)

    class RecordingOpener:
        def __init__(self) -> None:
            self.targets: list[Path] = []

        def open(self, target: Path) -> None:
            self.targets.append(target)

    opener = RecordingOpener()
    app.dependency_overrides[studio.local_opener] = lambda: opener
    try:
        response = client.post(
            f"/api/studio/projects/{project.id}/open",
            json={"kind": kind},
        )
    finally:
        app.dependency_overrides.pop(studio.local_opener, None)

    assert response.status_code == 409
    assert opener.targets == []


def test_open_project_rejects_a_regular_file_replacement(
    client: TestClient,
    tmp_path: Path,
) -> None:
    project_path = tmp_path / "registered.flp"
    project_path.write_bytes(b"FLhd-original")
    repository = StudioRepository(load_settings().studio_db_path)
    project = repository.upsert_project(project_path, display_name="registered")
    project_path.unlink()
    project_path.write_bytes(b"MZ-external-executable")

    class RecordingOpener:
        def __init__(self) -> None:
            self.targets: list[Path] = []

        def open(self, target: Path) -> None:
            self.targets.append(target)

    opener = RecordingOpener()
    app.dependency_overrides[studio.local_opener] = lambda: opener
    try:
        response = client.post(
            f"/api/studio/projects/{project.id}/open",
            json={"kind": "project"},
        )
    finally:
        app.dependency_overrides.pop(studio.local_opener, None)

    assert response.status_code == 409
    assert opener.targets == []


def test_open_folder_rejects_a_replacement_directory(
    client: TestClient,
    tmp_path: Path,
) -> None:
    project_folder = tmp_path / "registered-folder"
    project_folder.mkdir()
    project_path = project_folder / "song.flp"
    project_path.write_bytes(b"FLhd")
    repository = StudioRepository(load_settings().studio_db_path)
    project = repository.upsert_project(project_path, display_name="song")
    moved_folder = tmp_path / "original-folder"
    project_folder.rename(moved_folder)
    project_folder.mkdir()

    class RecordingOpener:
        def __init__(self) -> None:
            self.targets: list[Path] = []

        def open(self, target: Path) -> None:
            self.targets.append(target)

    opener = RecordingOpener()
    app.dependency_overrides[studio.local_opener] = lambda: opener
    try:
        response = client.post(
            f"/api/studio/projects/{project.id}/open",
            json={"kind": "folder"},
        )
    finally:
        app.dependency_overrides.pop(studio.local_opener, None)

    assert response.status_code == 409
    assert opener.targets == []


def test_open_backup_rejects_a_regular_file_replacement(
    client: TestClient,
    tmp_path: Path,
) -> None:
    repository = StudioRepository(load_settings().studio_db_path)
    main_path = tmp_path / "main.flp"
    backup_path = tmp_path / "Backups" / "main backup.flp"
    backup_path.parent.mkdir()
    main_path.write_bytes(b"FLhd-main")
    backup_path.write_bytes(b"FLhd-backup")
    main = repository.upsert_project(main_path, display_name="main")
    backup = repository.upsert_project(backup_path, display_name="main backup")
    record = repository.save_snapshot(
        backup.id, analysis_snapshot(backup_path, source_hash="backup")
    )
    association = repository.save_backup_association(
        main.id, backup.id, record.id, score=0.91, confirmed=True
    )
    backup_path.unlink()
    backup_path.write_bytes(b"MZ-external-executable")

    class RecordingOpener:
        def __init__(self) -> None:
            self.targets: list[Path] = []

        def open(self, target: Path) -> None:
            self.targets.append(target)

    opener = RecordingOpener()
    app.dependency_overrides[studio.local_opener] = lambda: opener
    try:
        response = client.post(
            f"/api/studio/projects/{main.id}/open",
            json={"kind": "backup", "entity_id": association.id},
        )
    finally:
        app.dependency_overrides.pop(studio.local_opener, None)

    assert response.status_code == 409
    assert opener.targets == []


def test_default_service_reuses_db_and_replaces_it_when_path_changes(
    monkeypatch: pytest.MonkeyPatch,
    tmp_path: Path,
) -> None:
    studio.close_studio_service()
    monkeypatch.setenv("KUMIKOROOM_STUDIO_DB_PATH", str(tmp_path / "first.sqlite3"))
    first = studio.studio_service()

    assert studio.studio_service() is first

    monkeypatch.setenv("KUMIKOROOM_STUDIO_DB_PATH", str(tmp_path / "second.sqlite3"))
    second = studio.studio_service()
    try:
        assert second is not first
        with pytest.raises(RuntimeError, match="closed"):
            first.start_scan()
    finally:
        studio.close_studio_service()


def test_close_studio_service_does_not_construct_a_service(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    studio.close_studio_service()

    def forbidden_constructor(*args: object, **kwargs: object) -> object:
        raise AssertionError("shutdown must not construct a service")

    monkeypatch.setattr(studio, "StudioService", forbidden_constructor)

    studio.close_studio_service()


def test_close_studio_service_closes_a_cached_instance_exactly_once(
    monkeypatch: pytest.MonkeyPatch,
    tmp_path: Path,
) -> None:
    studio.close_studio_service()

    class CloseSpy:
        def __init__(self) -> None:
            self.close_calls = 0

        def close(self) -> None:
            self.close_calls += 1

    constructed: list[CloseSpy] = []

    def construct_spy(*args: object, **kwargs: object) -> CloseSpy:
        spy = CloseSpy()
        constructed.append(spy)
        return spy

    monkeypatch.setenv("KUMIKOROOM_STUDIO_DB_PATH", str(tmp_path / "cached.sqlite3"))
    monkeypatch.setattr(studio, "StudioService", construct_spy)

    cached = studio.studio_service()
    studio.close_studio_service()
    studio.close_studio_service()

    assert cached is constructed[0]
    assert len(constructed) == 1
    assert constructed[0].close_calls == 1


def test_app_lifespan_closes_studio_service_once_and_keeps_room_api(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    close_calls: list[None] = []
    monkeypatch.setattr(
        studio,
        "close_studio_service",
        lambda: close_calls.append(None),
    )

    with TestClient(app) as lifespan_client:
        response = lifespan_client.get("/api/room/state")
        assert response.status_code == 200
        assert close_calls == []

    assert close_calls == [None]

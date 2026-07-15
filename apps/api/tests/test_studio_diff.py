from dataclasses import replace
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from kumikoroom.main import app
from kumikoroom.routers import studio
from kumikoroom.studio.diff import diff_snapshots, score_backup_association
from kumikoroom.studio.models import (
    AnalysisStatus,
    ChannelSummary,
    DependencyReference,
    FlpAnalysisSnapshot,
    MixerInsertSummary,
    NoteSummary,
    PatternSummary,
    PlaylistClipSummary,
    PluginInstance,
    ProjectInfo,
)
from kumikoroom.studio.repository import StudioRepository
from kumikoroom.studio.service import StudioService
from kumikoroom.studio import service as service_module


def snapshot(path: Path, source_hash: str, *, version: int = 1) -> FlpAnalysisSnapshot:
    return FlpAnalysisSnapshot(
        source_path=str(path),
        source_hash=source_hash,
        status=AnalysisStatus.READY,
        project=ProjectInfo(title="Blue Hour", tempo=120.0 + version, ppq=96),
        patterns=[
            PatternSummary(
                id="pattern-1",
                name="Verse",
                notes=[NoteSummary(60, 0, 96 + version, 100, "channel-1")],
                used_in_playlist=True,
            ),
            *(
                [PatternSummary(id="pattern-8", name="Pattern 8")]
                if version > 1 else []
            ),
        ],
        channels=[ChannelSummary("channel-1", "Keys", "FLEX", "instrument")],
        playlist_clips=[PlaylistClipSummary("clip-1", 1, 0, 384 + version, "pattern", "pattern-1")],
        plugins=[
            PluginInstance("plugin-1", "FLEX", "generator", "channel:channel-1", True),
            *(
                [PluginInstance("plugin-2", "Serum", "generator", "channel:channel-2", False)]
                if version > 1 else []
            ),
        ],
        mixer_inserts=[MixerInsertSummary("mixer-1", "Master", ["plugin-1"], [])],
        dependencies=[
            DependencyReference("D:/Samples/kick.wav", "sample", version == 1),
            *(
                [DependencyReference("D:/Samples/snare.wav", "sample", True)]
                if version > 1 else []
            ),
        ],
    )


def test_backup_association_requires_high_confidence(tmp_path: Path) -> None:
    main = snapshot(tmp_path / "Blue Hour.flp", "main")
    strong = replace(main, source_path=str(tmp_path / "Backups" / "Blue Hour - backup.flp"), source_hash="strong")
    weak = replace(
        main,
        source_path=str(tmp_path / "Backups" / "Untitled.flp"),
        source_hash="weak",
        project=ProjectInfo(title=None),
        patterns=[PatternSummary("9", "Other")],
        channels=[],
        plugins=[],
    )

    assert score_backup_association(main, strong, main_modified_at="2026-07-14T10:00:00Z", candidate_modified_at="2026-07-14T09:59:00Z") >= 0.8
    assert score_backup_association(main, weak, main_modified_at="2026-07-14T10:00:00Z", candidate_modified_at="2025-01-01T00:00:00Z") < 0.8


def test_backup_association_rejects_fuzzy_title_and_empty_evidence(tmp_path: Path) -> None:
    main = snapshot(tmp_path / "Blue Hour.flp", "main")
    fuzzy_title = replace(
        main,
        source_path=str(tmp_path / "Backups" / "Blue Hour 2 - backup.flp"),
        source_hash="fuzzy",
        project=replace(main.project, title="Blue Hour 2"),
    )
    empty_main = FlpAnalysisSnapshot(
        source_path=str(tmp_path / "Untitled.flp"),
        source_hash="empty-main",
        status=AnalysisStatus.READY,
        project=ProjectInfo(title=None),
    )
    empty_candidate = replace(
        empty_main,
        source_path=str(tmp_path / "Backups" / "Untitled - backup.flp"),
        source_hash="empty-candidate",
    )

    assert score_backup_association(
        main,
        fuzzy_title,
        main_modified_at="2026-07-14T10:00:00Z",
        candidate_modified_at="2026-07-14T09:59:00Z",
    ) < 0.8
    assert score_backup_association(
        empty_main,
        empty_candidate,
        main_modified_at="2026-07-14T10:00:00Z",
        candidate_modified_at="2026-07-14T09:59:00Z",
    ) < 0.8


def test_snapshot_diff_is_semantic_stable_and_complete(tmp_path: Path) -> None:
    before = snapshot(tmp_path / "Blue Hour.flp", "v1", version=1)
    after = snapshot(tmp_path / "Blue Hour.flp", "v2", version=2)

    result = diff_snapshots(before, after)

    assert "tempo" in {item["field"] for item in result["project_metrics"]["changed"]}
    assert result["patterns"]["added"][0]["id"] == "pattern-8"
    assert result["patterns"]["added"][0]["name"] == "Pattern 8"
    assert result["patterns"]["changed"][0]["id"] == "pattern-1"
    assert result["notes"]["changed"][0]["pattern_id"] == "pattern-1"
    assert result["plugins"]["added"][0]["name"] == "Serum"
    assert result["playlist_clips"]["changed"][0]["id"] == "clip-1"
    assert result["dependencies"]["added"][0]["path"].endswith("snare.wav")
    assert result["dependencies"]["changed"][0]["before"]["path"].endswith("kick.wav")
    assert diff_snapshots(after, before)["patterns"]["removed"] == result["patterns"]["added"]
    assert diff_snapshots(before, before)["summary"]["change_count"] == 0


def test_snapshot_diff_reports_all_parsed_project_and_inference_metrics(
    tmp_path: Path,
) -> None:
    before = snapshot(tmp_path / "Blue Hour.flp", "v1")
    after = replace(
        before,
        source_hash="v2",
        project=replace(
            before.project,
            title="Blue Hour Final",
            author="Kumiko",
            fl_version="21.2",
            created_at="2026-07-01T00:00:00Z",
            time_spent_seconds=7200,
        ),
        fingerprint=replace(
            before.fingerprint,
            inferred_key="A minor",
            inferred_key_confidence=0.82,
            inferred_key_evidence=["pitch classes", "cadence"],
        ),
        unknown_event_count=4,
    )

    fields = {
        item["field"]
        for item in diff_snapshots(before, after)["project_metrics"]["changed"]
    }

    assert {
        "title",
        "author",
        "fl_version",
        "created_at",
        "time_spent_seconds",
        "inferred_key",
        "inferred_key_confidence",
        "inferred_key_evidence",
        "unknown_event_count",
    } <= fields


def test_diff_matches_ids_and_duplicate_names_without_list_order(tmp_path: Path) -> None:
    base = snapshot(tmp_path / "Blue Hour.flp", "v1")
    reordered = replace(
        base,
        source_hash="v2",
        patterns=[
            PatternSummary("b", "Verse", [NoteSummary(64, 0, 96, 90, None)]),
            PatternSummary("a", "Verse", [NoteSummary(60, 0, 96, 90, None)]),
        ],
    )
    reordered_again = replace(reordered, patterns=list(reversed(reordered.patterns)))

    assert diff_snapshots(reordered, reordered_again)["summary"]["change_count"] == 0

    duplicate_ids = replace(
        base,
        patterns=[PatternSummary("duplicate", "Verse A"), PatternSummary("duplicate", "Verse B")],
    )
    assert diff_snapshots(
        duplicate_ids,
        replace(duplicate_ids, source_hash="v3", patterns=list(reversed(duplicate_ids.patterns))),
    )["summary"]["change_count"] == 0


def test_note_diff_reports_added_removed_changed_with_duplicates(tmp_path: Path) -> None:
    base = snapshot(tmp_path / "Blue Hour.flp", "v1")
    before = replace(
        base,
        patterns=[PatternSummary("p", "Notes", [
            NoteSummary(60, 0, 96, 90, "c"),
            NoteSummary(60, 0, 96, 90, "c"),
            NoteSummary(62, 96, 96, 90, "c"),
        ])],
    )
    after = replace(
        base,
        source_hash="v2",
        patterns=[PatternSummary("p", "Notes", [
            NoteSummary(60, 0, 96, 90, "c"),
            NoteSummary(62, 96, 48, 90, "c"),
            NoteSummary(64, 192, 96, 90, None),
        ])],
    )

    notes = diff_snapshots(before, after)["notes"]
    assert len(notes["removed"]) == 1
    assert notes["removed"][0]["key"] == 60
    assert notes["changed"][0]["before"]["length"] == 96
    assert notes["changed"][0]["after"]["length"] == 48
    assert notes["added"][0]["key"] == 64


def install_versions(repository: StudioRepository, tmp_path: Path):
    main_path = tmp_path / "Blue Hour.flp"
    backup_path = tmp_path / "Backups" / "Blue Hour - backup.flp"
    main = repository.upsert_project(main_path, display_name="Blue Hour", modified_at="2026-07-14T10:00:00Z")
    backup = repository.upsert_project(backup_path, display_name="Blue Hour - backup", modified_at="2026-07-14T09:59:00Z")
    main_record = repository.save_snapshot(main.id, snapshot(main_path, "main", version=2))
    backup_record = repository.save_snapshot(backup.id, snapshot(backup_path, "backup", version=1))
    association = repository.save_backup_association(
        main.id, backup.id, backup_record.id, score=0.7, confirmed=False
    )
    return main, backup, main_record, backup_record, association


def test_repository_association_is_owned_idempotent_and_bounded(tmp_path: Path) -> None:
    repository = StudioRepository(tmp_path / "studio.sqlite3")
    main, backup, _, backup_record, association = install_versions(repository, tmp_path)

    duplicate = repository.save_backup_association(main.id, backup.id, backup_record.id, score=0.9, confirmed=True)
    assert duplicate.id == association.id
    assert duplicate.confirmed is True
    assert repository.confirm_backup_association(main.id, association.id) == duplicate
    assert repository.list_project_versions(main.id, limit=1)[0].snapshot.id
    with pytest.raises(ValueError, match="self"):
        repository.save_backup_association(main.id, main.id, backup_record.id, score=0.5)
    with pytest.raises(ValueError, match="candidate"):
        repository.save_backup_association(backup.id, main.id, backup_record.id, score=0.5)
    other = repository.upsert_project(tmp_path / "Other.flp", display_name="Other")
    with pytest.raises(ValueError, match="already associated"):
        repository.save_backup_association(other.id, backup.id, backup_record.id, score=0.5)
    with pytest.raises(ValueError, match="limit"):
        repository.list_project_versions(main.id, limit=201)


def test_versions_api_confirmation_and_diff_enforce_ownership(tmp_path: Path) -> None:
    repository = StudioRepository(tmp_path / "studio.sqlite3")
    main, backup, main_record, backup_record, association = install_versions(repository, tmp_path)
    app.dependency_overrides[studio.studio_repository] = lambda: repository
    try:
        with TestClient(app) as client:
            versions = client.get(f"/api/studio/projects/{main.id}/versions")
            assert versions.status_code == 200
            assert versions.json()[0]["kind"] == "current"
            assert versions.json()[1]["confirmed"] is False

            assert client.get(
                f"/api/studio/projects/{main.id}/diff",
                params={"from": backup_record.id, "to": main_record.id},
            ).status_code == 400

            confirmed = client.post(
                f"/api/studio/projects/{main.id}/versions/confirm",
                json={"candidate_id": association.id},
            )
            assert confirmed.status_code == 200
            assert confirmed.json()["confirmed"] is True
            assert client.post(
                f"/api/studio/projects/{main.id}/versions/confirm",
                json={"candidate_id": association.id},
            ).status_code == 200

            compared = client.get(
                f"/api/studio/projects/{main.id}/diff",
                params={"from": backup_record.id, "to": main_record.id},
            )
            assert compared.status_code == 200
            assert compared.json()["summary"]["change_count"] > 0
            assert client.get(
                f"/api/studio/projects/{main.id}/diff",
                params={"from": main_record.id, "to": main_record.id},
            ).json()["summary"]["change_count"] == 0
            assert client.get(
                f"/api/studio/projects/{backup.id}/diff",
                params={"from": backup_record.id, "to": main_record.id},
            ).status_code == 400
    finally:
        app.dependency_overrides.clear()


def test_service_associates_backup_snapshots_idempotently(tmp_path: Path) -> None:
    repository = StudioRepository(tmp_path / "studio.sqlite3")
    main_path = tmp_path / "Blue Hour.flp"
    backup_path = tmp_path / "Backups" / "Blue Hour - backup.flp"
    main = repository.upsert_project(main_path, display_name="Blue Hour", modified_at="2026-07-14T10:00:00Z")
    backup = repository.upsert_project(backup_path, display_name="Blue Hour backup", modified_at="2026-07-14T09:59:00Z")
    repository.save_snapshot(main.id, snapshot(main_path, "main"))
    repository.save_snapshot(backup.id, snapshot(backup_path, "backup"))
    service = StudioService(repository, object())  # type: ignore[arg-type]
    try:
        service._associate_backup_snapshots()
        service._associate_backup_snapshots()
    finally:
        service.close()

    associations = repository.list_backup_associations(main.id)
    assert len(associations) == 1
    assert associations[0].confirmed is True


def test_versions_api_hides_corrupt_payload_and_caps_history(tmp_path: Path) -> None:
    repository = StudioRepository(tmp_path / "studio.sqlite3")
    path = tmp_path / "Blue Hour.flp"
    project = repository.upsert_project(path, display_name="Blue Hour")
    records = [
        repository.save_snapshot(project.id, snapshot(path, f"hash-{index}"))
        for index in range(12)
    ]
    with repository._connect() as connection:
        connection.execute(
            "UPDATE studio_snapshots SET payload_json = ? WHERE id = ?",
            ("{private-corrupt-payload", records[-1].id),
        )
    app.dependency_overrides[studio.studio_repository] = lambda: repository
    try:
        with TestClient(app, raise_server_exceptions=False) as client:
            response = client.get(f"/api/studio/projects/{project.id}/versions?limit=10")
            compared = client.get(
                f"/api/studio/projects/{project.id}/diff",
                params={"from": records[0].id, "to": records[-1].id},
            )
        assert response.status_code == 409
        assert "private-corrupt-payload" not in response.text
        assert compared.status_code == 409
        assert "private-corrupt-payload" not in compared.text
    finally:
        app.dependency_overrides.clear()


def test_version_limit_always_keeps_an_activated_older_current_snapshot(tmp_path: Path) -> None:
    repository = StudioRepository(tmp_path / "studio.sqlite3")
    path = tmp_path / "History.flp"
    project = repository.upsert_project(path, display_name="History")
    records = [
        repository.save_snapshot(
            project.id,
            snapshot(path, f"history-{index}"),
            analyzed_at=f"2026-07-{index + 1:02d}T00:00:00Z",
        )
        for index in range(12)
    ]
    repository.activate_snapshot(project.id, records[0].id)

    versions = repository.list_project_versions(project.id, limit=1)

    assert len(versions) == 1
    assert versions[0].kind == "current"
    assert versions[0].snapshot.id == records[0].id


class BackupParser:
    def parse(self, path: Path, *, source_hash: str) -> FlpAnalysisSnapshot:
        return replace(
            snapshot(path, source_hash),
            project=ProjectInfo(title="Blue Hour", tempo=128),
        )


def test_scan_includes_global_backup_root_and_persists_association(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    project_root = tmp_path / "Projects"
    project_root.mkdir()
    main_path = project_root / "Blue Hour.flp"
    main_path.write_bytes(b"main")
    global_backup = tmp_path / "Image-Line" / "Projects" / "Backup"
    global_backup.mkdir(parents=True)
    (global_backup / "Blue Hour - backup.flp").write_bytes(b"backup")
    repository = StudioRepository(tmp_path / "studio.sqlite3")
    repository.add_root(project_root)
    monkeypatch.setattr(service_module, "default_fl_studio_backup_root", lambda: global_backup)
    service = StudioService(repository, BackupParser())
    try:
        job = service.run_scan_now()
    finally:
        service.close()

    main = repository.get_project_by_path(main_path)
    associations = repository.list_backup_associations(main.id)
    assert job.discovered_count == 2
    assert len(associations) == 1
    assert associations[0].confirmed is True


def test_project_library_keeps_backup_candidates_in_secondary_timeline(tmp_path: Path) -> None:
    repository = StudioRepository(tmp_path / "studio.sqlite3")
    main, _, _, _, _ = install_versions(repository, tmp_path)
    app.dependency_overrides[studio.studio_repository] = lambda: repository
    try:
        with TestClient(app) as client:
            projects = client.get("/api/studio/projects")
        assert projects.status_code == 200
        assert [item["id"] for item in projects.json()] == [main.id]
    finally:
        app.dependency_overrides.clear()

from __future__ import annotations

import hashlib
import os
import subprocess
from dataclasses import FrozenInstanceError
from datetime import datetime, timezone
from pathlib import Path

import pytest

from kumikoroom.studio import scanner
from kumikoroom.studio.scanner import (
    DiscoveredFlp,
    default_fl_studio_backup_root,
    discover_flp_files,
    discover_project_assets,
    is_stable,
    observe_file,
    sha256_file,
)


def _create_directory_link_or_skip(link: Path, target: Path) -> None:
    try:
        link.symlink_to(target, target_is_directory=True)
        return
    except OSError as symlink_error:
        if os.name == "nt":
            junction = subprocess.run(
                ["cmd", "/c", "mklink", "/J", str(link), str(target)],
                capture_output=True,
                check=False,
                text=True,
            )
            if junction.returncode == 0:
                return
        pytest.skip(f"directory links are unavailable: {symlink_error}")


def test_discovered_flp_is_frozen() -> None:
    discovered = DiscoveredFlp(
        path=Path("Song.flp"),
        root=Path("."),
        modified_ns=1,
        size=2,
    )

    with pytest.raises(FrozenInstanceError):
        discovered.size = 3  # type: ignore[misc]


def test_discover_flp_files_filters_sorts_and_deduplicates_roots(
    tmp_path: Path,
) -> None:
    root = tmp_path / "Projects"
    nested = root / "Nested"
    nested.mkdir(parents=True)
    (root / "zeta.FLP").write_bytes(b"z")
    (nested / "Alpha.flp").write_bytes(b"alpha")
    (nested / "notes.txt").write_text("ignore", encoding="utf-8")

    discovered = discover_flp_files([root, nested, root])

    assert [item.path.name for item in discovered] == ["Alpha.flp", "zeta.FLP"]
    assert all(item.path.is_absolute() for item in discovered)
    assert {item.root for item in discovered} <= {root.resolve(), nested.resolve()}
    assert {item.size for item in discovered} == {1, 5}


def test_discover_flp_files_rejects_invalid_roots(tmp_path: Path) -> None:
    with pytest.raises(FileNotFoundError):
        discover_flp_files([tmp_path / "missing"])

    file_root = tmp_path / "file.flp"
    file_root.write_bytes(b"data")
    with pytest.raises(ValueError, match="directory"):
        discover_flp_files([file_root])


def test_discover_flp_files_does_not_follow_directory_links_outside_root(
    tmp_path: Path,
) -> None:
    root = tmp_path / "Projects"
    outside = tmp_path / "Private"
    root.mkdir()
    outside.mkdir()
    (outside / "Private.flp").write_bytes(b"private")
    link = root / "Linked"
    _create_directory_link_or_skip(link, outside)

    assert discover_flp_files([root]) == []


def test_discover_flp_files_rejects_linked_root(tmp_path: Path) -> None:
    outside = tmp_path / "Private"
    outside.mkdir()
    (outside / "Private.flp").write_bytes(b"private")
    linked_root = tmp_path / "LinkedProjects"
    _create_directory_link_or_skip(linked_root, outside)

    with pytest.raises(ValueError, match="regular directory"):
        discover_flp_files([linked_root])


def test_path_identity_uses_windows_normcase_when_platform_is_windows(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setattr(scanner, "_is_windows", lambda: True)

    upper = scanner._path_identity(Path("C:/Music/Song.FLP"))
    lower = scanner._path_identity(Path("c:/music/song.flp"))

    assert upper == lower


def test_file_observations_are_stable_when_size_and_mtime_match(
    tmp_path: Path,
) -> None:
    source = tmp_path / "Song.flp"
    source.write_bytes(b"song")

    first = observe_file(source)
    second = observe_file(source)

    assert first.path == source
    assert is_stable(first, second)


def test_file_observations_are_unstable_after_file_changes(tmp_path: Path) -> None:
    source = tmp_path / "Song.flp"
    source.write_bytes(b"one")
    first = observe_file(source)

    source.write_bytes(b"a longer revision")
    second = observe_file(source)

    assert not is_stable(first, second)


def test_observe_file_raises_when_file_does_not_exist(tmp_path: Path) -> None:
    with pytest.raises(FileNotFoundError):
        observe_file(tmp_path / "missing.flp")


def test_sha256_file_matches_hashlib(tmp_path: Path) -> None:
    payload = (b"KumikoRoom" * 150_000) + b"tail"
    source = tmp_path / "Song.flp"
    source.write_bytes(payload)

    assert sha256_file(source) == hashlib.sha256(payload).hexdigest()


def test_default_backup_root_prefers_windows_registry_documents(
    monkeypatch: pytest.MonkeyPatch,
    tmp_path: Path,
) -> None:
    documents = tmp_path / "Custom Documents"
    expected = documents / "Image-Line" / "FL Studio" / "Projects" / "Backup"
    expected.mkdir(parents=True)
    monkeypatch.setattr(scanner, "_is_windows", lambda: True)
    monkeypatch.setattr(
        scanner,
        "_windows_documents_from_registry",
        lambda: documents,
    )
    monkeypatch.setattr(scanner, "_home_directory", lambda: tmp_path / "Home")

    assert default_fl_studio_backup_root() == expected


def test_default_backup_root_falls_back_to_home_documents(
    monkeypatch: pytest.MonkeyPatch,
    tmp_path: Path,
) -> None:
    expected = (
        tmp_path
        / "Documents"
        / "Image-Line"
        / "FL Studio"
        / "Projects"
        / "Backup"
    )
    expected.mkdir(parents=True)
    monkeypatch.setattr(scanner, "_is_windows", lambda: True)

    def registry_failure() -> Path:
        raise OSError("registry unavailable")

    monkeypatch.setattr(
        scanner,
        "_windows_documents_from_registry",
        registry_failure,
    )
    monkeypatch.setattr(scanner, "_home_directory", lambda: tmp_path)

    assert default_fl_studio_backup_root() == expected


def test_default_backup_root_returns_none_when_directory_is_missing(
    monkeypatch: pytest.MonkeyPatch,
    tmp_path: Path,
) -> None:
    monkeypatch.setattr(scanner, "_is_windows", lambda: False)
    monkeypatch.setattr(scanner, "_home_directory", lambda: tmp_path)

    assert default_fl_studio_backup_root() is None


def test_discover_project_assets_finds_supported_adjacent_asset_types(
    tmp_path: Path,
) -> None:
    project = tmp_path / "Project"
    renders = project / "Renders"
    audio = project / "Audio"
    backup = project / "Backup"
    renders.mkdir(parents=True)
    audio.mkdir()
    backup.mkdir()
    main_flp = project / "Main.flp"
    main_flp.write_bytes(b"main")
    (renders / "Mix.WAV").write_bytes(b"render")
    (audio / "Sample.mP3").write_bytes(b"audio")
    (backup / "Autosave.FLP").write_bytes(b"backup")
    (renders / "notes.txt").write_text("ignore", encoding="utf-8")
    (audio / "Preset.flp").write_bytes(b"ignore")
    (backup / "Preview.wav").write_bytes(b"ignore")

    assets = discover_project_assets(main_flp)

    assert [(Path(item.path).name, item.kind) for item in assets] == [
        ("Sample.mP3", "audio"),
        ("Autosave.FLP", "backup"),
        ("Mix.WAV", "render"),
    ]
    assert all(Path(item.path).is_absolute() for item in assets)
    assert {item.size for item in assets} == {5, 6}
    for asset in assets:
        assert asset.modified_at is not None
        modified = datetime.fromisoformat(asset.modified_at)
        assert modified.tzinfo == timezone.utc


def test_discover_project_assets_scans_backups_and_deduplicates_paths(
    monkeypatch: pytest.MonkeyPatch,
    tmp_path: Path,
) -> None:
    project = tmp_path / "Project"
    backups = project / "Backups"
    backups.mkdir(parents=True)
    main_flp = project / "Main.flp"
    main_flp.write_bytes(b"main")
    autosave = backups / "Autosave.flp"
    autosave.write_bytes(b"backup")
    original_specs = scanner._ASSET_DIRECTORY_SPECS
    monkeypatch.setattr(
        scanner,
        "_ASSET_DIRECTORY_SPECS",
        (*original_specs, ("Backups", "backup")),
    )

    assets = discover_project_assets(main_flp)

    assert [Path(item.path) for item in assets] == [autosave.resolve()]


def test_discover_project_assets_rejects_links_outside_project(tmp_path: Path) -> None:
    project = tmp_path / "Project"
    renders = project / "Renders"
    outside = tmp_path / "Private"
    renders.mkdir(parents=True)
    outside.mkdir()
    main_flp = project / "Main.flp"
    main_flp.write_bytes(b"main")
    (outside / "Private.wav").write_bytes(b"private")
    link = renders / "Linked"
    _create_directory_link_or_skip(link, outside)

    assert discover_project_assets(main_flp) == []


def test_discover_project_assets_requires_regular_main_project(
    tmp_path: Path,
) -> None:
    with pytest.raises(FileNotFoundError):
        discover_project_assets(tmp_path / "Missing.flp")

    directory = tmp_path / "Directory.flp"
    directory.mkdir()
    with pytest.raises(ValueError, match="regular file"):
        discover_project_assets(directory)

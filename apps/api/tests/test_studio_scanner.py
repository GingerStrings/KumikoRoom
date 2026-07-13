from __future__ import annotations

import hashlib
import os
import subprocess
import sys
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


class _ScandirAdapter:
    def __init__(
        self,
        entries: object,
        transform: object,
        *,
        require_entered: bool = False,
    ) -> None:
        self._entries = entries
        self._transform = transform
        self._require_entered = require_entered
        self.entered = False

    def __enter__(self) -> "_ScandirAdapter":
        self.entered = True
        self._entries.__enter__()  # type: ignore[attr-defined]
        return self

    def __exit__(self, *args: object) -> object:
        return self._entries.__exit__(*args)  # type: ignore[attr-defined]

    def __iter__(self) -> object:
        if self._require_entered and not self.entered:
            raise RuntimeError("scandir must be entered before iteration")
        return (
            self._transform(entry)  # type: ignore[operator]
            for entry in self._entries  # type: ignore[union-attr]
        )


class _MutatingDirEntry:
    def __init__(self, entry: object, mutate: object) -> None:
        self._entry = entry
        self._mutate = mutate
        self._mutated = False

    def __getattr__(self, name: str) -> object:
        return getattr(self._entry, name)

    def stat(self, *, follow_symlinks: bool = True) -> os.stat_result:
        details = self._entry.stat(  # type: ignore[attr-defined]
            follow_symlinks=follow_symlinks
        )
        if not self._mutated:
            self._mutated = True
            self._mutate()  # type: ignore[operator]
        return details


class _MtimeChangingReader:
    def __init__(self, source: object, path: Path, modified_ns: int) -> None:
        self._source = source
        self._path = path
        self._modified_ns = modified_ns
        self._changed = False

    def __enter__(self) -> "_MtimeChangingReader":
        self._source.__enter__()  # type: ignore[attr-defined]
        return self

    def __exit__(self, *args: object) -> object:
        return self._source.__exit__(*args)  # type: ignore[attr-defined]

    def fileno(self) -> int:
        return self._source.fileno()  # type: ignore[attr-defined,no-any-return]

    def read(self, size: int = -1) -> bytes:
        payload = self._source.read(size)  # type: ignore[attr-defined]
        if not self._changed:
            self._changed = True
            details = self._path.stat()
            os.utime(
                self._path,
                ns=(details.st_atime_ns, self._modified_ns),
            )
        return payload  # type: ignore[no-any-return]


class _FakeRegistryKey:
    def __init__(self) -> None:
        self.closed = False

    def __enter__(self) -> "_FakeRegistryKey":
        return self

    def __exit__(self, *args: object) -> None:
        self.closed = True


class _FakeWinreg:
    HKEY_CURRENT_USER = object()

    def __init__(self, value: object) -> None:
        self.value = value
        self.key = _FakeRegistryKey()

    def OpenKey(self, hive: object, path: str) -> _FakeRegistryKey:
        assert hive is self.HKEY_CURRENT_USER
        assert path.endswith(r"Explorer\User Shell Folders")
        return self.key

    def QueryValueEx(self, key: _FakeRegistryKey, name: str) -> tuple[object, int]:
        assert key is self.key
        assert name == "Personal"
        return self.value, 2


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


def test_discover_flp_files_skips_file_replaced_after_entry_stat(
    monkeypatch: pytest.MonkeyPatch,
    tmp_path: Path,
) -> None:
    root = tmp_path / "Projects"
    root.mkdir()
    source = root / "Song.flp"
    source.write_bytes(b"old")
    original_details = source.stat()
    replacement = tmp_path / "replacement.tmp"
    replacement.write_bytes(b"new")
    os.utime(
        replacement,
        ns=(original_details.st_atime_ns, original_details.st_mtime_ns),
    )
    original_scandir = scanner.os.scandir

    def replacing_scandir(path: Path) -> _ScandirAdapter:
        def transform(entry: object) -> object:
            if Path(entry.path) != source:  # type: ignore[attr-defined]
                return entry
            return _MutatingDirEntry(
                entry,
                lambda: os.replace(replacement, source),
            )

        return _ScandirAdapter(original_scandir(path), transform)

    monkeypatch.setattr(scanner.os, "scandir", replacing_scandir)

    assert discover_flp_files([root]) == []


def test_discover_flp_files_skips_directory_replaced_after_entry_stat(
    monkeypatch: pytest.MonkeyPatch,
    tmp_path: Path,
) -> None:
    root = tmp_path / "Projects"
    original_directory = root / "Swap"
    original_directory.mkdir(parents=True)
    replacement_directory = tmp_path / "Replacement"
    replacement_directory.mkdir()
    (replacement_directory / "Private.flp").write_bytes(b"private")
    original_details = original_directory.stat()
    os.utime(
        replacement_directory,
        ns=(original_details.st_atime_ns, original_details.st_mtime_ns),
    )
    moved_original = tmp_path / "Original"
    original_scandir = scanner.os.scandir

    def swap_directory() -> None:
        original_directory.rename(moved_original)
        replacement_directory.rename(original_directory)

    def replacing_scandir(path: Path) -> _ScandirAdapter:
        def transform(entry: object) -> object:
            if Path(entry.path) != original_directory:  # type: ignore[attr-defined]
                return entry
            return _MutatingDirEntry(entry, swap_directory)

        return _ScandirAdapter(original_scandir(path), transform)

    monkeypatch.setattr(scanner.os, "scandir", replacing_scandir)

    assert discover_flp_files([root]) == []


def test_discover_flp_files_uses_scandir_as_context_manager(
    monkeypatch: pytest.MonkeyPatch,
    tmp_path: Path,
) -> None:
    root = tmp_path / "Projects"
    root.mkdir()
    (root / "Song.flp").write_bytes(b"song")
    original_scandir = scanner.os.scandir

    def guarded_scandir(path: Path) -> _ScandirAdapter:
        return _ScandirAdapter(
            original_scandir(path),
            lambda entry: entry,
            require_entered=True,
        )

    monkeypatch.setattr(scanner.os, "scandir", guarded_scandir)

    assert [item.path.name for item in discover_flp_files([root])] == ["Song.flp"]


def test_discover_flp_files_keeps_valid_item_when_another_disappears(
    monkeypatch: pytest.MonkeyPatch,
    tmp_path: Path,
) -> None:
    root = tmp_path / "Projects"
    root.mkdir()
    kept = root / "Keep.flp"
    vanished = root / "Vanish.flp"
    kept.write_bytes(b"keep")
    vanished.write_bytes(b"vanish")
    original_scandir = scanner.os.scandir

    def vanishing_scandir(path: Path) -> _ScandirAdapter:
        def transform(entry: object) -> object:
            if Path(entry.path) != vanished:  # type: ignore[attr-defined]
                return entry
            return _MutatingDirEntry(entry, vanished.unlink)

        return _ScandirAdapter(original_scandir(path), transform)

    monkeypatch.setattr(scanner.os, "scandir", vanishing_scandir)

    assert [item.path for item in discover_flp_files([root])] == [kept.resolve()]


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


def test_observe_file_uses_fstat_from_one_open_handle(
    monkeypatch: pytest.MonkeyPatch,
    tmp_path: Path,
) -> None:
    source = tmp_path / "Song.flp"
    source.write_bytes(b"song")
    resolved = source.resolve()

    def forbidden_path_stat(path: Path, *args: object, **kwargs: object) -> object:
        if path == resolved:
            raise AssertionError("observe_file must use fstat on its open handle")
        return original_path_stat(path, *args, **kwargs)

    original_path_stat = Path.stat
    monkeypatch.setattr(Path, "stat", forbidden_path_stat)

    observation = observe_file(source)

    assert observation.path == resolved
    assert observation.size == 4


def test_sha256_file_rejects_change_during_read(
    monkeypatch: pytest.MonkeyPatch,
    tmp_path: Path,
) -> None:
    source = tmp_path / "Song.flp"
    source.write_bytes(b"song" * 300_000)
    details = source.stat()
    changed_mtime_ns = details.st_mtime_ns + 1_000_000_000
    original_open = Path.open

    def changing_open(path: Path, *args: object, **kwargs: object) -> object:
        opened = original_open(path, *args, **kwargs)
        if path == source.resolve():
            return _MtimeChangingReader(opened, source, changed_mtime_ns)
        return opened

    monkeypatch.setattr(Path, "open", changing_open)

    with pytest.raises(
        scanner.FileChangedDuringRead,
        match="changed during read",
    ):
        sha256_file(source)


def test_sha256_file_rejects_expected_observation_from_replaced_file(
    tmp_path: Path,
) -> None:
    source = tmp_path / "Song.flp"
    source.write_bytes(b"same")
    expected = observe_file(source)
    replacement = tmp_path / "replacement.tmp"
    replacement.write_bytes(b"diff")
    os.utime(
        replacement,
        ns=(expected.modified_ns, expected.modified_ns),
    )
    os.replace(replacement, source)

    with pytest.raises(
        scanner.FileChangedDuringRead,
        match="expected observation",
    ):
        sha256_file(source, expected=expected)


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


def test_windows_documents_registry_expands_environment_and_closes_key(
    monkeypatch: pytest.MonkeyPatch,
    tmp_path: Path,
) -> None:
    fake_winreg = _FakeWinreg(r"%USERPROFILE%\My Documents")
    monkeypatch.setitem(sys.modules, "winreg", fake_winreg)
    monkeypatch.setenv("USERPROFILE", str(tmp_path))

    documents = scanner._windows_documents_from_registry()

    assert documents == tmp_path / "My Documents"
    assert fake_winreg.key.closed


@pytest.mark.parametrize("registry_value", [None, 42])
def test_windows_documents_registry_rejects_non_string_values_and_closes_key(
    monkeypatch: pytest.MonkeyPatch,
    registry_value: object,
) -> None:
    fake_winreg = _FakeWinreg(registry_value)
    monkeypatch.setitem(sys.modules, "winreg", fake_winreg)

    assert scanner._windows_documents_from_registry() is None
    assert fake_winreg.key.closed


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

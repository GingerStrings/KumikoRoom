from __future__ import annotations

import hashlib
import ntpath
import os
import stat
from dataclasses import dataclass, field
from datetime import datetime, timezone
from pathlib import Path
from typing import Iterable, Iterator, Literal

from .models import ProjectAsset


AssetKind = Literal["render", "audio", "backup"]
_ASSET_DIRECTORY_SPECS: tuple[tuple[str, AssetKind], ...] = (
    ("Renders", "render"),
    ("Audio", "audio"),
    ("Backup", "backup"),
    ("Backups", "backup"),
)
_AUDIO_ASSET_EXTENSIONS = frozenset({".wav", ".mp3", ".flac", ".ogg", ".m4a"})
_BACKUP_ASSET_EXTENSIONS = frozenset({".flp"})


@dataclass(frozen=True)
class DiscoveredFlp:
    path: Path
    root: Path
    modified_ns: int
    size: int


@dataclass(frozen=True)
class FileObservation:
    path: Path
    size: int
    modified_ns: int
    _identity: tuple[int, int] | None = field(
        default=None,
        repr=False,
        compare=False,
    )


class FileChangedDuringRead(RuntimeError):
    pass


def observe_file(path: Path) -> FileObservation:
    resolved = Path(path).expanduser().resolve(strict=True)
    with resolved.open("rb") as source:
        details = os.fstat(source.fileno())
        if not stat.S_ISREG(details.st_mode):
            raise ValueError(f"observed path must be a file: {path}")
    return FileObservation(
        path=resolved,
        size=details.st_size,
        modified_ns=details.st_mtime_ns,
        _identity=_file_identity(details),
    )


def is_stable(first: FileObservation, second: FileObservation) -> bool:
    return first.size == second.size and first.modified_ns == second.modified_ns


def sha256_file(
    path: Path,
    *,
    expected: FileObservation | None = None,
) -> str:
    resolved = Path(path).expanduser().resolve(strict=True)
    digest = hashlib.sha256()
    with resolved.open("rb") as source:
        before = os.fstat(source.fileno())
        if not stat.S_ISREG(before.st_mode):
            raise ValueError(f"hashed path must be a file: {path}")
        if expected is not None and not _matches_observation(
            resolved,
            before,
            expected,
        ):
            raise FileChangedDuringRead(
                f"{resolved} does not match the expected observation"
            )
        while chunk := source.read(1024 * 1024):
            digest.update(chunk)
        after = os.fstat(source.fileno())
        try:
            current_path_details = resolved.lstat()
        except OSError as exc:
            raise FileChangedDuringRead(f"{resolved} changed during read") from exc
        if (
            not _same_file_version(before, after)
            or not _same_file_version(after, current_path_details)
        ):
            raise FileChangedDuringRead(f"{resolved} changed during read")
    return digest.hexdigest()


def _matches_observation(
    path: Path,
    details: os.stat_result,
    expected: FileObservation,
) -> bool:
    expected_identity_matches = (
        expected._identity is None
        or expected._identity == _file_identity(details)
    )
    return (
        _path_identity(path) == _path_identity(expected.path)
        and expected_identity_matches
        and expected.size == details.st_size
        and expected.modified_ns == details.st_mtime_ns
    )


def default_fl_studio_backup_root() -> Path | None:
    documents: Path | None = None
    if _is_windows():
        try:
            documents = _windows_documents_from_registry()
        except (OSError, TypeError, ValueError):
            documents = None
    if documents is None:
        documents = _home_directory() / "Documents"
    documents = Path(documents).expanduser()

    backup = documents / "Image-Line" / "FL Studio" / "Projects" / "Backup"
    try:
        return backup if backup.is_dir() else None
    except OSError:
        return None


def _windows_documents_from_registry() -> Path | None:
    try:
        import winreg
    except ImportError:
        return None

    registry_path = (
        r"Software\Microsoft\Windows\CurrentVersion\Explorer"
        r"\User Shell Folders"
    )
    with winreg.OpenKey(winreg.HKEY_CURRENT_USER, registry_path) as key:
        value, _ = winreg.QueryValueEx(key, "Personal")
    if not isinstance(value, str) or not value.strip():
        return None
    return Path(ntpath.expandvars(value)).expanduser()


def _home_directory() -> Path:
    return Path.home()


def discover_project_assets(main_flp: Path) -> list[ProjectAsset]:
    source = Path(main_flp).expanduser()
    source_details = source.lstat()
    if _is_reparse_point(source_details) or not stat.S_ISREG(source_details.st_mode):
        raise ValueError(f"main FLP must be a regular file: {main_flp}")

    parent_details = source.parent.lstat()
    if _is_reparse_point(parent_details) or not stat.S_ISDIR(parent_details.st_mode):
        raise ValueError(f"main FLP must be located in a regular directory: {main_flp}")

    resolved_source = source.resolve(strict=True)
    project_directory = resolved_source.parent
    assets: dict[str, ProjectAsset] = {}
    for directory_name, kind in _ASSET_DIRECTORY_SPECS:
        asset_directory = project_directory / directory_name
        try:
            directory_details = asset_directory.lstat()
            if (
                _is_reparse_point(directory_details)
                or not stat.S_ISDIR(directory_details.st_mode)
            ):
                continue
            resolved_directory = asset_directory.resolve(strict=True)
            if not resolved_directory.is_relative_to(project_directory):
                continue
        except OSError:
            continue

        allowed_extensions = (
            _BACKUP_ASSET_EXTENSIONS if kind == "backup" else _AUDIO_ASSET_EXTENSIONS
        )
        for path, details in _bounded_regular_files(
            resolved_directory,
            expected_root_details=directory_details,
        ):
            if path.suffix.casefold() not in allowed_extensions:
                continue
            identity = _path_identity(path)
            assets.setdefault(
                identity,
                ProjectAsset(
                    path=str(path),
                    kind=kind,
                    modified_at=datetime.fromtimestamp(
                        details.st_mtime,
                        timezone.utc,
                    ).isoformat(),
                    size=details.st_size,
                ),
            )

    return sorted(
        assets.values(),
        key=lambda asset: (asset.path.casefold(), asset.path),
    )


def discover_flp_files(roots: Iterable[Path]) -> list[DiscoveredFlp]:
    discovered: dict[str, DiscoveredFlp] = {}
    resolved_roots: dict[str, Path] = {}

    for root in roots:
        source_root = Path(root).expanduser()
        root_details = source_root.lstat()
        if _is_reparse_point(root_details) or not stat.S_ISDIR(root_details.st_mode):
            raise ValueError(
                f"FL Studio project root must be a regular directory: {root}"
            )
        resolved_root = source_root.resolve(strict=True)
        if not resolved_root.is_dir():
            raise ValueError(f"FL Studio project root must be a directory: {root}")
        root_identity = _path_identity(resolved_root)
        if root_identity in resolved_roots:
            continue
        resolved_roots[root_identity] = resolved_root

        for resolved, details in _bounded_regular_files(
            resolved_root,
            expected_root_details=root_details,
        ):
            if resolved.suffix.casefold() != ".flp":
                continue
            identity = _path_identity(resolved)
            discovered.setdefault(
                identity,
                DiscoveredFlp(
                    path=resolved,
                    root=resolved_root,
                    modified_ns=details.st_mtime_ns,
                    size=details.st_size,
                ),
            )

    return sorted(
        discovered.values(),
        key=lambda item: (str(item.path).casefold(), str(item.path)),
    )


def _path_identity(path: Path) -> str:
    canonical = str(path.expanduser().resolve())
    normalizer = ntpath.normcase if _is_windows() else os.path.normcase
    return normalizer(canonical)


def _is_windows() -> bool:
    return os.name == "nt"


def _bounded_regular_files(
    root: Path,
    *,
    expected_root_details: os.stat_result | None = None,
) -> Iterator[tuple[Path, os.stat_result]]:
    if expected_root_details is None:
        try:
            expected_root_details = root.lstat()
        except OSError:
            return
    pending = [(root, expected_root_details)]
    while pending:
        directory, expected_details = pending.pop()
        try:
            current_directory_details = directory.lstat()
            if (
                _is_reparse_point(current_directory_details)
                or not stat.S_ISDIR(current_directory_details.st_mode)
                or not _same_file_version(
                    expected_details,
                    current_directory_details,
                )
            ):
                continue

            with os.scandir(directory) as entries:
                for entry in entries:
                    candidate = Path(entry.path)
                    try:
                        candidate_details = candidate.lstat()
                        entry_details = entry.stat(follow_symlinks=False)
                        if (
                            _is_reparse_point(entry_details)
                            or _is_reparse_point(candidate_details)
                            or not _same_entry_metadata(
                                entry_details,
                                candidate_details,
                            )
                        ):
                            continue
                        if not (
                            stat.S_ISDIR(candidate_details.st_mode)
                            or stat.S_ISREG(candidate_details.st_mode)
                        ):
                            continue
                        resolved = candidate.resolve(strict=True)
                        if not resolved.is_relative_to(root):
                            continue
                        current_details = resolved.lstat()
                        if (
                            _is_reparse_point(current_details)
                            or not _same_file_version(
                                candidate_details,
                                current_details,
                            )
                        ):
                            continue
                        if stat.S_ISDIR(current_details.st_mode):
                            pending.append((resolved, current_details))
                        elif stat.S_ISREG(current_details.st_mode):
                            yield resolved, current_details
                    except OSError:
                        continue
        except OSError:
            continue


def _same_file_version(first: os.stat_result, second: os.stat_result) -> bool:
    return (
        _file_identity(first) == _file_identity(second)
        and first.st_size == second.st_size
        and first.st_mtime_ns == second.st_mtime_ns
    )


def _file_identity(details: os.stat_result) -> tuple[int, int]:
    return details.st_dev, details.st_ino


def _same_entry_metadata(first: os.stat_result, second: os.stat_result) -> bool:
    first_identity = (first.st_dev, first.st_ino)
    second_identity = (second.st_dev, second.st_ino)
    identity_matches = (
        not all(first_identity)
        or not all(second_identity)
        or first_identity == second_identity
    )
    return (
        identity_matches
        and stat.S_IFMT(first.st_mode) == stat.S_IFMT(second.st_mode)
        and first.st_size == second.st_size
        and first.st_mtime_ns == second.st_mtime_ns
    )


def _is_reparse_point(details: os.stat_result) -> bool:
    attributes = getattr(details, "st_file_attributes", 0)
    reparse_attribute = getattr(stat, "FILE_ATTRIBUTE_REPARSE_POINT", 0x400)
    return bool(attributes & reparse_attribute)

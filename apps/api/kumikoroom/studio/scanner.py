from __future__ import annotations

import hashlib
import ntpath
import os
import stat
from dataclasses import dataclass
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


def observe_file(path: Path) -> FileObservation:
    resolved = Path(path).expanduser().resolve(strict=True)
    details = resolved.stat()
    if not resolved.is_file():
        raise ValueError(f"observed path must be a file: {path}")
    return FileObservation(
        path=resolved,
        size=details.st_size,
        modified_ns=details.st_mtime_ns,
    )


def is_stable(first: FileObservation, second: FileObservation) -> bool:
    return first.size == second.size and first.modified_ns == second.modified_ns


def sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with Path(path).open("rb") as source:
        while chunk := source.read(1024 * 1024):
            digest.update(chunk)
    return digest.hexdigest()


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
        for path, details in _bounded_regular_files(resolved_directory):
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

        for resolved, details in _bounded_regular_files(resolved_root):
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


def _bounded_regular_files(root: Path) -> Iterator[tuple[Path, os.stat_result]]:
    pending = [root]
    while pending:
        directory = pending.pop()
        try:
            entries = list(os.scandir(directory))
        except OSError:
            continue

        for entry in entries:
            candidate = Path(entry.path)
            try:
                details = entry.stat(follow_symlinks=False)
                if _is_reparse_point(details) or entry.is_symlink():
                    continue
                resolved = candidate.resolve(strict=True)
                if not resolved.is_relative_to(root):
                    continue
                if stat.S_ISDIR(details.st_mode):
                    pending.append(resolved)
                elif stat.S_ISREG(details.st_mode):
                    yield resolved, details
            except OSError:
                continue


def _is_reparse_point(details: os.stat_result) -> bool:
    attributes = getattr(details, "st_file_attributes", 0)
    reparse_attribute = getattr(stat, "FILE_ATTRIBUTE_REPARSE_POINT", 0x400)
    return bool(attributes & reparse_attribute)

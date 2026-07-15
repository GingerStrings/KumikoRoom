import hashlib
import os
from pathlib import Path
from threading import RLock
from typing import Annotated, Literal, Protocol

from fastapi import APIRouter, Depends, HTTPException, Query, Response, status
from pydantic import BaseModel, ConfigDict

from kumikoroom.config import load_settings
from kumikoroom.studio.models import (
    AnalysisDiagnostic,
    AnalysisStatus,
    AutomationSummary,
    ChannelSummary,
    FlpAnalysisSnapshot,
    MixerInsertSummary,
    MusicalFingerprint,
    PatternSummary,
    PlaylistClipSummary,
    PluginInstance,
    ProjectAsset,
    ProjectInfo,
)
from kumikoroom.studio.parsers import PyFlpParser
from kumikoroom.studio.diff import diff_snapshots
from kumikoroom.studio.repository import (
    ScanJobStatus,
    StudioProject,
    StudioRepository,
    StudioScanJob,
    StudioSnapshotRecord,
)
from kumikoroom.studio.service import StudioService


router = APIRouter(prefix="/api/studio", tags=["studio"])


class StudioModel(BaseModel):
    model_config = ConfigDict(from_attributes=True)


class RootOut(StudioModel):
    id: str
    path: str
    created_at: str


class RootIn(BaseModel):
    path: str


class ScanJobOut(StudioModel):
    id: str
    status: ScanJobStatus
    discovered_count: int
    parsed_count: int
    cached_count: int
    failed_count: int
    error: str | None
    created_at: str
    updated_at: str


class ProjectSummary(StudioModel):
    id: str
    canonical_path: str
    display_name: str
    status: AnalysisStatus
    modified_at: str | None
    latest_snapshot_id: str | None
    created_at: str
    updated_at: str
    tempo: float | None = None
    pattern_count: int = 0
    warning_count: int = 0
    error_count: int = 0
    diagnostic_count: int = 0
    inferred_key: str | None = None


class ProjectDetail(ProjectSummary):
    latest_snapshot_source_hash: str | None = None
    latest_snapshot_analyzed_at: str | None = None


class DependencyOut(StudioModel):
    entity_id: str
    path: str
    kind: str
    exists: bool


class AnalysisOut(StudioModel):
    source_path: str
    source_hash: str
    status: AnalysisStatus
    project: ProjectInfo
    patterns: list[PatternSummary]
    channels: list[ChannelSummary]
    playlist_clips: list[PlaylistClipSummary]
    plugins: list[PluginInstance]
    mixer_inserts: list[MixerInsertSummary]
    automations: list[AutomationSummary]
    related_assets: list[ProjectAsset]
    dependencies: list[DependencyOut]
    fingerprint: MusicalFingerprint
    diagnostics: list[AnalysisDiagnostic]
    unknown_event_count: int


class VersionOut(StudioModel):
    snapshot_id: str
    source_path: str
    source_hash: str
    analyzed_at: str
    kind: Literal["current", "history", "backup", "candidate"]
    association_id: str | None = None
    score: float | None = None
    confirmed: bool
    title: str | None = None
    tempo: float | None = None
    pattern_count: int | None = None


class VersionPageOut(StudioModel):
    items: list[VersionOut]
    next_cursor: str | None = None


class ConfirmVersionIn(BaseModel):
    candidate_id: str


class ConfirmVersionOut(StudioModel):
    id: str
    project_id: str
    candidate_project_id: str
    snapshot_id: str
    score: float
    confirmed: bool
    created_at: str
    updated_at: str


class OpenProjectIn(BaseModel):
    model_config = ConfigDict(extra="forbid")

    kind: Literal["project", "folder", "dependency", "backup"]
    entity_id: str | None = None


class LocalOpener(Protocol):
    def open(self, target: Path) -> None: ...


class WindowsLocalOpener:
    def open(self, target: Path) -> None:
        startfile = getattr(os, "startfile", None)
        if startfile is None:
            raise OSError("Local open actions require Windows")
        startfile(str(target))


def local_opener() -> LocalOpener:
    return WindowsLocalOpener()


LocalOpenerDependency = Annotated[LocalOpener, Depends(local_opener)]


def studio_repository() -> StudioRepository:
    return StudioRepository(load_settings().studio_db_path)


StudioRepositoryDependency = Annotated[StudioRepository, Depends(studio_repository)]


_studio_service_lock = RLock()
_default_studio_service: StudioService | None = None
_default_studio_service_db_path: Path | None = None
_root_mutation_lock = RLock()


def studio_service() -> StudioService:
    global _default_studio_service, _default_studio_service_db_path

    db_path = load_settings().studio_db_path.expanduser().resolve()
    with _studio_service_lock:
        if (
            _default_studio_service is None
            or _default_studio_service_db_path != db_path
        ):
            if _default_studio_service is not None:
                _default_studio_service.close()
            _default_studio_service = StudioService(
                StudioRepository(db_path),
                PyFlpParser(),
            )
            _default_studio_service_db_path = db_path
        return _default_studio_service


def close_studio_service() -> None:
    global _default_studio_service, _default_studio_service_db_path

    with _studio_service_lock:
        service = _default_studio_service
        _default_studio_service = None
        _default_studio_service_db_path = None
    if service is not None:
        service.close()


StudioServiceDependency = Annotated[StudioService, Depends(studio_service)]


@router.get("/roots", response_model=list[RootOut])
def list_roots(repository: StudioRepositoryDependency) -> list[RootOut]:
    return [RootOut.model_validate(root) for root in repository.list_roots()]


@router.post("/roots", response_model=RootOut, status_code=status.HTTP_201_CREATED)
def create_root(
    payload: RootIn,
    response: Response,
    repository: StudioRepositoryDependency,
) -> RootOut:
    root_path = payload.path.strip()
    if not root_path:
        raise HTTPException(status_code=400, detail="Studio root path is invalid")
    try:
        canonical_path = Path(root_path).expanduser().resolve(strict=True)
    except (OSError, RuntimeError):
        raise HTTPException(status_code=400, detail="Studio root path is invalid") from None
    if not canonical_path.is_dir() or not os.access(
        canonical_path,
        os.R_OK | os.X_OK,
    ):
        raise HTTPException(status_code=400, detail="Studio root must be a readable directory")

    with _root_mutation_lock:
        identity = os.path.normcase(str(canonical_path))
        existing = next(
            (
                root
                for root in repository.list_roots()
                if os.path.normcase(str(Path(root.path).resolve())) == identity
            ),
            None,
        )
        root = (
            existing
            if existing is not None
            else repository.add_root(canonical_path)
        )
    if existing is not None:
        response.status_code = status.HTTP_200_OK
    return RootOut.model_validate(root)


@router.delete("/roots/{root_id}", status_code=status.HTTP_204_NO_CONTENT)
def delete_root(
    root_id: str,
    repository: StudioRepositoryDependency,
) -> Response:
    try:
        repository.remove_root(root_id)
    except KeyError:
        raise HTTPException(status_code=404, detail="Studio root not found") from None
    return Response(status_code=status.HTTP_204_NO_CONTENT)


@router.post("/scans", response_model=ScanJobOut, status_code=status.HTTP_202_ACCEPTED)
def start_scan(service: StudioServiceDependency) -> ScanJobOut:
    return _scan_job_out(service.start_scan())


@router.get("/scans/{scan_id}", response_model=ScanJobOut)
def get_scan(scan_id: str, service: StudioServiceDependency) -> ScanJobOut:
    try:
        job = service.get_scan_job(scan_id)
    except KeyError:
        raise HTTPException(status_code=404, detail="Studio scan not found") from None
    return _scan_job_out(job)


@router.get("/projects", response_model=list[ProjectSummary])
def list_projects(
    repository: StudioRepositoryDependency,
) -> list[ProjectSummary]:
    return [
        _project_out(project, record)
        for project, record in repository.list_projects_with_latest_snapshots()
        if not _is_backup_candidate_path(project.canonical_path)
    ]


@router.get("/projects/{project_id}", response_model=ProjectDetail)
def get_project(
    project_id: str,
    repository: StudioRepositoryDependency,
) -> ProjectDetail:
    try:
        project = repository.get_project(project_id)
    except KeyError:
        raise HTTPException(status_code=404, detail="Studio project not found") from None

    record = _latest_snapshot(repository, project)
    summary = _project_out(project, record)
    return ProjectDetail(
        **summary.model_dump(),
        latest_snapshot_source_hash=(record.source_hash if record is not None else None),
        latest_snapshot_analyzed_at=(record.analyzed_at if record is not None else None),
    )


@router.get("/projects/{project_id}/analysis", response_model=AnalysisOut)
def get_project_analysis(
    project_id: str,
    repository: StudioRepositoryDependency,
) -> AnalysisOut:
    try:
        repository.get_project(project_id)
        record = repository.get_latest_snapshot(project_id)
    except KeyError:
        raise HTTPException(
            status_code=404,
            detail="Studio project analysis not found",
        ) from None
    try:
        snapshot = record.snapshot
    except (TypeError, ValueError):
        raise HTTPException(
            status_code=409,
            detail="Stored analysis is invalid; rescan the project.",
        ) from None
    return AnalysisOut.model_validate(
        {
            **snapshot.__dict__,
            "dependencies": [
                DependencyOut(
                    entity_id=_dependency_entity_id(
                        project_id,
                        record.id,
                        index,
                        dependency.path,
                        Path(snapshot.source_path).parent,
                    ),
                    path=dependency.path,
                    kind=dependency.kind,
                    exists=dependency.exists,
                )
                for index, dependency in enumerate(snapshot.dependencies)
            ],
        }
    )


@router.post(
    "/projects/{project_id}/open",
    status_code=status.HTTP_204_NO_CONTENT,
)
def open_project_target(
    project_id: str,
    payload: OpenProjectIn,
    repository: StudioRepositoryDependency,
    opener: LocalOpenerDependency,
) -> Response:
    try:
        project = repository.get_project(project_id)
    except KeyError:
        raise HTTPException(status_code=404, detail="Studio project not found") from None

    try:
        target = _resolve_open_target(repository, project, payload)
    except KeyError:
        raise HTTPException(status_code=404, detail="Local target not found") from None
    except ValueError:
        raise HTTPException(status_code=400, detail="Local target is invalid") from None
    except (FileNotFoundError, NotADirectoryError, PermissionError, OSError):
        raise HTTPException(
            status_code=409, detail="Local target no longer exists or is unavailable"
        ) from None

    try:
        opener.open(target)
    except OSError:
        raise HTTPException(status_code=409, detail="Local target could not be opened") from None
    return Response(status_code=status.HTTP_204_NO_CONTENT)


@router.get("/projects/{project_id}/versions", response_model=VersionPageOut)
def list_project_versions(
    project_id: str,
    repository: StudioRepositoryDependency,
    limit: int = Query(default=50, ge=1, le=100),
    cursor: str | None = Query(default=None),
) -> VersionPageOut:
    try:
        page = repository.list_project_versions_page(
            project_id,
            limit=limit,
            cursor=cursor,
        )
    except KeyError:
        raise HTTPException(status_code=404, detail="Studio project not found") from None
    except ValueError:
        raise HTTPException(status_code=400, detail="Version cursor is invalid") from None
    return VersionPageOut(
        items=[
            VersionOut(
                snapshot_id=version.snapshot_id,
                source_path=version.source_path,
                source_hash=version.source_hash,
                analyzed_at=version.analyzed_at,
                kind=version.kind,
                association_id=version.association_id,
                score=version.score,
                confirmed=version.confirmed,
                title=version.title,
                tempo=version.tempo,
                pattern_count=version.pattern_count,
            )
            for version in page.items
        ],
        next_cursor=page.next_cursor,
    )


@router.post(
    "/projects/{project_id}/versions/confirm",
    response_model=ConfirmVersionOut,
)
def confirm_project_version(
    project_id: str,
    payload: ConfirmVersionIn,
    repository: StudioRepositoryDependency,
) -> ConfirmVersionOut:
    try:
        association = repository.confirm_backup_association(
            project_id, payload.candidate_id
        )
    except KeyError:
        raise HTTPException(status_code=404, detail="Backup candidate not found") from None
    except ValueError:
        raise HTTPException(
            status_code=400, detail="Backup candidate does not belong to project"
        ) from None
    return ConfirmVersionOut.model_validate(association)


@router.get("/projects/{project_id}/diff")
def get_project_diff(
    project_id: str,
    repository: StudioRepositoryDependency,
    from_snapshot_id: str = Query(alias="from"),
    to_snapshot_id: str = Query(alias="to"),
) -> dict[str, object]:
    try:
        repository.get_project(project_id)
    except KeyError:
        raise HTTPException(status_code=404, detail="Studio project not found") from None
    try:
        before_record = repository.get_project_version_snapshot(
            project_id, from_snapshot_id
        )
        after_record = repository.get_project_version_snapshot(
            project_id, to_snapshot_id
        )
    except ValueError:
        raise HTTPException(
            status_code=400, detail="Snapshot does not belong to project"
        ) from None
    try:
        result = diff_snapshots(before_record.snapshot, after_record.snapshot)
    except (TypeError, ValueError):
        raise HTTPException(
            status_code=409,
            detail="Stored version analysis is invalid; rescan the project.",
        ) from None
    result["from_snapshot_id"] = from_snapshot_id
    result["to_snapshot_id"] = to_snapshot_id
    return result


def _scan_job_out(job: StudioScanJob) -> ScanJobOut:
    return ScanJobOut.model_validate(job)


def _project_out(
    project: StudioProject,
    record: StudioSnapshotRecord | None,
) -> ProjectSummary:
    snapshot = _snapshot_value(record)
    diagnostics = snapshot.diagnostics if snapshot is not None else []
    return ProjectSummary.model_validate(project).model_copy(
        update={
            "tempo": snapshot.project.tempo if snapshot is not None else None,
            "pattern_count": len(snapshot.patterns) if snapshot is not None else 0,
            "warning_count": sum(
                item.severity == "warning" for item in diagnostics
            ),
            "error_count": sum(item.severity == "error" for item in diagnostics),
            "diagnostic_count": len(diagnostics),
            "inferred_key": (
                snapshot.fingerprint.inferred_key if snapshot is not None else None
            ),
        }
    )


def _latest_snapshot(
    repository: StudioRepository,
    project: StudioProject,
) -> StudioSnapshotRecord | None:
    if project.latest_snapshot_id is None:
        return None
    try:
        return repository.get_latest_snapshot(project.id)
    except KeyError:
        return None


def _snapshot_value(
    record: StudioSnapshotRecord | None,
) -> FlpAnalysisSnapshot | None:
    if record is None:
        return None
    try:
        return record.snapshot
    except (TypeError, ValueError):
        return None


def _is_backup_candidate_path(path: str) -> bool:
    return any(
        part.casefold() in {"backup", "backups"}
        for part in Path(path).parts[:-1]
    )


def _entity_id(
    kind: str,
    project_id: str,
    snapshot_id: str,
    index: int,
    recorded_path: str,
) -> str:
    identity = "\0".join(
        (kind, project_id, snapshot_id, str(index), recorded_path)
    ).encode("utf-8", errors="surrogatepass")
    return f"{kind}_{hashlib.sha256(identity).hexdigest()}"


def _resolve_open_target(
    repository: StudioRepository,
    project: StudioProject,
    payload: OpenProjectIn,
) -> Path:
    project_path = Path(project.canonical_path)
    if payload.kind == "project":
        if payload.entity_id is not None:
            raise ValueError("project actions do not accept entity ids")
        return _existing_path(project_path, expected="file")
    if payload.kind == "folder":
        if payload.entity_id is not None:
            raise ValueError("folder actions do not accept entity ids")
        return _existing_path(project_path.parent, expected="directory")
    if not payload.entity_id:
        raise ValueError("entity id is required")

    if payload.kind == "backup":
        association = repository.get_backup_association(
            project.id, payload.entity_id
        )
        candidate = repository.get_project(association.candidate_project_id)
        backup_path = _existing_path(Path(candidate.canonical_path), expected="file")
        return _existing_path(backup_path.parent, expected="directory")

    try:
        record = repository.get_latest_snapshot(project.id)
        snapshot = record.snapshot
    except KeyError:
        raise KeyError(payload.entity_id) from None
    except (TypeError, ValueError):
        raise OSError("stored analysis is invalid") from None
    dependency_match = next(
        (
            (index, item)
            for index, item in enumerate(snapshot.dependencies)
            if payload.entity_id.startswith(
                f"{_entity_id('dependency', project.id, record.id, index, item.path)}_"
            )
        ),
        None,
    )
    if dependency_match is None:
        raise KeyError(payload.entity_id)
    index, dependency = dependency_match
    if not dependency.exists:
        raise FileNotFoundError(dependency.path)
    current_entity_id = _dependency_entity_id(
        project.id,
        record.id,
        index,
        dependency.path,
        Path(project.canonical_path).parent,
    )
    if current_entity_id != payload.entity_id:
        raise OSError("dependency target changed after entity id was issued")
    raw_path = Path(dependency.path).expanduser()
    dependency_path = (
        raw_path
        if raw_path.is_absolute()
        else Path(project.canonical_path).parent / raw_path
    )
    resolved = _existing_path(dependency_path)
    return resolved if resolved.is_dir() else _existing_path(
        resolved.parent, expected="directory"
    )


def _existing_path(path: Path, *, expected: str | None = None) -> Path:
    resolved = path.resolve(strict=True)
    # Refresh metadata immediately before dispatch; startfile itself remains an
    # OS-level operation, so no shell interpolation or user-controlled command exists.
    resolved.stat()
    if expected == "file" and not resolved.is_file():
        raise FileNotFoundError(str(resolved))
    if expected == "directory" and not resolved.is_dir():
        raise NotADirectoryError(str(resolved))
    return resolved


def _dependency_entity_id(
    project_id: str,
    snapshot_id: str,
    index: int,
    recorded_path: str,
    project_folder: Path,
) -> str:
    base = _entity_id(
        "dependency", project_id, snapshot_id, index, recorded_path
    )
    raw_path = Path(recorded_path).expanduser()
    candidate = raw_path if raw_path.is_absolute() else project_folder / raw_path
    try:
        resolved = candidate.resolve(strict=True)
        metadata = resolved.stat()
        version = "\0".join(
            (
                os.path.normcase(str(resolved)),
                str(metadata.st_dev),
                str(metadata.st_ino),
                str(metadata.st_size),
                str(metadata.st_mtime_ns),
            )
        )
    except (FileNotFoundError, NotADirectoryError, PermissionError, OSError):
        version = "unavailable"
    version_hash = hashlib.sha256(
        version.encode("utf-8", errors="surrogatepass")
    ).hexdigest()
    return f"{base}_{version_hash}"

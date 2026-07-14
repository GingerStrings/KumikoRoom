import os
from pathlib import Path
from threading import RLock
from typing import Annotated

from fastapi import APIRouter, Depends, HTTPException, Response, status
from pydantic import BaseModel, ConfigDict

from kumikoroom.config import load_settings
from kumikoroom.studio.models import (
    AnalysisDiagnostic,
    AnalysisStatus,
    AutomationSummary,
    ChannelSummary,
    DependencyReference,
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
    dependencies: list[DependencyReference]
    fingerprint: MusicalFingerprint
    diagnostics: list[AnalysisDiagnostic]
    unknown_event_count: int


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
    projects = repository.list_projects()
    latest_snapshots = repository.list_latest_snapshots()
    return [
        _project_out(project, latest_snapshots.get(project.id))
        for project in projects
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
    return AnalysisOut.model_validate_json(record.payload_json)


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

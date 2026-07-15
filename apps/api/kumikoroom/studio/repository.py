import base64
import json
import os
import sqlite3
import stat
import uuid
from dataclasses import dataclass, replace
from datetime import datetime, timezone
from pathlib import Path
from typing import Literal

from .models import (
    AnalysisStatus,
    DependencyOpenIdentity,
    DependencyReference,
    FlpAnalysisSnapshot,
)


ScanJobStatus = Literal["queued", "running", "completed", "failed"]
_SCAN_JOB_STATUSES: frozenset[str] = frozenset(
    {"queued", "running", "completed", "failed"}
)
_SCAN_JOB_UPDATE_FIELDS: frozenset[str] = frozenset(
    {
        "status",
        "discovered_count",
        "parsed_count",
        "cached_count",
        "failed_count",
        "error",
    }
)
_SCAN_JOB_COUNT_FIELDS: frozenset[str] = frozenset(
    {"discovered_count", "parsed_count", "cached_count", "failed_count"}
)
_SQLITE_MAX_INT = 2**63 - 1
_DEPENDENCY_IDENTITY_CAPTURE_LIMIT = 512


@dataclass(frozen=True)
class StudioRoot:
    id: str
    path: str
    created_at: str


@dataclass(frozen=True)
class StudioProject:
    id: str
    canonical_path: str
    display_name: str
    status: AnalysisStatus
    modified_at: str | None
    latest_snapshot_id: str | None
    created_at: str
    updated_at: str


@dataclass(frozen=True)
class ProjectOpenIdentity:
    project_id: str
    canonical_path_identity: str
    file_dev: int
    file_ino: int
    parent_path_identity: str
    parent_dev: int
    parent_ino: int


@dataclass(frozen=True)
class StudioSnapshotRecord:
    id: str
    project_id: str
    source_path: str
    source_hash: str
    analyzed_at: str
    payload_json: str

    @property
    def snapshot(self) -> FlpAnalysisSnapshot:
        return FlpAnalysisSnapshot.from_json(self.payload_json)


@dataclass(frozen=True)
class BackupAssociation:
    id: str
    project_id: str
    candidate_project_id: str
    snapshot_id: str
    score: float
    confirmed: bool
    created_at: str
    updated_at: str


@dataclass(frozen=True)
class StudioVersionRecord:
    snapshot_id: str
    project_id: str
    source_path: str
    source_hash: str
    analyzed_at: str
    title: str | None
    tempo: float | None
    pattern_count: int | None
    kind: Literal["current", "history", "backup", "candidate"]
    association_id: str | None = None
    score: float | None = None
    confirmed: bool = True


@dataclass(frozen=True)
class StudioVersionPage:
    items: list[StudioVersionRecord]
    next_cursor: str | None


@dataclass(frozen=True)
class _VersionView:
    project_id: str
    latest_snapshot_id: str | None
    snapshot_rowid: int
    association_rowid: int


@dataclass(frozen=True)
class _VersionCursor:
    view: _VersionView
    after: tuple[int, str, str]


@dataclass(frozen=True)
class StudioScanJob:
    id: str
    status: ScanJobStatus
    discovered_count: int
    parsed_count: int
    cached_count: int
    failed_count: int
    error: str | None
    created_at: str
    updated_at: str


class StudioRepository:
    def __init__(self, db_path: Path | str) -> None:
        self._db_path = Path(db_path)
        self._db_path.parent.mkdir(parents=True, exist_ok=True)
        self._initialize_schema()

    @property
    def db_path(self) -> Path:
        return self._db_path

    def add_root(self, path: Path) -> StudioRoot:
        canonical_path = _canonical_path(path)
        path_identity = _path_identity(path)
        connection = self._connect()
        try:
            with connection:
                connection.execute(
                    """
                    INSERT OR IGNORE INTO studio_roots (
                        id, path, path_identity, created_at
                    )
                    VALUES (?, ?, ?, ?)
                    """,
                    (
                        str(uuid.uuid4()),
                        canonical_path,
                        path_identity,
                        _utc_now(),
                    ),
                )
                row = connection.execute(
                    """
                    SELECT id, path, created_at
                    FROM studio_roots
                    WHERE path_identity = ?
                    """,
                    (path_identity,),
                ).fetchone()
        finally:
            connection.close()

        assert row is not None
        return self._root_from_row(row)

    def remove_root(self, root_id: str) -> None:
        connection = self._connect()
        try:
            with connection:
                cursor = connection.execute(
                    "DELETE FROM studio_roots WHERE id = ?",
                    (root_id,),
                )
                if cursor.rowcount == 0:
                    raise KeyError(root_id)
        finally:
            connection.close()

    def list_roots(self) -> list[StudioRoot]:
        connection = self._connect()
        try:
            rows = connection.execute(
                """
                SELECT id, path, created_at
                FROM studio_roots
                ORDER BY created_at, rowid
                """
            ).fetchall()
        finally:
            connection.close()
        return [self._root_from_row(row) for row in rows]

    def upsert_project(
        self,
        canonical_path: Path,
        *,
        display_name: str,
        status: AnalysisStatus | str = AnalysisStatus.DISCOVERED,
        modified_at: str | None = None,
    ) -> StudioProject:
        path_value = _canonical_path(canonical_path)
        path_identity = _path_identity(canonical_path)
        open_identity = _capture_open_identity(Path(path_value))
        if not isinstance(display_name, str):
            raise TypeError("display_name must be a string")
        if not display_name.strip():
            raise ValueError("display_name must not be blank")
        project_status = _analysis_status(status)
        modified_at_value = (
            _normalize_utc_iso(modified_at) if modified_at is not None else None
        )
        now = _utc_now()
        connection = self._connect()
        try:
            with connection:
                connection.execute(
                    """
                    INSERT INTO studio_projects (
                        id, canonical_path, canonical_path_identity, display_name,
                        status, modified_at, latest_snapshot_id, created_at, updated_at
                    )
                    VALUES (?, ?, ?, ?, ?, ?, NULL, ?, ?)
                    ON CONFLICT DO NOTHING
                    """,
                    (
                        str(uuid.uuid4()),
                        path_value,
                        path_identity,
                        display_name,
                        project_status.value,
                        modified_at_value,
                        now,
                        now,
                    ),
                )
                connection.execute(
                    """
                    UPDATE studio_projects
                    SET display_name = ?, status = ?, modified_at = ?, updated_at = ?
                    WHERE canonical_path_identity = ?
                    """,
                    (
                        display_name,
                        project_status.value,
                        modified_at_value,
                        now,
                        path_identity,
                    ),
                )
                row = connection.execute(
                    """
                    SELECT id, canonical_path, display_name, status, modified_at,
                           latest_snapshot_id, created_at, updated_at
                    FROM studio_projects
                    WHERE canonical_path_identity = ?
                    """,
                    (path_identity,),
                ).fetchone()
                if row is not None and open_identity is not None:
                    connection.execute(
                        """
                        INSERT INTO studio_project_open_identities (
                            project_id, canonical_path_identity,
                            file_dev, file_ino, parent_path_identity,
                            parent_dev, parent_ino
                        ) VALUES (?, ?, ?, ?, ?, ?, ?)
                        ON CONFLICT(project_id) DO UPDATE SET
                            canonical_path_identity = excluded.canonical_path_identity,
                            file_dev = excluded.file_dev,
                            file_ino = excluded.file_ino,
                            parent_path_identity = excluded.parent_path_identity,
                            parent_dev = excluded.parent_dev,
                            parent_ino = excluded.parent_ino
                        """,
                        (
                            row["id"],
                            open_identity[0],
                            str(open_identity[1]),
                            str(open_identity[2]),
                            open_identity[3],
                            str(open_identity[4]),
                            str(open_identity[5]),
                        ),
                    )
        finally:
            connection.close()

        assert row is not None
        return self._project_from_row(row)

    def get_project_open_identity(self, project_id: str) -> ProjectOpenIdentity:
        connection = self._connect()
        try:
            row = connection.execute(
                """
                SELECT project_id, canonical_path_identity,
                       file_dev, file_ino, parent_path_identity,
                       parent_dev, parent_ino
                FROM studio_project_open_identities
                WHERE project_id = ?
                """,
                (project_id,),
            ).fetchone()
        finally:
            connection.close()
        if row is None:
            raise KeyError(project_id)
        return ProjectOpenIdentity(
            project_id=row["project_id"],
            canonical_path_identity=row["canonical_path_identity"],
            file_dev=int(row["file_dev"]),
            file_ino=int(row["file_ino"]),
            parent_path_identity=row["parent_path_identity"],
            parent_dev=int(row["parent_dev"]),
            parent_ino=int(row["parent_ino"]),
        )

    def list_projects(self) -> list[StudioProject]:
        connection = self._connect()
        try:
            rows = connection.execute(
                """
                SELECT id, canonical_path, display_name, status, modified_at,
                       latest_snapshot_id, created_at, updated_at
                FROM studio_projects
                ORDER BY updated_at DESC, rowid DESC
                """
            ).fetchall()
        finally:
            connection.close()
        return [self._project_from_row(row) for row in rows]

    def list_latest_snapshots(self) -> dict[str, StudioSnapshotRecord]:
        connection = self._connect()
        try:
            rows = connection.execute(
                """
                SELECT snapshots.id, snapshots.project_id,
                       snapshots.source_path, snapshots.source_hash,
                       snapshots.analyzed_at, snapshots.payload_json
                FROM studio_projects AS projects
                JOIN studio_snapshots AS snapshots
                  ON snapshots.id = projects.latest_snapshot_id
                """
            ).fetchall()
        finally:
            connection.close()
        return {
            row["project_id"]: self._snapshot_from_row(row)
            for row in rows
        }

    def list_projects_with_latest_snapshots(
        self,
    ) -> list[tuple[StudioProject, StudioSnapshotRecord | None]]:
        connection = self._connect()
        try:
            rows = connection.execute(
                """
                SELECT projects.id, projects.canonical_path,
                       projects.display_name, projects.status,
                       projects.modified_at, projects.latest_snapshot_id,
                       projects.created_at, projects.updated_at,
                       snapshots.id AS snapshot_id,
                       snapshots.project_id AS snapshot_project_id,
                       snapshots.source_path AS snapshot_source_path,
                       snapshots.source_hash AS snapshot_source_hash,
                       snapshots.analyzed_at AS snapshot_analyzed_at,
                       snapshots.payload_json AS snapshot_payload_json
                FROM studio_projects AS projects
                LEFT JOIN studio_snapshots AS snapshots
                  ON snapshots.id = projects.latest_snapshot_id
                ORDER BY projects.updated_at DESC, projects.rowid DESC
                """
            ).fetchall()
        finally:
            connection.close()

        results: list[tuple[StudioProject, StudioSnapshotRecord | None]] = []
        for row in rows:
            record = None
            if row["snapshot_id"] is not None:
                record = StudioSnapshotRecord(
                    id=row["snapshot_id"],
                    project_id=row["snapshot_project_id"],
                    source_path=row["snapshot_source_path"],
                    source_hash=row["snapshot_source_hash"],
                    analyzed_at=row["snapshot_analyzed_at"],
                    payload_json=row["snapshot_payload_json"],
                )
            results.append((self._project_from_row(row), record))
        return results

    def get_project(self, project_id: str) -> StudioProject:
        connection = self._connect()
        try:
            row = connection.execute(
                """
                SELECT id, canonical_path, display_name, status, modified_at,
                       latest_snapshot_id, created_at, updated_at
                FROM studio_projects
                WHERE id = ?
                """,
                (project_id,),
            ).fetchone()
        finally:
            connection.close()
        if row is None:
            raise KeyError(project_id)
        return self._project_from_row(row)

    def get_project_by_path(self, path: Path) -> StudioProject:
        connection = self._connect()
        try:
            row = connection.execute(
                """
                SELECT id, canonical_path, display_name, status, modified_at,
                       latest_snapshot_id, created_at, updated_at
                FROM studio_projects
                WHERE canonical_path_identity = ?
                """,
                (_path_identity(path),),
            ).fetchone()
        finally:
            connection.close()
        if row is None:
            raise KeyError(str(path))
        return self._project_from_row(row)

    def save_backup_association(
        self,
        project_id: str,
        candidate_project_id: str,
        snapshot_id: str,
        *,
        score: float,
        confirmed: bool = False,
    ) -> BackupAssociation:
        if project_id == candidate_project_id:
            raise ValueError("backup association cannot reference self")
        if isinstance(score, bool) or not isinstance(score, (int, float)) or not 0 <= score <= 1:
            raise ValueError("association score must be between 0 and 1")
        now = _utc_now()
        connection = self._connect()
        try:
            with connection:
                projects = {
                    row["id"]
                    for row in connection.execute(
                        "SELECT id FROM studio_projects WHERE id IN (?, ?)",
                        (project_id, candidate_project_id),
                    )
                }
                if project_id not in projects:
                    raise KeyError(project_id)
                if candidate_project_id not in projects:
                    raise KeyError(candidate_project_id)
                snapshot = connection.execute(
                    "SELECT project_id FROM studio_snapshots WHERE id = ?",
                    (snapshot_id,),
                ).fetchone()
                if snapshot is None:
                    raise KeyError(snapshot_id)
                if snapshot["project_id"] != candidate_project_id:
                    raise ValueError("snapshot must belong to candidate project")
                existing_owner = connection.execute(
                    "SELECT project_id FROM studio_backup_associations WHERE snapshot_id = ?",
                    (snapshot_id,),
                ).fetchone()
                if existing_owner is not None and existing_owner["project_id"] != project_id:
                    raise ValueError("backup snapshot is already associated with another project")
                association_id = str(uuid.uuid4())
                connection.execute(
                    """
                    INSERT INTO studio_backup_associations (
                        id, project_id, candidate_project_id, snapshot_id,
                        score, confirmed, created_at, updated_at
                    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
                    ON CONFLICT(project_id, snapshot_id) DO UPDATE SET
                        candidate_project_id = excluded.candidate_project_id,
                        score = MAX(studio_backup_associations.score, excluded.score),
                        confirmed = MAX(studio_backup_associations.confirmed, excluded.confirmed),
                        updated_at = excluded.updated_at
                    """,
                    (
                        association_id,
                        project_id,
                        candidate_project_id,
                        snapshot_id,
                        float(score),
                        int(confirmed),
                        now,
                        now,
                    ),
                )
                row = connection.execute(
                    """
                    SELECT id, project_id, candidate_project_id, snapshot_id,
                           score, confirmed, created_at, updated_at
                    FROM studio_backup_associations
                    WHERE project_id = ? AND snapshot_id = ?
                    """,
                    (project_id, snapshot_id),
                ).fetchone()
        finally:
            connection.close()
        assert row is not None
        return self._association_from_row(row)

    def confirm_backup_association(
        self,
        project_id: str,
        association_id: str,
    ) -> BackupAssociation:
        connection = self._connect()
        try:
            with connection:
                project = connection.execute(
                    "SELECT id FROM studio_projects WHERE id = ?", (project_id,)
                ).fetchone()
                if project is None:
                    raise KeyError(project_id)
                row = connection.execute(
                    """
                    SELECT id, project_id, candidate_project_id, snapshot_id,
                           score, confirmed, created_at, updated_at
                    FROM studio_backup_associations
                    WHERE id = ?
                    """,
                    (association_id,),
                ).fetchone()
                if row is None:
                    raise KeyError(association_id)
                if row["project_id"] != project_id:
                    raise ValueError("candidate does not belong to project")
                if not row["confirmed"]:
                    connection.execute(
                        "UPDATE studio_backup_associations SET confirmed = 1, updated_at = ? WHERE id = ?",
                        (_utc_now(), association_id),
                    )
                    row = connection.execute(
                        """
                        SELECT id, project_id, candidate_project_id, snapshot_id,
                               score, confirmed, created_at, updated_at
                        FROM studio_backup_associations WHERE id = ?
                        """,
                        (association_id,),
                    ).fetchone()
        finally:
            connection.close()
        assert row is not None
        return self._association_from_row(row)

    def list_backup_associations(
        self,
        project_id: str,
        *,
        limit: int = 200,
    ) -> list[BackupAssociation]:
        _validate_version_limit(limit)
        connection = self._connect()
        try:
            if connection.execute(
                "SELECT id FROM studio_projects WHERE id = ?", (project_id,)
            ).fetchone() is None:
                raise KeyError(project_id)
            rows = connection.execute(
                """
                SELECT id, project_id, candidate_project_id, snapshot_id,
                       score, confirmed, created_at, updated_at
                FROM studio_backup_associations
                WHERE project_id = ?
                ORDER BY confirmed DESC, updated_at DESC, id
                LIMIT ?
                """,
                (project_id, limit),
            ).fetchall()
        finally:
            connection.close()
        return [self._association_from_row(row) for row in rows]

    def get_backup_association(
        self,
        project_id: str,
        association_id: str,
    ) -> BackupAssociation:
        connection = self._connect()
        try:
            if connection.execute(
                "SELECT id FROM studio_projects WHERE id = ?", (project_id,)
            ).fetchone() is None:
                raise KeyError(project_id)
            row = connection.execute(
                """
                SELECT id, project_id, candidate_project_id, snapshot_id,
                       score, confirmed, created_at, updated_at
                FROM studio_backup_associations
                WHERE id = ? AND project_id = ?
                """,
                (association_id, project_id),
            ).fetchone()
        finally:
            connection.close()
        if row is None:
            raise KeyError(association_id)
        return self._association_from_row(row)

    def list_project_versions(
        self,
        project_id: str,
        *,
        limit: int = 100,
    ) -> list[StudioVersionRecord]:
        return self.list_project_versions_page(project_id, limit=limit).items

    def list_project_versions_page(
        self,
        project_id: str,
        *,
        limit: int = 50,
        cursor: str | None = None,
    ) -> StudioVersionPage:
        _validate_page_limit(limit)
        decoded_cursor = _decode_version_cursor(cursor)
        connection = self._connect()
        try:
            connection.execute("BEGIN")
            if decoded_cursor is None:
                view = self._capture_version_view(connection, project_id)
                after = None
            else:
                if decoded_cursor.view.project_id != project_id:
                    raise ValueError("version cursor belongs to another project")
                if connection.execute(
                    "SELECT id FROM studio_projects WHERE id = ?",
                    (project_id,),
                ).fetchone() is None:
                    raise KeyError(project_id)
                view = decoded_cursor.view
                after = decoded_cursor.after
            return self._select_project_versions_page(
                connection,
                view,
                limit,
                after,
            )
        finally:
            connection.close()

    @staticmethod
    def _capture_version_view(
        connection: sqlite3.Connection,
        project_id: str,
    ) -> _VersionView:
        project = connection.execute(
            "SELECT latest_snapshot_id FROM studio_projects WHERE id = ?",
            (project_id,),
        ).fetchone()
        if project is None:
            raise KeyError(project_id)
        snapshot_rowid = connection.execute(
            "SELECT COALESCE(MAX(rowid), 0) FROM studio_snapshots"
        ).fetchone()[0]
        association_rowid = connection.execute(
            "SELECT COALESCE(MAX(rowid), 0) FROM studio_backup_associations"
        ).fetchone()[0]
        return _VersionView(
            project_id=project_id,
            latest_snapshot_id=project["latest_snapshot_id"],
            snapshot_rowid=int(snapshot_rowid),
            association_rowid=int(association_rowid),
        )

    def _select_project_versions_page(
        self,
        connection: sqlite3.Connection,
        view: _VersionView,
        limit: int,
        after: tuple[int, str, str] | None,
    ) -> StudioVersionPage:
        _validate_page_limit(limit)
        if after is None:
            cursor_priority, cursor_time, cursor_id = -1, "", ""
            has_cursor = 0
        else:
            cursor_priority, cursor_time, cursor_id = after
            has_cursor = 1
        rows = connection.execute(
            """
            WITH versions AS (
                SELECT snapshots.id, snapshots.project_id,
                       snapshots.source_path, snapshots.source_hash,
                       snapshots.analyzed_at, snapshots.summary_json,
                       NULL AS association_id, NULL AS score, 1 AS confirmed,
                       CASE WHEN snapshots.id = ? THEN 'current' ELSE 'history' END AS kind,
                       CASE WHEN snapshots.id = ? THEN 0 ELSE 2 END AS sort_priority
                FROM studio_snapshots AS snapshots
                WHERE snapshots.project_id = ? AND snapshots.rowid <= ?
                UNION ALL
                SELECT snapshots.id, snapshots.project_id,
                       snapshots.source_path, snapshots.source_hash,
                       snapshots.analyzed_at, snapshots.summary_json,
                       associations.id AS association_id,
                       associations.score, associations.confirmed,
                       CASE WHEN associations.confirmed = 1 THEN 'backup' ELSE 'candidate' END AS kind,
                       1 AS sort_priority
                FROM studio_backup_associations AS associations
                JOIN studio_snapshots AS snapshots ON snapshots.id = associations.snapshot_id
                WHERE associations.project_id = ?
                  AND associations.rowid <= ?
                  AND snapshots.rowid <= ?
            )
            SELECT id, project_id, source_path, source_hash, analyzed_at,
                   summary_json, association_id, score, confirmed, kind,
                   sort_priority
            FROM versions
            WHERE ? = 0
               OR sort_priority > ?
               OR (
                    sort_priority = ? AND (
                        analyzed_at < ?
                        OR (analyzed_at = ? AND id > ?)
                    )
               )
            ORDER BY sort_priority, analyzed_at DESC, id
            LIMIT ?
            """,
            (
                view.latest_snapshot_id,
                view.latest_snapshot_id,
                view.project_id,
                view.snapshot_rowid,
                view.project_id,
                view.association_rowid,
                view.snapshot_rowid,
                has_cursor,
                cursor_priority,
                cursor_priority,
                cursor_time,
                cursor_time,
                cursor_id,
                limit + 1,
            ),
        ).fetchall()
        page_rows = rows[:limit]
        items = [self._version_from_row(row) for row in page_rows]
        next_cursor = None
        if len(rows) > limit and page_rows:
            last = page_rows[-1]
            next_cursor = _encode_version_cursor(
                _VersionCursor(
                    view=view,
                    after=(
                        int(last["sort_priority"]),
                        last["analyzed_at"],
                        last["id"],
                    ),
                )
            )
        return StudioVersionPage(items=items, next_cursor=next_cursor)

    def get_project_version_snapshot(
        self,
        project_id: str,
        snapshot_id: str,
    ) -> StudioSnapshotRecord:
        connection = self._connect()
        try:
            if connection.execute(
                "SELECT id FROM studio_projects WHERE id = ?", (project_id,)
            ).fetchone() is None:
                raise KeyError(project_id)
            row = connection.execute(
                """
                SELECT snapshots.id, snapshots.project_id,
                       snapshots.source_path, snapshots.source_hash,
                       snapshots.analyzed_at, snapshots.payload_json
                FROM studio_snapshots AS snapshots
                WHERE snapshots.id = ? AND (
                    snapshots.project_id = ? OR EXISTS (
                        SELECT 1 FROM studio_backup_associations AS associations
                        WHERE associations.project_id = ?
                          AND associations.snapshot_id = snapshots.id
                          AND associations.confirmed = 1
                    )
                )
                """,
                (snapshot_id, project_id, project_id),
            ).fetchone()
        finally:
            connection.close()
        if row is None:
            raise ValueError("snapshot does not belong to project")
        return self._snapshot_from_row(row)

    def save_snapshot(
        self,
        project_id: str,
        snapshot: FlpAnalysisSnapshot,
        *,
        analyzed_at: str | None = None,
    ) -> StudioSnapshotRecord:
        snapshot_id = str(uuid.uuid4())
        source_path = _canonical_path(Path(snapshot.source_path))
        analyzed_at_value = (
            _normalize_utc_iso(analyzed_at) if analyzed_at is not None else _utc_now()
        )
        normalized_snapshot = replace(snapshot, source_path=source_path)
        updated_at = _utc_now()
        connection = self._connect()
        try:
            with connection:
                project_row = connection.execute(
                    "SELECT id, canonical_path FROM studio_projects WHERE id = ?",
                    (project_id,),
                ).fetchone()
                if project_row is None:
                    raise KeyError(project_id)
                if _path_identity(Path(project_row["canonical_path"])) != (
                    _path_identity(Path(source_path))
                ):
                    raise ValueError(
                        "snapshot source_path must match the project canonical_path"
                    )

                normalized_snapshot = replace(
                    normalized_snapshot,
                    dependencies=_capture_dependency_open_identities(
                        normalized_snapshot.dependencies,
                        project_folder=Path(source_path).parent,
                    ),
                )
                payload_json = normalized_snapshot.to_json()
                summary_json = _snapshot_summary_json(normalized_snapshot)

                cursor = connection.execute(
                    """
                    INSERT INTO studio_snapshots (
                        id, project_id, source_path, source_hash, analyzed_at,
                        payload_json, summary_json
                    )
                    VALUES (?, ?, ?, ?, ?, ?, ?)
                    ON CONFLICT(project_id, source_hash) DO NOTHING
                    """,
                    (
                        snapshot_id,
                        project_id,
                        source_path,
                        normalized_snapshot.source_hash,
                        analyzed_at_value,
                        payload_json,
                        summary_json,
                    ),
                )
                existing = connection.execute(
                    """
                    SELECT id, project_id, source_path, source_hash, analyzed_at,
                           payload_json
                    FROM studio_snapshots
                    WHERE project_id = ? AND source_hash = ?
                    """,
                    (project_id, normalized_snapshot.source_hash),
                ).fetchone()

                assert existing is not None
                connection.execute(
                    """
                    UPDATE studio_snapshots
                    SET summary_json = COALESCE(summary_json, ?)
                    WHERE id = ?
                    """,
                    (summary_json, existing["id"]),
                )
                if cursor.rowcount > 0:
                    connection.execute(
                        """
                        UPDATE studio_projects
                        SET latest_snapshot_id = ?, status = ?, updated_at = ?
                        WHERE id = ?
                        """,
                        (
                            existing["id"],
                            normalized_snapshot.status.value,
                            updated_at,
                            project_id,
                        ),
                    )
        finally:
            connection.close()

        return self._snapshot_from_row(existing)

    def get_latest_snapshot(self, project_id: str) -> StudioSnapshotRecord:
        connection = self._connect()
        try:
            project = connection.execute(
                """
                SELECT latest_snapshot_id
                FROM studio_projects
                WHERE id = ?
                """,
                (project_id,),
            ).fetchone()
            if project is None or project["latest_snapshot_id"] is None:
                raise KeyError(project_id)
            row = connection.execute(
                """
                SELECT id, project_id, source_path, source_hash, analyzed_at,
                       payload_json
                FROM studio_snapshots
                WHERE id = ?
                """,
                (project["latest_snapshot_id"],),
            ).fetchone()
        finally:
            connection.close()
        if row is None:
            raise KeyError(project_id)
        return self._snapshot_from_row(row)

    def activate_snapshot(
        self,
        project_id: str,
        snapshot_id: str,
        *,
        modified_at: str | None = None,
    ) -> StudioProject:
        modified_at_value = (
            _normalize_utc_iso(modified_at) if modified_at is not None else None
        )
        connection = self._connect()
        try:
            with connection:
                project = connection.execute(
                    "SELECT id FROM studio_projects WHERE id = ?",
                    (project_id,),
                ).fetchone()
                if project is None:
                    raise KeyError(project_id)
                snapshot = connection.execute(
                    """
                    SELECT project_id, payload_json
                    FROM studio_snapshots
                    WHERE id = ?
                    """,
                    (snapshot_id,),
                ).fetchone()
                if snapshot is None:
                    raise KeyError(snapshot_id)
                if snapshot["project_id"] != project_id:
                    raise ValueError("snapshot must belong to the project")

                snapshot_status = FlpAnalysisSnapshot.from_json(
                    snapshot["payload_json"]
                ).status
                if modified_at_value is None:
                    connection.execute(
                        """
                        UPDATE studio_projects
                        SET latest_snapshot_id = ?, status = ?, updated_at = ?
                        WHERE id = ?
                        """,
                        (
                            snapshot_id,
                            snapshot_status.value,
                            _utc_now(),
                            project_id,
                        ),
                    )
                else:
                    connection.execute(
                        """
                        UPDATE studio_projects
                        SET latest_snapshot_id = ?, status = ?, modified_at = ?,
                            updated_at = ?
                        WHERE id = ?
                        """,
                        (
                            snapshot_id,
                            snapshot_status.value,
                            modified_at_value,
                            _utc_now(),
                            project_id,
                        ),
                    )
                row = connection.execute(
                    """
                    SELECT id, canonical_path, display_name, status, modified_at,
                           latest_snapshot_id, created_at, updated_at
                    FROM studio_projects
                    WHERE id = ?
                    """,
                    (project_id,),
                ).fetchone()
        finally:
            connection.close()

        assert row is not None
        return self._project_from_row(row)

    def find_snapshot_by_hash(
        self,
        project_id: str,
        source_hash: str,
    ) -> StudioSnapshotRecord:
        connection = self._connect()
        try:
            project = connection.execute(
                "SELECT id FROM studio_projects WHERE id = ?",
                (project_id,),
            ).fetchone()
            if project is None:
                raise KeyError(project_id)
            row = connection.execute(
                """
                SELECT id, project_id, source_path, source_hash, analyzed_at,
                       payload_json
                FROM studio_snapshots
                WHERE project_id = ? AND source_hash = ?
                """,
                (project_id, source_hash),
            ).fetchone()
        finally:
            connection.close()
        if row is None:
            raise KeyError((project_id, source_hash))
        return self._snapshot_from_row(row)

    def create_scan_job(
        self,
        *,
        status: ScanJobStatus | str = "queued",
    ) -> StudioScanJob:
        job_status = _scan_job_status(status)
        job_id = str(uuid.uuid4())
        now = _utc_now()
        connection = self._connect()
        try:
            with connection:
                connection.execute(
                    """
                    INSERT INTO studio_scan_jobs (
                        id, status, discovered_count, parsed_count, cached_count,
                        failed_count, error, created_at, updated_at
                    )
                    VALUES (?, ?, 0, 0, 0, 0, NULL, ?, ?)
                    """,
                    (job_id, job_status, now, now),
                )
                row = self._select_scan_job(connection, job_id)
        finally:
            connection.close()

        assert row is not None
        return self._scan_job_from_row(row)

    def get_scan_job(self, job_id: str) -> StudioScanJob:
        connection = self._connect()
        try:
            row = self._select_scan_job(connection, job_id)
        finally:
            connection.close()
        if row is None:
            raise KeyError(job_id)
        return self._scan_job_from_row(row)

    def update_scan_job(self, job_id: str, **updates: object) -> StudioScanJob:
        unexpected = set(updates) - _SCAN_JOB_UPDATE_FIELDS
        if unexpected:
            names = ", ".join(sorted(unexpected))
            raise TypeError(f"unexpected scan job update field(s): {names}")
        if "status" in updates:
            updates["status"] = _scan_job_status(updates["status"])
        for field_name in _SCAN_JOB_COUNT_FIELDS & updates.keys():
            value = updates[field_name]
            if isinstance(value, bool) or not isinstance(value, int) or value < 0:
                raise ValueError(f"{field_name} must be a non-negative integer")
        if "error" in updates and not (
            updates["error"] is None or isinstance(updates["error"], str)
        ):
            raise TypeError("error must be a string or None")

        connection = self._connect()
        try:
            with connection:
                current = self._select_scan_job(connection, job_id)
                if current is None:
                    raise KeyError(job_id)
                if updates:
                    updates["updated_at"] = _utc_now()
                    assignments = ", ".join(f"{name} = ?" for name in updates)
                    values = [*updates.values(), job_id]
                    connection.execute(
                        f"UPDATE studio_scan_jobs SET {assignments} WHERE id = ?",
                        values,
                    )
                row = self._select_scan_job(connection, job_id)
        finally:
            connection.close()

        assert row is not None
        return self._scan_job_from_row(row)

    def _initialize_schema(self) -> None:
        connection = self._connect()
        try:
            with connection:
                had_open_identity_table = connection.execute(
                    """
                    SELECT 1
                    FROM sqlite_master
                    WHERE type = 'table'
                      AND name = 'studio_project_open_identities'
                    """
                ).fetchone() is not None
                connection.executescript(
                    """
                    CREATE TABLE IF NOT EXISTS studio_roots (
                        id TEXT PRIMARY KEY,
                        path TEXT UNIQUE NOT NULL,
                        path_identity TEXT UNIQUE NOT NULL,
                        created_at TEXT NOT NULL
                    );

                    CREATE TABLE IF NOT EXISTS studio_projects (
                        id TEXT PRIMARY KEY,
                        canonical_path TEXT UNIQUE NOT NULL,
                        canonical_path_identity TEXT UNIQUE NOT NULL,
                        display_name TEXT NOT NULL,
                        status TEXT NOT NULL CHECK (
                            status IN (
                                'discovered', 'queued', 'parsing', 'ready',
                                'partial', 'failed', 'stale'
                            )
                        ),
                        modified_at TEXT NULL,
                        latest_snapshot_id TEXT NULL,
                        created_at TEXT NOT NULL,
                        updated_at TEXT NOT NULL
                    );

                    CREATE TABLE IF NOT EXISTS studio_project_open_identities (
                        project_id TEXT PRIMARY KEY
                            REFERENCES studio_projects(id) ON DELETE CASCADE,
                        canonical_path_identity TEXT NOT NULL,
                        file_dev TEXT NOT NULL,
                        file_ino TEXT NOT NULL,
                        parent_path_identity TEXT NOT NULL,
                        parent_dev TEXT NOT NULL,
                        parent_ino TEXT NOT NULL
                    );

                    CREATE TABLE IF NOT EXISTS studio_snapshots (
                        id TEXT PRIMARY KEY,
                        project_id TEXT NOT NULL
                            REFERENCES studio_projects(id) ON DELETE CASCADE,
                        source_path TEXT NOT NULL,
                        source_hash TEXT NOT NULL,
                        analyzed_at TEXT NOT NULL,
                        payload_json TEXT NOT NULL,
                        summary_json TEXT NULL,
                        UNIQUE(project_id, source_hash)
                    );

                    CREATE TABLE IF NOT EXISTS studio_scan_jobs (
                        id TEXT PRIMARY KEY,
                        status TEXT NOT NULL CHECK (
                            status IN ('queued', 'running', 'completed', 'failed')
                        ),
                        discovered_count INTEGER NOT NULL DEFAULT 0 CHECK (
                            typeof(discovered_count) = 'integer'
                            AND discovered_count >= 0
                        ),
                        parsed_count INTEGER NOT NULL DEFAULT 0 CHECK (
                            typeof(parsed_count) = 'integer' AND parsed_count >= 0
                        ),
                        cached_count INTEGER NOT NULL DEFAULT 0 CHECK (
                            typeof(cached_count) = 'integer' AND cached_count >= 0
                        ),
                        failed_count INTEGER NOT NULL DEFAULT 0 CHECK (
                            typeof(failed_count) = 'integer' AND failed_count >= 0
                        ),
                        error TEXT,
                        created_at TEXT NOT NULL,
                        updated_at TEXT NOT NULL
                    );

                    CREATE TABLE IF NOT EXISTS studio_backup_associations (
                        id TEXT PRIMARY KEY,
                        project_id TEXT NOT NULL
                            REFERENCES studio_projects(id) ON DELETE CASCADE,
                        candidate_project_id TEXT NOT NULL
                            REFERENCES studio_projects(id) ON DELETE CASCADE,
                        snapshot_id TEXT NOT NULL
                            REFERENCES studio_snapshots(id) ON DELETE CASCADE,
                        score REAL NOT NULL CHECK (score >= 0 AND score <= 1),
                        confirmed INTEGER NOT NULL DEFAULT 0 CHECK (confirmed IN (0, 1)),
                        created_at TEXT NOT NULL,
                        updated_at TEXT NOT NULL,
                        CHECK (project_id != candidate_project_id),
                        UNIQUE(project_id, snapshot_id)
                    );

                    CREATE INDEX IF NOT EXISTS studio_backup_associations_project_idx
                    ON studio_backup_associations(project_id, confirmed, updated_at);

                    CREATE UNIQUE INDEX IF NOT EXISTS studio_backup_associations_snapshot_idx
                    ON studio_backup_associations(snapshot_id);

                    """
                )
                columns = {
                    row["name"]
                    for row in connection.execute(
                        "PRAGMA table_info(studio_snapshots)"
                    ).fetchall()
                }
                if "summary_json" not in columns:
                    connection.execute(
                        "ALTER TABLE studio_snapshots ADD COLUMN summary_json TEXT NULL"
                    )
                    self._backfill_snapshot_summaries(connection)
                if not had_open_identity_table:
                    self._backfill_project_open_identities(connection)
        finally:
            connection.close()

    @staticmethod
    def _backfill_project_open_identities(
        connection: sqlite3.Connection,
    ) -> None:
        rows = connection.execute(
            """
            SELECT projects.id, projects.canonical_path
            FROM studio_projects AS projects
            LEFT JOIN studio_project_open_identities AS identities
              ON identities.project_id = projects.id
            WHERE identities.project_id IS NULL
            """
        ).fetchall()
        for row in rows:
            identity = _capture_open_identity(Path(row["canonical_path"]))
            if identity is None:
                continue
            connection.execute(
                """
                INSERT INTO studio_project_open_identities (
                    project_id, canonical_path_identity,
                    file_dev, file_ino, parent_path_identity,
                    parent_dev, parent_ino
                ) VALUES (?, ?, ?, ?, ?, ?, ?)
                """,
                (
                    row["id"],
                    identity[0],
                    str(identity[1]),
                    str(identity[2]),
                    identity[3],
                    str(identity[4]),
                    str(identity[5]),
                ),
            )

    @staticmethod
    def _backfill_snapshot_summaries(
        connection: sqlite3.Connection,
        *,
        limit: int = 100,
    ) -> None:
        rows = connection.execute(
            """
            SELECT id, payload_json
            FROM studio_snapshots
            WHERE summary_json IS NULL
            ORDER BY analyzed_at DESC, id
            LIMIT ?
            """,
            (limit,),
        ).fetchall()
        for row in rows:
            try:
                summary_json = _snapshot_summary_json(
                    FlpAnalysisSnapshot.from_json(row["payload_json"])
                )
            except (TypeError, ValueError):
                summary_json = _empty_snapshot_summary_json()
            connection.execute(
                "UPDATE studio_snapshots SET summary_json = ? WHERE id = ?",
                (summary_json, row["id"]),
            )

    def _connect(self) -> sqlite3.Connection:
        connection = sqlite3.connect(self._db_path)
        connection.row_factory = sqlite3.Row
        connection.execute("PRAGMA foreign_keys = ON")
        return connection

    @staticmethod
    def _select_scan_job(
        connection: sqlite3.Connection,
        job_id: str,
    ) -> sqlite3.Row | None:
        return connection.execute(
            """
            SELECT id, status, discovered_count, parsed_count, cached_count,
                   failed_count, error, created_at, updated_at
            FROM studio_scan_jobs
            WHERE id = ?
            """,
            (job_id,),
        ).fetchone()

    @staticmethod
    def _root_from_row(row: sqlite3.Row) -> StudioRoot:
        return StudioRoot(
            id=row["id"],
            path=row["path"],
            created_at=row["created_at"],
        )

    @staticmethod
    def _project_from_row(row: sqlite3.Row) -> StudioProject:
        return StudioProject(
            id=row["id"],
            canonical_path=row["canonical_path"],
            display_name=row["display_name"],
            status=AnalysisStatus(row["status"]),
            modified_at=row["modified_at"],
            latest_snapshot_id=row["latest_snapshot_id"],
            created_at=row["created_at"],
            updated_at=row["updated_at"],
        )

    @staticmethod
    def _snapshot_from_row(row: sqlite3.Row) -> StudioSnapshotRecord:
        return StudioSnapshotRecord(
            id=row["id"],
            project_id=row["project_id"],
            source_path=row["source_path"],
            source_hash=row["source_hash"],
            analyzed_at=row["analyzed_at"],
            payload_json=row["payload_json"],
        )

    @staticmethod
    def _version_from_row(row: sqlite3.Row) -> StudioVersionRecord:
        title, tempo, pattern_count = _parse_snapshot_summary(row["summary_json"])
        return StudioVersionRecord(
            snapshot_id=row["id"],
            project_id=row["project_id"],
            source_path=row["source_path"],
            source_hash=row["source_hash"],
            analyzed_at=row["analyzed_at"],
            title=title,
            tempo=tempo,
            pattern_count=pattern_count,
            kind=row["kind"],
            association_id=row["association_id"],
            score=(float(row["score"]) if row["score"] is not None else None),
            confirmed=bool(row["confirmed"]),
        )

    @staticmethod
    def _scan_job_from_row(row: sqlite3.Row) -> StudioScanJob:
        return StudioScanJob(
            id=row["id"],
            status=_scan_job_status(row["status"]),
            discovered_count=row["discovered_count"],
            parsed_count=row["parsed_count"],
            cached_count=row["cached_count"],
            failed_count=row["failed_count"],
            error=row["error"],
            created_at=row["created_at"],
            updated_at=row["updated_at"],
        )

    @staticmethod
    def _association_from_row(row: sqlite3.Row) -> BackupAssociation:
        return BackupAssociation(
            id=row["id"],
            project_id=row["project_id"],
            candidate_project_id=row["candidate_project_id"],
            snapshot_id=row["snapshot_id"],
            score=float(row["score"]),
            confirmed=bool(row["confirmed"]),
            created_at=row["created_at"],
            updated_at=row["updated_at"],
        )


def _canonical_path(path: Path) -> str:
    return str(path.expanduser().resolve())


def _path_identity(path: Path) -> str:
    return os.path.normcase(_canonical_path(path))


def _capture_dependency_open_identities(
    dependencies: list[DependencyReference],
    *,
    project_folder: Path,
) -> list[DependencyReference]:
    captured: list[DependencyReference] = []
    remaining_budget = _DEPENDENCY_IDENTITY_CAPTURE_LIMIT
    for dependency in dependencies:
        identity: DependencyOpenIdentity | None = None
        if (
            dependency.exists
            and remaining_budget > 0
            and not _is_network_dependency_path(dependency.path)
        ):
            remaining_budget -= 1
            identity = _capture_dependency_open_identity(
                dependency.path,
                project_folder=project_folder,
            )
        captured.append(replace(dependency, open_identity=identity))
    return captured


def _capture_dependency_open_identity(
    recorded_path: str,
    *,
    project_folder: Path,
) -> DependencyOpenIdentity | None:
    raw_path = Path(recorded_path).expanduser()
    candidate = raw_path if raw_path.is_absolute() else project_folder / raw_path
    try:
        if _has_link_or_reparse_component(candidate):
            return None
        resolved = candidate.resolve(strict=True)
        first = resolved.lstat()
        if (
            not stat.S_ISREG(first.st_mode)
            or _is_reparse_point(first)
            or not all(_file_identity(first))
        ):
            return None
        current = resolved.lstat()
        if not _same_file_version(first, current):
            return None
    except OSError:
        return None
    return DependencyOpenIdentity(
        canonical_path_identity=os.path.normcase(str(resolved)),
        file_dev=current.st_dev,
        file_ino=current.st_ino,
        size=current.st_size,
        modified_ns=current.st_mtime_ns,
    )


def _is_network_dependency_path(recorded_path: str) -> bool:
    return recorded_path.replace("\\", "/").startswith("//")


def _capture_open_identity(
    path: Path,
) -> tuple[str, int, int, str, int, int] | None:
    if path.suffix.casefold() != ".flp":
        return None
    try:
        if _has_link_or_reparse_component(path):
            return None
        source_details = path.lstat()
        parent_details = path.parent.lstat()
        if (
            _is_reparse_point(source_details)
            or _is_reparse_point(parent_details)
            or not stat.S_ISREG(source_details.st_mode)
            or not stat.S_ISDIR(parent_details.st_mode)
            or not all(_file_identity(source_details))
            or not all(_file_identity(parent_details))
        ):
            return None

        resolved = path.resolve(strict=True)
        resolved_parent = path.parent.resolve(strict=True)
        if (
            os.path.normcase(str(resolved)) != os.path.normcase(str(path))
            or resolved.parent != resolved_parent
        ):
            return None

        current_details = resolved.lstat()
        current_parent_details = resolved_parent.lstat()
        if (
            _is_reparse_point(current_details)
            or _is_reparse_point(current_parent_details)
            or not stat.S_ISREG(current_details.st_mode)
            or not stat.S_ISDIR(current_parent_details.st_mode)
            or not _same_file_version(source_details, current_details)
            or not _same_file_version(parent_details, current_parent_details)
        ):
            return None
    except OSError:
        return None

    file_dev, file_ino = _file_identity(current_details)
    parent_dev, parent_ino = _file_identity(current_parent_details)
    return (
        os.path.normcase(str(resolved)),
        file_dev,
        file_ino,
        os.path.normcase(str(resolved_parent)),
        parent_dev,
        parent_ino,
    )


def _same_file_version(first: os.stat_result, second: os.stat_result) -> bool:
    return (
        _file_identity(first) == _file_identity(second)
        and first.st_size == second.st_size
        and first.st_mtime_ns == second.st_mtime_ns
    )


def _file_identity(details: os.stat_result) -> tuple[int, int]:
    return details.st_dev, details.st_ino


def _is_reparse_point(details: os.stat_result) -> bool:
    attributes = getattr(details, "st_file_attributes", 0)
    reparse_attribute = getattr(stat, "FILE_ATTRIBUTE_REPARSE_POINT", 0x400)
    return bool(attributes & reparse_attribute)


def _has_link_or_reparse_component(path: Path) -> bool:
    for component in (path, *path.parents):
        details = component.lstat()
        if stat.S_ISLNK(details.st_mode) or _is_reparse_point(details):
            return True
    return False


def _utc_now() -> str:
    return datetime.now(timezone.utc).isoformat()


def _normalize_utc_iso(value: str) -> str:
    try:
        parsed = datetime.fromisoformat(value)
    except (TypeError, ValueError) as exc:
        raise ValueError("time values must be timezone-aware UTC ISO strings") from exc
    if parsed.tzinfo is None or parsed.utcoffset() is None:
        raise ValueError("time values must be timezone-aware UTC ISO strings")
    return parsed.astimezone(timezone.utc).isoformat()


def _analysis_status(status: AnalysisStatus | str) -> AnalysisStatus:
    try:
        return AnalysisStatus(status)
    except ValueError as exc:
        raise ValueError(f"Unknown analysis status: {status}") from exc


def _scan_job_status(status: object) -> ScanJobStatus:
    if not isinstance(status, str) or status not in _SCAN_JOB_STATUSES:
        raise ValueError(f"Unknown scan job status: {status}")
    return status  # type: ignore[return-value]


def _validate_version_limit(limit: int) -> None:
    if isinstance(limit, bool) or not isinstance(limit, int) or not 1 <= limit <= 200:
        raise ValueError("version limit must be between 1 and 200")


def _validate_page_limit(limit: int) -> None:
    if isinstance(limit, bool) or not isinstance(limit, int) or not 1 <= limit <= 100:
        raise ValueError("version page limit must be between 1 and 100")


def _snapshot_summary_json(snapshot: FlpAnalysisSnapshot) -> str:
    return json.dumps(
        {
            "title": snapshot.project.title,
            "tempo": snapshot.project.tempo,
            "pattern_count": len(snapshot.patterns),
        },
        ensure_ascii=False,
        separators=(",", ":"),
        sort_keys=True,
    )


def _empty_snapshot_summary_json() -> str:
    return json.dumps(
        {"state": "corrupt"},
        separators=(",", ":"),
        sort_keys=True,
    )


def _parse_snapshot_summary(
    value: object,
) -> tuple[str | None, float | None, int | None]:
    try:
        payload = json.loads(value) if isinstance(value, str) else {}
    except (TypeError, ValueError):
        payload = {}
    if not isinstance(payload, dict):
        payload = {}
    title_value = payload.get("title")
    title = title_value if isinstance(title_value, str) else None
    tempo_value = payload.get("tempo")
    tempo = (
        float(tempo_value)
        if isinstance(tempo_value, (int, float)) and not isinstance(tempo_value, bool)
        else None
    )
    pattern_value = payload.get("pattern_count")
    pattern_count: int | None = (
        pattern_value
        if isinstance(pattern_value, int)
        and not isinstance(pattern_value, bool)
        and pattern_value >= 0
        else None
    )
    return title, tempo, pattern_count


def _encode_version_cursor(cursor: _VersionCursor) -> str:
    raw = json.dumps(
        {
            "v": 1,
            "project": cursor.view.project_id,
            "latest": cursor.view.latest_snapshot_id,
            "snapshot_rowid": cursor.view.snapshot_rowid,
            "association_rowid": cursor.view.association_rowid,
            "after": list(cursor.after),
        },
        separators=(",", ":"),
        sort_keys=True,
    ).encode("utf-8")
    return base64.urlsafe_b64encode(raw).decode("ascii").rstrip("=")


def _decode_version_cursor(value: str | None) -> _VersionCursor | None:
    if value is None:
        return None
    if not isinstance(value, str) or not value:
        raise ValueError("invalid version cursor")
    try:
        padded = value + "=" * (-len(value) % 4)
        payload = json.loads(base64.b64decode(padded, altchars=b"-_", validate=True))
    except (ValueError, TypeError, json.JSONDecodeError) as exc:
        raise ValueError("invalid version cursor") from exc
    if not isinstance(payload, dict) or payload.get("v") != 1:
        raise ValueError("invalid version cursor")
    project_id = payload.get("project")
    latest_snapshot_id = payload.get("latest")
    snapshot_rowid = payload.get("snapshot_rowid")
    association_rowid = payload.get("association_rowid")
    after = payload.get("after")
    if not isinstance(project_id, str) or not project_id:
        raise ValueError("invalid version cursor")
    if latest_snapshot_id is not None and (
        not isinstance(latest_snapshot_id, str) or not latest_snapshot_id
    ):
        raise ValueError("invalid version cursor")
    if (
        not _is_sqlite_nonnegative_int(snapshot_rowid)
        or not _is_sqlite_nonnegative_int(association_rowid)
        or not isinstance(after, list)
        or len(after) != 3
        or isinstance(after[0], bool)
        or not isinstance(after[0], int)
        or after[0] not in {0, 1, 2}
        or not isinstance(after[1], str)
        or not after[1]
        or not isinstance(after[2], str)
        or not after[2]
    ):
        raise ValueError("invalid version cursor")
    try:
        _normalize_utc_iso(after[1])
    except ValueError as exc:
        raise ValueError("invalid version cursor") from exc
    return _VersionCursor(
        view=_VersionView(
            project_id=project_id,
            latest_snapshot_id=latest_snapshot_id,
            snapshot_rowid=snapshot_rowid,
            association_rowid=association_rowid,
        ),
        after=(after[0], after[1], after[2]),
    )


def _is_sqlite_nonnegative_int(value: object) -> bool:
    return (
        isinstance(value, int)
        and not isinstance(value, bool)
        and 0 <= value <= _SQLITE_MAX_INT
    )

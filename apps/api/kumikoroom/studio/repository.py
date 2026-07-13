import sqlite3
import uuid
from dataclasses import dataclass, replace
from datetime import datetime, timezone
from pathlib import Path
from typing import Literal

from .models import AnalysisStatus, FlpAnalysisSnapshot


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


@dataclass(frozen=True)
class StudioRoot:
    id: str
    path: str
    created_at: str


@dataclass(frozen=True)
class StudioProject:
    id: str
    canonical_path: str
    display_name: str | None
    status: AnalysisStatus
    modified_at: str | None
    latest_snapshot_id: str | None
    created_at: str
    updated_at: str


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
        connection = self._connect()
        try:
            with connection:
                connection.execute(
                    """
                    INSERT OR IGNORE INTO studio_roots (id, path, created_at)
                    VALUES (?, ?, ?)
                    """,
                    (str(uuid.uuid4()), canonical_path, _utc_now()),
                )
                row = connection.execute(
                    """
                    SELECT id, path, created_at
                    FROM studio_roots
                    WHERE path = ?
                    """,
                    (canonical_path,),
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
        display_name: str | None,
        status: AnalysisStatus | str = AnalysisStatus.DISCOVERED,
        modified_at: str | None = None,
    ) -> StudioProject:
        path_value = _canonical_path(canonical_path)
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
                        id, canonical_path, display_name, status, modified_at,
                        latest_snapshot_id, created_at, updated_at
                    )
                    VALUES (?, ?, ?, ?, ?, NULL, ?, ?)
                    ON CONFLICT(canonical_path) DO UPDATE SET
                        display_name = excluded.display_name,
                        status = excluded.status,
                        modified_at = excluded.modified_at,
                        updated_at = excluded.updated_at
                    """,
                    (
                        str(uuid.uuid4()),
                        path_value,
                        display_name,
                        project_status.value,
                        modified_at_value,
                        now,
                        now,
                    ),
                )
                row = connection.execute(
                    """
                    SELECT id, canonical_path, display_name, status, modified_at,
                           latest_snapshot_id, created_at, updated_at
                    FROM studio_projects
                    WHERE canonical_path = ?
                    """,
                    (path_value,),
                ).fetchone()
        finally:
            connection.close()

        assert row is not None
        return self._project_from_row(row)

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
        payload_json = normalized_snapshot.to_json()
        updated_at = _utc_now()
        connection = self._connect()
        try:
            with connection:
                project_row = connection.execute(
                    "SELECT id FROM studio_projects WHERE id = ?",
                    (project_id,),
                ).fetchone()
                if project_row is None:
                    raise KeyError(project_id)

                connection.execute(
                    """
                    INSERT INTO studio_snapshots (
                        id, project_id, source_path, source_hash, analyzed_at,
                        payload_json
                    )
                    VALUES (?, ?, ?, ?, ?, ?)
                    ON CONFLICT(project_id, source_hash) DO NOTHING
                    """,
                    (
                        snapshot_id,
                        project_id,
                        source_path,
                        normalized_snapshot.source_hash,
                        analyzed_at_value,
                        payload_json,
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
                connection.executescript(
                    """
                    CREATE TABLE IF NOT EXISTS studio_roots (
                        id TEXT PRIMARY KEY,
                        path TEXT UNIQUE NOT NULL,
                        created_at TEXT NOT NULL
                    );

                    CREATE TABLE IF NOT EXISTS studio_projects (
                        id TEXT PRIMARY KEY,
                        canonical_path TEXT UNIQUE NOT NULL,
                        display_name TEXT,
                        status TEXT NOT NULL,
                        modified_at TEXT NULL,
                        latest_snapshot_id TEXT NULL,
                        created_at TEXT NOT NULL,
                        updated_at TEXT NOT NULL
                    );

                    CREATE TABLE IF NOT EXISTS studio_snapshots (
                        id TEXT PRIMARY KEY,
                        project_id TEXT NOT NULL
                            REFERENCES studio_projects(id) ON DELETE CASCADE,
                        source_path TEXT NOT NULL,
                        source_hash TEXT NOT NULL,
                        analyzed_at TEXT NOT NULL,
                        payload_json TEXT NOT NULL,
                        UNIQUE(project_id, source_hash)
                    );

                    CREATE TABLE IF NOT EXISTS studio_scan_jobs (
                        id TEXT PRIMARY KEY,
                        status TEXT NOT NULL,
                        discovered_count INTEGER NOT NULL,
                        parsed_count INTEGER NOT NULL,
                        cached_count INTEGER NOT NULL,
                        failed_count INTEGER NOT NULL,
                        error TEXT,
                        created_at TEXT NOT NULL,
                        updated_at TEXT NOT NULL
                    );
                    """
                )
        finally:
            connection.close()

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


def _canonical_path(path: Path) -> str:
    return str(path.expanduser().resolve())


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

import sqlite3
import uuid
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path
from typing import Literal


ChatRole = Literal["user", "kumiko"]
DEFAULT_SESSION_TITLE = "New conversation"
AUTO_TITLE_LIMIT = 48

_VALID_ROLES: tuple[ChatRole, ...] = ("user", "kumiko")


@dataclass(frozen=True)
class ChatSession:
    id: str
    title: str
    created_at: str
    updated_at: str
    latest_message_preview: str | None = None


@dataclass(frozen=True)
class StoredChatMessage:
    id: str
    session_id: str
    role: ChatRole
    content: str
    created_at: str
    provider: str | None = None
    provider_model: str | None = None
    provider_configured: bool | None = None
    provider_label: str | None = None


class SessionStore:
    def __init__(self, db_path: Path | str) -> None:
        self._db_path = Path(db_path)
        self._db_path.parent.mkdir(parents=True, exist_ok=True)
        self._initialize_schema()

    def create_session(self, title: str = DEFAULT_SESSION_TITLE) -> ChatSession:
        clean_title = _clean_required_text(title, field_name="title")
        session_id = str(uuid.uuid4())

        connection = self._connect()
        try:
            connection.execute("BEGIN IMMEDIATE")
            created_at = _utc_now()
            activity_seq = self._next_activity_seq(connection)
            connection.execute(
                """
                INSERT INTO chat_sessions (
                    id,
                    title,
                    created_at,
                    updated_at,
                    activity_seq
                )
                VALUES (?, ?, ?, ?, ?)
                """,
                (session_id, clean_title, created_at, created_at, activity_seq),
            )
            session = self._get_session(connection, session_id)
            connection.commit()
            return session
        except Exception:
            connection.rollback()
            raise
        finally:
            connection.close()

    def ensure_default_session(self) -> ChatSession:
        connection = self._connect()
        try:
            connection.execute("BEGIN IMMEDIATE")
            row = connection.execute(
                """
                SELECT id
                FROM chat_sessions
                ORDER BY updated_at DESC, activity_seq DESC, rowid DESC
                LIMIT 1
                """
            ).fetchone()
            if row is not None:
                session = self._get_session(connection, row["id"])
            else:
                session_id = str(uuid.uuid4())
                created_at = _utc_now()
                activity_seq = self._next_activity_seq(connection)
                connection.execute(
                    """
                    INSERT INTO chat_sessions (
                        id,
                        title,
                        created_at,
                        updated_at,
                        activity_seq
                    )
                    VALUES (?, ?, ?, ?, ?)
                    """,
                    (
                        session_id,
                        DEFAULT_SESSION_TITLE,
                        created_at,
                        created_at,
                        activity_seq,
                    ),
                )
                session = self._get_session(connection, session_id)
            connection.commit()
            return session
        except Exception:
            connection.rollback()
            raise
        finally:
            connection.close()

    def list_sessions(self, limit: int = 50) -> list[ChatSession]:
        connection = self._connect()
        try:
            rows = connection.execute(
                """
                SELECT
                    chat_sessions.id,
                    chat_sessions.title,
                    chat_sessions.created_at,
                    chat_sessions.updated_at,
                    (
                        SELECT chat_messages.content
                        FROM chat_messages
                        WHERE chat_messages.session_id = chat_sessions.id
                        ORDER BY chat_messages.created_at DESC, chat_messages.rowid DESC
                        LIMIT 1
                    ) AS latest_message_preview
                FROM chat_sessions
                ORDER BY
                    chat_sessions.updated_at DESC,
                    chat_sessions.activity_seq DESC,
                    chat_sessions.rowid DESC
                LIMIT ?
                """,
                (max(0, int(limit)),),
            ).fetchall()
        finally:
            connection.close()

        return [self._session_from_row(row) for row in rows]

    def get_session(self, session_id: str) -> ChatSession:
        connection = self._connect()
        try:
            return self._get_session(connection, session_id)
        finally:
            connection.close()

    def rename_session(self, session_id: str, title: str) -> ChatSession:
        clean_title = _clean_required_text(title, field_name="title")

        connection = self._connect()
        try:
            connection.execute("BEGIN IMMEDIATE")
            updated_at = _utc_now()
            activity_seq = self._next_activity_seq(connection)
            cursor = connection.execute(
                """
                UPDATE chat_sessions
                SET title = ?, updated_at = ?, activity_seq = ?
                WHERE id = ?
                """,
                (clean_title, updated_at, activity_seq, session_id),
            )
            if cursor.rowcount == 0:
                raise KeyError(session_id)

            session = self._get_session(connection, session_id)
            connection.commit()
            return session
        except Exception:
            connection.rollback()
            raise
        finally:
            connection.close()

    def delete_session(self, session_id: str) -> bool:
        connection = self._connect()
        try:
            cursor = connection.execute(
                "DELETE FROM chat_sessions WHERE id = ?",
                (session_id,),
            )
            connection.commit()
            return cursor.rowcount > 0
        finally:
            connection.close()

    def append_message(
        self,
        session_id: str,
        role: ChatRole,
        content: str,
        *,
        provider: str | None = None,
        provider_model: str | None = None,
        provider_configured: bool | None = None,
        provider_label: str | None = None,
    ) -> StoredChatMessage:
        if role not in _VALID_ROLES:
            raise ValueError(f"Unknown chat role: {role}")

        clean_content = _clean_required_text(content, field_name="content")
        message_id = str(uuid.uuid4())

        connection = self._connect()
        try:
            connection.execute("BEGIN IMMEDIATE")
            created_at = _utc_now()
            session = self._get_session(connection, session_id)
            activity_seq = self._next_activity_seq(connection)
            should_auto_title = (
                role == "user"
                and session.title == DEFAULT_SESSION_TITLE
                and not self._has_user_messages(connection, session_id)
            )
            connection.execute(
                """
                INSERT INTO chat_messages (
                    id,
                    session_id,
                    role,
                    content,
                    created_at,
                    provider,
                    provider_model,
                    provider_configured,
                    provider_label
                )
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
                """,
                (
                    message_id,
                    session_id,
                    role,
                    clean_content,
                    created_at,
                    provider,
                    provider_model,
                    _provider_configured_to_db(provider_configured),
                    provider_label,
                ),
            )

            title = session.title
            if should_auto_title:
                title = _auto_title(clean_content)

            connection.execute(
                """
                UPDATE chat_sessions
                SET title = ?, updated_at = ?, activity_seq = ?
                WHERE id = ?
                """,
                (title, created_at, activity_seq, session_id),
            )
            connection.commit()
        except Exception:
            connection.rollback()
            raise
        finally:
            connection.close()

        return StoredChatMessage(
            id=message_id,
            session_id=session_id,
            role=role,
            content=clean_content,
            created_at=created_at,
            provider=provider,
            provider_model=provider_model,
            provider_configured=provider_configured,
            provider_label=provider_label,
        )

    def list_messages(self, session_id: str) -> list[StoredChatMessage]:
        connection = self._connect()
        try:
            rows = connection.execute(
                """
                SELECT
                    id,
                    session_id,
                    role,
                    content,
                    created_at,
                    provider,
                    provider_model,
                    provider_configured,
                    provider_label
                FROM chat_messages
                WHERE session_id = ?
                ORDER BY created_at ASC, rowid ASC
                """,
                (session_id,),
            ).fetchall()
        finally:
            connection.close()

        return [self._message_from_row(row) for row in rows]

    def _initialize_schema(self) -> None:
        connection = self._connect()
        try:
            connection.execute(
                """
                CREATE TABLE IF NOT EXISTS chat_sessions (
                    id TEXT PRIMARY KEY,
                    title TEXT NOT NULL,
                    created_at TEXT NOT NULL,
                    updated_at TEXT NOT NULL,
                    activity_seq INTEGER NOT NULL
                )
                """
            )
            self._ensure_activity_sequence(connection)
            connection.execute(
                """
                CREATE INDEX IF NOT EXISTS idx_chat_sessions_updated_activity
                ON chat_sessions (updated_at DESC, activity_seq DESC)
                """
            )
            connection.execute(
                """
                CREATE TABLE IF NOT EXISTS chat_messages (
                    id TEXT PRIMARY KEY,
                    session_id TEXT NOT NULL,
                    role TEXT NOT NULL,
                    content TEXT NOT NULL,
                    created_at TEXT NOT NULL,
                    provider TEXT,
                    provider_model TEXT,
                    provider_configured INTEGER,
                    provider_label TEXT,
                    FOREIGN KEY (session_id)
                        REFERENCES chat_sessions(id)
                        ON DELETE CASCADE
                )
                """
            )
            connection.execute(
                """
                CREATE INDEX IF NOT EXISTS idx_chat_messages_session_created_at
                ON chat_messages (session_id, created_at)
                """
            )
            connection.execute(
                """
                CREATE INDEX IF NOT EXISTS idx_chat_messages_session_role
                ON chat_messages (session_id, role)
                """
            )
            connection.commit()
        finally:
            connection.close()

    def _connect(self) -> sqlite3.Connection:
        connection = sqlite3.connect(self._db_path)
        connection.row_factory = sqlite3.Row
        connection.execute("PRAGMA foreign_keys = ON")
        return connection

    def _get_session(
        self,
        connection: sqlite3.Connection,
        session_id: str,
    ) -> ChatSession:
        row = connection.execute(
            """
            SELECT
                chat_sessions.id,
                chat_sessions.title,
                chat_sessions.created_at,
                chat_sessions.updated_at,
                (
                    SELECT chat_messages.content
                    FROM chat_messages
                    WHERE chat_messages.session_id = chat_sessions.id
                    ORDER BY chat_messages.created_at DESC, chat_messages.rowid DESC
                    LIMIT 1
                ) AS latest_message_preview
            FROM chat_sessions
            WHERE chat_sessions.id = ?
            ORDER BY
                chat_sessions.updated_at DESC,
                chat_sessions.activity_seq DESC,
                chat_sessions.rowid DESC
            """,
            (session_id,),
        ).fetchone()
        if row is None:
            raise KeyError(session_id)
        return self._session_from_row(row)

    @staticmethod
    def _has_user_messages(connection: sqlite3.Connection, session_id: str) -> bool:
        row = connection.execute(
            """
            SELECT 1
            FROM chat_messages
            WHERE session_id = ? AND role = 'user'
            LIMIT 1
            """,
            (session_id,),
        ).fetchone()
        return row is not None

    @staticmethod
    def _ensure_activity_sequence(connection: sqlite3.Connection) -> None:
        columns = {
            row["name"]
            for row in connection.execute("PRAGMA table_info('chat_sessions')")
        }
        if "activity_seq" in columns:
            return

        connection.execute(
            """
            ALTER TABLE chat_sessions
            ADD COLUMN activity_seq INTEGER NOT NULL DEFAULT 0
            """
        )
        rows = connection.execute(
            """
            SELECT rowid
            FROM chat_sessions
            ORDER BY updated_at ASC, rowid ASC
            """
        ).fetchall()
        for activity_seq, row in enumerate(rows, start=1):
            connection.execute(
                """
                UPDATE chat_sessions
                SET activity_seq = ?
                WHERE rowid = ?
                """,
                (activity_seq, row["rowid"]),
            )

    @staticmethod
    def _next_activity_seq(connection: sqlite3.Connection) -> int:
        row = connection.execute(
            """
            SELECT COALESCE(MAX(activity_seq), 0) + 1 AS next_activity_seq
            FROM chat_sessions
            """
        ).fetchone()
        return int(row["next_activity_seq"])

    @staticmethod
    def _session_from_row(row: sqlite3.Row) -> ChatSession:
        return ChatSession(
            id=row["id"],
            title=row["title"],
            created_at=row["created_at"],
            updated_at=row["updated_at"],
            latest_message_preview=row["latest_message_preview"],
        )

    @staticmethod
    def _message_from_row(row: sqlite3.Row) -> StoredChatMessage:
        return StoredChatMessage(
            id=row["id"],
            session_id=row["session_id"],
            role=row["role"],
            content=row["content"],
            created_at=row["created_at"],
            provider=row["provider"],
            provider_model=row["provider_model"],
            provider_configured=_provider_configured_from_db(row["provider_configured"]),
            provider_label=row["provider_label"],
        )


def _utc_now() -> str:
    return datetime.now(timezone.utc).isoformat()


def _clean_required_text(value: str, *, field_name: str) -> str:
    clean_value = value.strip()
    if not clean_value:
        raise ValueError(f"{field_name} cannot be blank")
    return clean_value


def _auto_title(content: str) -> str:
    if len(content) <= AUTO_TITLE_LIMIT:
        return content
    return f"{content[:AUTO_TITLE_LIMIT].rstrip()}..."


def _provider_configured_to_db(value: bool | None) -> int | None:
    if value is None:
        return None
    return 1 if value else 0


def _provider_configured_from_db(value: int | None) -> bool | None:
    if value is None:
        return None
    return bool(value)


__all__ = [
    "AUTO_TITLE_LIMIT",
    "ChatRole",
    "ChatSession",
    "DEFAULT_SESSION_TITLE",
    "SessionStore",
    "StoredChatMessage",
]

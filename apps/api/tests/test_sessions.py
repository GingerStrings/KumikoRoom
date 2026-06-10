import queue
import sqlite3
import threading
from pathlib import Path

import pytest

import kumikoroom.sessions as sessions_module
from kumikoroom.sessions import AUTO_TITLE_LIMIT, ChatSession, SessionStore


class _BlockingBeginConnection:
    def __init__(
        self,
        connection: sqlite3.Connection,
        reached_begin: threading.Event,
        allow_begin: threading.Event,
    ) -> None:
        self._connection = connection
        self._reached_begin = reached_begin
        self._allow_begin = allow_begin

    def execute(self, sql: str, parameters=()):
        if sql.strip().upper() == "BEGIN IMMEDIATE":
            self._reached_begin.set()
            if not self._allow_begin.wait(timeout=5):
                raise TimeoutError("slow writer was not released")
        return self._connection.execute(sql, parameters)

    def __getattr__(self, name: str):
        return getattr(self._connection, name)


def test_session_store_initializes_chat_message_indexes(tmp_path: Path) -> None:
    db_path = tmp_path / "sessions.sqlite3"

    SessionStore(db_path)

    connection = sqlite3.connect(db_path)
    try:
        indexes = connection.execute("PRAGMA index_list('chat_messages')").fetchall()
        indexed_columns = {
            row[1]: [
                column[2]
                for column in connection.execute(f"PRAGMA index_info('{row[1]}')")
            ]
            for row in indexes
        }
    finally:
        connection.close()

    assert indexed_columns.get("idx_chat_messages_session_created_at") == [
        "session_id",
        "created_at",
    ]
    assert indexed_columns.get("idx_chat_messages_session_role") == [
        "session_id",
        "role",
    ]


def test_session_store_creates_lists_renames_and_deletes_sessions(tmp_path: Path) -> None:
    store = SessionStore(tmp_path / "sessions.sqlite3")

    session = store.create_session()
    assert session.title == "New conversation"

    renamed = store.rename_session(session.id, " Evening listening ")
    assert renamed.title == "Evening listening"
    assert store.list_sessions()[0].title == "Evening listening"

    assert store.delete_session(session.id) is True
    assert store.list_sessions() == []
    assert store.delete_session(session.id) is False


def test_session_store_rejects_blank_titles(tmp_path: Path) -> None:
    store = SessionStore(tmp_path / "sessions.sqlite3")
    session = store.create_session()

    try:
        store.rename_session(session.id, "   ")
    except ValueError as error:
        assert "title" in str(error)
    else:
        raise AssertionError("blank title was accepted")


def test_session_store_saves_messages_and_updates_default_title(tmp_path: Path) -> None:
    store = SessionStore(tmp_path / "sessions.sqlite3")
    session = store.create_session()

    user_message = store.append_message(
        session_id=session.id,
        role="user",
        content="  I want quiet piano tonight.  ",
    )
    kumiko_message = store.append_message(
        session.id,
        "kumiko",
        "Let's keep it quiet.",
        provider="mock",
        provider_model="mock-model",
        provider_configured=True,
        provider_label="Local Mock API",
    )

    messages = store.list_messages(session.id)
    assert [message.id for message in messages] == [user_message.id, kumiko_message.id]
    assert messages[0].content == "I want quiet piano tonight."
    assert messages[1].provider == "mock"
    assert messages[1].provider_model == "mock-model"
    assert messages[1].provider_configured is True
    assert messages[1].provider_label == "Local Mock API"
    assert store.list_sessions()[0].latest_message_preview == "Let's keep it quiet."
    assert store.get_session(session.id).title == "I want quiet piano tonight."


def test_session_store_uses_commit_order_for_latest_message_preview(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    store = SessionStore(tmp_path / "sessions.sqlite3")
    session = store.create_session(title="Manual title")
    timestamps: queue.Queue[str] = queue.Queue()
    timestamps.put("2026-06-10T12:00:00+00:00")
    timestamps.put("2026-06-10T12:00:01+00:00")
    original_connect = store._connect
    slow_reached_begin = threading.Event()
    allow_slow_begin = threading.Event()
    fast_done = threading.Event()
    errors: queue.Queue[BaseException] = queue.Queue()

    def deterministic_utc_now() -> str:
        try:
            return timestamps.get_nowait()
        except queue.Empty as error:
            raise AssertionError("unexpected _utc_now call") from error

    def coordinated_connect():
        connection = original_connect()
        if threading.current_thread().name == "slow-append":
            return _BlockingBeginConnection(
                connection,
                slow_reached_begin,
                allow_slow_begin,
            )
        return connection

    monkeypatch.setattr(sessions_module, "_utc_now", deterministic_utc_now)
    monkeypatch.setattr(store, "_connect", coordinated_connect)

    def append_message(content: str) -> None:
        try:
            store.append_message(session.id, "kumiko", content)
        except BaseException as error:
            errors.put(error)
        finally:
            if threading.current_thread().name == "fast-append":
                fast_done.set()

    slow_thread = threading.Thread(
        target=append_message,
        name="slow-append",
        args=("Slow commit last",),
    )
    fast_thread = threading.Thread(
        target=append_message,
        name="fast-append",
        args=("Fast commit first",),
    )

    slow_thread.start()
    assert slow_reached_begin.wait(timeout=5)
    fast_thread.start()
    fast_completed = fast_done.wait(timeout=5)
    allow_slow_begin.set()
    assert fast_completed
    slow_thread.join(timeout=5)
    fast_thread.join(timeout=5)

    assert not slow_thread.is_alive()
    assert not fast_thread.is_alive()
    if not errors.empty():
        raise errors.get()

    assert store.list_sessions()[0].latest_message_preview == "Slow commit last"
    assert store.list_messages(session.id)[-1].content == "Slow commit last"


def test_session_store_round_trips_provider_configured_states(tmp_path: Path) -> None:
    store = SessionStore(tmp_path / "sessions.sqlite3")
    session = store.create_session()
    provider_configured_states = [True, False, None]

    for index, provider_configured in enumerate(provider_configured_states):
        store.append_message(
            session.id,
            "kumiko",
            f"Provider state {index}",
            provider_configured=provider_configured,
        )

    messages = store.list_messages(session.id)
    assert [message.provider_configured for message in messages] == provider_configured_states


def test_session_store_uses_first_user_message_when_it_matches_default_title(
    tmp_path: Path,
) -> None:
    store = SessionStore(tmp_path / "sessions.sqlite3")
    session = store.create_session()

    store.append_message(session.id, "user", "New conversation")
    store.append_message(session.id, "user", "Second title should not win")

    assert store.get_session(session.id).title == "New conversation"


def test_session_store_auto_title_uses_first_user_message_under_stale_reads(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    store = SessionStore(tmp_path / "sessions.sqlite3")
    session = store.create_session()
    original_has_user_messages = SessionStore._has_user_messages
    first_read = threading.Event()
    first_append_done = threading.Event()
    stale_read_barrier = threading.Barrier(2)
    errors: queue.Queue[BaseException] = queue.Queue()

    def coordinated_has_user_messages(
        connection,
        session_id: str,
    ) -> bool:
        has_user_messages = original_has_user_messages(connection, session_id)
        thread_name = threading.current_thread().name
        if thread_name == "first-auto-title":
            first_read.set()
        if connection.in_transaction:
            return has_user_messages
        if thread_name not in {"first-auto-title", "second-auto-title"}:
            return has_user_messages

        try:
            stale_read_barrier.wait(timeout=5)
        except threading.BrokenBarrierError:
            return has_user_messages

        if thread_name == "second-auto-title" and not first_append_done.wait(timeout=5):
            raise TimeoutError("first append did not finish")

        return has_user_messages

    monkeypatch.setattr(
        SessionStore,
        "_has_user_messages",
        staticmethod(coordinated_has_user_messages),
    )

    def append_user_message(content: str) -> None:
        try:
            store.append_message(session.id, "user", content)
        except BaseException as error:
            errors.put(error)
        finally:
            if threading.current_thread().name == "first-auto-title":
                first_append_done.set()

    first_thread = threading.Thread(
        target=append_user_message,
        name="first-auto-title",
        args=("First title",),
    )
    second_thread = threading.Thread(
        target=append_user_message,
        name="second-auto-title",
        args=("Second title",),
    )

    first_thread.start()
    assert first_read.wait(timeout=5)
    second_thread.start()
    first_thread.join(timeout=5)
    second_thread.join(timeout=5)

    assert not first_thread.is_alive()
    assert not second_thread.is_alive()
    if not errors.empty():
        raise errors.get()

    first_user_content = next(
        message.content
        for message in store.list_messages(session.id)
        if message.role == "user"
    )
    assert store.get_session(session.id).title == first_user_content


def test_session_store_truncates_auto_title(tmp_path: Path) -> None:
    store = SessionStore(tmp_path / "sessions.sqlite3")
    session = store.create_session()
    content = "A" * (AUTO_TITLE_LIMIT + 10)

    store.append_message(session.id, "user", content)

    assert store.get_session(session.id).title == f"{'A' * AUTO_TITLE_LIMIT}..."


def test_session_store_preserves_manual_title_after_messages(tmp_path: Path) -> None:
    store = SessionStore(tmp_path / "sessions.sqlite3")
    session = store.create_session(title="Practice notes")

    store.append_message(session_id=session.id, role="user", content="Rename should stay.")

    assert store.get_session(session.id).title == "Practice notes"


def test_session_store_rejects_invalid_message_role_and_blank_content(
    tmp_path: Path,
) -> None:
    store = SessionStore(tmp_path / "sessions.sqlite3")
    session = store.create_session()

    with pytest.raises(ValueError, match="Unknown chat role"):
        store.append_message(session.id, "system", "Hello")

    with pytest.raises(ValueError, match="content"):
        store.append_message(session.id, "user", "   ")


def test_session_store_raises_key_error_for_missing_sessions(tmp_path: Path) -> None:
    store = SessionStore(tmp_path / "sessions.sqlite3")
    missing_session_id = "missing-session"

    with pytest.raises(KeyError):
        store.get_session(missing_session_id)

    with pytest.raises(KeyError):
        store.rename_session(missing_session_id, "Still missing")

    with pytest.raises(KeyError):
        store.append_message(missing_session_id, "user", "Still missing")


def test_session_store_lists_sessions_by_most_recent_update_with_limit(
    tmp_path: Path,
) -> None:
    store = SessionStore(tmp_path / "sessions.sqlite3")
    first = store.create_session(title="First")
    second = store.create_session(title="Second")

    store.append_message(first.id, "kumiko", "First was updated later.")

    sessions = store.list_sessions()
    assert [session.id for session in sessions] == [first.id, second.id]
    assert [session.id for session in store.list_sessions(limit=1)] == [first.id]


def test_session_store_lists_equal_updated_at_by_latest_activity(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    fixed_time = "2026-06-10T12:00:00+00:00"
    monkeypatch.setattr(sessions_module, "_utc_now", lambda: fixed_time)
    store = SessionStore(tmp_path / "sessions.sqlite3")
    first = store.create_session(title="First")
    store.create_session(title="Second")

    store.rename_session(first.id, "First was active most recently")

    assert store.list_sessions()[0].id == first.id


def test_session_store_deletes_session_messages(tmp_path: Path) -> None:
    store = SessionStore(tmp_path / "sessions.sqlite3")
    session = store.create_session()
    store.append_message(session_id=session.id, role="user", content="Gone soon.")

    store.delete_session(session.id)

    assert store.list_messages(session.id) == []


def test_session_store_ensures_default_session(tmp_path: Path) -> None:
    store = SessionStore(tmp_path / "sessions.sqlite3")

    first = store.ensure_default_session()
    second = store.ensure_default_session()

    assert first.id == second.id
    assert store.list_sessions() == [first]


def test_session_store_ensures_one_default_session_under_concurrent_empty_reads(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    store = SessionStore(tmp_path / "sessions.sqlite3")
    original_list_sessions = store.list_sessions
    empty_read_barrier = threading.Barrier(2)
    results: queue.Queue[ChatSession] = queue.Queue()
    errors: queue.Queue[BaseException] = queue.Queue()

    def coordinated_list_sessions(limit: int = 50) -> list[ChatSession]:
        existing_sessions = original_list_sessions(limit)
        if (
            threading.current_thread().name
            in {"ensure-default-first", "ensure-default-second"}
            and not existing_sessions
        ):
            try:
                empty_read_barrier.wait(timeout=5)
            except threading.BrokenBarrierError:
                pass
        return existing_sessions

    monkeypatch.setattr(store, "list_sessions", coordinated_list_sessions)

    def ensure_default_session() -> None:
        try:
            results.put(store.ensure_default_session())
        except BaseException as error:
            errors.put(error)

    threads = [
        threading.Thread(
            target=ensure_default_session,
            name="ensure-default-first",
        ),
        threading.Thread(
            target=ensure_default_session,
            name="ensure-default-second",
        ),
    ]

    for thread in threads:
        thread.start()
    for thread in threads:
        thread.join(timeout=5)

    assert all(not thread.is_alive() for thread in threads)
    if not errors.empty():
        raise errors.get()

    returned_sessions = [results.get_nowait() for _ in threads]
    returned_ids = {session.id for session in returned_sessions}
    stored_session_ids = [session.id for session in store.list_sessions()]
    assert len(returned_ids) == 1
    assert stored_session_ids == [returned_sessions[0].id]

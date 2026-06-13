from dataclasses import asdict

from fastapi import APIRouter, HTTPException, Response, status

from kumikoroom.config import load_settings
from kumikoroom.conversation import ConversationManager
from kumikoroom.memory import MemoryStore
from kumikoroom.schemas import (
    ChatIn,
    ChatOut,
    ChatSessionOut,
    MemoryEventOut,
    RoomStateOut,
    SessionRenameIn,
    StoredChatMessageOut,
)
from kumikoroom.sessions import ChatSession, SessionStore, StoredChatMessage

router = APIRouter(prefix="/api/room", tags=["room"])


def default_room_state() -> RoomStateOut:
    return RoomStateOut(
        app_name="KumikoRoom",
        room_name="陪伴房间",
        character={
            "display_name": "黄前久美子",
            "romanized_name": "Oumae Kumiko",
            "expression": "listening",
            "status_text": "正在听你今天想说的音乐",
        },
        music={
            "current_track_title": None,
            "current_artist": None,
            "listening_mood": "还没记录",
        },
        diary_summary="今天还没有写听歌日记。",
        inspiration_count=0,
        studio={
            "label": "创作资料室",
            "route": "/studio",
            "unfinished_count": 0,
        },
    )


@router.get("/state", response_model=RoomStateOut)
def get_room_state() -> RoomStateOut:
    return default_room_state()


@router.post("/chat", response_model=ChatOut)
def post_chat(payload: ChatIn) -> ChatOut:
    try:
        return ConversationManager(settings=load_settings()).chat(payload)
    except KeyError:
        raise HTTPException(status_code=404, detail="Session not found")


def memory_store() -> MemoryStore:
    return MemoryStore(load_settings().memory_db_path)


def session_store() -> SessionStore:
    return SessionStore(load_settings().memory_db_path)


@router.get("/memory", response_model=list[MemoryEventOut])
def list_memory() -> list[MemoryEventOut]:
    return [
        _memory_event_out(memory) for memory in memory_store().list_recent(limit=50)
    ]


@router.delete("/memory/{memory_id}", status_code=status.HTTP_204_NO_CONTENT)
def delete_memory(memory_id: str) -> Response:
    memory_store().delete(memory_id)
    return Response(status_code=status.HTTP_204_NO_CONTENT)


@router.delete("/memory", status_code=status.HTTP_204_NO_CONTENT)
def clear_memory() -> Response:
    memory_store().clear()
    return Response(status_code=status.HTTP_204_NO_CONTENT)


@router.get("/sessions", response_model=list[ChatSessionOut])
def list_sessions() -> list[ChatSessionOut]:
    return [_session_out(session) for session in session_store().list_sessions(limit=50)]


@router.post("/sessions", response_model=ChatSessionOut)
def create_session() -> ChatSessionOut:
    return _session_out(session_store().create_session())


@router.get("/sessions/{session_id}/messages", response_model=list[StoredChatMessageOut])
def list_session_messages(session_id: str) -> list[StoredChatMessageOut]:
    store = session_store()
    try:
        store.get_session(session_id)
    except KeyError:
        raise HTTPException(status_code=404, detail="Session not found")
    return [_stored_message_out(message) for message in store.list_messages(session_id)]


@router.patch("/sessions/{session_id}", response_model=ChatSessionOut)
def rename_session(session_id: str, payload: SessionRenameIn) -> ChatSessionOut:
    try:
        return _session_out(session_store().rename_session(session_id, payload.title))
    except ValueError as error:
        raise HTTPException(status_code=400, detail=str(error))
    except KeyError:
        raise HTTPException(status_code=404, detail="Session not found")


@router.delete("/sessions/{session_id}", status_code=status.HTTP_204_NO_CONTENT)
def delete_session(session_id: str) -> Response:
    session_store().delete_session(session_id)
    return Response(status_code=status.HTTP_204_NO_CONTENT)


def _memory_event_out(memory) -> MemoryEventOut:
    data = asdict(memory)
    data.pop("source", None)
    return MemoryEventOut(**data)


def _session_out(session: ChatSession) -> ChatSessionOut:
    return ChatSessionOut(**asdict(session))


def _stored_message_out(message: StoredChatMessage) -> StoredChatMessageOut:
    return StoredChatMessageOut(**asdict(message))

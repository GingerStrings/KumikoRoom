from dataclasses import asdict

from fastapi import APIRouter, Response, status

from kumikoroom.config import load_settings
from kumikoroom.conversation import ConversationManager
from kumikoroom.memory import MemoryStore
from kumikoroom.schemas import (
    ChatIn,
    ChatOut,
    MemoryEventOut,
    RoomStateOut,
)

router = APIRouter(prefix="/api/room", tags=["room"])


def default_room_state() -> RoomStateOut:
    return RoomStateOut(
        app_name="KumikoRoom",
        room_name="陪伴房间",
        character={
            "display_name": "黄前久美子",
            "romanized_name": "Kumiko Oumae",
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
    return ConversationManager(settings=load_settings()).chat(payload)


def memory_store() -> MemoryStore:
    return MemoryStore(load_settings().memory_db_path)


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


def _memory_event_out(memory) -> MemoryEventOut:
    data = asdict(memory)
    data.pop("source", None)
    return MemoryEventOut(**data)

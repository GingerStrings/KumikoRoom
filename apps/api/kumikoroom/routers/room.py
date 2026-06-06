from fastapi import APIRouter

from kumikoroom.schemas import (
    ChatIn,
    ChatMessageOut,
    ChatOut,
    ProviderStatusOut,
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
    message = payload.message.strip()
    quoted = message if message else "今天的音乐"
    return ChatOut(
        reply=ChatMessageOut(
            id="mock-kumiko-reply",
            role="kumiko",
            content=f"嗯，我听到了。你说的是「{quoted}」。先把这句话记下来也不错。",
        ),
        expression="listening",
        suggested_actions=["save_diary", "save_inspiration"],
        provider_status=ProviderStatusOut(
            provider="mock",
            model=None,
            configured=True,
            label="本地 Mock API",
        ),
        memory_events=[],
    )

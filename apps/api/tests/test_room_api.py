from fastapi.testclient import TestClient

from kumikoroom.schemas import MemoryEventOut


def test_room_state_uses_kumikoroom_identity(client: TestClient):
    response = client.get("/api/room/state")

    assert response.status_code == 200
    body = response.json()
    assert body["app_name"] == "KumikoRoom"
    assert body["room_name"] == "陪伴房间"
    assert body["character"]["display_name"] == "黄前久美子"
    assert body["studio"]["label"] == "创作资料室"
    assert body["studio"]["route"] == "/studio"


def test_mock_chat_returns_kumiko_reply(client: TestClient):
    response = client.post(
        "/api/room/chat",
        json={
            "message": "想听安静的歌",
            "persona_strength": "medium",
            "memory_enabled": True,
        },
    )

    assert response.status_code == 200
    body = response.json()
    assert body["reply"]["role"] == "kumiko"
    assert "想听安静的歌" in body["reply"]["content"]
    assert body["expression"] == "listening"
    assert body["suggested_actions"] == ["save_diary", "save_inspiration"]
    assert body["provider_status"] == {
        "provider": "mock",
        "model": None,
        "configured": True,
        "label": "\u672c\u5730 Mock API",
    }
    assert body["memory_events"] == []


def test_memory_event_schema_uses_conversation_manager_fields() -> None:
    event = MemoryEventOut(
        id="memory-1",
        category="preference",
        text="prefers quiet songs",
        confidence=0.85,
        created_at="2026-06-06T23:00:00Z",
    )

    assert event.model_dump() == {
        "id": "memory-1",
        "category": "preference",
        "text": "prefers quiet songs",
        "confidence": 0.85,
        "created_at": "2026-06-06T23:00:00Z",
    }

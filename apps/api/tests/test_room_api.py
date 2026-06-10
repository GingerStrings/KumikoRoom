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


def test_mock_chat_accepts_minimal_payload(client: TestClient):
    response = client.post(
        "/api/room/chat",
        json={"message": "想听安静的歌"},
    )

    assert response.status_code == 200
    body = response.json()
    assert body["provider_status"]["provider"] == "mock"
    assert body["memory_events"] == []


def test_memory_endpoints_list_delete_and_clear(client: TestClient):
    chat_response = client.post(
        "/api/room/chat",
        json={
            "message": "我喜欢安静的钢琴，这个 demo 明天继续编曲。",
            "memory_enabled": True,
        },
    )

    assert chat_response.status_code == 200

    list_response = client.get("/api/room/memory")
    assert list_response.status_code == 200
    memories = list_response.json()
    assert len(memories) == 2
    assert sorted(memory["category"] for memory in memories) == [
        "creative_note",
        "preference",
    ]

    delete_response = client.delete(f"/api/room/memory/{memories[0]['id']}")
    assert delete_response.status_code == 204

    list_after_delete = client.get("/api/room/memory")
    assert list_after_delete.status_code == 200
    assert len(list_after_delete.json()) == 1

    clear_response = client.delete("/api/room/memory")
    assert clear_response.status_code == 204

    list_after_clear = client.get("/api/room/memory")
    assert list_after_clear.status_code == 200
    assert list_after_clear.json() == []


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


def test_session_endpoints_create_list_rename_load_and_delete(client: TestClient):
    create_response = client.post("/api/room/sessions")
    assert create_response.status_code == 200
    session = create_response.json()
    assert session["title"] == "New conversation"

    list_response = client.get("/api/room/sessions")
    assert list_response.status_code == 200
    assert list_response.json()[0]["id"] == session["id"]

    rename_response = client.patch(
        f"/api/room/sessions/{session['id']}",
        json={"title": "Evening songs"},
    )
    assert rename_response.status_code == 200
    assert rename_response.json()["title"] == "Evening songs"

    messages_response = client.get(f"/api/room/sessions/{session['id']}/messages")
    assert messages_response.status_code == 200
    assert messages_response.json() == []

    delete_response = client.delete(f"/api/room/sessions/{session['id']}")
    assert delete_response.status_code == 204
    assert client.get("/api/room/sessions").json() == []


def test_session_rename_rejects_blank_title(client: TestClient):
    session = client.post("/api/room/sessions").json()

    response = client.patch(
        f"/api/room/sessions/{session['id']}",
        json={"title": "   "},
    )

    assert response.status_code == 400


def test_missing_session_messages_and_rename_return_404(client: TestClient):
    messages_response = client.get("/api/room/sessions/missing-session/messages")
    assert messages_response.status_code == 404

    rename_response = client.patch(
        "/api/room/sessions/missing-session",
        json={"title": "Still missing"},
    )
    assert rename_response.status_code == 404


def test_chat_saves_messages_to_session_and_returns_session(client: TestClient):
    session = client.post("/api/room/sessions").json()

    response = client.post(
        "/api/room/chat",
        json={
            "session_id": session["id"],
            "message": "I want quiet piano tonight.",
            "memory_enabled": False,
        },
    )

    assert response.status_code == 200
    body = response.json()
    assert body["session"]["id"] == session["id"]
    assert body["session"]["title"] == "I want quiet piano tonight."
    assert body["session"]["latest_message_preview"]

    messages = client.get(
        f"/api/room/sessions/{session['id']}/messages"
    ).json()
    assert [message["role"] for message in messages] == ["user", "kumiko"]
    assert messages[0]["content"] == "I want quiet piano tonight."
    assert body["reply"]["id"] == messages[1]["id"]


def test_chat_with_missing_session_returns_404(client: TestClient):
    response = client.post(
        "/api/room/chat",
        json={
            "session_id": "missing-session",
            "message": "hello",
            "memory_enabled": False,
        },
    )

    assert response.status_code == 404
    assert response.json()["detail"] == "Session not found"

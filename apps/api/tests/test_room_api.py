from fastapi.testclient import TestClient

from kumikoroom.music_search import (
    parse_bilibili_video_results,
    NeteaseSongSearchResult,
    parse_netease_song_results,
)
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


def test_mock_chat_accepts_listening_context(client: TestClient):
    response = client.post(
        "/api/room/chat",
        json={
            "message": "这首适合写什么？",
            "memory_enabled": False,
            "listening_context": {
                "source": "bilibili",
                "title": "合奏前调音",
                "creator": "部室 · 木管声部",
                "is_playing": True,
                "page_url": "https://www.bilibili.com/video/BV1xx411c7mD",
                "tags": ["bilibili", "rehearsal"],
            },
        },
    )

    assert response.status_code == 200
    body = response.json()
    assert body["reply"]["role"] == "kumiko"
    assert body["provider_status"]["provider"] == "mock"


def test_music_search_endpoint_maps_netease_result(
    client: TestClient, monkeypatch
) -> None:
    def fake_search_netease_songs(query: str, limit: int = 5):
        assert query == "晴天"
        assert limit == 1
        return [
            NeteaseSongSearchResult(
                id="netease-song-186016",
                song_id="186016",
                title="晴天",
                creator="周杰伦",
                duration_ms=269000,
                playable=True,
                popularity=100.0,
                comment_count=1970484,
                hot_comment_liked_count=823181,
                score=180.5,
                evidence=["title exact match", "comment_count=1970484"],
            )
        ]

    monkeypatch.setattr(
        "kumikoroom.routers.room.search_netease_songs", fake_search_netease_songs
    )

    response = client.get("/api/room/music/search", params={"q": " 晴天 ", "limit": 1})

    assert response.status_code == 200
    assert response.json() == [
        {
            "source": "netease",
            "id": "netease-song-186016",
            "song_id": "186016",
            "title": "晴天",
            "creator": "周杰伦",
            "duration_ms": 269000,
            "page_url": "https://music.163.com/#/song?id=186016",
            "platform_audio_url": "https://music.163.com/song/media/outer/url?id=186016.mp3",
            "tags": ["netease", "search"],
            "playable": True,
            "popularity": 100.0,
            "comment_count": 1970484,
            "hot_comment_liked_count": 823181,
            "score": 180.5,
            "evidence": ["title exact match", "comment_count=1970484"],
        }
    ]


def test_music_search_ranks_candidates_with_engagement_signals(monkeypatch) -> None:
    payload = {
        "result": {
            "songs": [
                {
                    "id": 1,
                    "name": "晴天",
                    "artists": [{"name": "周杰伦-"}],
                    "duration": 120000,
                },
                {
                    "id": 2,
                    "name": "晴天 (原唱 周杰伦)",
                    "artists": [{"name": "RyaVocal"}],
                    "duration": 270738,
                },
            ]
        }
    }

    monkeypatch.setattr(
        "kumikoroom.music_search.fetch_netease_song_details",
        lambda song_ids: {
            "1": {
                "popularity": 20.0,
                "score": 20,
                "commentThreadId": "R_SO_4_1",
            },
            "2": {
                "popularity": 70.0,
                "score": 70,
                "commentThreadId": "R_SO_4_2",
            },
        },
    )
    monkeypatch.setattr(
        "kumikoroom.music_search.fetch_netease_comment_metrics",
        lambda song_id: {
            "1": {"comment_count": 205, "hot_comment_liked_count": 248},
            "2": {"comment_count": 5918, "hot_comment_liked_count": 14314},
        }[song_id],
    )
    monkeypatch.setattr(
        "kumikoroom.music_search.check_netease_outer_audio_playable",
        lambda song_id: True,
    )

    results = parse_netease_song_results(payload, query="晴天 周杰伦", limit=2)

    assert results[0].song_id == "2"
    assert results[0].comment_count == 5918
    assert results[0].hot_comment_liked_count == 14314
    assert results[0].score > results[1].score
    assert "comment_count=5918" in results[0].evidence
    assert "hot_comment_liked_count=14314" in results[0].evidence


def test_bilibili_result_parser_prefers_full_song_with_stronger_engagement() -> None:
    payload = {
        "data": {
            "result": [
                {
                    "bvid": "BV1fullSong",
                    "title": '<em class="keyword">晴天</em> 官方现场版',
                    "author": "周杰伦",
                    "duration": "04:32",
                    "play": 3280000,
                    "video_review": 18234,
                    "like": 248000,
                },
                {
                    "bvid": "BV1shortClip",
                    "title": '<em class="keyword">晴天</em> 副歌片段',
                    "author": "剪辑号",
                    "duration": "00:28",
                    "play": 820000,
                    "video_review": 86,
                    "like": 2400,
                },
            ]
        }
    }

    results = parse_bilibili_video_results(payload, query="晴天", limit=2)

    assert [result.id for result in results] == [
        "bilibili-BV1fullSong",
        "bilibili-BV1shortClip",
    ]
    assert results[0].source == "bilibili"
    assert results[0].duration_ms == 272000
    assert results[0].page_url == "https://www.bilibili.com/video/BV1fullSong"
    assert results[0].embed_url == "https://player.bilibili.com/player.html?bvid=BV1fullSong"
    assert results[0].playable is True
    assert results[0].popularity == 3280000
    assert results[0].comment_count == 18234
    assert results[0].hot_comment_liked_count == 248000
    assert results[0].score > results[1].score
    assert "view_count=3280000" in results[0].evidence
    assert "duration looks like a full song or complete performance" in results[0].evidence


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

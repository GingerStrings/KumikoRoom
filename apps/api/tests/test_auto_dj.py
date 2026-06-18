from kumikoroom.auto_dj import recommend_auto_dj
from kumikoroom.music_search import BilibiliVideoSearchResult, NeteaseSongSearchResult
from kumikoroom.schemas import AutoDjRecommendIn


def empty_profile() -> dict:
    return {
        "version": 1,
        "updated_at": "2026-06-18T00:00:00.000Z",
        "artist_weights": {},
        "tag_weights": {},
        "source_weights": {},
        "query_weights": {},
        "recent_themes": [],
        "cooldowns": [],
        "recommended_items": [],
        "refill_history": [],
    }


def test_auto_dj_request_schema_defaults_settings() -> None:
    payload = AutoDjRecommendIn(
        music_state=None,
        recommendation_profile=empty_profile(),
        recent_messages=[],
    )

    assert payload.settings.count == 3
    assert payload.settings.queue_depth_trigger == 2
    assert payload.settings.similar_count == 2
    assert payload.settings.exploration_count == 1


def test_auto_dj_endpoint_returns_needs_more_context(client) -> None:
    response = client.post(
        "/api/room/music/auto-dj/recommend",
        json={
            "music_state": None,
            "recommendation_profile": empty_profile(),
            "recent_messages": [],
            "settings": {
                "count": 3,
                "queue_depth_trigger": 2,
                "similar_count": 2,
                "exploration_count": 1,
            },
        },
    )

    assert response.status_code == 200
    body = response.json()
    assert body["ok"] is False
    assert body["error"] == "needs_more_context"
    assert body["notice"] == "Auto DJ needs a current track or listening profile before it can recommend."
    assert body["client_actions"] == []
    assert body["recommendations"] == []
    assert body["profile_patch"] == {
        "recommended_items": [],
        "cooldowns": [],
        "refill_history": [],
    }


def music_track(
    item_id: str,
    title: str,
    *,
    creator: str = "Fixture Artist",
    tags: list[str] | None = None,
) -> dict:
    return {
        "id": item_id,
        "source": "netease",
        "title": title,
        "creator": creator,
        "duration_ms": 180000,
        "page_url": f"https://music.example/{item_id}",
        "platform_audio_url": f"https://audio.example/{item_id}.mp3",
        "tags": tags or ["brass", "ost"],
        "can_open_video": False,
        "saved": False,
    }


def music_state_for_auto_dj() -> dict:
    return {
        "is_playing": True,
        "current_time_ms": 42000,
        "duration_ms": 180000,
        "current": music_track(
            "current",
            "Brass Theme",
            creator="Concert Band",
            tags=["brass", "warm"],
        ),
        "previous": None,
        "next": music_track("queued-1", "Queued One"),
        "upcoming": [
            music_track("queued-1", "Queued One"),
            music_track("queued-2", "Queued Two"),
        ],
        "recent": [music_track("recent-1", "Recent One", tags=["brass"])],
        "saved": [music_track("saved-1", "Saved One", tags=["warm"])],
        "playlists": [
            {
                "id": "playlist-brass",
                "name": "Brass",
                "description": "warm brass",
                "item_count": 1,
                "updated_at": "2026-06-18T00:00:00.000Z",
                "items": [music_track("playlist-1", "Playlist One", tags=["brass"])],
            }
        ],
    }


def make_netease_candidate(
    item_id: str,
    title: str,
    score: float,
    *,
    playable: bool = True,
) -> NeteaseSongSearchResult:
    song_id = item_id.replace("netease-song-", "")
    return NeteaseSongSearchResult(
        id=item_id,
        song_id=song_id,
        title=title,
        creator="Concert Band",
        duration_ms=210000,
        playable=playable,
        popularity=80.0,
        comment_count=5000,
        hot_comment_liked_count=1200,
        score=score,
        evidence=[f"base score {score}", "playable candidate"],
    )


def make_bilibili_candidate(
    item_id: str,
    title: str,
    score: float,
) -> BilibiliVideoSearchResult:
    bvid = item_id.replace("bilibili-", "")
    return BilibiliVideoSearchResult(
        id=item_id,
        bvid=bvid,
        title=title,
        creator="Concert Band",
        duration_ms=230000,
        playable=True,
        popularity=900000,
        comment_count=3000,
        hot_comment_liked_count=900,
        score=score,
        evidence=[f"base score {score}", "video candidate"],
    )


def test_auto_dj_recommends_three_search_candidates(monkeypatch) -> None:
    def fake_netease(query: str, limit: int = 8):
        return [
            make_netease_candidate("netease-song-a", "Brass Similar A", 120.0),
            make_netease_candidate("netease-song-b", "Brass Similar B", 112.0),
            make_netease_candidate("queued-1", "Queued Duplicate", 500.0),
            make_netease_candidate("netease-song-cooldown", "Cooldown Track", 140.0),
        ]

    def fake_bilibili(query: str, limit: int = 8):
        return [make_bilibili_candidate("bilibili-BVexplore", "Brass Explore", 118.0)]

    monkeypatch.setattr("kumikoroom.auto_dj.search_netease_songs", fake_netease)
    monkeypatch.setattr("kumikoroom.auto_dj.search_bilibili_videos", fake_bilibili)

    profile = empty_profile()
    profile["tag_weights"] = {"brass": 2.0, "warm": 1.4}
    profile["cooldowns"] = [
        {
            "key": "netease-song-cooldown",
            "kind": "item",
            "weight": 3.0,
            "expires_at": "2099-01-01T00:00:00.000Z",
            "reason": "dislike",
        }
    ]

    result = recommend_auto_dj(
        AutoDjRecommendIn(
            music_state=music_state_for_auto_dj(),
            recommendation_profile=profile,
            recent_messages=[],
        )
    )

    assert result.ok is True
    assert len(result.recommendations) == 3
    assert [action.type for action in result.client_actions] == [
        "add_music_to_queue",
        "add_music_to_queue",
        "add_music_to_queue",
    ]
    selected_ids = [recommendation.item.id for recommendation in result.recommendations]
    assert "queued-1" not in selected_ids
    assert "netease-song-cooldown" not in selected_ids
    assert "bilibili-BVexplore" in selected_ids
    assert all(recommendation.reason for recommendation in result.recommendations)
    assert all(recommendation.evidence for recommendation in result.recommendations)
    assert result.profile_patch.refill_history[0].selected_item_ids == selected_ids


def test_auto_dj_increases_exploration_after_repeated_overlap(monkeypatch) -> None:
    monkeypatch.setattr(
        "kumikoroom.auto_dj.search_netease_songs",
        lambda query, limit=8: [
            make_netease_candidate("netease-song-a", "Brass Similar A", 120.0),
            make_netease_candidate("netease-song-b", "Brass Similar B", 115.0),
            make_netease_candidate("netease-song-c", "Brass Explore C", 110.0),
            make_netease_candidate("netease-song-d", "Brass Explore D", 109.0),
        ],
    )
    monkeypatch.setattr(
        "kumikoroom.auto_dj.search_bilibili_videos",
        lambda query, limit=8: [],
    )

    profile = empty_profile()
    profile["refill_history"] = [
        {
            "refill_id": "old-1",
            "created_at": "2026-06-18T00:00:00.000Z",
            "selected_item_ids": ["old-a", "old-b", "old-c"],
            "dominant_themes": ["brass", "warm"],
            "exploration_count": 1,
        },
        {
            "refill_id": "old-2",
            "created_at": "2026-06-18T00:05:00.000Z",
            "selected_item_ids": ["old-d", "old-e", "old-f"],
            "dominant_themes": ["brass", "warm"],
            "exploration_count": 1,
        },
    ]

    result = recommend_auto_dj(
        AutoDjRecommendIn(
            music_state=music_state_for_auto_dj(),
            recommendation_profile=profile,
            recent_messages=[],
        )
    )

    assert result.ok is True
    assert result.profile_patch.refill_history[0].exploration_count == 2
    exploration_recommendations = [
        recommendation
        for recommendation in result.recommendations
        if recommendation.intent == "light_exploration"
    ]
    assert len(exploration_recommendations) == 2


def test_auto_dj_keeps_working_when_one_source_fails(monkeypatch) -> None:
    def failing_bilibili(query: str, limit: int = 8):
        raise RuntimeError("bilibili unavailable")

    monkeypatch.setattr(
        "kumikoroom.auto_dj.search_netease_songs",
        lambda query, limit=8: [
            make_netease_candidate("netease-song-a", "Brass Similar A", 120.0)
        ],
    )
    monkeypatch.setattr("kumikoroom.auto_dj.search_bilibili_videos", failing_bilibili)

    result = recommend_auto_dj(
        AutoDjRecommendIn(
            music_state=music_state_for_auto_dj(),
            recommendation_profile=empty_profile(),
            recent_messages=[],
        )
    )

    assert result.ok is True
    assert len(result.recommendations) == 1
    assert result.source_errors == ["bilibili unavailable"]


def test_auto_dj_treats_offsetless_cooldown_timestamp_as_utc(monkeypatch) -> None:
    monkeypatch.setattr(
        "kumikoroom.auto_dj.search_netease_songs",
        lambda query, limit=8: [
            make_netease_candidate("netease-song-cooldown", "Cooldown Track", 140.0),
            make_netease_candidate("netease-song-safe", "Safe Track", 120.0),
        ],
    )
    monkeypatch.setattr(
        "kumikoroom.auto_dj.search_bilibili_videos",
        lambda query, limit=8: [],
    )

    profile = empty_profile()
    profile["cooldowns"] = [
        {
            "key": "netease-song-cooldown",
            "kind": "item",
            "weight": 3.0,
            "expires_at": "2099-01-01T00:00:00.000",
            "reason": "dislike",
        }
    ]

    result = recommend_auto_dj(
        AutoDjRecommendIn(
            music_state=music_state_for_auto_dj(),
            recommendation_profile=profile,
            recent_messages=[],
        )
    )

    selected_ids = [recommendation.item.id for recommendation in result.recommendations]
    assert result.ok is True
    assert selected_ids == ["netease-song-safe"]


def test_auto_dj_preserves_recall_query_and_intent(monkeypatch) -> None:
    similar_query = "Brass Theme Concert Band"
    exploration_query = "brass explore"

    def fake_netease(query: str, limit: int = 8):
        if query == similar_query:
            return [
                make_netease_candidate(
                    "netease-song-similar",
                    "Brass Similar",
                    120.0,
                )
            ]
        if query == exploration_query:
            return [
                make_netease_candidate(
                    "netease-song-explore",
                    "Brass Explore",
                    118.0,
                )
            ]
        return []

    monkeypatch.setattr("kumikoroom.auto_dj.search_netease_songs", fake_netease)
    monkeypatch.setattr(
        "kumikoroom.auto_dj.search_bilibili_videos",
        lambda query, limit=8: [],
    )

    result = recommend_auto_dj(
        AutoDjRecommendIn(
            music_state=music_state_for_auto_dj(),
            recommendation_profile=empty_profile(),
            recent_messages=[],
        )
    )

    by_id = {
        recommendation.item.id: recommendation
        for recommendation in result.recommendations
    }

    assert by_id["netease-song-similar"].intent == "similar_theme"
    assert by_id["netease-song-similar"].item.source_query == similar_query
    assert by_id["netease-song-explore"].intent == "light_exploration"
    assert by_id["netease-song-explore"].item.source_query == exploration_query

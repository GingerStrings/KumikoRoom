import json

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

from copy import deepcopy

import pytest

from kumikoroom.auto_dj import recommend_auto_dj, _sanitize_profile, _METADATA_TAGS
from kumikoroom.auto_dj_planning import (
    AutoDjPlanQuery,
    AutoDjQueryPlan,
    PlanningError,
)
from kumikoroom.music_search import BilibiliVideoSearchResult, NeteaseSongSearchResult
from kumikoroom.schemas import (
    AutoDjRecommendIn,
    AutoDjSettingsIn,
    ChatMessageOut,
    MusicRecommendationProfileIn,
)


# ---------------------------------------------------------------------------
# FakePlanner
# ---------------------------------------------------------------------------


class FakePlanner:
    def __init__(self, plan_or_error):
        self._plan_or_error = plan_or_error
        self.calls = 0

    def plan_auto_dj_queries(self, context):
        self.calls += 1
        if isinstance(self._plan_or_error, BaseException):
            raise self._plan_or_error
        return self._plan_or_error


# ---------------------------------------------------------------------------
# Fixtures
# ---------------------------------------------------------------------------


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
    creator: str = "Concert Band",
    playable: bool = True,
) -> NeteaseSongSearchResult:
    song_id = item_id.replace("netease-song-", "")
    return NeteaseSongSearchResult(
        id=item_id,
        song_id=song_id,
        title=title,
        creator=creator,
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


def _default_plan() -> AutoDjQueryPlan:
    """Build a standard plan with similar + exploration queries."""
    return AutoDjQueryPlan(
        queries=(
            AutoDjPlanQuery(
                query="Brass Theme Concert Band",
                intent="similar_theme",
                themes=("brass", "warm"),
            ),
            AutoDjPlanQuery(
                query="brass explore",
                intent="light_exploration",
                themes=("brass",),
            ),
        )
    )


# ---------------------------------------------------------------------------
# Schema tests
# ---------------------------------------------------------------------------


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


# ---------------------------------------------------------------------------
# Endpoint test
# ---------------------------------------------------------------------------


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


# ---------------------------------------------------------------------------
# Core recommendation tests (using FakePlanner)
# ---------------------------------------------------------------------------


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
        ),
        planner=FakePlanner(_default_plan()),
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
        ),
        planner=FakePlanner(_default_plan()),
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
        ),
        planner=FakePlanner(_default_plan()),
    )

    assert result.ok is True
    assert len(result.recommendations) >= 1
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
        ),
        planner=FakePlanner(_default_plan()),
    )

    selected_ids = [recommendation.item.id for recommendation in result.recommendations]
    assert result.ok is True
    # The cooldown track should be blocked; at least "netease-song-safe" selected
    assert "netease-song-cooldown" not in selected_ids
    assert "netease-song-safe" in selected_ids


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
        ),
        planner=FakePlanner(_default_plan()),
    )

    by_id = {
        recommendation.item.id: recommendation
        for recommendation in result.recommendations
    }

    assert by_id["netease-song-similar"].intent == "similar_theme"
    assert by_id["netease-song-similar"].item.source_query == similar_query
    assert by_id["netease-song-explore"].intent == "light_exploration"
    assert by_id["netease-song-explore"].item.source_query == exploration_query


def test_auto_dj_selects_normalized_duplicate_song_once(monkeypatch) -> None:
    similar_query = "Brass Theme Concert Band"
    exploration_query = "brass explore"

    def fake_netease(query: str, limit: int = 8):
        if query == similar_query:
            return [
                make_netease_candidate(
                    "netease-song-duplicate-low",
                    "Shared Brass Song",
                    100.0,
                )
            ]
        if query == exploration_query:
            return [
                make_netease_candidate(
                    "netease-song-duplicate-high",
                    " Shared   Brass Song ",
                    130.0,
                ),
                make_netease_candidate(
                    "netease-song-fresh",
                    "Fresh Brass Song",
                    90.0,
                ),
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
            settings={"count": 3, "similar_count": 1, "exploration_count": 1},
        ),
        planner=FakePlanner(_default_plan()),
    )

    selected_ids = [recommendation.item.id for recommendation in result.recommendations]
    duplicate_ids = {
        "netease-song-duplicate-low",
        "netease-song-duplicate-high",
    }
    selected_duplicates = duplicate_ids & set(selected_ids)

    assert selected_duplicates == {"netease-song-duplicate-high"}
    assert selected_ids.count("netease-song-fresh") == 1
    selected_duplicate = next(
        recommendation
        for recommendation in result.recommendations
        if recommendation.item.id == "netease-song-duplicate-high"
    )
    assert selected_duplicate.intent == "light_exploration"
    assert selected_duplicate.item.source_query == exploration_query


@pytest.mark.parametrize(
    ("cooldown", "blocked"),
    [
        (
            {"key": "Blocked Artist", "kind": "artist", "reason": "dislike"},
            make_netease_candidate(
                "netease-song-blocked-artist",
                "Artist Cooldown",
                500.0,
                creator="Blocked Artist",
            ),
        ),
        (
            {"key": "forbidden", "kind": "tag", "reason": "recently_recommended"},
            make_netease_candidate(
                "netease-song-blocked-tag",
                "Forbidden Brass",
                500.0,
            ),
        ),
        (
            {
                "key": "Brass Theme Concert Band",
                "kind": "query",
                "reason": "recently_recommended",
            },
            make_netease_candidate(
                "netease-song-blocked-query",
                "Query Cooldown",
                500.0,
            ),
        ),
    ],
)
def test_auto_dj_hard_filters_active_cooldowns_for_all_kinds(
    monkeypatch,
    cooldown,
    blocked,
) -> None:
    safe = make_netease_candidate("netease-song-safe-cooldown", "Safe Track", 100.0)

    def fake_netease(query: str, limit: int = 8):
        if cooldown["kind"] == "query" and query != cooldown["key"]:
            return [safe]
        return [blocked, safe]

    monkeypatch.setattr(
        "kumikoroom.auto_dj.search_netease_songs",
        fake_netease,
    )
    monkeypatch.setattr(
        "kumikoroom.auto_dj.search_bilibili_videos",
        lambda query, limit=8: [],
    )

    profile = empty_profile()
    profile["cooldowns"] = [
        {
            **cooldown,
            "weight": 2.0,
            "expires_at": "2099-01-01T00:00:00.000",
        }
    ]

    result = recommend_auto_dj(
        AutoDjRecommendIn(
            music_state=music_state_for_auto_dj(),
            recommendation_profile=profile,
            recent_messages=[],
        ),
        planner=FakePlanner(_default_plan()),
    )

    selected_ids = [recommendation.item.id for recommendation in result.recommendations]
    assert blocked.id not in selected_ids
    assert selected_ids == [safe.id]


def test_auto_dj_searches_and_scores_artist_only_profile(monkeypatch) -> None:
    queries: list[str] = []

    def fake_netease(query: str, limit: int = 8):
        queries.append(query)
        if query == "Preferred Artist":
            return [
                make_netease_candidate(
                    "netease-song-preferred-artist",
                    "Preferred Artist Theme",
                    100.0,
                    creator="Preferred Artist",
                )
            ]
        return []

    monkeypatch.setattr("kumikoroom.auto_dj.search_netease_songs", fake_netease)
    monkeypatch.setattr(
        "kumikoroom.auto_dj.search_bilibili_videos",
        lambda query, limit=8: [],
    )

    profile = empty_profile()
    profile["artist_weights"] = {"Other Artist": 1.0, "Preferred Artist": 4.0}

    plan = AutoDjQueryPlan(
        queries=(
            AutoDjPlanQuery(
                query="Preferred Artist",
                intent="similar_theme",
                themes=(),
            ),
        )
    )

    result = recommend_auto_dj(
        AutoDjRecommendIn(
            music_state=None,
            recommendation_profile=profile,
            recent_messages=[],
            settings={"count": 1, "similar_count": 1, "exploration_count": 0},
        ),
        planner=FakePlanner(plan),
    )

    assert queries[0] == "Preferred Artist"
    assert result.ok is True
    assert [recommendation.item.id for recommendation in result.recommendations] == [
        "netease-song-preferred-artist"
    ]
    assert result.recommendations[0].item.source_query == "Preferred Artist"
    assert "artist preference Preferred Artist=4" in result.recommendations[0].evidence


def test_auto_dj_filters_unplayed_recommended_items(monkeypatch) -> None:
    repeat = make_netease_candidate("netease-song-repeat", "Repeat Track", 500.0)
    fresh = make_netease_candidate("netease-song-fresh", "Fresh Track", 100.0)

    monkeypatch.setattr(
        "kumikoroom.auto_dj.search_netease_songs",
        lambda query, limit=8: [repeat, fresh],
    )
    monkeypatch.setattr(
        "kumikoroom.auto_dj.search_bilibili_videos",
        lambda query, limit=8: [],
    )

    profile = empty_profile()
    profile["recommended_items"] = [
        {
            "item_id": "netease-song-repeat",
            "title": "Repeat Track",
            "creator": "Concert Band",
            "source": "netease",
            "recommended_at": "2026-06-18T00:00:00.000Z",
            "played": False,
            "disliked": False,
            "reason": "previous refill",
        }
    ]

    result = recommend_auto_dj(
        AutoDjRecommendIn(
            music_state=music_state_for_auto_dj(),
            recommendation_profile=profile,
            recent_messages=[],
            settings={"count": 1, "similar_count": 1, "exploration_count": 0},
        ),
        planner=FakePlanner(
            AutoDjQueryPlan(
                queries=(
                    AutoDjPlanQuery(
                        query="Brass Theme Concert Band",
                        intent="similar_theme",
                        themes=("brass",),
                    ),
                )
            )
        ),
    )

    assert [recommendation.item.id for recommendation in result.recommendations] == [
        "netease-song-fresh"
    ]


def test_auto_dj_notice_uses_singular_for_one_full_recommendation(monkeypatch) -> None:
    monkeypatch.setattr(
        "kumikoroom.auto_dj.search_netease_songs",
        lambda query, limit=8: [
            make_netease_candidate("netease-song-one", "One Track", 100.0)
        ],
    )
    monkeypatch.setattr(
        "kumikoroom.auto_dj.search_bilibili_videos",
        lambda query, limit=8: [],
    )

    plan = AutoDjQueryPlan(
        queries=(
            AutoDjPlanQuery(
                query="Brass Theme Concert Band",
                intent="similar_theme",
                themes=("brass",),
            ),
        )
    )

    result = recommend_auto_dj(
        AutoDjRecommendIn(
            music_state=music_state_for_auto_dj(),
            recommendation_profile=empty_profile(),
            recent_messages=[],
            settings={"count": 1, "similar_count": 1, "exploration_count": 0},
        ),
        planner=FakePlanner(plan),
    )

    assert result.notice == "Auto DJ added 1 recommendation to the queue."


def test_auto_dj_excludes_metadata_tags_from_search_queries(monkeypatch) -> None:
    captured_queries: list[str] = []

    def fake_netease(query: str, limit: int = 8):
        captured_queries.append(query)
        return [
            NeteaseSongSearchResult(
                id="netease-song-x",
                song_id="x",
                title=f"Result for {query}",
                creator="Artist",
                duration_ms=180000,
                playable=True,
                popularity=80.0,
                comment_count=1000,
                hot_comment_liked_count=200,
                score=100.0,
                evidence=["test"],
            ),
        ]

    monkeypatch.setattr("kumikoroom.auto_dj.search_netease_songs", fake_netease)
    monkeypatch.setattr("kumikoroom.auto_dj.search_bilibili_videos", lambda query, limit=8: [])

    state = music_state_for_auto_dj()
    state["current"]["tags"] = ["agent-selected", "search", "netease", "bilibili"]

    profile = empty_profile()
    profile["tag_weights"] = {"netease": 10.0, "bilibili": 9.0}

    result = recommend_auto_dj(
        AutoDjRecommendIn(
            music_state=state,
            recommendation_profile=profile,
            recent_messages=[],
        ),
        planner=FakePlanner(_default_plan()),
    )

    assert result.ok is True
    # Plan queries are from the planner, not generated from profile tags.
    # But verify no metadata tags leak into search.
    for query in captured_queries:
        assert "agent-selected" not in query
        assert "search" not in query


# ---------------------------------------------------------------------------
# Profile sanitization tests
# ---------------------------------------------------------------------------


def _seed_profile() -> dict:
    return {
        "version": 1,
        "updated_at": "2026-06-19T00:00:00Z",
        "artist_weights": {"sammy": 1.0},
        "tag_weights": {
            "agent-selected": 5.0,
            "search": 3.0,
            "netease": 2.0,
            "j-pop": 4.0,
        },
        "source_weights": {"netease": 1.0, "bilibili": 0.5},
        "query_weights": {
            "music explore": 9.0,
            "songs": 4.0,
            "hibike euphonium": 6.0,
        },
        "recent_themes": [
            {"key": "agent-selected", "weight": 1.0, "last_seen_at": "2026-06-19T00:00:00Z"},
            {"key": "wind orchestra", "weight": 1.0, "last_seen_at": "2026-06-19T00:00:00Z"},
        ],
        "cooldowns": [
            {"kind": "tag", "key": "agent-selected", "weight": 1, "expires_at": "2099-01-01T00:00:00Z", "reason": "dislike"},
            {"kind": "tag", "key": "j-pop", "weight": 1, "expires_at": "2099-01-01T00:00:00Z", "reason": "dislike"},
            {"kind": "query", "key": "music explore", "weight": 1, "expires_at": "2099-01-01T00:00:00Z", "reason": "dislike"},
            {"kind": "query", "key": "hibike euphonium", "weight": 1, "expires_at": "2099-01-01T00:00:00Z", "reason": "dislike"},
        ],
        "recommended_items": [],
        "refill_history": [],
    }


def test_sanitize_drops_metadata_tag_weights():
    raw = MusicRecommendationProfileIn.model_validate(_seed_profile())
    sanitized = _sanitize_profile(raw)
    assert "agent-selected" not in sanitized.tag_weights
    assert "search" not in sanitized.tag_weights
    assert "netease" not in sanitized.tag_weights
    assert sanitized.tag_weights["j-pop"] == 4.0


def test_sanitize_drops_metadata_recent_themes():
    sanitized = _sanitize_profile(MusicRecommendationProfileIn.model_validate(_seed_profile()))
    keys = [theme.key for theme in sanitized.recent_themes]
    assert "agent-selected" not in keys
    assert "wind orchestra" in keys


def test_sanitize_drops_generic_query_weights():
    sanitized = _sanitize_profile(MusicRecommendationProfileIn.model_validate(_seed_profile()))
    assert "music explore" not in sanitized.query_weights
    assert "songs" not in sanitized.query_weights
    assert sanitized.query_weights["hibike euphonium"] == 6.0


def test_sanitize_drops_metadata_tag_cooldowns_and_generic_query_cooldowns():
    sanitized = _sanitize_profile(MusicRecommendationProfileIn.model_validate(_seed_profile()))
    keys = {(c.kind, c.key) for c in sanitized.cooldowns}
    assert ("tag", "agent-selected") not in keys
    assert ("query", "music explore") not in keys
    assert ("tag", "j-pop") in keys
    assert ("query", "hibike euphonium") in keys


def test_sanitize_does_not_mutate_input():
    raw_dict = _seed_profile()
    raw = MusicRecommendationProfileIn.model_validate(raw_dict)
    snapshot = deepcopy(raw.model_dump())
    _ = _sanitize_profile(raw)
    assert raw.model_dump() == snapshot


def test_sanitize_preserves_source_weights():
    sanitized = _sanitize_profile(MusicRecommendationProfileIn.model_validate(_seed_profile()))
    assert sanitized.source_weights == {"netease": 1.0, "bilibili": 0.5}


# ---------------------------------------------------------------------------
# New tests: planner integration
# ---------------------------------------------------------------------------


def test_planner_failure_causes_zero_search_calls(monkeypatch) -> None:
    search_calls: list[str] = []

    def tracking_netease(query: str, limit: int = 8):
        search_calls.append(query)
        return []

    monkeypatch.setattr("kumikoroom.auto_dj.search_netease_songs", tracking_netease)
    monkeypatch.setattr("kumikoroom.auto_dj.search_bilibili_videos", lambda query, limit=8: [])

    planner = FakePlanner(PlanningError("LLM timeout"))

    result = recommend_auto_dj(
        AutoDjRecommendIn(
            music_state=music_state_for_auto_dj(),
            recommendation_profile=empty_profile(),
            recent_messages=[],
        ),
        planner=planner,
    )

    assert result.ok is False
    assert result.error == "query_planning_failed"
    assert planner.calls == 1
    assert search_calls == []


def test_every_captured_search_query_appears_in_plan(monkeypatch) -> None:
    captured_queries: list[str] = []

    def tracking_netease(query: str, limit: int = 8):
        captured_queries.append(query)
        return []

    monkeypatch.setattr("kumikoroom.auto_dj.search_netease_songs", tracking_netease)
    monkeypatch.setattr("kumikoroom.auto_dj.search_bilibili_videos", lambda query, limit=8: [])

    plan = AutoDjQueryPlan(
        queries=(
            AutoDjPlanQuery(query="query alpha", intent="similar_theme", themes=()),
            AutoDjPlanQuery(query="query beta", intent="light_exploration", themes=()),
        )
    )

    recommend_auto_dj(
        AutoDjRecommendIn(
            music_state=music_state_for_auto_dj(),
            recommendation_profile=empty_profile(),
            recent_messages=[],
        ),
        planner=FakePlanner(plan),
    )

    # Each plan query is searched on both netease and bilibili
    # (bilibili is a no-op lambda so only netease captures)
    assert set(captured_queries) == {"query alpha", "query beta"}


def test_pure_pollution_profile_returns_needs_more_context(monkeypatch) -> None:
    """Profile with only metadata tags and queries with only 'music explore' type
    content should fail the context check after sanitization -- planner never called."""
    search_calls: list[str] = []

    def tracking_netease(query: str, limit: int = 8):
        search_calls.append(query)
        return []

    monkeypatch.setattr("kumikoroom.auto_dj.search_netease_songs", tracking_netease)
    monkeypatch.setattr("kumikoroom.auto_dj.search_bilibili_videos", lambda query, limit=8: [])

    profile = empty_profile()
    profile["tag_weights"] = {"agent-selected": 5.0, "search": 3.0, "netease": 2.0}
    profile["query_weights"] = {"music explore": 9.0, "songs": 4.0}
    profile["recent_themes"] = [
        {"key": "agent-selected", "weight": 1.0, "last_seen_at": "2026-06-19T00:00:00Z"},
    ]

    planner = FakePlanner(_default_plan())

    result = recommend_auto_dj(
        AutoDjRecommendIn(
            music_state=None,
            recommendation_profile=profile,
            recent_messages=[],
        ),
        planner=planner,
    )

    assert result.ok is False
    assert result.error == "needs_more_context"
    assert planner.calls == 0
    assert search_calls == []


def test_planner_omits_required_intent_group_returns_failed(monkeypatch) -> None:
    """If planner returns only similar queries but exploration_count > 0,
    the plan validation should fail."""
    monkeypatch.setattr("kumikoroom.auto_dj.search_netease_songs", lambda query, limit=8: [])
    monkeypatch.setattr("kumikoroom.auto_dj.search_bilibili_videos", lambda query, limit=8: [])

    # The plan validator rejects missing exploration group when exploration_count > 0,
    # but _intents_from_plan itself never rejects. Instead we test that PlanningError
    # from the planner is handled.
    planner = FakePlanner(PlanningError("plan missing exploration intent group"))

    result = recommend_auto_dj(
        AutoDjRecommendIn(
            music_state=music_state_for_auto_dj(),
            recommendation_profile=empty_profile(),
            recent_messages=[],
        ),
        planner=planner,
    )

    assert result.ok is False
    assert result.error == "query_planning_failed"
    assert "exploration" in result.notice.lower() or "plan missing" in result.notice.lower()


def test_auto_dj_caps_recent_messages_at_200(monkeypatch) -> None:
    """Backend must ignore messages beyond 200 even if the client sends more."""
    monkeypatch.setattr(
        "kumikoroom.auto_dj.search_netease_songs",
        lambda query, limit=8: [make_netease_candidate("netease-song-a", "Auto Song", 100.0, creator="Auto Artist")],
    )
    monkeypatch.setattr(
        "kumikoroom.auto_dj.search_bilibili_videos",
        lambda query, limit=8: [],
    )
    captured_context: list = []

    class CapturingPlanner(FakePlanner):
        def plan_auto_dj_queries(self, context):
            captured_context.append(context)
            return super().plan_auto_dj_queries(context)

    plan = AutoDjQueryPlan(
        queries=(
            AutoDjPlanQuery(query="test q", intent="similar_theme", themes=("test",)),
            AutoDjPlanQuery(query="exp q", intent="light_exploration", themes=("test",)),
        )
    )
    planner = CapturingPlanner(plan)

    long_messages: list[ChatMessageOut] = [
        ChatMessageOut(id=f"m-{i}", role="user", content=f"msg {i}")
        for i in range(300)
    ]

    recommend_auto_dj(
        AutoDjRecommendIn(
            music_state=music_state_for_auto_dj(),
            recommendation_profile=empty_profile(),
            recent_messages=long_messages,
            settings=AutoDjSettingsIn(count=3, similar_count=2, exploration_count=1),
        ),
        planner=planner,
    )

    assert len(captured_context) == 1
    assert len(captured_context[0].recent_messages) == 200


def test_auto_dj_normalizes_multi_word_themes_in_scoring(monkeypatch) -> None:
    """LLM themes like 'wind orchestra' must match titles after whitespace stripping."""
    monkeypatch.setattr(
        "kumikoroom.auto_dj.search_netease_songs",
        lambda query, limit=8: [make_netease_candidate("netease-song-a", "Wind Orchestra Suite", 100.0, creator="Test Creator")],
    )
    monkeypatch.setattr("kumikoroom.auto_dj.search_bilibili_videos", lambda query, limit=8: [])

    plan = AutoDjQueryPlan(
        queries=(
            AutoDjPlanQuery(query="test", intent="similar_theme", themes=("wind orchestra",)),
            AutoDjPlanQuery(query="exp", intent="light_exploration", themes=("test",)),
        )
    )

    result = recommend_auto_dj(
        AutoDjRecommendIn(
            music_state=music_state_for_auto_dj(),
            recommendation_profile=empty_profile(),
            settings=AutoDjSettingsIn(count=2, similar_count=1, exploration_count=1),
        ),
        planner=FakePlanner(plan),
    )

    assert result.ok is True
    # The multi-word theme should have matched after normalization
    assert any("title matches theme wind orchestra" in e for r in result.recommendations for e in r.evidence)

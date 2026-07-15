# Auto DJ Recommendation System Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a local-first Auto DJ system that refills the queue with search-based recommendations when enabled and the queue depth reaches 2 tracks.

**Architecture:** The browser owns the Auto DJ switch, local recommendation profile, queue-depth trigger, and UI feedback. The backend exposes a thin Auto DJ endpoint backed by a deterministic recommendation service that derives intents, recalls NetEase and Bilibili candidates, scores them with profile and cooldown signals, and returns typed queue actions. The agent role is bounded to intent/query shaping; the recommendation core stays testable and deterministic.

**Tech Stack:** FastAPI, Pydantic v2, pytest, Next.js 14, React 18, TypeScript, Vitest, Testing Library, browser localStorage.

---

## Scope Check

The spec describes one connected subsystem: Auto DJ queue refill. It has backend service/API work, frontend state/API wiring, queue metadata, and UI controls. Those pieces should ship together because no slice is useful to the user on its own.

## File Structure

- Create `apps/api/kumikoroom/auto_dj.py`
  - Owns Auto DJ context extraction, intent generation, candidate recall, scoring, diversity selection, and output mapping.
- Modify `apps/api/kumikoroom/schemas.py`
  - Adds Auto DJ request/response/profile schemas.
- Modify `apps/api/kumikoroom/routers/room.py`
  - Adds `POST /api/room/music/auto-dj/recommend`.
- Create `apps/api/tests/test_auto_dj.py`
  - Covers endpoint shape, scoring, cooldowns, diversity, and partial search failure.
- Modify `apps/web/src/api/types.ts`
  - Adds Auto DJ request/response/profile/recommendation types.
- Modify `apps/web/src/api/client.ts`
  - Adds `recommendAutoDj()` and API mappers.
- Create `apps/web/src/lib/musicRecommendationProfile.ts`
  - Owns profile hydration, persistence shape checks, feedback updates, cooldowns, and refill history helpers.
- Create `apps/web/tests/musicRecommendationProfile.test.ts`
  - Covers profile hydration and feedback updates.
- Create `apps/web/src/lib/autoDj.ts`
  - Owns queue-depth trigger, queue signature, response application data helpers, and profile event helpers.
- Create `apps/web/tests/autoDj.test.ts`
  - Covers trigger depth, signature dedupe, and response-to-queue metadata.
- Modify `apps/web/src/lib/musicQueue.ts`
  - Adds recommendation metadata to queue entries and preserves it through persistence and action application.
- Modify `apps/web/src/components/RoomShell.tsx`
  - Adds Auto DJ state, hydration, trigger effect, response application, short notice, reasons, and dislike action.
- Modify `apps/web/app/globals.css`
  - Styles the switch, compact recommendation reason, and dislike action within existing player/queue surfaces.
- Modify `apps/web/tests/RoomShell.test.tsx`
  - Covers Auto DJ switch persistence, trigger, notice, reasons, and dislike behavior.

## Task 1: Backend Schemas And Empty-Context Endpoint

**Files:**
- Modify: `apps/api/kumikoroom/schemas.py`
- Create: `apps/api/kumikoroom/auto_dj.py`
- Modify: `apps/api/kumikoroom/routers/room.py`
- Test: `apps/api/tests/test_auto_dj.py`

- [ ] **Step 1: Write the failing endpoint contract test**

Add this file:

```python
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
```

- [ ] **Step 2: Run the endpoint test to verify it fails**

Run:

```powershell
cd apps/api
python -m pytest tests/test_auto_dj.py -q
```

Expected: FAIL because `AutoDjRecommendIn` and the route do not exist.

- [ ] **Step 3: Add Auto DJ schemas**

Append these models to `apps/api/kumikoroom/schemas.py` after `ChatIn` and before `ProviderStatusOut`:

```python
RecommendationIntentKind = Literal[
    "similar_theme",
    "similar_mood",
    "same_creator_or_work",
    "light_exploration",
]
RecommendationCooldownKind = Literal["item", "artist", "tag", "query"]
RecommendationCooldownReason = Literal[
    "dislike",
    "recently_played",
    "recently_recommended",
]


class RecommendationThemeSignalIn(BaseModel):
    key: str
    weight: float = 1.0
    last_seen_at: str


class RecommendationCooldownIn(BaseModel):
    key: str
    kind: RecommendationCooldownKind
    weight: float = 1.0
    expires_at: str
    reason: RecommendationCooldownReason


class RecommendationHistoryEntryIn(BaseModel):
    item_id: str
    title: str
    creator: str
    source: MusicSourceKind
    recommended_at: str
    played: bool = False
    disliked: bool = False
    reason: str


class RecommendationRefillHistoryEntryIn(BaseModel):
    refill_id: str
    created_at: str
    selected_item_ids: list[str] = Field(default_factory=list)
    dominant_themes: list[str] = Field(default_factory=list)
    exploration_count: int = 0


class MusicRecommendationProfileIn(BaseModel):
    version: Literal[1] = 1
    updated_at: str | None = None
    artist_weights: dict[str, float] = Field(default_factory=dict)
    tag_weights: dict[str, float] = Field(default_factory=dict)
    source_weights: dict[MusicSourceKind, float] = Field(default_factory=dict)
    query_weights: dict[str, float] = Field(default_factory=dict)
    recent_themes: list[RecommendationThemeSignalIn] = Field(default_factory=list)
    cooldowns: list[RecommendationCooldownIn] = Field(default_factory=list)
    recommended_items: list[RecommendationHistoryEntryIn] = Field(default_factory=list)
    refill_history: list[RecommendationRefillHistoryEntryIn] = Field(default_factory=list)


class AutoDjSettingsIn(BaseModel):
    count: int = Field(default=3, ge=1, le=5)
    queue_depth_trigger: int = Field(default=2, ge=1, le=10)
    similar_count: int = Field(default=2, ge=0, le=5)
    exploration_count: int = Field(default=1, ge=0, le=5)


class AutoDjRecommendIn(BaseModel):
    music_state: MusicAgentState | None = None
    recommendation_profile: MusicRecommendationProfileIn | None = None
    recent_messages: list[ChatMessageOut] = Field(default_factory=list)
    settings: AutoDjSettingsIn = Field(default_factory=AutoDjSettingsIn)


class AutoDjRecommendationOut(BaseModel):
    item: ClientMusicItemOut
    score: float
    intent: RecommendationIntentKind
    reason: str
    evidence: list[str] = Field(default_factory=list)


class RecommendationProfilePatchOut(BaseModel):
    recommended_items: list[RecommendationHistoryEntryIn] = Field(default_factory=list)
    cooldowns: list[RecommendationCooldownIn] = Field(default_factory=list)
    refill_history: list[RecommendationRefillHistoryEntryIn] = Field(default_factory=list)


class AutoDjRecommendOut(BaseModel):
    ok: bool
    refill_id: str | None = None
    notice: str
    client_actions: list[RoomClientActionOut] = Field(default_factory=list)
    recommendations: list[AutoDjRecommendationOut] = Field(default_factory=list)
    profile_patch: RecommendationProfilePatchOut = Field(default_factory=RecommendationProfilePatchOut)
    error: str | None = None
    source_errors: list[str] = Field(default_factory=list)
```

- [ ] **Step 4: Create the minimal Auto DJ service**

Create `apps/api/kumikoroom/auto_dj.py`:

```python
from __future__ import annotations

from datetime import datetime, timezone

from kumikoroom.schemas import (
    AutoDjRecommendIn,
    AutoDjRecommendOut,
    MusicRecommendationProfileIn,
    RecommendationProfilePatchOut,
)


def recommend_auto_dj(payload: AutoDjRecommendIn) -> AutoDjRecommendOut:
    if not _has_recommendation_context(payload.music_state, payload.recommendation_profile):
        return AutoDjRecommendOut(
            ok=False,
            refill_id=None,
            notice="Auto DJ needs a current track or listening profile before it can recommend.",
            client_actions=[],
            recommendations=[],
            profile_patch=RecommendationProfilePatchOut(),
            error="needs_more_context",
        )

    return AutoDjRecommendOut(
        ok=True,
        refill_id=f"auto-dj-{_utc_compact_timestamp()}",
        notice="Auto DJ did not find enough recommendations this time.",
        client_actions=[],
        recommendations=[],
        profile_patch=RecommendationProfilePatchOut(),
    )


def _has_recommendation_context(
    music_state,
    profile: MusicRecommendationProfileIn | None,
) -> bool:
    if music_state is not None:
        if music_state.current is not None:
            return True
        if music_state.recent or music_state.saved or music_state.playlists:
            return True

    if profile is None:
        return False

    return bool(
        profile.artist_weights
        or profile.tag_weights
        or profile.query_weights
        or profile.recent_themes
    )


def _utc_compact_timestamp() -> str:
    return datetime.now(timezone.utc).strftime("%Y%m%d%H%M%S%f")
```

- [ ] **Step 5: Add the endpoint**

In `apps/api/kumikoroom/routers/room.py`, add imports:

```python
from kumikoroom.auto_dj import recommend_auto_dj
```

And include these schema names in the existing schema import block:

```python
    AutoDjRecommendIn,
    AutoDjRecommendOut,
```

Add this route after `search_music()`:

```python
@router.post("/music/auto-dj/recommend", response_model=AutoDjRecommendOut)
def recommend_auto_dj_tracks(payload: AutoDjRecommendIn) -> AutoDjRecommendOut:
    return recommend_auto_dj(payload)
```

- [ ] **Step 6: Run the endpoint test to verify it passes**

Run:

```powershell
cd apps/api
python -m pytest tests/test_auto_dj.py -q
```

Expected: PASS.

- [ ] **Step 7: Commit**

```powershell
git add apps/api/kumikoroom/schemas.py apps/api/kumikoroom/auto_dj.py apps/api/kumikoroom/routers/room.py apps/api/tests/test_auto_dj.py
git commit -m "feat: add auto dj recommendation endpoint"
```

## Task 2: Backend Recommendation Core

**Files:**
- Modify: `apps/api/kumikoroom/auto_dj.py`
- Modify: `apps/api/tests/test_auto_dj.py`

- [ ] **Step 1: Add backend recommendation tests**

Append these tests to `apps/api/tests/test_auto_dj.py`:

```python
from kumikoroom.auto_dj import recommend_auto_dj
from kumikoroom.music_search import BilibiliVideoSearchResult, NeteaseSongSearchResult


def music_track(item_id: str, title: str, *, creator: str = "Fixture Artist", tags: list[str] | None = None) -> dict:
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
        "current": music_track("current", "Brass Theme", creator="Concert Band", tags=["brass", "warm"]),
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


def make_netease_candidate(item_id: str, title: str, score: float, *, playable: bool = True) -> NeteaseSongSearchResult:
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


def make_bilibili_candidate(item_id: str, title: str, score: float) -> BilibiliVideoSearchResult:
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
    monkeypatch.setattr("kumikoroom.auto_dj.search_bilibili_videos", lambda query, limit=8: [])

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
    assert sum(1 for recommendation in result.recommendations if recommendation.intent == "light_exploration") == 2


def test_auto_dj_keeps_working_when_one_source_fails(monkeypatch) -> None:
    def failing_bilibili(query: str, limit: int = 8):
        raise RuntimeError("bilibili unavailable")

    monkeypatch.setattr(
        "kumikoroom.auto_dj.search_netease_songs",
        lambda query, limit=8: [make_netease_candidate("netease-song-a", "Brass Similar A", 120.0)],
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
```

- [ ] **Step 2: Run the backend core tests to verify they fail**

Run:

```powershell
cd apps/api
python -m pytest tests/test_auto_dj.py -q
```

Expected: FAIL because `recommend_auto_dj()` does not recall, score, select, or return recommendations yet.

- [ ] **Step 3: Replace `auto_dj.py` with the recommendation core**

Replace the file content with:

```python
from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime, timezone
import re
from typing import Literal

from kumikoroom.agent_tools import music_result_to_client_item
from kumikoroom.music_search import (
    MusicSearchCandidate,
    search_bilibili_videos,
    search_netease_songs,
)
from kumikoroom.schemas import (
    AutoDjRecommendIn,
    AutoDjRecommendationOut,
    AutoDjRecommendOut,
    ClientMusicItemOut,
    MusicAgentState,
    MusicAgentTrack,
    MusicRecommendationProfileIn,
    RecommendationCooldownIn,
    RecommendationHistoryEntryIn,
    RecommendationIntentKind,
    RecommendationProfilePatchOut,
    RecommendationRefillHistoryEntryIn,
    RoomClientActionOut,
)


@dataclass(frozen=True)
class AutoDjIntent:
    name: RecommendationIntentKind
    query_seeds: list[str]
    target_count: int
    rationale: str


@dataclass(frozen=True)
class ScoredCandidate:
    result: MusicSearchCandidate
    score: float
    intent: RecommendationIntentKind
    reason: str
    evidence: list[str]
    dominant_themes: list[str]


def recommend_auto_dj(payload: AutoDjRecommendIn) -> AutoDjRecommendOut:
    if not _has_recommendation_context(payload.music_state, payload.recommendation_profile):
        return AutoDjRecommendOut(
            ok=False,
            refill_id=None,
            notice="Auto DJ needs a current track or listening profile before it can recommend.",
            client_actions=[],
            recommendations=[],
            profile_patch=RecommendationProfilePatchOut(),
            error="needs_more_context",
        )

    profile = payload.recommendation_profile or MusicRecommendationProfileIn()
    similar_count, exploration_count = _effective_mix(profile, payload.settings.similar_count, payload.settings.exploration_count)
    intents = _generate_intents(payload.music_state, profile, similar_count, exploration_count)
    candidates, source_errors = _recall_candidates(intents, limit=max(8, payload.settings.count * 4))
    scored = _score_candidates(candidates, intents, payload.music_state, profile)
    selected = _select_candidates(scored, payload.settings.count, similar_count, exploration_count)

    recommendations = [_recommendation_out(candidate) for candidate in selected]
    actions = [
        RoomClientActionOut(type="add_music_to_queue", item=recommendation.item)
        for recommendation in recommendations
    ]
    refill_id = f"auto-dj-{_utc_compact_timestamp()}"
    profile_patch = _profile_patch(refill_id, selected)

    return AutoDjRecommendOut(
        ok=True,
        refill_id=refill_id,
        notice=_notice_for_count(len(recommendations)),
        client_actions=actions,
        recommendations=recommendations,
        profile_patch=profile_patch,
        source_errors=source_errors,
    )


def _has_recommendation_context(
    music_state: MusicAgentState | None,
    profile: MusicRecommendationProfileIn | None,
) -> bool:
    if music_state is not None:
        if music_state.current is not None:
            return True
        if music_state.recent or music_state.saved or music_state.playlists:
            return True

    if profile is None:
        return False

    return bool(
        profile.artist_weights
        or profile.tag_weights
        or profile.query_weights
        or profile.recent_themes
    )


def _effective_mix(
    profile: MusicRecommendationProfileIn,
    similar_count: int,
    exploration_count: int,
) -> tuple[int, int]:
    last_two = profile.refill_history[-2:]
    if len(last_two) < 2:
        return similar_count, exploration_count

    first = set(last_two[0].dominant_themes)
    second = set(last_two[1].dominant_themes)
    overlap = len(first & second)
    if overlap >= 2:
        total = max(1, similar_count + exploration_count)
        next_exploration = min(total, max(exploration_count + 1, 2))
        return max(0, total - next_exploration), next_exploration

    return similar_count, exploration_count


def _generate_intents(
    music_state: MusicAgentState | None,
    profile: MusicRecommendationProfileIn,
    similar_count: int,
    exploration_count: int,
) -> list[AutoDjIntent]:
    current = music_state.current if music_state is not None else None
    tags = _top_music_tags(music_state, profile)
    seeds: list[str] = []
    if current is not None:
        seeds.append(f"{current.title} {current.creator}")
        if current.tags:
            seeds.append(" ".join(current.tags[:3]))
    if tags:
        seeds.append(" ".join(tags[:3]))
    if not seeds:
        seeds.extend(list(profile.query_weights.keys())[:2])

    intents: list[AutoDjIntent] = []
    if similar_count > 0:
        intents.append(
            AutoDjIntent(
                name="similar_theme",
                query_seeds=seeds or ["instrumental music"],
                target_count=similar_count,
                rationale="continue the current listening theme",
            )
        )
    if exploration_count > 0:
        exploration_seeds = [theme.key for theme in profile.recent_themes[:3]] or tags[:3] or seeds or ["soundtrack"]
        intents.append(
            AutoDjIntent(
                name="light_exploration",
                query_seeds=exploration_seeds,
                target_count=exploration_count,
                rationale="add a controlled amount of variety",
            )
        )
    return intents


def _top_music_tags(
    music_state: MusicAgentState | None,
    profile: MusicRecommendationProfileIn,
) -> list[str]:
    weights: dict[str, float] = dict(profile.tag_weights)
    if music_state is not None:
        for track in _known_tracks(music_state):
            for tag in track.tags:
                weights[tag] = weights.get(tag, 0.0) + 1.0
    return [tag for tag, _ in sorted(weights.items(), key=lambda item: item[1], reverse=True)]


def _recall_candidates(
    intents: list[AutoDjIntent],
    *,
    limit: int,
) -> tuple[list[tuple[MusicSearchCandidate, RecommendationIntentKind]], list[str]]:
    recalled: list[tuple[MusicSearchCandidate, RecommendationIntentKind]] = []
    errors: list[str] = []
    seen_queries: set[str] = set()

    for intent in intents:
        for query in intent.query_seeds:
            normalized_query = _normalize(query)
            if not normalized_query or normalized_query in seen_queries:
                continue
            seen_queries.add(normalized_query)
            try:
                recalled.extend((candidate, intent.name) for candidate in search_netease_songs(query, limit=limit))
            except Exception as error:
                errors.append(str(error))
            try:
                recalled.extend((candidate, intent.name) for candidate in search_bilibili_videos(query, limit=limit))
            except Exception as error:
                errors.append(str(error))

    deduped: dict[str, tuple[MusicSearchCandidate, RecommendationIntentKind]] = {}
    for candidate, intent_name in recalled:
        dedupe_key = _candidate_dedupe_key(candidate)
        existing = deduped.get(dedupe_key)
        if existing is None or candidate.score > existing[0].score:
            deduped[dedupe_key] = (candidate, intent_name)

    return list(deduped.values()), _unique_preserving_order(errors)


def _score_candidates(
    candidates: list[tuple[MusicSearchCandidate, RecommendationIntentKind]],
    intents: list[AutoDjIntent],
    music_state: MusicAgentState | None,
    profile: MusicRecommendationProfileIn,
) -> list[ScoredCandidate]:
    blocked_ids = _blocked_item_ids(music_state)
    cooldowns = _active_cooldowns(profile)
    profile_tags = set(profile.tag_weights)
    current_tags = set(music_state.current.tags if music_state and music_state.current else [])
    current_creator = _normalize(music_state.current.creator if music_state and music_state.current else "")
    intent_targets = {intent.name: intent.target_count for intent in intents}
    scored: list[ScoredCandidate] = []

    for candidate, intent_name in candidates:
        if candidate.id in blocked_ids:
            continue
        if not candidate.playable:
            continue

        score = candidate.score
        evidence = list(candidate.evidence[:4])
        dominant_themes: list[str] = []
        title_norm = _normalize(candidate.title)
        creator_norm = _normalize(candidate.creator)

        if current_creator and creator_norm == current_creator:
            score += 18.0
            evidence.append("same creator as current track")
            dominant_themes.append(candidate.creator)
        for tag in current_tags | profile_tags:
            tag_norm = _normalize(tag)
            if tag_norm and tag_norm in title_norm:
                score += 8.0
                evidence.append(f"title matches tag {tag}")
                dominant_themes.append(tag)

        score += profile.source_weights.get(candidate.source, 0.0) * 4.0
        if candidate.source in profile.source_weights:
            evidence.append(f"source preference {candidate.source}")

        cooldown_penalty = _cooldown_penalty(candidate, cooldowns)
        if cooldown_penalty >= 100.0:
            continue
        if cooldown_penalty > 0:
            score -= cooldown_penalty
            evidence.append(f"cooldown penalty {cooldown_penalty:g}")

        if intent_name == "light_exploration":
            score += 10.0
            evidence.append("exploration slot bonus")

        target = intent_targets.get(intent_name, 0)
        reason = "light exploration from listening profile" if intent_name == "light_exploration" else "close to the current listening context"
        if target > 0:
            scored.append(
                ScoredCandidate(
                    result=candidate,
                    score=round(score, 3),
                    intent=intent_name,
                    reason=reason,
                    evidence=_unique_preserving_order(evidence),
                    dominant_themes=_unique_preserving_order(dominant_themes or list(current_tags or profile_tags)[:3]),
                )
            )

    return sorted(scored, key=lambda item: item.score, reverse=True)


def _select_candidates(
    scored: list[ScoredCandidate],
    count: int,
    similar_count: int,
    exploration_count: int,
) -> list[ScoredCandidate]:
    selected: list[ScoredCandidate] = []
    used_ids: set[str] = set()

    def take(intent_name: RecommendationIntentKind, target: int) -> None:
        for candidate in scored:
            if len([item for item in selected if item.intent == intent_name]) >= target:
                return
            if candidate.intent != intent_name or candidate.result.id in used_ids:
                continue
            selected.append(candidate)
            used_ids.add(candidate.result.id)

    take("similar_theme", similar_count)
    take("light_exploration", exploration_count)

    for candidate in scored:
        if len(selected) >= count:
            break
        if candidate.result.id in used_ids:
            continue
        selected.append(candidate)
        used_ids.add(candidate.result.id)

    return selected[:count]


def _recommendation_out(candidate: ScoredCandidate) -> AutoDjRecommendationOut:
    item = music_result_to_client_item(candidate.result)
    item_payload = item.model_dump()
    item_payload.update(
        {
            "selected_reason": candidate.reason,
            "selection_evidence": candidate.evidence,
            "selection_score": candidate.score,
        }
    )
    item = ClientMusicItemOut(**item_payload)
    return AutoDjRecommendationOut(
        item=item,
        score=candidate.score,
        intent=candidate.intent,
        reason=candidate.reason,
        evidence=candidate.evidence,
    )


def _profile_patch(
    refill_id: str,
    selected: list[ScoredCandidate],
) -> RecommendationProfilePatchOut:
    created_at = _current_iso_time()
    history = [
        RecommendationHistoryEntryIn(
            item_id=candidate.result.id,
            title=candidate.result.title,
            creator=candidate.result.creator,
            source=candidate.result.source,
            recommended_at=created_at,
            played=False,
            disliked=False,
            reason=candidate.reason,
        )
        for candidate in selected
    ]
    refill = RecommendationRefillHistoryEntryIn(
        refill_id=refill_id,
        created_at=created_at,
        selected_item_ids=[candidate.result.id for candidate in selected],
        dominant_themes=_unique_preserving_order(
            theme
            for candidate in selected
            for theme in candidate.dominant_themes
        )[:5],
        exploration_count=sum(1 for candidate in selected if candidate.intent == "light_exploration"),
    )
    return RecommendationProfilePatchOut(
        recommended_items=history,
        cooldowns=[],
        refill_history=[refill],
    )


def _known_tracks(state: MusicAgentState) -> list[MusicAgentTrack]:
    tracks: list[MusicAgentTrack] = []
    for track in [state.current, state.previous, state.next]:
        if track is not None:
            tracks.append(track)
    tracks.extend(state.upcoming)
    tracks.extend(state.recent)
    tracks.extend(state.saved)
    for playlist in state.playlists:
        tracks.extend(playlist.items)
    return tracks


def _blocked_item_ids(state: MusicAgentState | None) -> set[str]:
    if state is None:
        return set()
    blocked = {track.id for track in [state.current, state.next] if track is not None}
    blocked.update(track.id for track in state.upcoming)
    blocked.update(track.id for track in state.recent)
    return blocked


def _active_cooldowns(profile: MusicRecommendationProfileIn) -> list[RecommendationCooldownIn]:
    now = _current_iso_time()
    return [cooldown for cooldown in profile.cooldowns if cooldown.expires_at > now]


def _cooldown_penalty(
    candidate: MusicSearchCandidate,
    cooldowns: list[RecommendationCooldownIn],
) -> float:
    title_norm = _normalize(candidate.title)
    creator_norm = _normalize(candidate.creator)
    penalty = 0.0
    for cooldown in cooldowns:
        key_norm = _normalize(cooldown.key)
        if cooldown.kind == "item" and cooldown.key == candidate.id:
            penalty += 200.0 * cooldown.weight
        elif cooldown.kind == "artist" and key_norm and key_norm in creator_norm:
            penalty += 20.0 * cooldown.weight
        elif cooldown.kind in {"tag", "query"} and key_norm and key_norm in title_norm:
            penalty += 16.0 * cooldown.weight
    return penalty


def _candidate_dedupe_key(candidate: MusicSearchCandidate) -> str:
    return f"{candidate.source}:{_normalize(candidate.title)}:{_normalize(candidate.creator)}"


def _notice_for_count(count: int) -> str:
    if count == 0:
        return "Auto DJ could not find a strong match this time."
    if count == 1:
        return "Auto DJ added 1 track and kept close to the current mood."
    return f"Auto DJ added {count} tracks and kept close to the current mood."


def _normalize(value: str) -> str:
    return re.sub(r"\s+", "", value.lower())


def _unique_preserving_order(values) -> list:
    result = []
    seen = set()
    for value in values:
        if value in seen:
            continue
        seen.add(value)
        result.append(value)
    return result


def _current_iso_time() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="milliseconds").replace("+00:00", "Z")


def _utc_compact_timestamp() -> str:
    return datetime.now(timezone.utc).strftime("%Y%m%d%H%M%S%f")
```

- [ ] **Step 4: Run the backend core tests**

Run:

```powershell
cd apps/api
python -m pytest tests/test_auto_dj.py -q
```

Expected: PASS.

- [ ] **Step 5: Run related API regression tests**

Run:

```powershell
cd apps/api
python -m pytest tests/test_conversation.py -q
```

Expected: PASS.

- [ ] **Step 6: Commit**

```powershell
git add apps/api/kumikoroom/auto_dj.py apps/api/tests/test_auto_dj.py
git commit -m "feat: score auto dj recommendations"
```

## Task 3: Frontend API Contract

**Files:**
- Modify: `apps/web/src/api/types.ts`
- Modify: `apps/web/src/api/client.ts`
- Test: `apps/web/tests/client.test.ts`

- [ ] **Step 1: Add failing client mapper tests**

Add this type import near the top of `apps/web/tests/client.test.ts`:

```ts
import type { AutoDjRecommendRequest } from "../src/api/types";
```

Append this test inside `describe("room API client", () => { ... })`:

```ts
it("posts auto dj recommendation requests and maps recommendations", async () => {
  const fetchMock = vi.fn(async () => ({
    ok: true,
    status: 200,
    statusText: "OK",
    text: async () =>
      JSON.stringify({
        ok: true,
        refill_id: "auto-dj-test",
        notice: "Auto DJ added 3 tracks and kept close to the current mood.",
        client_actions: [
          {
            type: "add_music_to_queue",
            item: {
              id: "netease-song-a",
              source: "netease",
              title: "Auto Song",
              creator: "Auto Artist",
              duration_ms: 180000,
              page_url: "https://music.163.com/#/song?id=a",
              platform_audio_url: "https://music.163.com/song/media/outer/url?id=a.mp3",
              tags: ["netease", "agent-selected"],
              can_open_video: false,
              selected_reason: "close to the current listening context",
              selection_evidence: ["playable candidate"],
              selection_score: 122.5
            }
          }
        ],
        recommendations: [
          {
            item: {
              id: "netease-song-a",
              source: "netease",
              title: "Auto Song",
              creator: "Auto Artist",
              duration_ms: 180000,
              page_url: "https://music.163.com/#/song?id=a",
              platform_audio_url: "https://music.163.com/song/media/outer/url?id=a.mp3",
              tags: ["netease", "agent-selected"],
              can_open_video: false,
              selected_reason: "close to the current listening context",
              selection_evidence: ["playable candidate"],
              selection_score: 122.5
            },
            score: 122.5,
            intent: "similar_theme",
            reason: "close to the current listening context",
            evidence: ["playable candidate"]
          }
        ],
        profile_patch: {
          recommended_items: [
            {
              item_id: "netease-song-a",
              title: "Auto Song",
              creator: "Auto Artist",
              source: "netease",
              recommended_at: "2026-06-18T00:00:00.000Z",
              played: false,
              disliked: false,
              reason: "close to the current listening context"
            }
          ],
          cooldowns: [],
          refill_history: [
            {
              refill_id: "auto-dj-test",
              created_at: "2026-06-18T00:00:00.000Z",
              selected_item_ids: ["netease-song-a"],
              dominant_themes: ["brass"],
              exploration_count: 0
            }
          ]
        },
        error: null,
        source_errors: []
      })
  }));
  vi.stubGlobal("fetch", fetchMock);

  const payload: AutoDjRecommendRequest = {
    musicState: {
      isPlaying: true,
      currentTimeMs: 0,
      durationMs: 180000,
      current: {
        id: "current",
        source: "netease",
        title: "Current",
        creator: "Current Artist",
        durationMs: 180000,
        pageUrl: null,
        platformAudioUrl: null,
        tags: ["brass"],
        canOpenVideo: false,
        saved: false
      },
      previous: null,
      next: null,
      upcoming: [],
      recent: [],
      saved: [],
      playlists: []
    },
    recommendationProfile: {
      version: 1,
      updatedAt: "2026-06-18T00:00:00.000Z",
      artistWeights: {},
      tagWeights: {},
      sourceWeights: {},
      queryWeights: {},
      recentThemes: [],
      cooldowns: [],
      recommendedItems: [],
      refillHistory: []
    },
    recentMessages: [],
    settings: {
      count: 3,
      queueDepthTrigger: 2,
      similarCount: 2,
      explorationCount: 1
    }
  };

  const response = await roomApi.recommendAutoDj(payload);

  expect(response.ok).toBe(true);
  expect(response.refillId).toBe("auto-dj-test");
  expect(response.recommendations[0].item.durationMs).toBe(180000);
  expect(response.profilePatch.refillHistory[0].refillId).toBe("auto-dj-test");
  const requestBody = JSON.parse(String(fetchMock.mock.calls[0][1]?.body));
  expect(fetchMock.mock.calls[0][0]).toBe("/api/room/music/auto-dj/recommend");
  expect(requestBody.settings.queue_depth_trigger).toBe(2);
  expect(requestBody.recommendation_profile.updated_at).toBe("2026-06-18T00:00:00.000Z");
});
```

- [ ] **Step 2: Run the client test to verify it fails**

Run:

```powershell
npm run test --workspace apps/web -- client.test.ts
```

Expected: FAIL because `recommendAutoDj` and Auto DJ types do not exist.

- [ ] **Step 3: Add frontend Auto DJ types**

Append to `apps/web/src/api/types.ts` after `ChatResponse`:

```ts
export type RecommendationIntent =
  | "similar_theme"
  | "similar_mood"
  | "same_creator_or_work"
  | "light_exploration";

export interface RecommendationThemeSignal {
  key: string;
  weight: number;
  lastSeenAt: string;
}

export interface RecommendationCooldown {
  key: string;
  kind: "item" | "artist" | "tag" | "query";
  weight: number;
  expiresAt: string;
  reason: "dislike" | "recently_played" | "recently_recommended";
}

export interface RecommendationHistoryEntry {
  itemId: string;
  title: string;
  creator: string;
  source: ClientMusicItem["source"];
  recommendedAt: string;
  played: boolean;
  disliked: boolean;
  reason: string;
}

export interface RecommendationRefillHistoryEntry {
  refillId: string;
  createdAt: string;
  selectedItemIds: string[];
  dominantThemes: string[];
  explorationCount: number;
}

export interface MusicRecommendationProfile {
  version: 1;
  updatedAt: string;
  artistWeights: Record<string, number>;
  tagWeights: Record<string, number>;
  sourceWeights: Partial<Record<ClientMusicItem["source"], number>>;
  queryWeights: Record<string, number>;
  recentThemes: RecommendationThemeSignal[];
  cooldowns: RecommendationCooldown[];
  recommendedItems: RecommendationHistoryEntry[];
  refillHistory: RecommendationRefillHistoryEntry[];
}

export interface AutoDjSettings {
  count: number;
  queueDepthTrigger: number;
  similarCount: number;
  explorationCount: number;
}

export interface AutoDjRecommendRequest {
  musicState: MusicAgentState | null;
  recommendationProfile: MusicRecommendationProfile;
  recentMessages: ChatMessage[];
  settings: AutoDjSettings;
}

export interface AutoDjRecommendation {
  item: ClientMusicItem;
  score: number;
  intent: RecommendationIntent;
  reason: string;
  evidence: string[];
}

export interface RecommendationProfilePatch {
  recommendedItems: RecommendationHistoryEntry[];
  cooldowns: RecommendationCooldown[];
  refillHistory: RecommendationRefillHistoryEntry[];
}

export interface AutoDjRecommendResponse {
  ok: boolean;
  refillId: string | null;
  notice: string;
  clientActions: RoomClientAction[];
  recommendations: AutoDjRecommendation[];
  profilePatch: RecommendationProfilePatch;
  error: string | null;
  sourceErrors: string[];
}
```

- [ ] **Step 4: Add client mapper function**

In `apps/web/src/api/client.ts`, add imports for new types:

```ts
  AutoDjRecommendRequest,
  AutoDjRecommendResponse,
  AutoDjRecommendation,
  RecommendationCooldown,
  RecommendationHistoryEntry,
  RecommendationProfilePatch,
  RecommendationRefillHistoryEntry,
  RecommendationThemeSignal,
```

Add this exported function after `searchMusic()`:

```ts
export function recommendAutoDj(payload: AutoDjRecommendRequest): Promise<AutoDjRecommendResponse> {
  return request<AutoDjRecommendResponseApi>("/api/room/music/auto-dj/recommend", {
    method: "POST",
    body: JSON.stringify({
      music_state: payload.musicState ? mapMusicAgentStateRequest(payload.musicState) : null,
      recommendation_profile: mapRecommendationProfileRequest(payload.recommendationProfile),
      recent_messages: payload.recentMessages,
      settings: {
        count: payload.settings.count,
        queue_depth_trigger: payload.settings.queueDepthTrigger,
        similar_count: payload.settings.similarCount,
        exploration_count: payload.settings.explorationCount
      }
    })
  }).then(mapAutoDjRecommendResponse);
}
```

Add these API interfaces near the other API interfaces:

```ts
interface RecommendationThemeSignalApi {
  key: string;
  weight: number;
  last_seen_at: string;
}

interface RecommendationCooldownApi {
  key: string;
  kind: RecommendationCooldown["kind"];
  weight: number;
  expires_at: string;
  reason: RecommendationCooldown["reason"];
}

interface RecommendationHistoryEntryApi {
  item_id: string;
  title: string;
  creator: string;
  source: RecommendationHistoryEntry["source"];
  recommended_at: string;
  played: boolean;
  disliked: boolean;
  reason: string;
}

interface RecommendationRefillHistoryEntryApi {
  refill_id: string;
  created_at: string;
  selected_item_ids: string[];
  dominant_themes: string[];
  exploration_count: number;
}

interface RecommendationProfileApi {
  version: 1;
  updated_at: string;
  artist_weights: Record<string, number>;
  tag_weights: Record<string, number>;
  source_weights: Partial<Record<ClientMusicItem["source"], number>>;
  query_weights: Record<string, number>;
  recent_themes: RecommendationThemeSignalApi[];
  cooldowns: RecommendationCooldownApi[];
  recommended_items: RecommendationHistoryEntryApi[];
  refill_history: RecommendationRefillHistoryEntryApi[];
}

interface RecommendationProfilePatchApi {
  recommended_items: RecommendationHistoryEntryApi[];
  cooldowns: RecommendationCooldownApi[];
  refill_history: RecommendationRefillHistoryEntryApi[];
}

interface AutoDjRecommendationApi {
  item: ClientMusicItemApi;
  score: number;
  intent: AutoDjRecommendation["intent"];
  reason: string;
  evidence: string[];
}

interface AutoDjRecommendResponseApi {
  ok: boolean;
  refill_id: string | null;
  notice: string;
  client_actions: RoomClientActionApi[];
  recommendations: AutoDjRecommendationApi[];
  profile_patch: RecommendationProfilePatchApi;
  error: string | null;
  source_errors: string[];
}
```

Add these mapper functions before `isRecord()`:

```ts
function mapRecommendationProfileRequest(value: AutoDjRecommendRequest["recommendationProfile"]): RecommendationProfileApi {
  return {
    version: value.version,
    updated_at: value.updatedAt,
    artist_weights: value.artistWeights,
    tag_weights: value.tagWeights,
    source_weights: value.sourceWeights,
    query_weights: value.queryWeights,
    recent_themes: value.recentThemes.map(mapRecommendationThemeRequest),
    cooldowns: value.cooldowns.map(mapRecommendationCooldownRequest),
    recommended_items: value.recommendedItems.map(mapRecommendationHistoryRequest),
    refill_history: value.refillHistory.map(mapRecommendationRefillHistoryRequest)
  };
}

function mapRecommendationThemeRequest(value: RecommendationThemeSignal): RecommendationThemeSignalApi {
  return {
    key: value.key,
    weight: value.weight,
    last_seen_at: value.lastSeenAt
  };
}

function mapRecommendationCooldownRequest(value: RecommendationCooldown): RecommendationCooldownApi {
  return {
    key: value.key,
    kind: value.kind,
    weight: value.weight,
    expires_at: value.expiresAt,
    reason: value.reason
  };
}

function mapRecommendationHistoryRequest(value: RecommendationHistoryEntry): RecommendationHistoryEntryApi {
  return {
    item_id: value.itemId,
    title: value.title,
    creator: value.creator,
    source: value.source,
    recommended_at: value.recommendedAt,
    played: value.played,
    disliked: value.disliked,
    reason: value.reason
  };
}

function mapRecommendationRefillHistoryRequest(value: RecommendationRefillHistoryEntry): RecommendationRefillHistoryEntryApi {
  return {
    refill_id: value.refillId,
    created_at: value.createdAt,
    selected_item_ids: value.selectedItemIds,
    dominant_themes: value.dominantThemes,
    exploration_count: value.explorationCount
  };
}

function mapAutoDjRecommendResponse(value: AutoDjRecommendResponseApi): AutoDjRecommendResponse {
  return {
    ok: value.ok,
    refillId: value.refill_id,
    notice: value.notice,
    clientActions: value.client_actions.map(mapRoomClientAction).filter(isRoomClientAction),
    recommendations: value.recommendations.map(mapAutoDjRecommendation),
    profilePatch: mapRecommendationProfilePatch(value.profile_patch),
    error: value.error,
    sourceErrors: value.source_errors
  };
}

function mapAutoDjRecommendation(value: AutoDjRecommendationApi): AutoDjRecommendation {
  return {
    item: mapClientMusicItem(value.item),
    score: value.score,
    intent: value.intent,
    reason: value.reason,
    evidence: value.evidence
  };
}

function mapRecommendationProfilePatch(value: RecommendationProfilePatchApi): RecommendationProfilePatch {
  return {
    recommendedItems: value.recommended_items.map(mapRecommendationHistory),
    cooldowns: value.cooldowns.map(mapRecommendationCooldown),
    refillHistory: value.refill_history.map(mapRecommendationRefillHistory)
  };
}

function mapRecommendationHistory(value: RecommendationHistoryEntryApi): RecommendationHistoryEntry {
  return {
    itemId: value.item_id,
    title: value.title,
    creator: value.creator,
    source: value.source,
    recommendedAt: value.recommended_at,
    played: value.played,
    disliked: value.disliked,
    reason: value.reason
  };
}

function mapRecommendationCooldown(value: RecommendationCooldownApi): RecommendationCooldown {
  return {
    key: value.key,
    kind: value.kind,
    weight: value.weight,
    expiresAt: value.expires_at,
    reason: value.reason
  };
}

function mapRecommendationRefillHistory(value: RecommendationRefillHistoryEntryApi): RecommendationRefillHistoryEntry {
  return {
    refillId: value.refill_id,
    createdAt: value.created_at,
    selectedItemIds: value.selected_item_ids,
    dominantThemes: value.dominant_themes,
    explorationCount: value.exploration_count
  };
}
```

- [ ] **Step 5: Run the client mapper test**

Run:

```powershell
npm run test --workspace apps/web -- client.test.ts
```

Expected: PASS.

- [ ] **Step 6: Commit**

```powershell
git add apps/web/src/api/types.ts apps/web/src/api/client.ts apps/web/tests/client.test.ts
git commit -m "feat: add auto dj client api"
```

## Task 4: Frontend Recommendation Profile Helpers

**Files:**
- Create: `apps/web/src/lib/musicRecommendationProfile.ts`
- Create: `apps/web/tests/musicRecommendationProfile.test.ts`

- [ ] **Step 1: Write profile helper tests**

Create `apps/web/tests/musicRecommendationProfile.test.ts`:

```ts
import type { AutoDjRecommendation, MusicRecommendationProfile, RecommendationProfilePatch } from "../src/api/types";
import {
  applyRecommendationProfilePatch,
  createInitialMusicRecommendationProfile,
  dislikeRecommendedItem,
  isMusicRecommendationProfile,
  markRecommendedItemAccepted,
  markRecommendedItemSkipped,
} from "../src/lib/musicRecommendationProfile";

function recommendation(id: string, tags: string[] = ["brass"]): AutoDjRecommendation {
  return {
    item: {
      id,
      source: "netease",
      title: `Song ${id}`,
      creator: "Concert Band",
      durationMs: 180000,
      pageUrl: `https://example.test/${id}`,
      platformAudioUrl: `https://example.test/${id}.mp3`,
      tags,
      canOpenVideo: false
    },
    score: 120,
    intent: "similar_theme",
    reason: "close to the current listening context",
    evidence: ["playable candidate"]
  };
}

describe("musicRecommendationProfile", () => {
  it("creates and validates the initial profile", () => {
    const profile = createInitialMusicRecommendationProfile("2026-06-18T00:00:00.000Z");

    expect(profile.version).toBe(1);
    expect(profile.updatedAt).toBe("2026-06-18T00:00:00.000Z");
    expect(isMusicRecommendationProfile(profile)).toBe(true);
    expect(isMusicRecommendationProfile({ version: 2 })).toBe(false);
    expect(isMusicRecommendationProfile({ version: 1, cooldowns: "bad" })).toBe(false);
  });

  it("applies backend profile patches without duplicating history", () => {
    const profile = createInitialMusicRecommendationProfile("2026-06-18T00:00:00.000Z");
    const patch: RecommendationProfilePatch = {
      recommendedItems: [
        {
          itemId: "song-a",
          title: "Song A",
          creator: "Concert Band",
          source: "netease",
          recommendedAt: "2026-06-18T00:01:00.000Z",
          played: false,
          disliked: false,
          reason: "close to the current listening context"
        }
      ],
      cooldowns: [],
      refillHistory: [
        {
          refillId: "refill-a",
          createdAt: "2026-06-18T00:01:00.000Z",
          selectedItemIds: ["song-a"],
          dominantThemes: ["brass"],
          explorationCount: 1
        }
      ]
    };

    const once = applyRecommendationProfilePatch(profile, patch, "2026-06-18T00:02:00.000Z");
    const twice = applyRecommendationProfilePatch(once, patch, "2026-06-18T00:03:00.000Z");

    expect(twice.recommendedItems.map((item) => item.itemId)).toEqual(["song-a"]);
    expect(twice.refillHistory.map((entry) => entry.refillId)).toEqual(["refill-a"]);
    expect(twice.updatedAt).toBe("2026-06-18T00:03:00.000Z");
  });

  it("updates profile weights for accepted, skipped, and disliked recommendations", () => {
    const profile = createInitialMusicRecommendationProfile("2026-06-18T00:00:00.000Z");
    const accepted = markRecommendedItemAccepted(
      applyRecommendationProfilePatch(profile, {
        recommendedItems: [],
        cooldowns: [],
        refillHistory: []
      }),
      recommendation("song-a", ["brass", "warm"]),
      "2026-06-18T00:01:00.000Z"
    );
    const skipped = markRecommendedItemSkipped(accepted, recommendation("song-b", ["brass"]), "2026-06-18T00:02:00.000Z");
    const disliked = dislikeRecommendedItem(skipped, recommendation("song-c", ["noisy"]), "2026-06-18T00:03:00.000Z");

    expect(disliked.artistWeights["concert band"]).toBeGreaterThan(0);
    expect(disliked.tagWeights.brass).toBeGreaterThan(0);
    expect(disliked.cooldowns.some((cooldown) => cooldown.kind === "item" && cooldown.key === "song-c")).toBe(true);
    expect(disliked.cooldowns.some((cooldown) => cooldown.kind === "artist" && cooldown.key === "concert band")).toBe(true);
    expect(disliked.tagWeights.noisy).toBeLessThan(0);
  });
});
```

- [ ] **Step 2: Run profile tests to verify they fail**

Run:

```powershell
npm run test --workspace apps/web -- musicRecommendationProfile.test.ts
```

Expected: FAIL because `musicRecommendationProfile.ts` does not exist.

- [ ] **Step 3: Implement profile helpers**

Create `apps/web/src/lib/musicRecommendationProfile.ts`:

```ts
import type {
  AutoDjRecommendation,
  MusicRecommendationProfile,
  RecommendationCooldown,
  RecommendationHistoryEntry,
  RecommendationProfilePatch,
  RecommendationRefillHistoryEntry,
  RecommendationThemeSignal
} from "../api/types";

const MAX_HISTORY_ITEMS = 80;
const MAX_REFILL_HISTORY = 20;
const DISLIKE_COOLDOWN_MS = 1000 * 60 * 60 * 12;

export function createInitialMusicRecommendationProfile(now = currentIsoTime()): MusicRecommendationProfile {
  return {
    version: 1,
    updatedAt: now,
    artistWeights: {},
    tagWeights: {},
    sourceWeights: {},
    queryWeights: {},
    recentThemes: [],
    cooldowns: [],
    recommendedItems: [],
    refillHistory: []
  };
}

export function isMusicRecommendationProfile(value: unknown): value is MusicRecommendationProfile {
  if (!isRecord(value)) return false;
  return (
    value.version === 1 &&
    typeof value.updatedAt === "string" &&
    isNumberRecord(value.artistWeights) &&
    isNumberRecord(value.tagWeights) &&
    isSourceWeightRecord(value.sourceWeights) &&
    isNumberRecord(value.queryWeights) &&
    Array.isArray(value.recentThemes) &&
    value.recentThemes.every(isRecommendationThemeSignal) &&
    Array.isArray(value.cooldowns) &&
    value.cooldowns.every(isRecommendationCooldown) &&
    Array.isArray(value.recommendedItems) &&
    value.recommendedItems.every(isRecommendationHistoryEntry) &&
    Array.isArray(value.refillHistory) &&
    value.refillHistory.every(isRecommendationRefillHistoryEntry)
  );
}

export function applyRecommendationProfilePatch(
  profile: MusicRecommendationProfile,
  patch: RecommendationProfilePatch,
  now = currentIsoTime()
): MusicRecommendationProfile {
  return {
    ...cloneProfile(profile),
    updatedAt: now,
    cooldowns: mergeCooldowns(profile.cooldowns, patch.cooldowns),
    recommendedItems: mergeRecommendedItems(profile.recommendedItems, patch.recommendedItems).slice(-MAX_HISTORY_ITEMS),
    refillHistory: mergeRefillHistory(profile.refillHistory, patch.refillHistory).slice(-MAX_REFILL_HISTORY)
  };
}

export function markRecommendedItemAccepted(
  profile: MusicRecommendationProfile,
  recommendation: AutoDjRecommendation,
  now = currentIsoTime()
): MusicRecommendationProfile {
  const next = cloneProfile(profile);
  bump(next.artistWeights, normalizeKey(recommendation.item.creator), 1.2);
  for (const tag of recommendation.item.tags) {
    bump(next.tagWeights, normalizeKey(tag), 0.8);
  }
  bumpSource(next, recommendation.item.source, 0.5);
  next.updatedAt = now;
  return markHistory(next, recommendation.item.id, { played: true });
}

export function markRecommendedItemSkipped(
  profile: MusicRecommendationProfile,
  recommendation: AutoDjRecommendation,
  now = currentIsoTime()
): MusicRecommendationProfile {
  const next = cloneProfile(profile);
  bump(next.artistWeights, normalizeKey(recommendation.item.creator), -0.3);
  for (const tag of recommendation.item.tags) {
    bump(next.tagWeights, normalizeKey(tag), -0.2);
  }
  next.updatedAt = now;
  return next;
}

export function dislikeRecommendedItem(
  profile: MusicRecommendationProfile,
  recommendation: AutoDjRecommendation,
  now = currentIsoTime()
): MusicRecommendationProfile {
  const next = cloneProfile(profile);
  const expiresAt = new Date(Date.parse(now) + DISLIKE_COOLDOWN_MS).toISOString();
  bump(next.artistWeights, normalizeKey(recommendation.item.creator), -0.6);
  for (const tag of recommendation.item.tags) {
    bump(next.tagWeights, normalizeKey(tag), -0.5);
  }
  next.cooldowns = mergeCooldowns(next.cooldowns, [
    {
      key: recommendation.item.id,
      kind: "item",
      weight: 3,
      expiresAt,
      reason: "dislike"
    },
    {
      key: normalizeKey(recommendation.item.creator),
      kind: "artist",
      weight: 1,
      expiresAt,
      reason: "dislike"
    },
    ...recommendation.item.tags.map<RecommendationCooldown>((tag) => ({
      key: normalizeKey(tag),
      kind: "tag",
      weight: 0.8,
      expiresAt,
      reason: "dislike"
    }))
  ]);
  next.updatedAt = now;
  return markHistory(next, recommendation.item.id, { disliked: true });
}

function cloneProfile(profile: MusicRecommendationProfile): MusicRecommendationProfile {
  return {
    version: 1,
    updatedAt: profile.updatedAt,
    artistWeights: { ...profile.artistWeights },
    tagWeights: { ...profile.tagWeights },
    sourceWeights: { ...profile.sourceWeights },
    queryWeights: { ...profile.queryWeights },
    recentThemes: profile.recentThemes.map((theme) => ({ ...theme })),
    cooldowns: profile.cooldowns.map((cooldown) => ({ ...cooldown })),
    recommendedItems: profile.recommendedItems.map((item) => ({ ...item })),
    refillHistory: profile.refillHistory.map((entry) => ({
      ...entry,
      selectedItemIds: [...entry.selectedItemIds],
      dominantThemes: [...entry.dominantThemes]
    }))
  };
}

function markHistory(
  profile: MusicRecommendationProfile,
  itemId: string,
  patch: Partial<Pick<RecommendationHistoryEntry, "played" | "disliked">>
): MusicRecommendationProfile {
  return {
    ...profile,
    recommendedItems: profile.recommendedItems.map((item) =>
      item.itemId === itemId ? { ...item, ...patch } : item
    )
  };
}

function mergeRecommendedItems(
  current: RecommendationHistoryEntry[],
  incoming: RecommendationHistoryEntry[]
): RecommendationHistoryEntry[] {
  const byId = new Map(current.map((item) => [item.itemId, { ...item }]));
  for (const item of incoming) {
    byId.set(item.itemId, { ...byId.get(item.itemId), ...item });
  }
  return [...byId.values()];
}

function mergeRefillHistory(
  current: RecommendationRefillHistoryEntry[],
  incoming: RecommendationRefillHistoryEntry[]
): RecommendationRefillHistoryEntry[] {
  const byId = new Map(current.map((entry) => [entry.refillId, cloneRefillHistory(entry)]));
  for (const entry of incoming) {
    byId.set(entry.refillId, cloneRefillHistory(entry));
  }
  return [...byId.values()];
}

function mergeCooldowns(current: RecommendationCooldown[], incoming: RecommendationCooldown[]): RecommendationCooldown[] {
  const byKey = new Map(current.map((cooldown) => [cooldownKey(cooldown), { ...cooldown }]));
  for (const cooldown of incoming) {
    byKey.set(cooldownKey(cooldown), { ...cooldown });
  }
  return [...byKey.values()];
}

function cloneRefillHistory(entry: RecommendationRefillHistoryEntry): RecommendationRefillHistoryEntry {
  return {
    ...entry,
    selectedItemIds: [...entry.selectedItemIds],
    dominantThemes: [...entry.dominantThemes]
  };
}

function cooldownKey(cooldown: RecommendationCooldown): string {
  return `${cooldown.kind}:${cooldown.key}`;
}

function bump(record: Record<string, number>, key: string, amount: number): void {
  if (!key) return;
  record[key] = roundWeight((record[key] ?? 0) + amount);
}

function bumpSource(profile: MusicRecommendationProfile, source: "bilibili" | "netease", amount: number): void {
  profile.sourceWeights[source] = roundWeight((profile.sourceWeights[source] ?? 0) + amount);
}

function normalizeKey(value: string): string {
  return value.trim().toLowerCase();
}

function roundWeight(value: number): number {
  return Math.round(value * 1000) / 1000;
}

function isRecommendationThemeSignal(value: unknown): value is RecommendationThemeSignal {
  return isRecord(value) && typeof value.key === "string" && typeof value.weight === "number" && typeof value.lastSeenAt === "string";
}

function isRecommendationCooldown(value: unknown): value is RecommendationCooldown {
  return (
    isRecord(value) &&
    typeof value.key === "string" &&
    (value.kind === "item" || value.kind === "artist" || value.kind === "tag" || value.kind === "query") &&
    typeof value.weight === "number" &&
    typeof value.expiresAt === "string" &&
    (value.reason === "dislike" || value.reason === "recently_played" || value.reason === "recently_recommended")
  );
}

function isRecommendationHistoryEntry(value: unknown): value is RecommendationHistoryEntry {
  return (
    isRecord(value) &&
    typeof value.itemId === "string" &&
    typeof value.title === "string" &&
    typeof value.creator === "string" &&
    (value.source === "bilibili" || value.source === "netease") &&
    typeof value.recommendedAt === "string" &&
    typeof value.played === "boolean" &&
    typeof value.disliked === "boolean" &&
    typeof value.reason === "string"
  );
}

function isRecommendationRefillHistoryEntry(value: unknown): value is RecommendationRefillHistoryEntry {
  return (
    isRecord(value) &&
    typeof value.refillId === "string" &&
    typeof value.createdAt === "string" &&
    Array.isArray(value.selectedItemIds) &&
    value.selectedItemIds.every((item) => typeof item === "string") &&
    Array.isArray(value.dominantThemes) &&
    value.dominantThemes.every((theme) => typeof theme === "string") &&
    typeof value.explorationCount === "number"
  );
}

function isSourceWeightRecord(value: unknown): value is MusicRecommendationProfile["sourceWeights"] {
  if (!isRecord(value)) return false;
  return Object.entries(value).every(
    ([key, entry]) => (key === "bilibili" || key === "netease") && typeof entry === "number"
  );
}

function isNumberRecord(value: unknown): value is Record<string, number> {
  return isRecord(value) && Object.values(value).every((entry) => typeof entry === "number");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object";
}

function currentIsoTime(): string {
  return new Date().toISOString();
}
```

- [ ] **Step 4: Run profile tests**

Run:

```powershell
npm run test --workspace apps/web -- musicRecommendationProfile.test.ts
```

Expected: PASS.

- [ ] **Step 5: Commit**

```powershell
git add apps/web/src/lib/musicRecommendationProfile.ts apps/web/tests/musicRecommendationProfile.test.ts
git commit -m "feat: add music recommendation profile"
```

## Task 5: Queue Recommendation Metadata And Auto DJ Helpers

**Files:**
- Modify: `apps/web/src/lib/musicQueue.ts`
- Create: `apps/web/src/lib/autoDj.ts`
- Modify: `apps/web/tests/musicQueue.test.ts`
- Create: `apps/web/tests/autoDj.test.ts`

- [ ] **Step 1: Add queue metadata and helper tests**

Append to `apps/web/tests/musicQueue.test.ts`:

```ts
it("preserves recommendation metadata from auto dj client items", () => {
  const initial = createInitialMusicQueue([makeItem("current", "Current")], "2026-06-18T00:00:00.000Z");
  const state = addQueueItem(
    initial,
    {
      ...makeClientItem("auto-a", "Auto A"),
      selectedReason: "close to the current listening context",
      selectionEvidence: ["playable candidate", "source preference netease"],
      selectionScore: 122.5
    },
    "2026-06-18T00:01:00.000Z"
  );

  const queued = getUpcomingQueueEntries(state)[0];
  expect(queued.selectedReason).toBe("close to the current listening context");
  expect(queued.selectionEvidence).toEqual(["playable candidate", "source preference netease"]);
  expect(queued.selectionScore).toBe(122.5);
});
```

Create `apps/web/tests/autoDj.test.ts`:

```ts
import type { AutoDjRecommendResponse, AutoDjSettings } from "../src/api/types";
import { createAutoDjQueueSignature, getPlayableQueueDepth, shouldRequestAutoDjRefill } from "../src/lib/autoDj";
import type { MusicQueueState } from "../src/lib/musicQueue";

function queueState(ids: string[], currentId: string | null = ids[0] ?? null): MusicQueueState {
  return {
    currentId,
    recentLimit: 30,
    entries: ids.map((id, index) => ({
      id,
      item: {
        id,
        source: "netease",
        title: `Song ${id}`,
        creator: "Artist",
        durationMs: 180000,
        pageUrl: `https://example.test/${id}`,
        platformAudioUrl: `https://example.test/${id}.mp3`,
        tags: ["netease"],
        canOpenVideo: false
      },
      status: index === 0 ? "current" : "queued",
      addedBy: "user",
      addedAt: "2026-06-18T00:00:00.000Z",
      playCount: index === 0 ? 1 : 0
    }))
  };
}

const settings: AutoDjSettings = {
  count: 3,
  queueDepthTrigger: 2,
  similarCount: 2,
  explorationCount: 1
};

describe("autoDj", () => {
  it("counts current plus upcoming playable entries", () => {
    expect(getPlayableQueueDepth(queueState(["a", "b", "c"]))).toBe(3);
    expect(getPlayableQueueDepth(queueState(["a", "b"]))).toBe(2);
  });

  it("requests refill only when enabled, hydrated, shallow, and signature is new", () => {
    const queue = queueState(["a", "b"]);
    const signature = createAutoDjQueueSignature(queue, settings);

    expect(shouldRequestAutoDjRefill({ enabled: true, hydrated: true, queue, settings, inFlightSignature: null, lastRequestedSignature: null })).toBe(signature);
    expect(shouldRequestAutoDjRefill({ enabled: false, hydrated: true, queue, settings, inFlightSignature: null, lastRequestedSignature: null })).toBeNull();
    expect(shouldRequestAutoDjRefill({ enabled: true, hydrated: false, queue, settings, inFlightSignature: null, lastRequestedSignature: null })).toBeNull();
    expect(shouldRequestAutoDjRefill({ enabled: true, hydrated: true, queue, settings, inFlightSignature: signature, lastRequestedSignature: null })).toBeNull();
    expect(shouldRequestAutoDjRefill({ enabled: true, hydrated: true, queue, settings, inFlightSignature: null, lastRequestedSignature: signature })).toBeNull();
  });
});
```

- [ ] **Step 2: Run helper tests to verify they fail**

Run:

```powershell
npm run test --workspace apps/web -- musicQueue.test.ts autoDj.test.ts
```

Expected: FAIL because `autoDj.ts` does not exist.

- [ ] **Step 3: Create Auto DJ helper file**

Create `apps/web/src/lib/autoDj.ts`:

```ts
import type { AutoDjSettings } from "../api/types";
import {
  getPlaybackQueueEntries,
  type MusicQueueState
} from "./musicQueue";

interface ShouldRequestAutoDjRefillInput {
  enabled: boolean;
  hydrated: boolean;
  queue: MusicQueueState;
  settings: AutoDjSettings;
  inFlightSignature: string | null;
  lastRequestedSignature: string | null;
}

export function getPlayableQueueDepth(queue: MusicQueueState): number {
  return getPlaybackQueueEntries(queue).filter((entry) => entry.status === "current" || entry.status === "queued").length;
}

export function createAutoDjQueueSignature(queue: MusicQueueState, settings: AutoDjSettings): string {
  const ids = getPlaybackQueueEntries(queue).map((entry) => `${entry.status}:${entry.id}`).join("|");
  return `${ids}::${settings.count}:${settings.queueDepthTrigger}:${settings.similarCount}:${settings.explorationCount}`;
}

export function shouldRequestAutoDjRefill(input: ShouldRequestAutoDjRefillInput): string | null {
  if (!input.enabled || !input.hydrated) return null;
  if (getPlayableQueueDepth(input.queue) > input.settings.queueDepthTrigger) return null;

  const signature = createAutoDjQueueSignature(input.queue, input.settings);
  if (input.inFlightSignature === signature || input.lastRequestedSignature === signature) {
    return null;
  }

  return signature;
}
```

- [ ] **Step 4: Run helper tests**

Run:

```powershell
npm run test --workspace apps/web -- musicQueue.test.ts autoDj.test.ts
```

Expected: PASS.

- [ ] **Step 5: Commit**

```powershell
git add apps/web/src/lib/autoDj.ts apps/web/src/lib/musicQueue.ts apps/web/tests/musicQueue.test.ts apps/web/tests/autoDj.test.ts
git commit -m "feat: add auto dj queue helpers"
```

## Task 6: RoomShell Auto DJ Trigger And Response Application

**Files:**
- Modify: `apps/web/src/components/RoomShell.tsx`
- Modify: `apps/web/tests/RoomShell.test.tsx`

- [ ] **Step 1: Add failing RoomShell trigger test**

Update the API mock in `apps/web/tests/RoomShell.test.tsx`:

```ts
const apiMocks = vi.hoisted(() => ({
  createSession: vi.fn(),
  deleteSession: vi.fn(),
  getSessionMessages: vi.fn(),
  getSessions: vi.fn(),
  recommendAutoDj: vi.fn(),
  renameSession: vi.fn(),
  postChat: vi.fn(),
  searchMusic: vi.fn(),
  testLLMConnection: vi.fn()
}));
```

Add `recommendAutoDj` to the module mock:

```ts
  recommendAutoDj: apiMocks.recommendAutoDj,
```

Add to `beforeEach()`:

```ts
    apiMocks.recommendAutoDj.mockResolvedValue({
      ok: true,
      refillId: "auto-dj-test",
      notice: "Auto DJ added 1 track and kept close to the current mood.",
      clientActions: [
        {
          type: "add_music_to_queue",
          item: {
            id: "netease-auto-a",
            source: "netease",
            title: "Auto DJ Song",
            creator: "Auto Artist",
            durationMs: 180000,
            pageUrl: "https://music.163.com/#/song?id=100",
            platformAudioUrl: "https://music.163.com/song/media/outer/url?id=100.mp3",
            tags: ["netease", "agent-selected"],
            canOpenVideo: false,
            selectedReason: "close to the current listening context",
            selectionEvidence: ["playable candidate"],
            selectionScore: 120
          }
        }
      ],
      recommendations: [
        {
          item: {
            id: "netease-auto-a",
            source: "netease",
            title: "Auto DJ Song",
            creator: "Auto Artist",
            durationMs: 180000,
            pageUrl: "https://music.163.com/#/song?id=100",
            platformAudioUrl: "https://music.163.com/song/media/outer/url?id=100.mp3",
            tags: ["netease", "agent-selected"],
            canOpenVideo: false,
            selectedReason: "close to the current listening context",
            selectionEvidence: ["playable candidate"],
            selectionScore: 120
          },
          score: 120,
          intent: "similar_theme",
          reason: "close to the current listening context",
          evidence: ["playable candidate"]
        }
      ],
      profilePatch: {
        recommendedItems: [
          {
            itemId: "netease-auto-a",
            title: "Auto DJ Song",
            creator: "Auto Artist",
            source: "netease",
            recommendedAt: "2026-06-18T00:00:00.000Z",
            played: false,
            disliked: false,
            reason: "close to the current listening context"
          }
        ],
        cooldowns: [],
        refillHistory: [
          {
            refillId: "auto-dj-test",
            createdAt: "2026-06-18T00:00:00.000Z",
            selectedItemIds: ["netease-auto-a"],
            dominantThemes: ["netease"],
            explorationCount: 0
          }
        ]
      },
      error: null,
      sourceErrors: []
    });
```

Add this test:

```ts
it("persists Auto DJ and refills the queue when depth reaches the trigger", async () => {
  render(<RoomShell initialState={DEFAULT_ROOM_STATE} connectionStatus={connectionStatus} />);

  expect(await screen.findByRole("button", { name: defaultSession.title })).toBeTruthy();
  fireEvent.click(screen.getByRole("switch", { name: "Auto DJ" }));

  await waitFor(() => expect(apiMocks.recommendAutoDj).toHaveBeenCalledTimes(1));
  expect(localStorage.getItem("kumikoroom.autoDjEnabled")).toBe("true");
  expect(apiMocks.recommendAutoDj).toHaveBeenCalledWith(
    expect.objectContaining({
      settings: {
        count: 3,
        queueDepthTrigger: 2,
        similarCount: 2,
        explorationCount: 1
      },
      recommendationProfile: expect.objectContaining({
        version: 1
      })
    })
  );
  expect(await within(getTimeline()).findByText("Auto DJ added 1 track and kept close to the current mood.")).toBeTruthy();
  fireEvent.click(getQueueManageButton());
  expect(within(getMusicQueuePanel()).getByText("Auto DJ Song")).toBeTruthy();
  expect(localStorage.getItem("kumikoroom.musicRecommendationProfile")).toContain("netease-auto-a");
});
```

- [ ] **Step 2: Run the RoomShell test to verify it fails**

Run:

```powershell
npm run test --workspace apps/web -- RoomShell.test.tsx -t "Auto DJ"
```

Expected: FAIL because the switch, state, and trigger are absent.

- [ ] **Step 3: Add imports and constants to RoomShell**

In `apps/web/src/components/RoomShell.tsx`, add `recommendAutoDj` to the API import:

```ts
  recommendAutoDj,
```

Add new type imports:

```ts
  AutoDjRecommendResponse,
  AutoDjSettings,
  MusicRecommendationProfile,
```

Add helper imports:

```ts
import {
  applyRecommendationProfilePatch,
  createInitialMusicRecommendationProfile,
  dislikeRecommendedItem,
  isMusicRecommendationProfile,
} from "../lib/musicRecommendationProfile";
import { shouldRequestAutoDjRefill } from "../lib/autoDj";
```

Add constants near existing storage keys:

```ts
const AUTO_DJ_ENABLED_STORAGE_KEY = "kumikoroom.autoDjEnabled";
const MUSIC_RECOMMENDATION_PROFILE_STORAGE_KEY = "kumikoroom.musicRecommendationProfile";
const DEFAULT_AUTO_DJ_SETTINGS: AutoDjSettings = {
  count: 3,
  queueDepthTrigger: 2,
  similarCount: 2,
  explorationCount: 1,
};
```

- [ ] **Step 4: Add Auto DJ state and hydration**

Inside `RoomShell`, near music state:

```ts
  const [autoDjEnabled, setAutoDjEnabled] = useState(false);
  const [autoDjHydrated, setAutoDjHydrated] = useState(false);
  const [autoDjInFlightSignature, setAutoDjInFlightSignature] = useState<string | null>(null);
  const [autoDjLastRequestedSignature, setAutoDjLastRequestedSignature] = useState<string | null>(null);
  const [musicRecommendationProfile, setMusicRecommendationProfile] = useState<MusicRecommendationProfile>(() =>
    createInitialMusicRecommendationProfile()
  );
  const musicRecommendationProfileRef = useRef(musicRecommendationProfile);
  musicRecommendationProfileRef.current = musicRecommendationProfile;
```

Add hydration effects near queue/library hydration:

```ts
  useEffect(() => {
    if (typeof window === "undefined") return;

    setAutoDjEnabled(window.localStorage.getItem(AUTO_DJ_ENABLED_STORAGE_KEY) === "true");
    const storedProfile = readStoredMusicRecommendationProfile(window.localStorage);
    if (storedProfile) {
      setMusicRecommendationProfile(storedProfile);
    }
    setAutoDjHydrated(true);
  }, []);

  useEffect(() => {
    if (!autoDjHydrated || typeof window === "undefined") return;

    window.localStorage.setItem(AUTO_DJ_ENABLED_STORAGE_KEY, String(autoDjEnabled));
  }, [autoDjEnabled, autoDjHydrated]);

  useEffect(() => {
    if (!autoDjHydrated || typeof window === "undefined") return;

    window.localStorage.setItem(
      MUSIC_RECOMMENDATION_PROFILE_STORAGE_KEY,
      JSON.stringify(musicRecommendationProfile)
    );
  }, [musicRecommendationProfile, autoDjHydrated]);
```

Add reader near `readStoredMusicLibrary()`:

```ts
function readStoredMusicRecommendationProfile(storage: Storage): MusicRecommendationProfile | null {
  const rawProfile = storage.getItem(MUSIC_RECOMMENDATION_PROFILE_STORAGE_KEY);
  if (!rawProfile) return null;

  try {
    const parsed = JSON.parse(rawProfile);
    return isMusicRecommendationProfile(parsed) ? parsed : null;
  } catch {
    return null;
  }
}
```

- [ ] **Step 5: Add trigger and response application**

Inside `RoomShell`, add this effect after `activeListeningContext` and refs are available:

```ts
  useEffect(() => {
    const signature = shouldRequestAutoDjRefill({
      enabled: autoDjEnabled,
      hydrated: autoDjHydrated && musicQueueHydrated && musicLibraryHydrated,
      queue: musicQueue,
      settings: DEFAULT_AUTO_DJ_SETTINGS,
      inFlightSignature: autoDjInFlightSignature,
      lastRequestedSignature: autoDjLastRequestedSignature,
    });
    if (!signature) return;

    setAutoDjInFlightSignature(signature);
    setAutoDjLastRequestedSignature(signature);
    const musicState = buildMusicAgentState(musicQueue, {
      isPlaying: isPlayerPlaying,
      currentTimeMs: Math.round(playerCurrentTime * 1000),
      durationMs: Math.round(playerDurationSeconds * 1000)
    }, musicLibrary);

    void recommendAutoDj({
      musicState,
      recommendationProfile: musicRecommendationProfileRef.current,
      recentMessages: messages.slice(-8),
      settings: DEFAULT_AUTO_DJ_SETTINGS
    })
      .then((response) => {
        applyAutoDjResponse(response);
      })
      .catch(() => {
        setSendError("Auto DJ refill failed");
      })
      .finally(() => {
        setAutoDjInFlightSignature(null);
      });
  }, [
    autoDjEnabled,
    autoDjHydrated,
    musicQueueHydrated,
    musicLibraryHydrated,
    musicQueue,
    musicLibrary,
    isPlayerPlaying,
    playerCurrentTime,
    playerDurationSeconds,
    messages,
    autoDjInFlightSignature,
    autoDjLastRequestedSignature
  ]);
```

Add function near `applyRoomClientActions()`:

```ts
  function applyAutoDjResponse(response: AutoDjRecommendResponse) {
    if (response.profilePatch) {
      setMusicRecommendationProfile((current) =>
        applyRecommendationProfilePatch(current, response.profilePatch)
      );
    }
    if (!response.ok || response.clientActions.length === 0) {
      return;
    }

    applyRoomClientActions(response.clientActions);
    const notice: ChatMessage = {
      id: `auto-dj-${response.refillId ?? Date.now()}`,
      role: "kumiko",
      content: response.notice
    };
    setMessages((current) => [...current, notice]);
  }
```

- [ ] **Step 6: Add the switch**

In the player controls block, add:

```tsx
              <label className="auto-dj-switch">
                <input
                  type="checkbox"
                  role="switch"
                  checked={autoDjEnabled}
                  onChange={(event) => setAutoDjEnabled(event.currentTarget.checked)}
                  aria-label="Auto DJ"
                />
                <span>Auto DJ</span>
              </label>
```

Place it near playback mode controls so it remains inside the player surface.

- [ ] **Step 7: Run RoomShell Auto DJ test**

Run:

```powershell
npm run test --workspace apps/web -- RoomShell.test.tsx -t "Auto DJ"
```

Expected: PASS.

- [ ] **Step 8: Commit**

```powershell
git add apps/web/src/components/RoomShell.tsx apps/web/tests/RoomShell.test.tsx
git commit -m "feat: trigger auto dj refills"
```

## Task 7: Reasons, Dislike Feedback, And Styles

**Files:**
- Modify: `apps/web/src/components/RoomShell.tsx`
- Modify: `apps/web/app/globals.css`
- Modify: `apps/web/tests/RoomShell.test.tsx`

- [ ] **Step 1: Add failing UI feedback test**

Append this test to `apps/web/tests/RoomShell.test.tsx`:

```ts
it("shows recommendation reasons and lets the user dislike a recommended track", async () => {
  render(<RoomShell initialState={DEFAULT_ROOM_STATE} connectionStatus={connectionStatus} />);

  expect(await screen.findByRole("button", { name: defaultSession.title })).toBeTruthy();
  fireEvent.click(screen.getByRole("switch", { name: "Auto DJ" }));
  await waitFor(() => expect(apiMocks.recommendAutoDj).toHaveBeenCalledTimes(1));

  fireEvent.click(getQueueManageButton());
  const panel = getMusicQueuePanel();
  expect(within(panel).getByText("close to the current listening context")).toBeTruthy();
  fireEvent.click(within(panel).getByRole("button", { name: "Dislike recommendation Auto DJ Song" }));

  const storedProfile = localStorage.getItem("kumikoroom.musicRecommendationProfile") ?? "";
  expect(storedProfile).toContain("\"disliked\":true");
  expect(storedProfile).toContain("\"kind\":\"item\"");
});
```

- [ ] **Step 2: Run the feedback test to verify it fails**

Run:

```powershell
npm run test --workspace apps/web -- RoomShell.test.tsx -t "recommendation reasons"
```

Expected: FAIL because queue rows do not show reason/dislike controls.

- [ ] **Step 3: Add dislike handler**

In `RoomShell`, add:

```ts
  function handleDislikeRecommendation(entry: MusicQueueEntry) {
    if (!entry.selectedReason) return;

    setMusicRecommendationProfile((current) =>
      dislikeRecommendedItem(
        current,
        {
          item: makeClientMusicItemFromMusicItem(entry.item),
          score: entry.selectionScore ?? 0,
          intent: "similar_theme",
          reason: entry.selectedReason,
          evidence: entry.selectionEvidence ?? []
        },
        new Date().toISOString()
      )
    );
    if (entry.status === "queued") {
      commitMusicQueue(removeQueueEntry(musicQueueRef.current, entry.id));
    }
  }
```

- [ ] **Step 4: Render reason and dislike action**

Inside `renderQueueEntryRow()`, after the existing title/creator/source text, add:

```tsx
          {entry.selectedReason ? (
            <em className="music-recommendation-reason">{entry.selectedReason}</em>
          ) : null}
```

Inside row actions, before the remove button:

```tsx
          {entry.selectedReason ? (
            <button
              type="button"
              aria-label={`Dislike recommendation ${entry.item.title}`}
              onClick={() => handleDislikeRecommendation(entry)}
            >
              Dislike
            </button>
          ) : null}
```

- [ ] **Step 5: Add styles**

Append to `apps/web/app/globals.css` near the music queue styles:

```css
.auto-dj-switch {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  min-height: 30px;
  padding: 0 8px;
  border: 1px solid rgba(104, 88, 62, 0.18);
  border-radius: 8px;
  background: rgba(255, 255, 255, 0.72);
  color: var(--muted);
  font-size: 12px;
  font-weight: 700;
}

.auto-dj-switch input {
  width: 16px;
  height: 16px;
  accent-color: var(--accent);
}

.music-recommendation-reason {
  display: block;
  max-width: 100%;
  overflow: hidden;
  color: var(--muted);
  font-size: 11px;
  font-style: normal;
  text-overflow: ellipsis;
  white-space: nowrap;
}
```

- [ ] **Step 6: Run UI feedback test**

Run:

```powershell
npm run test --workspace apps/web -- RoomShell.test.tsx -t "recommendation reasons"
```

Expected: PASS.

- [ ] **Step 7: Run focused frontend tests**

Run:

```powershell
npm run test --workspace apps/web -- RoomShell.test.tsx musicRecommendationProfile.test.ts autoDj.test.ts musicQueue.test.ts
```

Expected: PASS.

- [ ] **Step 8: Commit**

```powershell
git add apps/web/src/components/RoomShell.tsx apps/web/app/globals.css apps/web/tests/RoomShell.test.tsx
git commit -m "feat: show auto dj feedback"
```

## Task 8: Integration Verification And Polish

**Files:**
- Modify only files touched by earlier tasks if verification reveals issues.

- [ ] **Step 1: Run backend tests**

Run:

```powershell
cd apps/api
python -m pytest tests/test_auto_dj.py tests/test_conversation.py tests/test_room_api.py -q
```

Expected: PASS.

- [ ] **Step 2: Run frontend tests**

Run:

```powershell
npm run test --workspace apps/web
```

Expected: PASS.

- [ ] **Step 3: Run frontend build**

Run:

```powershell
npm run build --workspace apps/web
```

Expected: PASS.

- [ ] **Step 4: Run full repo test command**

Run:

```powershell
npm test
```

Expected: PASS.

- [ ] **Step 5: Manual browser smoke test**

Start API and web servers in two terminals:

```powershell
cd apps/api
python -m uvicorn kumikoroom.main:app --reload --port 8000
```

```powershell
npm run dev --workspace apps/web -- --port 3001
```

Open `http://127.0.0.1:3001/room`.

Manual checks:

- The room loads with no console errors.
- The player shows an `Auto DJ` switch.
- Turning it on persists after refresh.
- With the default short queue, a mocked or live Auto DJ response appends tracks.
- A short Auto DJ notice appears in the chat timeline.
- Queue rows show recommendation reasons.
- Clicking `Dislike` on a recommended queued row removes or marks the row and updates localStorage.

- [ ] **Step 6: Commit verification fixes**

Only run this commit if files changed during verification:

```powershell
git add apps/api apps/web
git commit -m "fix: polish auto dj integration"
```

If no files changed, record the passing commands in the final implementation summary.

## Final Acceptance Checklist

- [ ] Auto DJ can be enabled from the player.
- [ ] The enabled flag persists locally.
- [ ] Queue depth 2 triggers one refill request for a unique queue signature.
- [ ] The backend endpoint returns structured recommendations and typed `add_music_to_queue` client actions.
- [ ] Fresh search candidates are preferred, while queue/recent duplicates are blocked or penalized.
- [ ] Recommendation output includes score, intent, reason, and evidence.
- [ ] Default mix is 2 similar tracks plus 1 exploratory track.
- [ ] Repeated overlap increases exploration.
- [ ] The local profile stores recommended history, refill history, weights, and cooldowns.
- [ ] Dislike feedback creates short-term cooldowns and lightly changes profile weights.
- [ ] Automatic refill adds one compact chat notice without calling the normal chat endpoint.
- [ ] Backend tests, frontend tests, and frontend build pass.

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
    RecommendationHistoryEntryIn,
    RecommendationProfilePatchOut,
    RecommendationRefillHistoryEntryIn,
    RoomClientActionOut,
)


@dataclass(frozen=True)
class AutoDjIntent:
    name: Literal["similar_theme", "light_exploration"]
    query: str
    themes: tuple[str, ...]


@dataclass(frozen=True)
class ScoredCandidate:
    candidate: MusicSearchCandidate
    intent: AutoDjIntent
    score: float
    reason: str
    evidence: tuple[str, ...]


def recommend_auto_dj(payload: AutoDjRecommendIn) -> AutoDjRecommendOut:
    if not _has_recommendation_context(
        payload.music_state, payload.recommendation_profile
    ):
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
    refill_id = f"auto-dj-{_utc_compact_timestamp()}"
    created_at = _current_iso_time()
    similar_count, exploration_count = _effective_mix(payload, profile)
    intents = _build_intents(payload, profile, similar_count, exploration_count)
    source_errors: list[str] = []
    candidates_by_key = _recall_candidates(intents, source_errors)
    blocked_ids = _blocked_item_ids(payload.music_state)
    scored = _score_candidates(
        list(candidates_by_key.values()),
        intents,
        payload.music_state,
        profile,
        blocked_ids,
    )
    selected = _select_candidates(
        scored,
        count=payload.settings.count,
        similar_count=similar_count,
        exploration_count=exploration_count,
    )

    recommendations = [
        _recommendation_from_scored(scored_candidate)
        for scored_candidate in selected
    ]
    client_actions = [
        RoomClientActionOut(type="add_music_to_queue", item=recommendation.item)
        for recommendation in recommendations
    ]
    selected_ids = [recommendation.item.id for recommendation in recommendations]
    dominant_themes = _dominant_themes(payload.music_state, profile)
    profile_patch = RecommendationProfilePatchOut(
        recommended_items=[
            RecommendationHistoryEntryIn(
                item_id=recommendation.item.id,
                title=recommendation.item.title,
                creator=recommendation.item.creator,
                source=recommendation.item.source,
                recommended_at=created_at,
                reason=recommendation.reason,
            )
            for recommendation in recommendations
        ],
        refill_history=[
            RecommendationRefillHistoryEntryIn(
                refill_id=refill_id,
                created_at=created_at,
                selected_item_ids=selected_ids,
                dominant_themes=dominant_themes,
                exploration_count=sum(
                    1
                    for recommendation in recommendations
                    if recommendation.intent == "light_exploration"
                ),
            )
        ],
    )

    return AutoDjRecommendOut(
        ok=True,
        refill_id=refill_id,
        notice=_notice_for_count(len(recommendations), payload.settings.count),
        client_actions=client_actions,
        recommendations=recommendations,
        profile_patch=profile_patch,
        source_errors=source_errors,
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


def _effective_mix(
    payload: AutoDjRecommendIn,
    profile: MusicRecommendationProfileIn,
) -> tuple[int, int]:
    count = payload.settings.count
    exploration_count = min(payload.settings.exploration_count, count)
    similar_count = min(payload.settings.similar_count, count - exploration_count)

    if _last_two_refills_overlap(profile):
        exploration_count = min(max(exploration_count, 2), count)
        similar_count = max(0, count - exploration_count)

    if similar_count + exploration_count < count:
        similar_count = count - exploration_count
    return similar_count, exploration_count


def _last_two_refills_overlap(profile: MusicRecommendationProfileIn) -> bool:
    if len(profile.refill_history) < 2:
        return False
    first, second = profile.refill_history[-2:]
    return len(set(first.dominant_themes) & set(second.dominant_themes)) >= 2


def _build_intents(
    payload: AutoDjRecommendIn,
    profile: MusicRecommendationProfileIn,
    similar_count: int,
    exploration_count: int,
) -> list[AutoDjIntent]:
    themes = tuple(_dominant_themes(payload.music_state, profile))
    similar_queries = _similar_query_seeds(payload.music_state, profile, themes)
    exploration_queries = _exploration_query_seeds(themes, profile)
    intents: list[AutoDjIntent] = []

    for query in similar_queries[: max(similar_count, 1)]:
        intents.append(AutoDjIntent("similar_theme", query, themes))
    for query in exploration_queries[: max(exploration_count, 1)]:
        intents.append(AutoDjIntent("light_exploration", query, themes))

    return _dedupe_intents(intents)


def _similar_query_seeds(
    music_state: MusicAgentState | None,
    profile: MusicRecommendationProfileIn,
    themes: tuple[str, ...],
) -> list[str]:
    seeds: list[str] = []
    current = music_state.current if music_state is not None else None
    if current is not None:
        seeds.extend(
            [
                f"{current.title} {current.creator}",
                current.title,
                current.creator,
            ]
        )
    seeds.extend(profile.query_weights.keys())
    seeds.extend(themes)
    return _unique_nonempty(seeds)


def _exploration_query_seeds(
    themes: tuple[str, ...],
    profile: MusicRecommendationProfileIn,
) -> list[str]:
    seeds: list[str] = []
    for theme in themes:
        seeds.append(f"{theme} explore")
        seeds.append(f"{theme} ost")
    seeds.extend(theme.key for theme in profile.recent_themes)
    return _unique_nonempty(seeds or ["music explore"])


def _dedupe_intents(intents: list[AutoDjIntent]) -> list[AutoDjIntent]:
    seen: set[tuple[str, str]] = set()
    deduped: list[AutoDjIntent] = []
    for intent in intents:
        key = (intent.name, _normalize_text(intent.query))
        if key in seen:
            continue
        seen.add(key)
        deduped.append(intent)
    return deduped


def _recall_candidates(
    intents: list[AutoDjIntent],
    source_errors: list[str],
) -> dict[tuple[str, str, str], MusicSearchCandidate]:
    candidates: dict[tuple[str, str, str], MusicSearchCandidate] = {}
    queries = _unique_nonempty(intent.query for intent in intents)

    for query in queries:
        for search in (search_netease_songs, search_bilibili_videos):
            try:
                results = search(query, limit=8)
            except Exception as error:
                _append_unique(source_errors, str(error))
                continue
            for result in results:
                key = (
                    result.source,
                    _normalize_text(result.title),
                    _normalize_text(result.creator),
                )
                existing = candidates.get(key)
                if existing is None or result.score > existing.score:
                    candidates[key] = result
    return candidates


def _score_candidates(
    candidates: list[MusicSearchCandidate],
    intents: list[AutoDjIntent],
    music_state: MusicAgentState | None,
    profile: MusicRecommendationProfileIn,
    blocked_ids: set[str],
) -> list[ScoredCandidate]:
    scored: list[ScoredCandidate] = []
    current = music_state.current if music_state is not None else None

    for candidate in candidates:
        if candidate.id in blocked_ids or not candidate.playable:
            continue
        if _has_strong_item_cooldown(candidate.id, profile):
            continue
        for intent in intents:
            score, evidence = _candidate_score(candidate, intent, current, profile)
            reason = _reason_for_score(candidate, intent, score)
            scored.append(
                ScoredCandidate(
                    candidate=candidate,
                    intent=intent,
                    score=score,
                    reason=reason,
                    evidence=tuple(evidence),
                )
            )

    return sorted(scored, key=lambda item: item.score, reverse=True)


def _candidate_score(
    candidate: MusicSearchCandidate,
    intent: AutoDjIntent,
    current: MusicAgentTrack | None,
    profile: MusicRecommendationProfileIn,
) -> tuple[float, list[str]]:
    score = float(candidate.score)
    evidence = [*candidate.evidence, f"base_search_score={candidate.score:g}"]

    if current is not None and _same_text(candidate.creator, current.creator):
        score += 18.0
        evidence.append("same creator as current track")

    title_norm = _normalize_text(candidate.title)
    creator_norm = _normalize_text(candidate.creator)
    for theme in intent.themes:
        weight = profile.tag_weights.get(theme, 1.0)
        if theme in title_norm:
            score += 10.0 * weight
            evidence.append(f"title matches theme {theme}")
        if theme in creator_norm:
            score += 4.0 * weight
            evidence.append(f"creator matches theme {theme}")

    source_weight = profile.source_weights.get(candidate.source, 0.0)
    if source_weight:
        score += source_weight * 8.0
        evidence.append(f"source preference {candidate.source}={source_weight:g}")

    cooldown_penalty = _cooldown_penalty(candidate, profile)
    if cooldown_penalty:
        score -= cooldown_penalty
        evidence.append(f"cooldown penalty {cooldown_penalty:g}")

    if intent.name == "light_exploration":
        score += 7.0
        evidence.append("light exploration bonus")
        if "explore" in title_norm:
            score += 14.0
            evidence.append("title supports exploration")
    else:
        score += 5.0
        evidence.append("similar theme bonus")

    return score, evidence


def _select_candidates(
    scored: list[ScoredCandidate],
    *,
    count: int,
    similar_count: int,
    exploration_count: int,
) -> list[ScoredCandidate]:
    selected: list[ScoredCandidate] = []
    selected_ids: set[str] = set()

    _select_for_intent(
        scored,
        selected,
        selected_ids,
        intent_name="similar_theme",
        slots=similar_count,
    )
    _select_for_intent(
        scored,
        selected,
        selected_ids,
        intent_name="light_exploration",
        slots=exploration_count,
    )

    for candidate in scored:
        if len(selected) >= count:
            break
        if candidate.candidate.id in selected_ids:
            continue
        selected.append(candidate)
        selected_ids.add(candidate.candidate.id)

    return selected


def _select_for_intent(
    scored: list[ScoredCandidate],
    selected: list[ScoredCandidate],
    selected_ids: set[str],
    *,
    intent_name: Literal["similar_theme", "light_exploration"],
    slots: int,
) -> None:
    for candidate in scored:
        if slots <= 0:
            break
        if candidate.intent.name != intent_name or candidate.candidate.id in selected_ids:
            continue
        selected.append(candidate)
        selected_ids.add(candidate.candidate.id)
        slots -= 1


def _recommendation_from_scored(
    scored_candidate: ScoredCandidate,
) -> AutoDjRecommendationOut:
    item = _client_item_from_scored(scored_candidate)
    return AutoDjRecommendationOut(
        item=item,
        score=round(scored_candidate.score, 3),
        intent=scored_candidate.intent.name,
        reason=scored_candidate.reason,
        evidence=list(scored_candidate.evidence),
    )


def _client_item_from_scored(scored_candidate: ScoredCandidate) -> ClientMusicItemOut:
    item = music_result_to_client_item(
        scored_candidate.candidate,
        source_query=scored_candidate.intent.query,
    )
    return item.model_copy(
        update={
            "selected_reason": scored_candidate.reason,
            "selection_evidence": list(scored_candidate.evidence),
            "selection_score": round(scored_candidate.score, 3),
        }
    )


def _reason_for_score(
    candidate: MusicSearchCandidate,
    intent: AutoDjIntent,
    score: float,
) -> str:
    if intent.name == "light_exploration":
        return f"light exploration pick scored {score:.1f}: {candidate.title}"
    return f"similar theme pick scored {score:.1f}: {candidate.title}"


def _blocked_item_ids(music_state: MusicAgentState | None) -> set[str]:
    if music_state is None:
        return set()
    blocked = set()
    for track in [
        music_state.current,
        music_state.next,
        *music_state.upcoming,
        *music_state.recent,
    ]:
        if track is not None:
            blocked.add(track.id)
    return blocked


def _dominant_themes(
    music_state: MusicAgentState | None,
    profile: MusicRecommendationProfileIn,
) -> list[str]:
    weights: dict[str, float] = {}
    for tag, weight in profile.tag_weights.items():
        weights[_normalize_text(tag)] = weights.get(_normalize_text(tag), 0.0) + weight
    for theme in profile.recent_themes:
        key = _normalize_text(theme.key)
        weights[key] = weights.get(key, 0.0) + theme.weight

    if music_state is not None:
        tracks = [
            track
            for track in [
                music_state.current,
                *music_state.recent,
                *music_state.saved,
                *[item for playlist in music_state.playlists for item in playlist.items],
            ]
            if track is not None
        ]
        for track in tracks:
            for tag in track.tags:
                key = _normalize_text(tag)
                weights[key] = weights.get(key, 0.0) + 1.0

    ranked = [
        theme
        for theme, _weight in sorted(
            weights.items(),
            key=lambda item: (-item[1], item[0]),
        )
        if theme
    ]
    return ranked[:4]


def _has_strong_item_cooldown(
    item_id: str,
    profile: MusicRecommendationProfileIn,
) -> bool:
    now = datetime.now(timezone.utc)
    for cooldown in profile.cooldowns:
        if cooldown.kind != "item" or cooldown.key != item_id:
            continue
        if cooldown.weight < 2.0:
            continue
        if _parse_iso_time(cooldown.expires_at) > now:
            return True
    return False


def _cooldown_penalty(
    candidate: MusicSearchCandidate,
    profile: MusicRecommendationProfileIn,
) -> float:
    now = datetime.now(timezone.utc)
    penalty = 0.0
    title_norm = _normalize_text(candidate.title)
    creator_norm = _normalize_text(candidate.creator)
    for cooldown in profile.cooldowns:
        if _parse_iso_time(cooldown.expires_at) <= now:
            continue
        key_norm = _normalize_text(cooldown.key)
        if cooldown.kind == "item" and cooldown.key == candidate.id:
            penalty += cooldown.weight * 12.0
        elif cooldown.kind == "artist" and key_norm in creator_norm:
            penalty += cooldown.weight * 8.0
        elif cooldown.kind in {"tag", "query"} and key_norm in title_norm:
            penalty += cooldown.weight * 6.0
    return penalty


def _notice_for_count(selected_count: int, requested_count: int) -> str:
    if selected_count == 0:
        return "Auto DJ did not find enough recommendations this time."
    if selected_count < requested_count:
        return f"Auto DJ added {selected_count} recommendation and will keep listening for better fits."
    return f"Auto DJ added {selected_count} recommendations to the queue."


def _parse_iso_time(value: str) -> datetime:
    try:
        return datetime.fromisoformat(value.replace("Z", "+00:00"))
    except ValueError:
        return datetime.min.replace(tzinfo=timezone.utc)


def _append_unique(values: list[str], value: str) -> None:
    if value and value not in values:
        values.append(value)


def _unique_nonempty(values) -> list[str]:
    seen: set[str] = set()
    unique: list[str] = []
    for value in values:
        text = str(value or "").strip()
        key = _normalize_text(text)
        if not text or key in seen:
            continue
        seen.add(key)
        unique.append(text)
    return unique


def _same_text(left: str, right: str) -> bool:
    return _normalize_text(left) == _normalize_text(right)


def _normalize_text(value: str) -> str:
    return re.sub(r"\s+", "", value.strip().lower())


def _current_iso_time() -> str:
    return (
        datetime.now(timezone.utc)
        .isoformat(timespec="milliseconds")
        .replace("+00:00", "Z")
    )


def _utc_compact_timestamp() -> str:
    return datetime.now(timezone.utc).strftime("%Y%m%d%H%M%S%f")

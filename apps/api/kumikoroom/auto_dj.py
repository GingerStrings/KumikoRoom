from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime, timezone
import logging
import re
from collections import Counter
from typing import Literal, Protocol

from kumikoroom.agent_tools import music_result_to_client_item
from kumikoroom.auto_dj_planning import (
    AutoDjQueryPlan,
    AutoDjQueryPlanningContext,
    AutoDjSearchFeedback,
    AutoDjSelection,
    AutoDjSelectionCandidate,
    AutoDjSelectionContext,
    PlanningError,
    _SIMILAR_INTENTS,
    is_generic_query,
)
from kumikoroom.music_search import (
    MusicSearchCandidate,
    search_bilibili_videos,
    search_netease_songs,
)
from kumikoroom.schemas import (
    AutoDjRecommendIn,
    AutoDjRecommendationOut,
    AutoDjRecommendOut,
    AutoDjTraceCandidateOut,
    AutoDjTraceOut,
    ClientMusicItemOut,
    MusicAgentState,
    MusicAgentTrack,
    MusicRecommendationProfileIn,
    RecommendationIntentKind,
    RecommendationHistoryEntryIn,
    RecommendationProfilePatchOut,
    RecommendationRefillHistoryEntryIn,
    RoomClientActionOut,
)


logger = logging.getLogger(__name__)


IntentSelectionGroup = Literal["similar", "exploration"]


@dataclass(frozen=True)
class AutoDjIntent:
    name: str
    selection_group: IntentSelectionGroup
    query: str
    themes: tuple[str, ...]


@dataclass(frozen=True)
class RecalledCandidate:
    result: MusicSearchCandidate
    intent: AutoDjIntent
    query: str


@dataclass(frozen=True)
class ScoredCandidate:
    recalled: RecalledCandidate
    score: float
    reason: str
    evidence: tuple[str, ...]


@dataclass(frozen=True)
class AutoDjRecallQueryReport:
    attempt: int
    query: str
    intent: RecommendationIntentKind
    candidate_count: int
    source_errors: tuple[str, ...] = ()


@dataclass(frozen=True)
class AutoDjRecallResult:
    candidates: dict[tuple[str, str, str, str], RecalledCandidate]
    reports: tuple[AutoDjRecallQueryReport, ...]


class AutoDjQueryPlanner(Protocol):
    def plan_auto_dj_queries(
        self, context: AutoDjQueryPlanningContext
    ) -> AutoDjQueryPlan: ...


class AutoDjRecommendationSelector(Protocol):
    def select_auto_dj_recommendations(
        self, context: AutoDjSelectionContext
    ) -> AutoDjSelection: ...


MAX_AUTO_DJ_SEARCH_ATTEMPTS = 3
MAX_AUTO_DJ_SELECTION_CANDIDATES = 24


def recommend_auto_dj(
    payload: AutoDjRecommendIn, *, planner: AutoDjQueryPlanner | None = None
) -> AutoDjRecommendOut:
    sanitized_profile = _sanitize_profile(
        payload.recommendation_profile or MusicRecommendationProfileIn()
    )

    if not _has_recommendation_context(payload.music_state, sanitized_profile):
        return _needs_more_context_response()

    if planner is None:
        return _query_planning_failed_response("no planner provided")

    refill_id = f"auto-dj-{_utc_compact_timestamp()}"
    created_at = _current_iso_time()

    similar_count, exploration_count = _effective_mix(payload, sanitized_profile)
    source_errors: list[str] = []
    blocked_ids = _blocked_item_ids(payload.music_state, sanitized_profile)
    recent_messages = tuple((msg.role, msg.content) for msg in payload.recent_messages)
    search_feedback: list[AutoDjSearchFeedback] = []
    planner_queries = []
    recalled_by_key: dict[tuple[str, str, str, str], RecalledCandidate] = {}
    scored: list[ScoredCandidate] = []
    last_planning_error: str | None = None

    for attempt in range(1, MAX_AUTO_DJ_SEARCH_ATTEMPTS + 1):
        context = AutoDjQueryPlanningContext(
            music_state=payload.music_state,
            profile=sanitized_profile,
            recent_messages=recent_messages,
            settings=payload.settings,
            search_feedback=tuple(search_feedback),
        )
        try:
            plan = planner.plan_auto_dj_queries(context)
        except PlanningError as exc:
            logger.warning("auto dj query planning failed: %s", exc)
            last_planning_error = str(exc)
            break

        intents = _intents_from_plan(plan)
        if not intents:
            last_planning_error = "plan produced no intents"
            break

        planner_queries.extend(plan.queries)
        recall_result = _recall_candidates(
            intents,
            source_errors,
            attempt=attempt,
        )
        recalled_by_key.update(recall_result.candidates)
        scored = _score_candidates(
            list(recalled_by_key.values()),
            payload.music_state,
            sanitized_profile,
            blocked_ids,
        )
        search_feedback.extend(_feedback_from_recall_result(recall_result, scored))

        if len(_best_scored_by_identity(scored)) >= payload.settings.count:
            break

    plan = AutoDjQueryPlan(queries=tuple(planner_queries))
    if last_planning_error and not planner_queries:
        return _query_planning_failed_response(last_planning_error)

    selected = _select_candidates_with_llm(
        planner,
        scored,
        payload=payload,
        sanitized_profile=sanitized_profile,
        recent_messages=recent_messages,
        search_feedback=tuple(search_feedback),
        similar_count=similar_count,
        exploration_count=exploration_count,
        source_errors=source_errors,
    )

    if not selected:
        return _no_qualified_candidates_response(
            source_errors,
            plan,
            len(recalled_by_key),
            scored,
        )

    return _build_success_response(
        payload,
        selected,
        source_errors,
        sanitized_profile,
        refill_id,
        created_at,
        plan,
        len(recalled_by_key),
        scored,
    )


def _empty_profile_patch() -> RecommendationProfilePatchOut:
    return RecommendationProfilePatchOut()


def _needs_more_context_response() -> AutoDjRecommendOut:
    return AutoDjRecommendOut(
        ok=False,
        refill_id=None,
        notice="Auto DJ needs a current track or listening profile before it can recommend.",
        client_actions=[],
        recommendations=[],
        profile_patch=_empty_profile_patch(),
        error="needs_more_context",
        trace=AutoDjTraceOut(error="needs_more_context"),
    )


def _query_planning_failed_response(detail: str) -> AutoDjRecommendOut:
    return AutoDjRecommendOut(
        ok=False,
        refill_id=None,
        notice="Auto DJ 暂时没找到合适的歌",
        client_actions=[],
        recommendations=[],
        profile_patch=_empty_profile_patch(),
        error="query_planning_failed",
        trace=AutoDjTraceOut(error=detail or "query_planning_failed"),
    )


def _no_qualified_candidates_response(
    source_errors: list[str],
    plan: AutoDjQueryPlan,
    candidate_count: int,
    scored: list[ScoredCandidate],
) -> AutoDjRecommendOut:
    return AutoDjRecommendOut(
        ok=False,
        refill_id=None,
        notice="Auto DJ found no qualified recommendations this time.",
        client_actions=[],
        recommendations=[],
        profile_patch=_empty_profile_patch(),
        error="no_qualified_candidates",
        source_errors=source_errors,
        trace=_build_auto_dj_trace(
            plan=plan,
            candidate_count=candidate_count,
            scored=scored,
            selected=[],
            source_errors=source_errors,
            error="no_qualified_candidates",
        ),
    )


def _build_success_response(
    payload: AutoDjRecommendIn,
    selected: list[ScoredCandidate],
    source_errors: list[str],
    sanitized_profile: MusicRecommendationProfileIn,
    refill_id: str,
    created_at: str,
    plan: AutoDjQueryPlan,
    candidate_count: int,
    scored: list[ScoredCandidate],
) -> AutoDjRecommendOut:
    recommendations = [
        _recommendation_from_scored(scored_candidate)
        for scored_candidate in selected
    ]
    client_actions = [
        RoomClientActionOut(type="add_music_to_queue", item=recommendation.item)
        for recommendation in recommendations
    ]
    selected_ids = [recommendation.item.id for recommendation in recommendations]
    dominant_themes = _dominant_themes(payload.music_state, sanitized_profile)
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
        trace=_build_auto_dj_trace(
            plan=plan,
            candidate_count=candidate_count,
            scored=scored,
            selected=selected,
            source_errors=source_errors,
        ),
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



def _intents_from_plan(plan: AutoDjQueryPlan) -> list[AutoDjIntent]:
    intents: list[AutoDjIntent] = []
    for entry in plan.queries:
        group: IntentSelectionGroup = (
            "similar" if entry.intent in _SIMILAR_INTENTS else "exploration"
        )
        intents.append(
            AutoDjIntent(
                name=entry.intent,
                selection_group=group,
                query=entry.query,
                themes=entry.themes,
            )
        )
    return intents


def _recall_candidates(
    intents: list[AutoDjIntent],
    source_errors: list[str],
    *,
    attempt: int,
) -> AutoDjRecallResult:
    candidates: dict[tuple[str, str, str, str], RecalledCandidate] = {}
    reports: list[AutoDjRecallQueryReport] = []
    logger.info("auto dj search queries: %s", [intent.query for intent in intents])

    for intent in intents:
        query = intent.query
        query_errors: list[str] = []
        try:
            results = search_netease_songs(query, limit=8)
        except Exception as error:
            message = str(error)
            _append_unique(source_errors, message)
            query_errors.append(message)
            results = []
        reports.append(
            AutoDjRecallQueryReport(
                attempt=attempt,
                query=query,
                intent=intent.name,
                candidate_count=len(results),
                source_errors=tuple(query_errors),
            )
        )
        if not results:
            continue
        for result in results:
            key = (
                result.source,
                _normalize_text(result.title),
                _normalize_text(result.creator),
                intent.name,
            )
            existing = candidates.get(key)
            if existing is None or result.score > existing.result.score:
                candidates[key] = RecalledCandidate(
                    result=result,
                    intent=intent,
                    query=query,
                )
    return AutoDjRecallResult(candidates=candidates, reports=tuple(reports))


def _score_candidates(
    recalled_candidates: list[RecalledCandidate],
    music_state: MusicAgentState | None,
    profile: MusicRecommendationProfileIn,
    blocked_ids: set[str],
) -> list[ScoredCandidate]:
    scored: list[ScoredCandidate] = []
    current = music_state.current if music_state is not None else None

    for recalled in recalled_candidates:
        candidate = recalled.result
        if candidate.id in blocked_ids or not candidate.playable:
            continue
        if _has_active_hard_cooldown(recalled, profile):
            continue
        score, evidence = _candidate_score(
            candidate,
            recalled.intent,
            current,
            profile,
        )
        reason = _reason_for_score(candidate, recalled.intent, score)
        scored.append(
            ScoredCandidate(
                recalled=recalled,
                score=score,
                reason=reason,
                evidence=tuple(evidence),
            )
        )

    return sorted(scored, key=lambda item: item.score, reverse=True)


def _feedback_from_recall_result(
    recall_result: AutoDjRecallResult,
    scored: list[ScoredCandidate],
) -> list[AutoDjSearchFeedback]:
    qualified_by_query = Counter(
        (candidate.recalled.query, candidate.recalled.intent.name)
        for candidate in scored
    )
    return [
        AutoDjSearchFeedback(
            attempt=report.attempt,
            query=report.query,
            intent=report.intent,
            candidate_count=report.candidate_count,
            qualified_count=qualified_by_query.get((report.query, report.intent), 0),
            source_errors=report.source_errors,
        )
        for report in recall_result.reports
    ]


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
    for artist, weight in profile.artist_weights.items():
        artist_norm = _normalize_text(artist)
        if artist_norm and artist_norm in creator_norm:
            score += 12.0 * weight
            evidence.append(f"artist preference {artist}={weight:g}")

    for theme in intent.themes:
        theme_norm = _normalize_text(theme)
        weight = profile.tag_weights.get(theme, profile.tag_weights.get(theme_norm, 1.0))
        if theme_norm in title_norm:
            score += 10.0 * weight
            evidence.append(f"title matches theme {theme}")
        if theme_norm in creator_norm:
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

    if intent.selection_group == "exploration":
        score += 7.0
        evidence.append("exploration bonus")
    else:
        score += 5.0
        evidence.append("similar bonus")

    return score, evidence


def _select_candidates(
    scored: list[ScoredCandidate],
    *,
    count: int,
    similar_count: int,
    exploration_count: int,
) -> list[ScoredCandidate]:
    scored = _best_scored_by_identity(scored)
    selected: list[ScoredCandidate] = []
    selected_ids: set[str] = set()
    selected_keys: set[tuple[str, str, str]] = set()

    _select_for_intent(
        scored,
        selected,
        selected_ids,
        selected_keys,
        selection_group="similar",
        slots=similar_count,
    )
    _select_for_intent(
        scored,
        selected,
        selected_ids,
        selected_keys,
        selection_group="exploration",
        slots=exploration_count,
    )

    for candidate in scored:
        if len(selected) >= count:
            break
        candidate_key = _candidate_identity_key(candidate)
        if (
            candidate.recalled.result.id in selected_ids
            or candidate_key in selected_keys
        ):
            continue
        selected.append(candidate)
        selected_ids.add(candidate.recalled.result.id)
        selected_keys.add(candidate_key)

    return _ensure_source_mix(selected, scored, count=count)


def _select_candidates_with_llm(
    planner: AutoDjQueryPlanner,
    scored: list[ScoredCandidate],
    *,
    payload: AutoDjRecommendIn,
    sanitized_profile: MusicRecommendationProfileIn,
    recent_messages: tuple[tuple[str, str], ...],
    search_feedback: tuple[AutoDjSearchFeedback, ...],
    similar_count: int,
    exploration_count: int,
    source_errors: list[str],
) -> list[ScoredCandidate]:
    fallback = _select_candidates(
        scored,
        count=payload.settings.count,
        similar_count=similar_count,
        exploration_count=exploration_count,
    )
    selector = getattr(planner, "select_auto_dj_recommendations", None)
    if not callable(selector):
        return fallback

    selection_candidates = _selection_candidates_from_scored(scored)
    if not selection_candidates:
        return fallback

    context = AutoDjSelectionContext(
        music_state=payload.music_state,
        profile=sanitized_profile,
        recent_messages=recent_messages,
        settings=payload.settings,
        candidates=selection_candidates,
        search_feedback=search_feedback,
    )
    try:
        selection = selector(context)
    except PlanningError as exc:
        _append_unique(source_errors, f"selection failed: {exc}")
        return fallback

    selected = _apply_llm_selection(selection, scored, payload.settings.count)
    if len(selected) >= payload.settings.count:
        return selected

    selected_ids = {candidate.recalled.result.id for candidate in selected}
    for candidate in fallback:
        if len(selected) >= payload.settings.count:
            break
        if candidate.recalled.result.id in selected_ids:
            continue
        selected.append(candidate)
        selected_ids.add(candidate.recalled.result.id)
    return selected


def _selection_candidates_from_scored(
    scored: list[ScoredCandidate],
) -> tuple[AutoDjSelectionCandidate, ...]:
    candidates: list[ScoredCandidate] = []
    seen_item_ids: set[str] = set()
    for candidate in _best_scored_by_identity(scored):
        item_id = candidate.recalled.result.id
        if item_id in seen_item_ids:
            continue
        seen_item_ids.add(item_id)
        candidates.append(candidate)
        if len(candidates) >= MAX_AUTO_DJ_SELECTION_CANDIDATES:
            break
    return tuple(
        AutoDjSelectionCandidate(
            item_id=candidate.recalled.result.id,
            title=candidate.recalled.result.title,
            creator=candidate.recalled.result.creator,
            source=candidate.recalled.result.source,
            intent=candidate.recalled.intent.name,
            query=candidate.recalled.query,
            score=round(candidate.score, 3),
            evidence=candidate.evidence,
        )
        for candidate in candidates
    )


def _apply_llm_selection(
    selection: AutoDjSelection,
    scored: list[ScoredCandidate],
    count: int,
) -> list[ScoredCandidate]:
    candidates_by_id: dict[str, ScoredCandidate] = {}
    for candidate in _best_scored_by_identity(scored):
        candidates_by_id.setdefault(candidate.recalled.result.id, candidate)

    selected: list[ScoredCandidate] = []
    seen: set[str] = set()
    for item_id in selection.selected_item_ids:
        if len(selected) >= count or item_id in seen:
            continue
        candidate = candidates_by_id.get(item_id)
        if candidate is None:
            continue
        seen.add(item_id)
        reason = selection.reasons.get(item_id)
        if reason:
            selected.append(_with_llm_reason(candidate, reason))
        else:
            selected.append(candidate)
    return selected


def _with_llm_reason(candidate: ScoredCandidate, reason: str) -> ScoredCandidate:
    evidence = tuple([*candidate.evidence, reason])
    return ScoredCandidate(
        recalled=candidate.recalled,
        score=candidate.score,
        reason=reason,
        evidence=evidence,
    )


def _ensure_source_mix(
    selected: list[ScoredCandidate],
    scored: list[ScoredCandidate],
    *,
    count: int,
) -> list[ScoredCandidate]:
    if count <= 1 or not selected:
        return selected
    if any(candidate.recalled.result.source == "netease" for candidate in selected):
        return selected

    selected_ids = {candidate.recalled.result.id for candidate in selected}
    netease_candidate = next(
        (
            candidate
            for candidate in scored
            if candidate.recalled.result.source == "netease"
            and candidate.recalled.result.id not in selected_ids
        ),
        None,
    )
    if netease_candidate is None:
        return selected

    replacement = ScoredCandidate(
        recalled=netease_candidate.recalled,
        score=netease_candidate.score,
        reason=netease_candidate.reason,
        evidence=(
            *netease_candidate.evidence,
            "source mix keeps audio search results in the queue",
        ),
    )
    replacement_index = min(
        range(len(selected)),
        key=lambda index: selected[index].score,
    )
    mixed = list(selected)
    mixed[replacement_index] = replacement
    return mixed


def _best_scored_by_identity(scored: list[ScoredCandidate]) -> list[ScoredCandidate]:
    by_key: dict[tuple[str, str, str], list[ScoredCandidate]] = {}
    for candidate in scored:
        by_key.setdefault(_candidate_identity_key(candidate), []).append(candidate)

    deduped: list[ScoredCandidate] = []
    for candidates in by_key.values():
        item_ids = {candidate.recalled.result.id for candidate in candidates}
        if len(item_ids) == 1:
            deduped.extend(candidates)
            continue
        deduped.append(max(candidates, key=lambda item: item.score))
    return sorted(deduped, key=lambda item: item.score, reverse=True)


def _select_for_intent(
    scored: list[ScoredCandidate],
    selected: list[ScoredCandidate],
    selected_ids: set[str],
    selected_keys: set[tuple[str, str, str]],
    *,
    selection_group: IntentSelectionGroup,
    slots: int,
) -> None:
    for candidate in scored:
        if slots <= 0:
            break
        candidate_key = _candidate_identity_key(candidate)
        if (
            candidate.recalled.intent.selection_group != selection_group
            or candidate.recalled.result.id in selected_ids
            or candidate_key in selected_keys
        ):
            continue
        selected.append(candidate)
        selected_ids.add(candidate.recalled.result.id)
        selected_keys.add(candidate_key)
        slots -= 1


def _recommendation_from_scored(
    scored_candidate: ScoredCandidate,
) -> AutoDjRecommendationOut:
    item = _client_item_from_scored(scored_candidate)
    return AutoDjRecommendationOut(
        item=item,
        score=round(scored_candidate.score, 3),
        intent=scored_candidate.recalled.intent.name,
        reason=scored_candidate.reason,
        evidence=list(scored_candidate.evidence),
    )


def _build_auto_dj_trace(
    *,
    plan: AutoDjQueryPlan,
    candidate_count: int,
    scored: list[ScoredCandidate],
    selected: list[ScoredCandidate],
    source_errors: list[str],
    error: str | None = None,
) -> AutoDjTraceOut:
    selected_keys = {_trace_candidate_key(candidate) for candidate in selected}
    ordered_candidates = [
        *selected,
        *[
            candidate
            for candidate in scored
            if _trace_candidate_key(candidate) not in selected_keys
        ],
    ]
    return AutoDjTraceOut(
        planner_queries=[
            {
                "query": entry.query,
                "intent": entry.intent,
                "themes": list(entry.themes),
            }
            for entry in plan.queries
        ],
        candidate_count=candidate_count,
        scored_count=len(scored),
        selected_item_ids=[candidate.recalled.result.id for candidate in selected],
        candidates=[
            AutoDjTraceCandidateOut(
                item_id=candidate.recalled.result.id,
                title=candidate.recalled.result.title,
                creator=candidate.recalled.result.creator,
                source=candidate.recalled.result.source,
                query=candidate.recalled.query,
                intent=candidate.recalled.intent.name,
                score=round(candidate.score, 3),
                reason=candidate.reason,
                evidence=list(candidate.evidence),
                selected=_trace_candidate_key(candidate) in selected_keys,
            )
            for candidate in ordered_candidates[:12]
        ],
        source_errors=source_errors,
        error=error,
    )


def _trace_candidate_key(candidate: ScoredCandidate) -> tuple[str, str, str]:
    return (
        candidate.recalled.result.id,
        candidate.recalled.intent.name,
        candidate.recalled.query,
    )


def _candidate_identity_key(scored_candidate: ScoredCandidate) -> tuple[str, str, str]:
    candidate = scored_candidate.recalled.result
    return (
        candidate.source,
        _normalize_text(candidate.title),
        _normalize_text(candidate.creator),
    )


def _client_item_from_scored(scored_candidate: ScoredCandidate) -> ClientMusicItemOut:
    item = music_result_to_client_item(
        scored_candidate.recalled.result,
        source_query=scored_candidate.recalled.query,
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
    if intent.selection_group == "exploration":
        return f"exploration pick scored {score:.1f}: {candidate.title}"
    return f"similar pick scored {score:.1f}: {candidate.title}"


def _blocked_item_ids(
    music_state: MusicAgentState | None,
    profile: MusicRecommendationProfileIn,
) -> set[str]:
    blocked = set()
    if music_state is not None:
        for track in [
            music_state.current,
            music_state.next,
            *music_state.upcoming,
            *music_state.recent,
        ]:
            if track is not None:
                blocked.add(track.id)
    for history in profile.recommended_items:
        if not history.played and not history.disliked:
            blocked.add(history.item_id)
    return blocked


_METADATA_TAGS = frozenset({"agent-selected", "bilibili", "netease", "search"})


def _sanitize_profile(
    profile: MusicRecommendationProfileIn,
) -> MusicRecommendationProfileIn:
    snapshot = profile.model_copy(deep=True)
    cleaned_tag_weights = {
        key: weight
        for key, weight in snapshot.tag_weights.items()
        if _normalize_text(key) not in _METADATA_TAGS
    }
    cleaned_recent_themes = [
        theme
        for theme in snapshot.recent_themes
        if _normalize_text(theme.key) not in _METADATA_TAGS
    ]
    cleaned_query_weights = {
        key: weight
        for key, weight in snapshot.query_weights.items()
        if not is_generic_query(key)
    }
    cleaned_cooldowns = []
    for cooldown in snapshot.cooldowns:
        if cooldown.kind == "tag" and _normalize_text(cooldown.key) in _METADATA_TAGS:
            continue
        if cooldown.kind == "query" and is_generic_query(cooldown.key):
            continue
        cleaned_cooldowns.append(cooldown)

    return snapshot.model_copy(
        update={
            "tag_weights": cleaned_tag_weights,
            "recent_themes": cleaned_recent_themes,
            "query_weights": cleaned_query_weights,
            "cooldowns": cleaned_cooldowns,
        }
    )


def _dominant_themes(
    music_state: MusicAgentState | None,
    profile: MusicRecommendationProfileIn,
) -> list[str]:
    weights: dict[str, float] = {}
    for tag, weight in profile.tag_weights.items():
        key = _normalize_text(tag)
        if key in _METADATA_TAGS:
            continue
        weights[key] = weights.get(key, 0.0) + weight
    for theme in profile.recent_themes:
        key = _normalize_text(theme.key)
        if key in _METADATA_TAGS:
            continue
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
                if key in _METADATA_TAGS:
                    continue
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


def _has_active_hard_cooldown(
    recalled: RecalledCandidate,
    profile: MusicRecommendationProfileIn,
) -> bool:
    now = datetime.now(timezone.utc)
    for cooldown in profile.cooldowns:
        if _parse_iso_time(cooldown.expires_at) <= now:
            continue
        if cooldown.reason != "dislike" and cooldown.weight < 2.0:
            continue
        if _cooldown_matches(cooldown.kind, cooldown.key, recalled):
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


def _cooldown_matches(kind: str, key: str, recalled: RecalledCandidate) -> bool:
    candidate = recalled.result
    key_norm = _normalize_text(key)
    if not key_norm:
        return False
    if kind == "item":
        return key == candidate.id
    if kind == "artist":
        return key_norm in _normalize_text(candidate.creator)
    if kind == "tag":
        return key_norm in _normalize_text(candidate.title)
    if kind == "query":
        return key_norm in _normalize_text(recalled.query)
    return False


def _notice_for_count(selected_count: int, requested_count: int) -> str:
    if selected_count == 0:
        return "Auto DJ did not find enough recommendations this time."
    if selected_count < requested_count:
        noun = "recommendation" if selected_count == 1 else "recommendations"
        return f"Auto DJ added {selected_count} {noun} and will keep listening for better fits."
    noun = "recommendation" if selected_count == 1 else "recommendations"
    return f"Auto DJ added {selected_count} {noun} to the queue."


def _parse_iso_time(value: str) -> datetime:
    try:
        parsed = datetime.fromisoformat(value.replace("Z", "+00:00"))
    except ValueError:
        return datetime.min.replace(tzinfo=timezone.utc)
    if parsed.tzinfo is None:
        return parsed.replace(tzinfo=timezone.utc)
    return parsed


def _append_unique(values: list[str], value: str) -> None:
    if value and value not in values:
        values.append(value)


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

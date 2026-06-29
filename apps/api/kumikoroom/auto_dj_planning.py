from __future__ import annotations

import json
import logging
import re
from dataclasses import dataclass
from typing import Iterable

_logger = logging.getLogger(__name__)

from kumikoroom.schemas import (
    AutoDjSettingsIn,
    MusicAgentState,
    MusicRecommendationProfileIn,
    RecommendationIntentKind,
)


_ALLOWED_INTENTS: frozenset[RecommendationIntentKind] = frozenset(
    {"similar_theme", "similar_mood", "same_creator_or_work", "light_exploration"}
)
_SIMILAR_INTENTS: frozenset[RecommendationIntentKind] = frozenset(
    {"similar_theme", "similar_mood", "same_creator_or_work"}
)
_EXPLORATION_INTENTS: frozenset[RecommendationIntentKind] = frozenset(
    {"light_exploration"}
)
_GENERIC_QUERIES: frozenset[str] = frozenset(
    {"music", "songs", "song", "new music", "music explore", "explore", "playlist"}
)
_QUERY_MIN = 2
_QUERY_MAX = 120
_PLAN_MIN = 1
_PLAN_MAX = 6
_THEMES_MAX = 4


class PlanningError(RuntimeError):
    """Raised when the LLM plan is missing, malformed, or fails validation."""


@dataclass(frozen=True)
class AutoDjPlanQuery:
    query: str
    intent: RecommendationIntentKind
    themes: tuple[str, ...]


@dataclass(frozen=True)
class AutoDjQueryPlan:
    queries: tuple[AutoDjPlanQuery, ...]


@dataclass(frozen=True)
class AutoDjSearchFeedback:
    attempt: int
    query: str
    intent: RecommendationIntentKind
    candidate_count: int
    qualified_count: int
    source_errors: tuple[str, ...] = ()


@dataclass(frozen=True)
class AutoDjQueryPlanningContext:
    music_state: MusicAgentState | None
    profile: MusicRecommendationProfileIn
    recent_messages: tuple[tuple[str, str], ...]  # (role, content)
    settings: AutoDjSettingsIn
    search_feedback: tuple[AutoDjSearchFeedback, ...] = ()


@dataclass(frozen=True)
class AutoDjSelectionCandidate:
    item_id: str
    title: str
    creator: str
    source: str
    intent: RecommendationIntentKind
    query: str
    score: float
    evidence: tuple[str, ...]


@dataclass(frozen=True)
class AutoDjSelectionContext:
    music_state: MusicAgentState | None
    profile: MusicRecommendationProfileIn
    recent_messages: tuple[tuple[str, str], ...]
    settings: AutoDjSettingsIn
    candidates: tuple[AutoDjSelectionCandidate, ...]
    search_feedback: tuple[AutoDjSearchFeedback, ...] = ()


@dataclass(frozen=True)
class AutoDjSelection:
    selected_item_ids: tuple[str, ...]
    reasons: dict[str, str]


def _normalize_query(value: str) -> str:
    return re.sub(r"\s+", " ", value.strip().lower())


def is_generic_query(value: str) -> bool:
    return _normalize_query(value) in _GENERIC_QUERIES


def parse_and_validate_plan(
    raw: str, settings: AutoDjSettingsIn
) -> AutoDjQueryPlan:
    text = raw.strip()
    if not text or text.startswith("```") or not text.startswith("{"):
        raise PlanningError("response is not a bare JSON object")
    if not text.endswith("}"):
        raise PlanningError("response has trailing prose after JSON")
    try:
        document = json.loads(text)
    except json.JSONDecodeError as error:
        raise PlanningError(f"invalid JSON: {error}") from error
    if not isinstance(document, dict):
        raise PlanningError("response is not a JSON object")
    raw_queries = document.get("queries")
    if not isinstance(raw_queries, list):
        raise PlanningError("queries field missing or not a list")
    if not (_PLAN_MIN <= len(raw_queries) <= _PLAN_MAX):
        raise PlanningError(
            f"queries count must be between {_PLAN_MIN} and {_PLAN_MAX}"
        )

    accepted: list[AutoDjPlanQuery] = []
    seen_normalized: set[str] = set()
    dropped = 0
    for entry in raw_queries:
        if not isinstance(entry, dict):
            dropped += 1
            continue
        query = entry.get("query")
        intent = entry.get("intent")
        themes = entry.get("themes", [])
        if not isinstance(query, str) or not isinstance(intent, str):
            dropped += 1
            continue
        if intent not in _ALLOWED_INTENTS:
            dropped += 1
            continue
        trimmed = query.strip()
        if not (_QUERY_MIN <= len(trimmed) <= _QUERY_MAX):
            dropped += 1
            continue
        if is_generic_query(trimmed):
            dropped += 1
            continue
        normalized = _normalize_query(trimmed)
        if normalized in seen_normalized:
            continue
        if isinstance(themes, list) and len(themes) > _THEMES_MAX:
            dropped += 1
            continue  # hard-reject: spec says max four themes
        clean_themes: list[str] = []
        if isinstance(themes, list):
            for theme in themes:
                if not isinstance(theme, str):
                    continue
                stripped = theme.strip()
                if stripped:
                    clean_themes.append(stripped)
        seen_normalized.add(normalized)
        accepted.append(
            AutoDjPlanQuery(
                query=trimmed, intent=intent, themes=tuple(clean_themes)
            )
        )

    if dropped:
        _logger.info(
            "auto dj plan: %d of %d entries dropped during validation",
            dropped,
            len(raw_queries),
        )
    if not accepted:
        raise PlanningError(
            f"no valid queries after filtering ({dropped} of {len(raw_queries)} dropped)"
        )
    if not (_PLAN_MIN <= len(accepted) <= _PLAN_MAX):
        raise PlanningError("accepted plan out of size bounds")

    intents_present = {entry.intent for entry in accepted}
    if settings.similar_count > 0 and not (intents_present & _SIMILAR_INTENTS):
        raise PlanningError("plan missing similar intent group")
    if (
        settings.exploration_count > 0
        and not (intents_present & _EXPLORATION_INTENTS)
    ):
        raise PlanningError("plan missing exploration intent group")

    return AutoDjQueryPlan(queries=tuple(accepted))


def parse_and_validate_selection(
    raw: str,
    candidates: tuple[AutoDjSelectionCandidate, ...],
    settings: AutoDjSettingsIn,
) -> AutoDjSelection:
    text = raw.strip()
    if not text or text.startswith("```") or not text.startswith("{"):
        raise PlanningError("selection response is not a bare JSON object")
    if not text.endswith("}"):
        raise PlanningError("selection response has trailing prose after JSON")
    try:
        document = json.loads(text)
    except json.JSONDecodeError as error:
        raise PlanningError(f"invalid selection JSON: {error}") from error
    if not isinstance(document, dict):
        raise PlanningError("selection response is not a JSON object")

    raw_selected = document.get("selected")
    if raw_selected is None:
        raw_selected = document.get("selected_item_ids")
    if not isinstance(raw_selected, list):
        raise PlanningError("selected field missing or not a list")

    candidate_ids = {candidate.item_id for candidate in candidates}
    selected_item_ids: list[str] = []
    reasons: dict[str, str] = {}
    seen: set[str] = set()
    for entry in raw_selected:
        item_id = ""
        reason = ""
        if isinstance(entry, str):
            item_id = entry.strip()
        elif isinstance(entry, dict):
            raw_item_id = entry.get("item_id") or entry.get("id")
            if isinstance(raw_item_id, str):
                item_id = raw_item_id.strip()
            raw_reason = entry.get("reason")
            if isinstance(raw_reason, str):
                reason = raw_reason.strip()
        if not item_id or item_id in seen or item_id not in candidate_ids:
            continue
        seen.add(item_id)
        selected_item_ids.append(item_id)
        if reason:
            reasons[item_id] = reason[:240]
        if len(selected_item_ids) >= settings.count:
            break

    if not selected_item_ids:
        raise PlanningError("selection contained no valid candidate ids")

    return AutoDjSelection(
        selected_item_ids=tuple(selected_item_ids),
        reasons=reasons,
    )


# ---------------------------------------------------------------------------
# Prompt builders
# ---------------------------------------------------------------------------

_SYSTEM_PROMPT = """\
You are KumikoRoom's Auto DJ query planner. Read the user's listening context
and produce search queries for NetEase Cloud Music.

Return ONE JSON object only, with this exact shape:

{
  "queries": [
    {"query": "<search phrase 2-120 chars>",
     "intent": "<similar_theme|similar_mood|same_creator_or_work|light_exploration>",
     "themes": ["<theme>", ...]}  // up to 4 short tokens, may be empty
  ]
}

Rules:
- Output JSON only. No prose, no markdown fences, no comments.
- 1 to 6 queries. Each query string is unique after lowercasing.
- Reject generic terms like "music", "songs", "explore", "music explore".
- Cover every requested intent group: produce at least one similar-style
  query when similar_count > 0, and at least one light_exploration query
  when exploration_count > 0.
- Tailor queries to the listening context. Combine creator names, work
  titles, moods, and themes in natural NetEase search phrasing.
- Prefer concise Chinese/Japanese work titles, artist names, anime OST names,
  and short mood terms. If prior search feedback says a query returned zero
  candidates, broaden it and remove overly specific performer/instrument terms.
"""


def build_auto_dj_planning_system_prompt(settings: AutoDjSettingsIn) -> str:
    return (
        f"{_SYSTEM_PROMPT}\n"
        f"This refill requests {settings.count} tracks "
        f"(similar_count={settings.similar_count}, "
        f"exploration_count={settings.exploration_count})."
    )


def _format_track(track) -> str:
    return f"- {track.title} — {track.creator} (id={track.id})"


def _format_recent_messages(messages: tuple[tuple[str, str], ...]) -> str:
    if not messages:
        return "(none)"
    lines = []
    for role, content in messages:
        text = content.strip().replace("\n", " ")
        lines.append(f"{role}: {text[:240]}")
    return "\n".join(lines)


def _format_search_feedback(feedback: tuple[AutoDjSearchFeedback, ...]) -> str:
    if not feedback:
        return "(none)"
    lines = []
    for item in feedback:
        errors = "; ".join(item.source_errors) if item.source_errors else "none"
        lines.append(
            "- "
            f"attempt={item.attempt}, query={item.query}, intent={item.intent}, "
            f"candidates={item.candidate_count}, qualified={item.qualified_count}, "
            f"errors={errors}"
        )
    return "\n".join(lines)


def _format_profile(profile: MusicRecommendationProfileIn) -> str:
    artists = ", ".join(
        f"{name}({weight:g})"
        for name, weight in sorted(
            profile.artist_weights.items(), key=lambda kv: -kv[1]
        )[:8]
    ) or "(none)"
    tags = ", ".join(
        f"{name}({weight:g})"
        for name, weight in sorted(
            profile.tag_weights.items(), key=lambda kv: -kv[1]
        )[:8]
    ) or "(none)"
    queries = ", ".join(
        f"{name}({weight:g})"
        for name, weight in sorted(
            profile.query_weights.items(), key=lambda kv: -kv[1]
        )[:8]
    ) or "(none)"
    themes = ", ".join(
        f"{theme.key}({theme.weight:g})" for theme in profile.recent_themes[:8]
    ) or "(none)"
    return (
        f"Top artists: {artists}\n"
        f"Top tags: {tags}\n"
        f"Top prior queries: {queries}\n"
        f"Recent themes: {themes}"
    )


def build_auto_dj_planning_user_prompt(context: AutoDjQueryPlanningContext) -> str:
    parts: list[str] = []
    state: MusicAgentState | None = context.music_state
    if state is None or state.current is None:
        parts.append("Currently playing: (none)")
    else:
        parts.append(f"Currently playing: {state.current.title} — {state.current.creator}")
    if state is not None and state.recent:
        parts.append("Recently played:")
        parts.append("\n".join(_format_track(t) for t in state.recent[:10]))
    if state is not None and getattr(state, "saved", None):
        parts.append("Saved tracks (sample):")
        parts.append("\n".join(_format_track(t) for t in state.saved[:8]))
    parts.append("Profile signals:")
    parts.append(_format_profile(context.profile))
    parts.append("Conversation context (oldest first):")
    parts.append(_format_recent_messages(context.recent_messages))
    if context.search_feedback:
        parts.append("Search feedback from previous attempts:")
        parts.append(_format_search_feedback(context.search_feedback))
    return "\n\n".join(parts)


_SELECTION_SYSTEM_PROMPT = """\
You are KumikoRoom's Auto DJ selector. Choose final recommendations only from
the provided candidate ids.

Return ONE JSON object only, with this exact shape:

{
  "selected": [
    {"item_id": "<candidate id>", "reason": "<short reason tied to context>"}
  ]
}

Rules:
- Output JSON only. No prose, no markdown fences, no comments.
- Select at most the requested count.
- Use only candidate ids from the candidate list.
- Prefer songs that fit the current track, conversation, queue, saved tracks,
  and playlist context. Balance close matches with one light exploration pick
  when the candidate pool supports it.
"""


def build_auto_dj_selection_system_prompt(settings: AutoDjSettingsIn) -> str:
    return f"{_SELECTION_SYSTEM_PROMPT}\nThis refill requests {settings.count} tracks."


def build_auto_dj_selection_user_prompt(context: AutoDjSelectionContext) -> str:
    parts: list[str] = []
    state: MusicAgentState | None = context.music_state
    if state is None or state.current is None:
        parts.append("Currently playing: (none)")
    else:
        parts.append(f"Currently playing: {state.current.title} — {state.current.creator}")
    if state is not None and state.upcoming:
        parts.append("Upcoming queue:")
        parts.append("\n".join(_format_track(t) for t in state.upcoming[:8]))
    if state is not None and state.recent:
        parts.append("Recently played:")
        parts.append("\n".join(_format_track(t) for t in state.recent[:8]))
    if state is not None and getattr(state, "playlists", None):
        playlist_lines = []
        for playlist in state.playlists[:6]:
            playlist_lines.append(
                f"- {playlist.name}: "
                + ", ".join(f"{track.title} — {track.creator}" for track in playlist.items[:6])
            )
        parts.append("Playlist context:")
        parts.append("\n".join(playlist_lines))
    parts.append("Profile signals:")
    parts.append(_format_profile(context.profile))
    parts.append("Conversation context (oldest first):")
    parts.append(_format_recent_messages(context.recent_messages))
    if context.search_feedback:
        parts.append("Search feedback:")
        parts.append(_format_search_feedback(context.search_feedback))
    parts.append("Candidates:")
    parts.append(
        "\n".join(
            "- "
            f"id={candidate.item_id}; title={candidate.title}; creator={candidate.creator}; "
            f"source={candidate.source}; intent={candidate.intent}; query={candidate.query}; "
            f"score={candidate.score:g}; evidence={'; '.join(candidate.evidence[:5])}"
            for candidate in context.candidates
        )
        or "(none)"
    )
    return "\n\n".join(parts)

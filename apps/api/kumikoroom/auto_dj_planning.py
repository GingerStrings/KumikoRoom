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
class AutoDjQueryPlanningContext:
    music_state: MusicAgentState | None
    profile: MusicRecommendationProfileIn
    recent_messages: tuple[tuple[str, str], ...]  # (role, content)
    settings: AutoDjSettingsIn


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


# ---------------------------------------------------------------------------
# Prompt builders
# ---------------------------------------------------------------------------

_SYSTEM_PROMPT = """\
You are KumikoRoom's Auto DJ query planner. Read the user's listening context
and produce search queries for NetEase Cloud Music and Bilibili.

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
  titles, moods, themes, and platform terms ("ost", "动画", "concert band")
  in natural search-engine phrasing.
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
    parts.append("Recent chat (oldest first, up to 200 entries):")
    parts.append(_format_recent_messages(context.recent_messages))
    return "\n\n".join(parts)

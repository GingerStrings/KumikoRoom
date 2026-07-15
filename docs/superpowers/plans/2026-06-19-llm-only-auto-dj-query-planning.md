# LLM-Only Auto DJ Query Planning Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the heuristic Auto DJ query construction with an LLM-only planner. Every NetEase / Bilibili search must come from a validated LLM query plan from the current request. No fallback queries. Profile pollution is sanitized before prompting and scoring. Failures stop the refill cleanly.

**Architecture:** The Auto DJ endpoint constructs a planning-only `ConversationManager` (PR1 prerequisite) and calls a new `plan_auto_dj_queries()` method. A new `auto_dj_planning.py` module owns the planning context, strict JSON parsing, validation rules, and the generic-query denylist. `auto_dj.py` sanitizes the incoming profile, delegates planning, then runs deterministic recall/score/select with the validated plan. The frontend forwards `llmConfig`, sends up to 200 chat messages, and shows a low-key inline status.

**Tech Stack:** FastAPI, Pydantic v2, pytest, Next.js 14, React 18, TypeScript, Vitest, Testing Library.

**Spec reference:** `docs/superpowers/specs/2026-06-19-llm-only-auto-dj-query-planning-design.md`.

**Prerequisite:** `docs/superpowers/plans/2026-06-19-conversation-manager-planning-only-construction.md` must land first.

---

## Scope Check

Backend planning, profile sanitization, orchestration changes, frontend `llmConfig` wiring, message-limit raise, and inline status all have to ship together. None alone is useful: backend without frontend wiring can never reach the LLM with user config; frontend without backend gets a 422 on the new field. Sanitization without orchestration changes leaks. Inline status without orchestration has no failure to render.

## File Structure

- Modify `apps/api/kumikoroom/schemas.py`
  - Add `llm_config: LLMConfigIn | None` to `AutoDjRecommendIn`. Add `error` literal extension if missing.
- Create `apps/api/kumikoroom/auto_dj_planning.py`
  - Owns `AutoDjQueryPlanningContext`, `AutoDjQueryPlan`, `AutoDjPlanQuery`, `PlanningError`, `is_generic_query()`, `parse_and_validate_plan(raw_text, settings)`.
- Modify `apps/api/kumikoroom/llm.py`
  - Add `timeout: float | None = None` to `LLMProvider.generate`, `MockLLMProvider.generate`, and `DeepSeekLLMProvider.generate`. The DeepSeek path threads it into `httpx.Client(timeout=...)`; mock ignores it. The current 45-second default stays when `timeout` is `None`.
- Modify `apps/api/tests/test_llm.py`
  - Add a regression test that asserts `DeepSeekLLMProvider.generate(messages, timeout=3.0)` propagates the value into the HTTP client (via a fake transport).
- Modify `apps/api/kumikoroom/conversation.py`
  - Add `plan_auto_dj_queries(context) -> AutoDjQueryPlan`. Add `planner_timeout_seconds: float = 45.0` constructor option. Auto DJ route passes `15.0`.
- Modify `apps/api/kumikoroom/auto_dj.py`
  - Add `_sanitize_profile()`. Replace `_build_intents` callsite with the LLM planner. Delete `_similar_query_seeds`, `_exploration_query_seeds`, `music explore` fallback, and the `explore`-in-title score bonus.
- Modify `apps/api/kumikoroom/routers/room.py`
  - Construct planning-only `ConversationManager`, pass it as a planner dependency to `recommend_auto_dj`.
- Modify `apps/api/tests/test_auto_dj.py`
  - Replace heuristic-query tests with planner-driven tests. Add sanitization, intent-coverage, and planning-failure tests.
- Create `apps/api/tests/test_auto_dj_planning.py`
  - Strict parsing, validation rules, generic-query denylist, intent coverage, plan failures.
- Create `apps/api/tests/test_conversation_planning.py`
  - `plan_auto_dj_queries` happy path, timeout, provider error, JSON failure, store-write absence.
- Modify `apps/web/src/api/types.ts`
  - Add optional `llmConfig` to `AutoDjRecommendRequest`. Add `error` field on response.
- Modify `apps/web/src/api/client.ts`
  - Map `llmConfig` to `llm_config` on the way out. Pass `error` through on the way back.
- Modify `apps/web/src/components/RoomShell.tsx`
  - Send `llmConfig` with refill, raise `messages.slice(-8)` to `messages.slice(-200)`, render inline Auto DJ status, do not insert chat notice on failure, isolate Auto DJ errors from `sendError`.
- Modify `apps/web/app/globals.css`
  - Style `.auto-dj-status` (loading / unavailable).
- Modify `apps/web/tests/RoomShell.test.tsx`
  - Cover llmConfig serialization, 200-message slice, failure status without chat notice, retry on toggle.
- Modify `apps/web/tests/client.test.ts`
  - Cover request/response mapping for new fields.

## Task 0: Provider Timeout Plumbing

**Files:**
- Modify: `apps/api/kumikoroom/llm.py`
- Modify: `apps/api/tests/test_llm.py`

The Auto DJ planner needs a 15-second cap. `LLMProvider.generate` currently has no `timeout` parameter and `DeepSeekLLMProvider` hard-codes `httpx.Client(timeout=45.0)`. Land the plumbing first so later tasks can rely on it.

- [ ] **Step 1: Write a failing test for DeepSeek timeout propagation**

Use a fake `httpx.MockTransport` to capture the request, and assert the timeout reaches the client:

```python
import httpx

from kumikoroom.config import LlmRuntimeConfig
from kumikoroom.llm import DeepSeekLLMProvider, LLMMessage


def test_deepseek_provider_threads_custom_timeout_into_http_client() -> None:
    captured: dict[str, object] = {}

    def handler(request: httpx.Request) -> httpx.Response:
        captured["timeout"] = request.extensions.get("timeout")
        return httpx.Response(
            200,
            json={
                "choices": [
                    {"message": {"role": "assistant", "content": "ok"}}
                ]
            },
        )

    transport = httpx.MockTransport(handler)
    provider = DeepSeekLLMProvider(
        runtime_config=LlmRuntimeConfig(
            provider="deepseek",
            base_url="https://example.invalid",
            api_key="key",
            model="m",
        ),
        transport=transport,
    )

    provider.generate(messages=[LLMMessage(role="user", content="hi")], timeout=3.0)

    assert captured["timeout"] is not None
    # httpx packs the timeout as a dict of {"connect": 3.0, "read": 3.0, ...}
    timeout = captured["timeout"]
    assert any(value == 3.0 for value in timeout.values())  # type: ignore[union-attr]


def test_deepseek_provider_keeps_45s_default_when_timeout_missing() -> None:
    captured: dict[str, object] = {}

    def handler(request: httpx.Request) -> httpx.Response:
        captured["timeout"] = request.extensions.get("timeout")
        return httpx.Response(
            200,
            json={
                "choices": [
                    {"message": {"role": "assistant", "content": "ok"}}
                ]
            },
        )

    transport = httpx.MockTransport(handler)
    provider = DeepSeekLLMProvider(
        runtime_config=LlmRuntimeConfig(
            provider="deepseek",
            base_url="https://example.invalid",
            api_key="key",
            model="m",
        ),
        transport=transport,
    )

    provider.generate(messages=[LLMMessage(role="user", content="hi")])

    timeout = captured["timeout"]
    assert any(value == 45.0 for value in timeout.values())  # type: ignore[union-attr]
```

Run and confirm both tests fail (parameter not accepted):

```text
python -m pytest apps/api/tests/test_llm.py -q
```

- [ ] **Step 2: Add the parameter on the protocol and both providers**

In `apps/api/kumikoroom/llm.py`:

In `apps/api/kumikoroom/llm.py`:

```python
class LLMProvider(Protocol):
    def generate(
        self,
        messages: list[LLMMessage],
        tools: list[dict[str, Any]] | None = None,
        tool_choice: str | None = None,
        timeout: float | None = None,
    ) -> LLMResult:
        ...
```

`MockLLMProvider.generate` accepts `timeout` and ignores it. Replace its current signature:

```python
class MockLLMProvider:
    # ...existing __init__ unchanged...

    def generate(
        self,
        messages: list[LLMMessage],
        tools: list[dict[str, Any]] | None = None,
        tool_choice: str | None = None,
        timeout: float | None = None,  # accepted, ignored
    ) -> LLMResult:
        # rest of body unchanged
        ...
```

`DeepSeekLLMProvider.generate` threads it into the HTTP client. Replace **only** the signature line and the `httpx.Client(timeout=...)` call; everything else (request body, retry, parsing) stays:

```python
def generate(
    self,
    messages: list[LLMMessage],
    tools: list[dict[str, Any]] | None = None,
    tool_choice: str | None = None,
    timeout: float | None = None,
) -> LLMResult:
    # ...existing body up to and including request_body / headers construction unchanged...
    effective_timeout = 45.0 if timeout is None else timeout
    try:
        with httpx.Client(
            timeout=effective_timeout,
            transport=self.transport,
            trust_env=False,
        ) as client:
            response = client.post(
                f"{runtime.base_url.rstrip('/')}/chat/completions",
                headers=headers,
                json=request_body,
            )
            response.raise_for_status()
    # ...existing except / parse / return unchanged...
```

The two `...` lines in those snippets are **literal placeholders for the existing function bodies** — do not introduce a Python `...` ellipsis statement; just leave the surrounding code unchanged.

Re-run and confirm green:

```text
python -m pytest apps/api/tests/test_llm.py -q
```

- [ ] **Step 3: Confirm chat path is unaffected**

The chat path never passes `timeout`, so it gets `45.0`. Run the full backend suite:

```text
python -m pytest apps/api/tests -q
```

Existing chat tests must still pass. Commit only `llm.py` and the new tests so the timeout-plumbing change can be reverted independently if needed:

```text
git add apps/api/kumikoroom/llm.py apps/api/tests/test_llm.py
git commit -m "feat: optional generate(timeout=...) on LLM providers"
```

## Task 1: Backend Planning Module And Validator

**Files:**
- Create: `apps/api/kumikoroom/auto_dj_planning.py`
- Create: `apps/api/tests/test_auto_dj_planning.py`- [ ] **Step 1: Write the failing validator tests**

Add `apps/api/tests/test_auto_dj_planning.py`:

```python
import pytest

from kumikoroom.auto_dj_planning import (
    PlanningError,
    is_generic_query,
    parse_and_validate_plan,
)
from kumikoroom.schemas import AutoDjSettingsIn


def settings(similar: int = 2, exploration: int = 1) -> AutoDjSettingsIn:
    return AutoDjSettingsIn(
        count=similar + exploration,
        similar_count=similar,
        exploration_count=exploration,
    )


def _valid_payload() -> str:
    return (
        '{"queries":[{"query":"hibike euphonium ost","intent":"same_creator_or_work","themes":["wind orchestra"]},'
        '{"query":"gentle anime brass band","intent":"similar_mood","themes":["gentle"]},'
        '{"query":"modern concert band cinematic","intent":"light_exploration","themes":["concert band"]}]}'
    )


def test_parse_accepts_well_formed_plan():
    plan = parse_and_validate_plan(_valid_payload(), settings())
    assert {q.intent for q in plan.queries} == {
        "same_creator_or_work", "similar_mood", "light_exploration"
    }


def test_parse_rejects_markdown_fences():
    raw = "```json\n" + _valid_payload() + "\n```"
    with pytest.raises(PlanningError):
        parse_and_validate_plan(raw, settings())


def test_parse_rejects_surrounding_prose():
    raw = "Sure, here is the plan: " + _valid_payload()
    with pytest.raises(PlanningError):
        parse_and_validate_plan(raw, settings())


def test_parse_rejects_more_than_six_entries():
    queries = ",".join(
        '{"query":"q' + str(i) + '","intent":"similar_theme","themes":[]}'
        for i in range(7)
    )
    with pytest.raises(PlanningError):
        parse_and_validate_plan('{"queries":[' + queries + "]}", settings())


def test_parse_drops_invalid_entries_and_keeps_remainder():
    raw = (
        '{"queries":['
        '{"query":"valid one","intent":"similar_theme","themes":[]},'
        '{"query":"music","intent":"light_exploration","themes":[]}'  # generic
        ']}'
    )
    with pytest.raises(PlanningError):
        # generic dropped, exploration coverage missing
        parse_and_validate_plan(raw, settings(similar=1, exploration=1))


def test_parse_fails_when_similar_group_missing():
    raw = (
        '{"queries":['
        '{"query":"concert band cinematic","intent":"light_exploration","themes":[]}'
        ']}'
    )
    with pytest.raises(PlanningError):
        parse_and_validate_plan(raw, settings(similar=2, exploration=1))


def test_parse_fails_when_exploration_group_missing():
    raw = (
        '{"queries":['
        '{"query":"hibike euphonium","intent":"same_creator_or_work","themes":[]}'
        ']}'
    )
    with pytest.raises(PlanningError):
        parse_and_validate_plan(raw, settings(similar=1, exploration=1))


def test_parse_passes_when_only_similar_requested():
    raw = (
        '{"queries":['
        '{"query":"hibike euphonium","intent":"similar_theme","themes":[]}'
        ']}'
    )
    plan = parse_and_validate_plan(raw, settings(similar=1, exploration=0))
    assert len(plan.queries) == 1


@pytest.mark.parametrize(
    "query",
    ["music", "songs", "new music", "music explore", "MUSIC", "  music  "],
)
def test_generic_denylist_rejects_known_terms(query: str):
    assert is_generic_query(query)


def test_generic_denylist_passes_real_queries():
    assert not is_generic_query("hibike euphonium soundtrack")
    assert not is_generic_query("gentle japanese brass band")


def test_query_length_bounds():
    short = '{"queries":[{"query":"a","intent":"similar_theme","themes":[]}]}'
    too_long = '{"queries":[{"query":"' + ("x" * 121) + '","intent":"similar_theme","themes":[]}]}'
    with pytest.raises(PlanningError):
        parse_and_validate_plan(short, settings(similar=1, exploration=0))
    with pytest.raises(PlanningError):
        parse_and_validate_plan(too_long, settings(similar=1, exploration=0))


def test_themes_max_four_entries():
    raw = (
        '{"queries":[{"query":"hibike","intent":"similar_theme",'
        '"themes":["a","b","c","d","e"]}]}'
    )
    with pytest.raises(PlanningError):
        parse_and_validate_plan(raw, settings(similar=1, exploration=0))


def test_duplicate_normalized_queries_collapsed():
    raw = (
        '{"queries":['
        '{"query":"Hibike Euphonium","intent":"similar_theme","themes":[]},'
        '{"query":"hibike  euphonium","intent":"similar_mood","themes":[]}'
        ']}'
    )
    plan = parse_and_validate_plan(raw, settings(similar=1, exploration=0))
    assert len(plan.queries) == 1
```

Run and confirm 12+ failures (module does not exist):

```text
python -m pytest apps/api/tests/test_auto_dj_planning.py -q
```

- [ ] **Step 2: Implement `auto_dj_planning.py`**

```python
from __future__ import annotations

import json
import re
from dataclasses import dataclass
from typing import Iterable

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
    for entry in raw_queries:
        if not isinstance(entry, dict):
            continue
        query = entry.get("query")
        intent = entry.get("intent")
        themes = entry.get("themes", [])
        if not isinstance(query, str) or not isinstance(intent, str):
            continue
        if intent not in _ALLOWED_INTENTS:
            continue
        trimmed = query.strip()
        if not (_QUERY_MIN <= len(trimmed) <= _QUERY_MAX):
            continue
        if is_generic_query(trimmed):
            continue
        normalized = _normalize_query(trimmed)
        if normalized in seen_normalized:
            continue
        clean_themes: list[str] = []
        if isinstance(themes, list):
            for theme in themes:
                if not isinstance(theme, str):
                    continue
                stripped = theme.strip()
                if stripped:
                    clean_themes.append(stripped)
                if len(clean_themes) > _THEMES_MAX:
                    break
        if isinstance(themes, list) and len(themes) > _THEMES_MAX:
            continue  # spec: themes max four entries
        seen_normalized.add(normalized)
        accepted.append(
            AutoDjPlanQuery(
                query=trimmed, intent=intent, themes=tuple(clean_themes)
            )
        )

    if not accepted:
        raise PlanningError("no valid queries after filtering")
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
```

Re-run and confirm green:

```text
python -m pytest apps/api/tests/test_auto_dj_planning.py -q
```

## Task 2: ConversationManager Planner Method

**Files:**
- Modify: `apps/api/kumikoroom/conversation.py`
- Modify: `apps/api/kumikoroom/auto_dj_planning.py` (prompt builders only — see Step 3 below)
- Create: `apps/api/tests/test_conversation_planning.py`

- [ ] **Step 1: Write failing planner tests**

These tests need an `openai_compatible` runtime config so the planner's mock-preflight does not reject the FakeProvider before it is even called:

```python
from pathlib import Path

import pytest

from kumikoroom.auto_dj_planning import (
    AutoDjQueryPlanningContext,
    PlanningError,
)
from kumikoroom.config import ApiSettings
from kumikoroom.conversation import ConversationManager
from kumikoroom.llm import LLMResult, ProviderStatus
from kumikoroom.schemas import (
    AutoDjSettingsIn,
    LLMConfigIn,
    MusicRecommendationProfileIn,
)


def _planner_settings(tmp_path: Path) -> ApiSettings:
    """Forces a real (non-mock) provider so the planner preflight passes.
    `openai_compatible` is the only provider that may have no API key."""
    return ApiSettings(
        llm_provider="openai_compatible",
        deepseek_api_key=None,
        deepseek_model="ignored",
        deepseek_base_url="https://example.invalid",
        memory_db_path=tmp_path / "memory.sqlite3",
    )


def _planner_llm_config() -> LLMConfigIn:
    return LLMConfigIn(
        provider="openai_compatible",
        base_url="https://example.invalid",
        api_key="test",
        model="planner-model",
    )


class FakeProvider:
    def __init__(
        self,
        response: str | None = None,
        raise_with: Exception | None = None,
    ) -> None:
        self.response = response
        self.raise_with = raise_with
        self.calls = 0
        self.last_timeout: float | None = None

    def generate(self, messages, tools=None, tool_choice=None, timeout=None):
        self.calls += 1
        self.last_timeout = timeout
        if self.raise_with is not None:
            raise self.raise_with
        return LLMResult(
            content=self.response or "",
            provider_status=ProviderStatus(
                provider="openai_compatible",
                model="planner-model",
                configured=True,
                label="test",
            ),
            tool_calls=[],
        )


def _empty_profile() -> MusicRecommendationProfileIn:
    return MusicRecommendationProfileIn.model_validate(
        {
            "version": 1,
            "updated_at": "2026-06-19T00:00:00Z",
            "artist_weights": {},
            "tag_weights": {},
            "source_weights": {},
            "query_weights": {},
            "recent_themes": [],
            "cooldowns": [],
            "recommended_items": [],
            "refill_history": [],
        }
    )


def _context(
    settings: AutoDjSettingsIn | None = None,
) -> AutoDjQueryPlanningContext:
    return AutoDjQueryPlanningContext(
        music_state=None,
        profile=_empty_profile(),
        recent_messages=(),
        settings=settings
        or AutoDjSettingsIn(count=3, similar_count=2, exploration_count=1),
    )


def _make_planner(
    tmp_path: Path,
    provider: FakeProvider,
    *,
    timeout: float = 15.0,
) -> ConversationManager:
    return ConversationManager(
        settings=_planner_settings(tmp_path),
        provider=provider,
        llm_config=_planner_llm_config(),
        initialize_stores=False,
        planner_timeout_seconds=timeout,
    )


def test_plan_auto_dj_queries_returns_typed_plan(tmp_path: Path) -> None:
    valid = (
        '{"queries":['
        '{"query":"hibike euphonium","intent":"similar_theme","themes":[]},'
        '{"query":"gentle brass band","intent":"similar_mood","themes":[]},'
        '{"query":"concert band cinematic","intent":"light_exploration","themes":[]}'
        "]}"
    )
    provider = FakeProvider(response=valid)
    manager = _make_planner(tmp_path, provider)

    plan = manager.plan_auto_dj_queries(_context())

    assert provider.calls == 1
    assert provider.last_timeout == 15.0
    assert len(plan.queries) == 3


def test_plan_auto_dj_queries_does_not_initialize_stores(tmp_path: Path) -> None:
    provider = FakeProvider(response="{}")
    manager = _make_planner(tmp_path, provider)

    assert manager.memory_store is None
    assert manager.session_store is None


def test_plan_auto_dj_queries_raises_on_provider_failure(tmp_path: Path) -> None:
    manager = _make_planner(
        tmp_path, FakeProvider(raise_with=RuntimeError("boom"))
    )
    with pytest.raises(PlanningError):
        manager.plan_auto_dj_queries(_context())


def test_plan_auto_dj_queries_raises_on_invalid_json(tmp_path: Path) -> None:
    manager = _make_planner(tmp_path, FakeProvider(response="not json"))
    with pytest.raises(PlanningError):
        manager.plan_auto_dj_queries(_context())


def test_plan_auto_dj_queries_raises_when_runtime_is_mock(tmp_path: Path) -> None:
    manager = ConversationManager(
        settings=ApiSettings(
            llm_provider="mock",
            deepseek_api_key=None,
            deepseek_model="m",
            deepseek_base_url="https://example.invalid",
            memory_db_path=tmp_path / "memory.sqlite3",
        ),
        provider=FakeProvider(response="ignored"),
        initialize_stores=False,
    )
    with pytest.raises(PlanningError):
        manager.plan_auto_dj_queries(_context())


def test_plan_auto_dj_queries_does_not_write_to_stores(tmp_path: Path) -> None:
    """If a future caller forgets initialize_stores=False, planning must
    still leave session/memory tables untouched. Construct a stores-on
    manager and assert the chat session count is unchanged after planning."""
    valid = (
        '{"queries":['
        '{"query":"hibike euphonium","intent":"similar_theme","themes":[]},'
        '{"query":"concert band cinematic","intent":"light_exploration","themes":[]}'
        "]}"
    )
    manager = ConversationManager(
        settings=_planner_settings(tmp_path),
        provider=FakeProvider(response=valid),
        llm_config=_planner_llm_config(),
        # default initialize_stores=True
    )
    session = manager.session_store.ensure_default_session()
    before = len(manager.session_store.list_messages(session_id=session.id))

    manager.plan_auto_dj_queries(_context())

    after = len(manager.session_store.list_messages(session_id=session.id))
    assert after == before
```

Run and confirm failures (method missing, planner-timeout kwarg unknown, etc.):

```text
python -m pytest apps/api/tests/test_conversation_planning.py -q
```

- [ ] **Step 2: Add prompt builders to `auto_dj_planning.py`**

Append to `apps/api/kumikoroom/auto_dj_planning.py`:

```python
from kumikoroom.schemas import (
    AutoDjSettingsIn,
    MusicAgentState,
    MusicRecommendationProfileIn,
)


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


def build_auto_dj_planning_user_prompt(context) -> str:
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
```

The exact format above is a starting point; the contract that matters is that no raw API key, no SQLite path, and no unrelated session content reaches the prompt. Adjust field names to match the real `MusicAgentState` shape if needed — read `apps/api/kumikoroom/schemas.py` first.

- [ ] **Step 3: Implement `plan_auto_dj_queries` and the planner-timeout kwarg**

In `conversation.py`:

1. Extend `__init__` (the existing argument list lives at `apps/api/kumikoroom/conversation.py:58`). Append two arguments and one assignment; do not touch the other lines:

   ```python
   def __init__(
       self,
       settings: ApiSettings | None = None,
       provider: LLMProvider | None = None,
       memory_store: MemoryStore | None = None,
       session_store: SessionStore | None = None,
       llm_config=None,
       initialize_stores: bool = True,        # added in PR1
       planner_timeout_seconds: float = 45.0, # added here
   ) -> None:
       # ...all existing settings/provider/runtime_config/store init unchanged...
       self.planner_timeout_seconds = planner_timeout_seconds
   ```
2. Add the planner method:

   ```python
   from kumikoroom.auto_dj_planning import (
       AutoDjQueryPlan,
       AutoDjQueryPlanningContext,
       PlanningError,
       build_auto_dj_planning_system_prompt,
       build_auto_dj_planning_user_prompt,
       parse_and_validate_plan,
   )


   def plan_auto_dj_queries(
       self, context: AutoDjQueryPlanningContext
   ) -> AutoDjQueryPlan:
       if self.runtime_config.provider == "mock":
           raise PlanningError(
               "Auto DJ planner cannot use the mock LLM runtime"
           )

       system_prompt = build_auto_dj_planning_system_prompt(context.settings)
       user_prompt = build_auto_dj_planning_user_prompt(context)
       try:
           result = self.provider.generate(
               messages=[
                   {"role": "system", "content": system_prompt},
                   {"role": "user", "content": user_prompt},
               ],
               timeout=self.planner_timeout_seconds,
           )
       except Exception as error:  # noqa: BLE001
           raise PlanningError(f"provider call failed: {error}") from error
       return parse_and_validate_plan(result.content, context.settings)
   ```

3. Never call `self.session_store.append_message`, `self.memory_store.save`, `extract_memories`, or `chat()`.

Re-run the planner suite:

```text
python -m pytest apps/api/tests/test_conversation_planning.py -q
```

All tests must pass.

## Task 3: Profile Sanitization

**Files:**
- Modify: `apps/api/kumikoroom/auto_dj.py`
- Modify: `apps/api/tests/test_auto_dj.py`

- [ ] **Step 1: Write the failing sanitization tests**

```python
from copy import deepcopy

from kumikoroom.auto_dj import _sanitize_profile, _METADATA_TAGS
from kumikoroom.schemas import MusicRecommendationProfileIn


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
```

- [ ] **Step 2: Implement `_sanitize_profile`**

Add to `auto_dj.py` near `_METADATA_TAGS`:

```python
from kumikoroom.auto_dj_planning import is_generic_query


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
```

Re-run sanitization tests:

```text
python -m pytest apps/api/tests/test_auto_dj.py -q -k sanitize
```

## Task 4: Auto DJ Orchestration Rewrite

**Files:**
- Modify: `apps/api/kumikoroom/auto_dj.py`
- Modify: `apps/api/kumikoroom/schemas.py`
- Modify: `apps/api/tests/test_auto_dj.py`

- [ ] **Step 1: Add `llm_config` to `AutoDjRecommendIn`**

```python
class AutoDjRecommendIn(BaseModel):
    music_state: MusicAgentState | None = None
    recommendation_profile: MusicRecommendationProfileIn | None = None
    recent_messages: list[ChatMessageOut] = Field(default_factory=list)
    settings: AutoDjSettingsIn = Field(default_factory=AutoDjSettingsIn)
    llm_config: LLMConfigIn | None = None
```

- [ ] **Step 2: Replace heuristic query construction with the planner**

Refactor `recommend_auto_dj` so it accepts a planner dependency:

```python
from typing import Protocol

from kumikoroom.auto_dj_planning import (
    AutoDjQueryPlan,
    AutoDjQueryPlanningContext,
    PlanningError,
)


class AutoDjQueryPlanner(Protocol):
    def plan_auto_dj_queries(
        self, context: AutoDjQueryPlanningContext
    ) -> AutoDjQueryPlan: ...


def recommend_auto_dj(
    payload: AutoDjRecommendIn,
    planner: AutoDjQueryPlanner,
) -> AutoDjRecommendOut:
    raw_profile = payload.recommendation_profile or _empty_profile()
    sanitized_profile = _sanitize_profile(raw_profile)
    # Context check runs AFTER sanitization. If a profile contains only
    # metadata tags or generic queries, sanitization strips it back to empty
    # and Auto DJ must short-circuit to needs_more_context. Calling the LLM
    # with no real signals would let it invent queries from nothing.
    if not _has_recommendation_context(payload.music_state, sanitized_profile):
        return _needs_more_context_response()

    context = AutoDjQueryPlanningContext(
        music_state=payload.music_state,
        profile=sanitized_profile,
        recent_messages=tuple(
            (m.role, m.content) for m in payload.recent_messages[-200:]
        ),
        settings=payload.settings,
    )

    try:
        plan = planner.plan_auto_dj_queries(context)
    except PlanningError as error:
        return _query_planning_failed_response(str(error))

    intents = _intents_from_plan(plan)
    source_errors: list[str] = []
    candidates = _recall_candidates(intents, source_errors)
    scored = _score_candidates(
        list(candidates.values()),
        payload.music_state,
        sanitized_profile,
        _blocked_item_ids(payload.music_state, sanitized_profile),
    )
    similar_count, exploration_count = _effective_mix(payload, sanitized_profile)
    selected = _select_candidates(
        scored,
        count=payload.settings.count,
        similar_count=similar_count,
        exploration_count=exploration_count,
    )
    if not selected:
        return _no_qualified_candidates_response(source_errors)

    return _build_success_response(
        payload=payload,
        selected=selected,
        source_errors=source_errors,
        sanitized_profile=sanitized_profile,
    )
```

Add the success helper next to the failure helpers. It mirrors the existing inline success path in `recommend_auto_dj` (current `auto_dj.py:86-131`), but takes already-selected candidates and the sanitized profile:

```python
from kumikoroom.schemas import (
    RecommendationHistoryEntryIn,
    RecommendationProfilePatchOut,
    RecommendationRefillHistoryEntryIn,
    RoomClientActionOut,
)


def _build_success_response(
    *,
    payload: AutoDjRecommendIn,
    selected: list[ScoredCandidate],
    source_errors: list[str],
    sanitized_profile: MusicRecommendationProfileIn,
) -> AutoDjRecommendOut:
    refill_id = f"auto-dj-{_utc_compact_timestamp()}"
    created_at = _current_iso_time()

    recommendations = [
        _recommendation_from_scored(scored_candidate)
        for scored_candidate in selected
    ]
    client_actions = [
        RoomClientActionOut(
            type="add_music_to_queue", item=recommendation.item
        )
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
        cooldowns=[],
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
        error=None,
        source_errors=source_errors,
    )
```

`_dominant_themes` is the existing helper. Keep it (it filters `_METADATA_TAGS` already). The only delete in `auto_dj.py` is `_similar_query_seeds`, `_exploration_query_seeds`, the `["music explore"]` fallback, the inline success block now superseded by `_build_success_response`, and the `explore`-in-title score bonus inside `_candidate_score`.

Implementation details:

1. **Extend `AutoDjIntent`** to carry the original LLM intent and a derived `selection_group` for slot logic. The four kinds match `RecommendationIntentKind`:

   ```python
   from typing import Literal

   IntentSelectionGroup = Literal["similar", "exploration"]

   @dataclass(frozen=True)
   class AutoDjIntent:
       name: RecommendationIntentKind  # "similar_theme" | "similar_mood" |
                                       # "same_creator_or_work" | "light_exploration"
       selection_group: IntentSelectionGroup
       query: str
       themes: tuple[str, ...]
   ```

   Map similar_theme / similar_mood / same_creator_or_work → `selection_group="similar"`. Map light_exploration → `selection_group="exploration"`. The recommendation response keeps reporting `intent.name` so the UI shows the original LLM intent label, not the coarse group.

2. **Update slot selection (`_select_for_intent`, `_select_candidates`)** to filter on `candidate.recalled.intent.selection_group` instead of `intent_name`. The Literal type for `intent_name` parameter changes to `IntentSelectionGroup`.

3. **Delete `_similar_query_seeds`, `_exploration_query_seeds`, the `["music explore"]` fallback**, and the `_dominant_themes` callsite that fed those seeds. Keep `_dominant_themes` only if other scoring code reads it; otherwise delete.

4. **Add `_intents_from_plan(plan)`** to build `AutoDjIntent` objects from the validated plan, computing `selection_group` per the mapping above. Use `entry.themes` as the `themes` tuple for `_candidate_score`.

5. **In `_candidate_score`**, delete the `if intent.name == "light_exploration": ... if "explore" in title_norm: score += 14.0` block (spec §11). Keep slot bonuses against `selection_group` if they are still useful, but no title-substring rewards.

6. **`_query_planning_failed_response(detail)`** returns the planning-failure body from spec §12.
7. **`_no_qualified_candidates_response(source_errors)`** returns empty actions/recommendations with `error="no_qualified_candidates"`.
8. **`_needs_more_context_response()`** is the existing zero-context response, untouched.

Concrete bodies for the three response helpers (spec §12):

```python
def _empty_profile_patch() -> RecommendationProfilePatchOut:
    return RecommendationProfilePatchOut(
        recommended_items=[], cooldowns=[], refill_history=[]
    )


def _needs_more_context_response() -> AutoDjRecommendOut:
    return AutoDjRecommendOut(
        ok=False,
        refill_id=None,
        notice="Auto DJ 暂时没找到合适的歌",
        client_actions=[],
        recommendations=[],
        profile_patch=_empty_profile_patch(),
        error="needs_more_context",
        source_errors=[],
    )


def _query_planning_failed_response(detail: str) -> AutoDjRecommendOut:
    # `detail` goes to logs only; the public notice stays compact.
    logger.info("auto dj planning failed: %s", detail)
    return AutoDjRecommendOut(
        ok=False,
        refill_id=None,
        notice="Auto DJ 暂时没找到合适的歌",
        client_actions=[],
        recommendations=[],
        profile_patch=_empty_profile_patch(),
        error="query_planning_failed",
        source_errors=[],
    )


def _no_qualified_candidates_response(source_errors: list[str]) -> AutoDjRecommendOut:
    return AutoDjRecommendOut(
        ok=False,
        refill_id=None,
        notice="Auto DJ 暂时没找到合适的歌",
        client_actions=[],
        recommendations=[],
        profile_patch=_empty_profile_patch(),
        error="no_qualified_candidates",
        source_errors=source_errors,
    )
```

Add `import logging` and `logger = logging.getLogger(__name__)` at module top if not already present.

- [ ] **Step 3: Wire the router**

In `apps/api/kumikoroom/routers/room.py`:

```python
from kumikoroom.auto_dj import recommend_auto_dj
from kumikoroom.config import load_settings
from kumikoroom.conversation import ConversationManager


@router.post("/music/auto-dj/recommend", response_model=AutoDjRecommendOut)
def recommend_auto_dj_tracks(payload: AutoDjRecommendIn) -> AutoDjRecommendOut:
    planner = ConversationManager(
        settings=load_settings(),
        llm_config=payload.llm_config,
        initialize_stores=False,
        planner_timeout_seconds=15.0,
    )
    return recommend_auto_dj(payload, planner=planner)
```

- [ ] **Step 4: Update existing Auto DJ tests**

Most existing `test_auto_dj.py` tests construct payloads and call `recommend_auto_dj(payload)` directly. They now need a fake planner:

```python
class FakePlanner:
    def __init__(self, plan_or_error):
        self._plan_or_error = plan_or_error
        self.calls = 0

    def plan_auto_dj_queries(self, context):
        self.calls += 1
        if isinstance(self._plan_or_error, BaseException):
            raise self._plan_or_error
        return self._plan_or_error
```

Replace heuristic-query assertions with planner-driven ones. Specifically:

- Tests that asserted "queries derived from current track title/creator" now build a `FakePlanner` returning a fixed `AutoDjQueryPlan` and assert that the captured search queries match plan queries verbatim.
- Tests that asserted `music explore` fallback should now assert that the fallback never appears AND that planner failure produces `error == "query_planning_failed"`.
- Add: planner failure causes zero NetEase / Bilibili calls.
- Add: every captured platform search query appears in the validated plan. Use a search-call recorder (monkeypatch `search_netease_songs` / `search_bilibili_videos`).
- Add: a candidate whose title contains `"explore"` does not receive an extra bonus (set up two candidates with identical signals except title and assert score equality within the platform-base tolerance).
- Add: planner returning a plan that omits a requested intent group propagates as `query_planning_failed`.
- Add: a payload where `music_state is None` and the profile contains **only** `agent-selected` / `search` tag-weights and `music explore` query-weights returns `needs_more_context` and **the FakePlanner is never called** (`planner.calls == 0`). This locks down the sanitize-then-context-check ordering: a profile that is "non-empty before sanitization, empty after" must short-circuit, never let the LLM hallucinate queries from a stripped context. Use `MusicRecommendationProfileIn.model_validate({...})` to seed the polluted profile and assert both the response `error == "needs_more_context"` and `planner.calls == 0`.

- [ ] **Step 5: Run all backend tests**

```text
python -m pytest apps/api/tests -q
```

Fix any chat-side test that breaks. Chat behavior must stay identical.

## Task 5: Frontend Wiring

**Files:**
- Modify: `apps/web/src/api/types.ts`
- Modify: `apps/web/src/api/client.ts`
- Modify: `apps/web/tests/client.test.ts`

- [ ] **Step 1: Add `llmConfig` to the request type and `error` to the response**

```ts
export interface AutoDjRecommendRequest {
  musicState: MusicAgentState | null;
  recommendationProfile: MusicRecommendationProfile;
  recentMessages: ChatMessage[];
  settings: AutoDjSettings;
  llmConfig: LLMConfig | null;
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

- [ ] **Step 2: Map config and error in `client.ts`**

Reuse the existing `mapLlmConfigRequest` (whatever the chat path uses). On the way back, parse `error` (or `null`).

- [ ] **Step 3: Test the round trip**

```ts
import { describe, expect, it, vi } from "vitest";

import { recommendAutoDj } from "../src/api/client";
import type { AutoDjRecommendRequest, LLMConfig } from "../src/api/types";

const baseRequest = (overrides: Partial<AutoDjRecommendRequest> = {}): AutoDjRecommendRequest => ({
  musicState: null,
  recommendationProfile: {
    version: 1,
    updatedAt: "2026-06-19T00:00:00.000Z",
    artistWeights: {},
    tagWeights: {},
    sourceWeights: {},
    queryWeights: {},
    recentThemes: [],
    cooldowns: [],
    recommendedItems: [],
    refillHistory: [],
  },
  recentMessages: [],
  settings: { count: 3, queueDepthTrigger: 2, similarCount: 2, explorationCount: 1 },
  llmConfig: null,
  ...overrides,
});

const llmConfig: LLMConfig = {
  provider: "openai_compatible",
  baseUrl: "https://example.invalid",
  apiKey: "test",
  model: "planner-model",
};

describe("recommendAutoDj request", () => {
  it("posts llm_config when llmConfig is provided", async () => {
    const fetchMock = vi.fn(async (_url: string, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body ?? "{}"));
      expect(body.llm_config).toEqual({
        provider: "openai_compatible",
        base_url: "https://example.invalid",
        api_key: "test",
        model: "planner-model",
      });
      return new Response(
        JSON.stringify({
          ok: true,
          refill_id: "r1",
          notice: "ok",
          client_actions: [],
          recommendations: [],
          profile_patch: { recommended_items: [], cooldowns: [], refill_history: [] },
          error: null,
          source_errors: [],
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    });
    vi.stubGlobal("fetch", fetchMock);

    await recommendAutoDj(baseRequest({ llmConfig }));

    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it("maps the error code from a planner failure", async () => {
    vi.stubGlobal("fetch", vi.fn(async () =>
      new Response(
        JSON.stringify({
          ok: false,
          refill_id: null,
          notice: "Auto DJ 暂时没找到合适的歌",
          client_actions: [],
          recommendations: [],
          profile_patch: { recommended_items: [], cooldowns: [], refill_history: [] },
          error: "query_planning_failed",
          source_errors: [],
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      ),
    ));

    const response = await recommendAutoDj(baseRequest());
    expect(response.ok).toBe(false);
    expect(response.error).toBe("query_planning_failed");
  });
});
```

```text
npm run test --workspace apps/web -- client.test.ts
```

## Task 6: RoomShell — 200 Messages, Status, Failure Isolation

**Files:**
- Modify: `apps/web/src/components/RoomShell.tsx`
- Modify: `apps/web/app/globals.css`
- Modify: `apps/web/tests/RoomShell.test.tsx`

- [ ] **Step 1: Write failing UI tests**

The existing `apps/web/tests/RoomShell.test.tsx` already declares `apiMocks` via `vi.hoisted` at module top (lines 10-32). All new tests must reuse that same `apiMocks` and `vi.mock("../src/api/client", ...)` block — do not invent a separate mock module or a `helpers/apiMocks` import. `RoomShell` is a **named** export (`import { RoomShell } from "../src/components/RoomShell"`).

Append these tests to the existing `describe("RoomShell", () => {...})` block. They reuse the file's `defaultSession`, `connectionStatus`, and the `beforeEach` setup that resets mocks and clears `localStorage`. The exact storage keys (`kumikoroom.musicQueue`, `kumikoroom.llmConfig`) come from `apps/web/src/components/RoomShell.tsx` — open that file first to confirm the names before pasting:

```ts
const PLANNER_LLM_CONFIG = {
  provider: "openai_compatible" as const,
  baseUrl: "https://example.invalid",
  apiKey: "test",
  model: "planner-model",
};

const SUCCESS_AUTO_DJ_RESPONSE = {
  ok: true,
  refillId: "auto-dj-test",
  notice: "Auto DJ added 1 track and kept close to the current mood.",
  clientActions: [],
  recommendations: [],
  profilePatch: { recommendedItems: [], cooldowns: [], refillHistory: [] },
  error: null,
  sourceErrors: [],
};

const FAILURE_AUTO_DJ_RESPONSE = {
  ok: false,
  refillId: null,
  notice: "Auto DJ 暂时没找到合适的歌",
  clientActions: [],
  recommendations: [],
  profilePatch: { recommendedItems: [], cooldowns: [], refillHistory: [] },
  error: "query_planning_failed",
  sourceErrors: [],
};

function seedStoredMessages(sessionId: string, count: number): void {
  const messages: StoredChatMessage[] = Array.from({ length: count }, (_, index) => ({
    id: `m-${index}`,
    sessionId,
    role: index % 2 === 0 ? "user" : "kumiko",
    content: `seed message ${index}`,
    createdAt: new Date(2026, 5, 19, 0, 0, index).toISOString(),
    providerStatus: null,
  }));
  apiMocks.getSessionMessages.mockResolvedValueOnce(messages);
}

function seedQueueAtTrigger(): void {
  // Queue depth equal to settings.queueDepthTrigger (default 2). Reuse the
  // existing makeQueueEntry helper / queue fixture earlier in this file.
  const queue = {
    entries: [
      makeQueueEntry({ id: "playable-1", status: "current" }),
      makeQueueEntry({ id: "playable-2", status: "queued" }),
    ],
    updatedAt: new Date(2026, 5, 19).toISOString(),
  };
  localStorage.setItem("kumikoroom.musicQueue", JSON.stringify(queue));
}

it("sends llmConfig with the auto dj refill", async () => {
  apiMocks.recommendAutoDj.mockResolvedValueOnce(SUCCESS_AUTO_DJ_RESPONSE);
  localStorage.setItem("kumikoroom.llmConfig", JSON.stringify(PLANNER_LLM_CONFIG));
  seedQueueAtTrigger();

  render(
    <RoomShell initialState={DEFAULT_ROOM_STATE} connectionStatus={connectionStatus} />,
  );
  fireEvent.click(await screen.findByRole("switch", { name: /Auto DJ/i }));

  await waitFor(() => expect(apiMocks.recommendAutoDj).toHaveBeenCalled());
  const request = apiMocks.recommendAutoDj.mock.calls[0][0];
  expect(request.llmConfig).toMatchObject({
    provider: "openai_compatible",
    apiKey: "test",
  });
});

it("includes up to the last 200 chat messages on auto dj refill", async () => {
  apiMocks.recommendAutoDj.mockResolvedValueOnce(SUCCESS_AUTO_DJ_RESPONSE);
  seedStoredMessages(defaultSession.id, 250);
  seedQueueAtTrigger();

  render(
    <RoomShell initialState={DEFAULT_ROOM_STATE} connectionStatus={connectionStatus} />,
  );
  fireEvent.click(await screen.findByRole("switch", { name: /Auto DJ/i }));

  await waitFor(() => expect(apiMocks.recommendAutoDj).toHaveBeenCalled());
  const request = apiMocks.recommendAutoDj.mock.calls[0][0];
  expect(request.recentMessages).toHaveLength(200);
});

it("shows the inline planner-failure status", async () => {
  apiMocks.recommendAutoDj.mockResolvedValueOnce(FAILURE_AUTO_DJ_RESPONSE);
  seedQueueAtTrigger();

  render(
    <RoomShell initialState={DEFAULT_ROOM_STATE} connectionStatus={connectionStatus} />,
  );
  fireEvent.click(await screen.findByRole("switch", { name: /Auto DJ/i }));

  expect(await screen.findByText("暂时没找到合适的歌")).toBeInTheDocument();
  // No chat notice was appended.
  expect(screen.queryByText(/Auto DJ added/i)).toBeNull();
});

it("does not route auto dj planner failure through chat send error", async () => {
  apiMocks.recommendAutoDj.mockResolvedValueOnce(FAILURE_AUTO_DJ_RESPONSE);
  seedQueueAtTrigger();

  render(
    <RoomShell initialState={DEFAULT_ROOM_STATE} connectionStatus={connectionStatus} />,
  );
  fireEvent.click(await screen.findByRole("switch", { name: /Auto DJ/i }));

  await waitFor(() => expect(apiMocks.recommendAutoDj).toHaveBeenCalled());
  // The chat send-error banner used by sendChatMessage stays empty.
  expect(screen.queryByText("消息没送出去，检查本地 API 后可以重试。")).toBeNull();
});

it("retries the same queue after toggling auto dj off then on", async () => {
  apiMocks.recommendAutoDj
    .mockResolvedValueOnce(FAILURE_AUTO_DJ_RESPONSE)
    .mockResolvedValueOnce(SUCCESS_AUTO_DJ_RESPONSE);
  seedQueueAtTrigger();

  render(
    <RoomShell initialState={DEFAULT_ROOM_STATE} connectionStatus={connectionStatus} />,
  );
  const toggle = await screen.findByRole("switch", { name: /Auto DJ/i });
  fireEvent.click(toggle); // on, fires once
  await waitFor(() => expect(apiMocks.recommendAutoDj).toHaveBeenCalledTimes(1));
  fireEvent.click(toggle); // off
  fireEvent.click(toggle); // on, fires again on the same signature
  await waitFor(() => expect(apiMocks.recommendAutoDj).toHaveBeenCalledTimes(2));
});
```

`makeQueueEntry` already exists earlier in `RoomShell.test.tsx` for the existing Auto DJ tests — reuse it. If a helper does not exist for a piece of fixture, mirror the shape from the surrounding tests in the same file rather than inventing a new module.

- [ ] **Step 2: Update RoomShell**

1. Find `messages.slice(-8)` in the Auto DJ trigger effect and the `recommendAutoDj` call. Change to `messages.slice(-200)`.
2. In `recommendAutoDj({...})`, add `llmConfig: llmConfig ?? null`.
3. Replace `setSendError("Auto DJ refill failed")` with a new local state, e.g. `setAutoDjStatus({ kind: "unavailable" })`. Add `idle | loading | unavailable | success` states.
4. Render the status near the existing Auto DJ switch. CSS class `.auto-dj-status[data-state="unavailable"]`.
5. In the trigger effect, before calling `recommendAutoDj`, set status to `loading`. On success, set status to `success` then clear after a short timeout (or on next render commit). On failure or `ok:false`, set status to `unavailable`.
6. Add an explicit toggle handler. When the user turns the switch off, clear status and clear `autoDjLastRequestedSignature` so re-enable can retry.
7. `applyAutoDjResponse` already short-circuits when `!response.ok` — confirm it does NOT append a chat timeline `notice` in that path. If it does, gate the `setMessages([...current, notice])` line on `response.ok`.

- [ ] **Step 3: Add CSS**

```css
.auto-dj-status {
  font-size: 12px;
  margin-left: 8px;
  opacity: 0.8;
}
.auto-dj-status[data-state="loading"]::before { content: "·"; }
.auto-dj-status[data-state="unavailable"] { color: var(--warn-fg, #c66); }
```

- [ ] **Step 4: Run frontend suite**

```text
npm run test --workspace apps/web
npm run build --workspace apps/web
```

Fix any test that depended on the old 8-message slice or the old failure-path chat notice.

## Task 7: End-to-End Verification

**Files:** None modified in this task.

- [ ] **Step 1: Run all tests**

```text
python -m pytest apps/api/tests -q
npm run test --workspace apps/web
npm run build --workspace apps/web
```

All green is the bar.

- [ ] **Step 2: Add a backend log line for selected search queries**

For the manual verification below to be meaningful, the orchestrator must log the queries it actually sent. Add one line at the top of `_recall_candidates` in `auto_dj.py`:

```python
logger.info(
    "auto dj search queries: %s",
    [intent.query for intent in intents],
)
```

This is the only logging change in scope; do not add per-track scoring logs. Run the backend suite once more to confirm nothing broke.

- [ ] **Step 3: Manual desktop browser verification**

1. Start the API and web dev servers.
2. Configure a real LLM in the UI (frontend `llmConfig`).
3. Play a track, let the queue drain to ≤ 2.
4. Confirm Auto DJ refills with 3 recommendations. Each entry's `selectedReason` is built by deterministic scoring (`_reason_for_score`); verify it mentions the LLM-supplied themes/intent and is non-empty. Do **not** expect verbatim LLM prose.
5. In the API server logs, find the `auto dj search queries:` line and confirm none of them is `music explore` and none contains `agent-selected`. Also grep the log for `query_planning_failed`; there should be zero occurrences for the success path.
6. Failure path: in the UI, switch the LLM provider to **mock** (the planner explicitly rejects mock per spec §6). Drain the queue, then confirm: the inline status shows "暂时没找到合适的歌", queue does not change, no chat notice appears, and the chat send-error region stays empty. Do **not** test by clearing the local LLM config — the server may still have a configured provider.
7. Toggle Auto DJ off and on; confirm a retry is permitted on the same queue (a second `recommendAutoDj` call is dispatched).
8. Switch back to a real LLM, drain again, confirm a successful refill.

This covers the manual portion of spec §15.

- [ ] **Step 4: Commit per scope**

Per-task scoped commits keep the diff readable. Earlier tasks committed `llm.py` and the lazy-init prerequisite separately. Land the remaining changes in two more commits:

```text
# Backend planning + sanitization + orchestration rewrite
git add \
  apps/api/kumikoroom/auto_dj_planning.py \
  apps/api/kumikoroom/auto_dj.py \
  apps/api/kumikoroom/conversation.py \
  apps/api/kumikoroom/schemas.py \
  apps/api/kumikoroom/routers/room.py \
  apps/api/tests/test_auto_dj.py \
  apps/api/tests/test_auto_dj_planning.py \
  apps/api/tests/test_conversation_planning.py
git commit -m "feat: llm-only auto dj query planning (backend)"

# Frontend wiring + UI status
git add \
  apps/web/src/api/types.ts \
  apps/web/src/api/client.ts \
  apps/web/src/components/RoomShell.tsx \
  apps/web/app/globals.css \
  apps/web/tests/client.test.ts \
  apps/web/tests/RoomShell.test.tsx
git commit -m "feat: llm-only auto dj query planning (frontend)"
```

Run `git status` before each commit and reject anything outside the listed paths. Stray files (build artefacts, IDE settings) get cleaned up first, not committed.

## Acceptance Criteria

- Auto DJ performs no NetEase or Bilibili search without a validated LLM plan from the current request.
- The router constructs a planning-only `ConversationManager` with a 15-second provider timeout.
- Profile sanitization (§7.1) drops metadata tags from `tag_weights` / `recent_themes` / `kind == "tag"` cooldowns and drops generic queries from `query_weights` / `kind == "query"` cooldowns. The original payload object is not mutated.
- A profile that was non-empty before sanitization but empty afterwards short-circuits to `needs_more_context` without invoking the LLM.
- Plans missing a requested non-zero intent group fail validation with `query_planning_failed`.
- The `explore`-in-title score bonus is gone.
- The frontend sends `llmConfig` and up to 200 recent chat messages.
- Failure renders an inline status, leaves the queue and playback untouched, and does not pollute `sendError` or the chat timeline.
- Toggling Auto DJ off and on permits a retry on the same queue.
- Full test suite passes; manual verification confirms a successful refill and a clean failure path.

## Out of Scope

- Caching (spec §9 — explicitly none).
- Codex-framework adoption (spec §4).
- Profile-source rework (spec §4 — automatic learning still writes raw tags; this plan only sanitizes them downstream).
- The known cooldown-field-mismatch bugs (spec §4.1).
- The `autoDjLastRequestedSignature` retry-after-failure root cause (spec §4.1 — only the toggle-based reset is in scope).
- Mobile browser verification (spec §4).

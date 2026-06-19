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
    timeout: float = 3.0,
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
    assert provider.last_timeout == 3.0
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

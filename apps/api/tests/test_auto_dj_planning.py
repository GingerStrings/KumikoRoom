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
        parse_and_validate_plan(raw=short, settings=settings(similar=1, exploration=0))
    with pytest.raises(PlanningError):
        parse_and_validate_plan(raw=too_long, settings=settings(similar=1, exploration=0))


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

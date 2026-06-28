import json
from dataclasses import replace
from pathlib import Path

import pytest

from kumikoroom.config import ApiSettings, load_settings
from kumikoroom.conversation import ConversationManager
from kumikoroom.llm import (
    LLMResult,
    LLMToolCall,
    MockLLMProvider,
    ProviderStatus,
    ProviderUnavailable,
)
from kumikoroom.memory import MemoryStore
from kumikoroom.novel_rag import NovelRagDecision, NovelSearchResult
import kumikoroom.agent_tools as agent_tools
from kumikoroom.agent_tools import (
    RoomAgentToolContext,
    dispatch_room_agent_tool,
    room_agent_tool_specs,
)
from kumikoroom.music_search import (
    BilibiliVideoSearchResult,
    NeteaseSongSearchResult,
)
from kumikoroom.schemas import ChatIn, ChatMessageOut, LLMConfigIn
from kumikoroom.sessions import ChatSession, StoredChatMessage


class FakeProvider:
    def __init__(self, content="嗯，我在听。这个 demo 可以先保留一个安静的版本。"):
        self.messages = []
        self.content = content

    def generate(self, messages, tools=None, tool_choice=None):
        self.messages = messages
        return LLMResult(
            content=self.content,
            provider_status=ProviderStatus(
                provider="deepseek",
                model="deepseek-v4-flash",
                configured=True,
                label="DeepSeek deepseek-v4-flash",
            ),
        )


class RecordingProvider:
    def __init__(self, content="Kumiko reply"):
        self.calls = []
        self.content = content

    def generate(self, messages, **kwargs):
        self.calls.append({"messages": messages, "kwargs": kwargs})
        return LLMResult(
            content=self.content,
            provider_status=ProviderStatus(
                provider="deepseek",
                model="deepseek-v4-flash",
                configured=True,
                label="DeepSeek deepseek-v4-flash",
            ),
        )


class UnavailableProvider:
    def generate(self, messages, tools=None, tool_choice=None):
        raise ProviderUnavailable("provider unavailable")


class ToolCallingProvider:
    def __init__(self):
        self.calls = []
        self.status = ProviderStatus(
            provider="deepseek",
            model="deepseek-v4-flash",
            configured=True,
            label="DeepSeek deepseek-v4-flash",
        )

    def generate(self, messages, tools=None, tool_choice=None):
        self.calls.append(
            {"messages": messages, "tools": tools, "tool_choice": tool_choice}
        )
        if len(self.calls) == 1:
            return LLMResult(
                content="",
                provider_status=self.status,
                tool_calls=[
                    LLMToolCall(
                        id="call-search",
                        name="search_music",
                        arguments={
                            "query": "晴天 周杰伦",
                            "source": "netease",
                            "limit": 8,
                        },
                    )
                ],
            )
        if len(self.calls) == 2:
            return LLMResult(
                content="",
                provider_status=self.status,
                tool_calls=[
                    LLMToolCall(
                        id="call-play",
                        name="play_music_item",
                        arguments={"item_id": "netease-song-2"},
                    )
                ],
            )
        return LLMResult(
            content="我找了一下，选了证据最稳的《晴天》。",
            provider_status=self.status,
        )


class FakeSessionStore:
    def __init__(self):
        self.session = ChatSession(
            id="session-1",
            title="New conversation",
            created_at="2026-06-10T00:00:00+00:00",
            updated_at="2026-06-10T00:00:00+00:00",
        )
        self.saved = []

    def ensure_default_session(self):
        return self.session

    def get_session(self, session_id):
        assert session_id == self.session.id
        return self.session

    def append_message(self, **kwargs):
        message = StoredChatMessage(
            id=f"message-{len(self.saved) + 1}",
            session_id=kwargs["session_id"],
            role=kwargs["role"],
            content=kwargs["content"],
            created_at=f"2026-06-10T00:00:0{len(self.saved)}+00:00",
            provider=kwargs.get("provider"),
            provider_model=kwargs.get("provider_model"),
            provider_configured=kwargs.get("provider_configured"),
            provider_label=kwargs.get("provider_label"),
        )
        self.saved.append(message)
        return message


class FakeNovelRouter:
    def __init__(self, decision=None, error: Exception | None = None):
        self.decision = decision or NovelRagDecision(False, "", reason="skip")
        self.error = error
        self.calls = []

    def route(self, message, *, recent_user_messages=()):
        self.calls.append(
            {
                "message": message,
                "recent_user_messages": list(recent_user_messages),
            }
        )
        if self.error is not None:
            raise self.error
        return self.decision


class FakeNovelStore:
    def __init__(self, results=None, error: Exception | None = None):
        self.results = list(results or [])
        self.error = error
        self.calls = []

    def search(self, query, limit=5):
        self.calls.append({"query": query, "limit": limit})
        if self.error is not None:
            raise self.error
        return self.results


def music_track_fixture(
    item_id: str,
    title: str,
    *,
    saved: bool = False,
) -> dict:
    return {
        "id": item_id,
        "source": "netease",
        "title": title,
        "creator": "Fixture Artist",
        "duration_ms": 180000,
        "page_url": f"https://music.example/{item_id}",
        "platform_audio_url": f"https://audio.example/{item_id}.mp3",
        "tags": ["fixture"],
        "can_open_video": False,
        "saved": saved,
    }


def music_state_fixture() -> dict:
    return {
        "is_playing": True,
        "current_time_ms": 42000,
        "duration_ms": 180000,
        "current": music_track_fixture("current", "Current Song", saved=True),
        "previous": music_track_fixture("previous", "Previous Song"),
        "next": music_track_fixture("next", "Next Song"),
        "upcoming": [
            music_track_fixture("next", "Next Song"),
            music_track_fixture("later", "Later Song"),
        ],
        "recent": [music_track_fixture("recent", "Recent Song")],
        "saved": [
            music_track_fixture("current", "Current Song", saved=True),
            music_track_fixture("saved", "Saved Song", saved=True),
        ],
        "playlists": [
            {
                "id": "playlist-night-writing",
                "name": "Night Writing",
                "description": "quiet songs",
                "item_count": 1,
                "updated_at": "2026-06-15T00:01:00.000Z",
                "items": [music_track_fixture("saved", "Saved Song", saved=True)],
            }
        ],
    }


def playlist_only_music_state_fixture() -> dict:
    state = music_state_fixture()
    state["playlists"].append(
        {
            "id": "playlist-deep-cuts",
            "name": "Deep Cuts",
            "description": None,
            "item_count": 1,
            "updated_at": "2026-06-15T00:02:00.000Z",
            "items": [
                music_track_fixture("playlist-only", "Playlist Only Song"),
            ],
        }
    )
    return state


def assert_successful_playlist_action(context, name, arguments):
    before_count = len(context.client_actions)
    result = dispatch_room_agent_tool(
        LLMToolCall(id=name, name=name, arguments=arguments),
        context,
    )

    assert result.ok is True
    assert len(context.client_actions) == before_count + 1
    return result, context.client_actions[-1], json.loads(result.content)


def test_music_state_schema_preserves_snapshot_and_prompt(monkeypatch, tmp_path) -> None:
    monkeypatch.setenv("KUMIKOROOM_MEMORY_DB_PATH", str(tmp_path / "memory.sqlite3"))
    provider = FakeProvider()

    payload = ChatIn(
        message="what is playing",
        music_state=music_state_fixture(),
        memory_enabled=False,
    )

    assert payload.music_state is not None
    assert payload.music_state.next is not None
    assert payload.music_state.next.title == "Next Song"
    assert payload.music_state.upcoming[1].id == "later"
    assert payload.music_state.playlists[0].name == "Night Writing"

    ConversationManager(settings=load_settings(), provider=provider).chat(payload)

    system_text = provider.messages[0]["content"]
    assert "Music state:" in system_text
    assert "Playing: yes" in system_text
    assert "Current: Current Song - Fixture Artist (current)" in system_text
    assert "Next: Next Song - Fixture Artist (next)" in system_text
    assert (
        "Upcoming: Next Song - Fixture Artist (next); "
        "Later Song - Fixture Artist (later)"
    ) in system_text
    assert "Recent: Recent Song - Fixture Artist (recent)" in system_text
    assert (
        "Saved: Current Song - Fixture Artist (current); "
        "Saved Song - Fixture Artist (saved)"
    ) in system_text
    assert "Playlists: Night Writing (1 track, playlist-night-writing)" in system_text


def test_music_state_schema_defaults_missing_playlists_to_empty_list() -> None:
    state = music_state_fixture()
    state.pop("playlists")

    payload = ChatIn(message="legacy state", music_state=state)

    assert payload.music_state is not None
    assert payload.music_state.playlists == []


def test_get_music_state_and_state_mutation_tools_emit_client_actions() -> None:
    payload = ChatIn(message="state", music_state=music_state_fixture())
    context = RoomAgentToolContext(music_state=payload.music_state)

    specs = {spec["function"]["name"] for spec in room_agent_tool_specs()}
    assert {
        "get_music_state",
        "add_music_to_queue",
        "remove_music_from_queue",
        "save_music_item",
        "unsave_music_item",
        "clear_music_queue",
    }.issubset(specs)

    state_result = dispatch_room_agent_tool(
        LLMToolCall(id="state", name="get_music_state", arguments={}),
        context,
    )
    assert state_result.ok is True
    state_payload = json.loads(state_result.content)
    assert state_payload["music_state"]["next"]["title"] == "Next Song"
    assert state_payload["music_state"]["recent"][0]["id"] == "recent"

    save_result = dispatch_room_agent_tool(
        LLMToolCall(
            id="save",
            name="save_music_item",
            arguments={"item_id": "current"},
        ),
        context,
    )
    assert save_result.ok is True
    assert context.client_actions[-1].type == "save_music_item"
    assert context.client_actions[-1].item.id == "current"

    remove_result = dispatch_room_agent_tool(
        LLMToolCall(
            id="remove",
            name="remove_music_from_queue",
            arguments={"item_id": "next"},
        ),
        context,
    )
    assert remove_result.ok is True
    assert context.client_actions[-1].type == "remove_music_from_queue"
    assert context.client_actions[-1].item_id == "next"

    unsave_result = dispatch_room_agent_tool(
        LLMToolCall(
            id="unsave",
            name="unsave_music_item",
            arguments={"item_id": "saved"},
        ),
        context,
    )
    assert unsave_result.ok is True
    assert context.client_actions[-1].type == "unsave_music_item"
    assert context.client_actions[-1].item_id == "saved"

    clear_result = dispatch_room_agent_tool(
        LLMToolCall(id="clear", name="clear_music_queue", arguments={}),
        context,
    )
    assert clear_result.ok is True
    assert context.client_actions[-1].type == "clear_music_queue"
    assert context.client_actions[-1].item is None
    assert context.client_actions[-1].item_id is None


def test_playlist_agent_tool_specs_and_read_tools() -> None:
    payload = ChatIn(message="playlist state", music_state=music_state_fixture())
    context = RoomAgentToolContext(music_state=payload.music_state)

    specs_by_name = {
        spec["function"]["name"]: spec["function"] for spec in room_agent_tool_specs()
    }
    assert {
        "list_music_playlists",
        "get_music_playlist",
        "create_music_playlist",
        "rename_music_playlist",
        "delete_music_playlist",
        "add_music_to_playlist",
        "remove_music_from_playlist",
        "play_music_playlist",
        "add_playlist_to_queue",
    }.issubset(specs_by_name)
    assert "playlists" in specs_by_name["get_music_state"]["description"]

    list_result = dispatch_room_agent_tool(
        LLMToolCall(id="list", name="list_music_playlists", arguments={}),
        context,
    )
    assert list_result.ok is True
    list_payload = json.loads(list_result.content)
    assert list_payload["playlists"][0] == {
        "id": "playlist-night-writing",
        "name": "Night Writing",
        "description": "quiet songs",
        "item_count": 1,
        "updated_at": "2026-06-15T00:01:00.000Z",
    }
    assert "items" not in list_payload["playlists"][0]
    assert context.client_actions == []

    get_result = dispatch_room_agent_tool(
        LLMToolCall(
            id="get",
            name="get_music_playlist",
            arguments={"playlist_id_or_name": "Night Writing"},
        ),
        context,
    )
    assert get_result.ok is True
    get_payload = json.loads(get_result.content)
    assert get_payload["playlist"]["id"] == "playlist-night-writing"
    assert get_payload["playlist"]["items"][0]["id"] == "saved"
    assert context.client_actions == []


def test_playlist_mutation_tools_emit_exactly_one_client_action() -> None:
    def make_context() -> RoomAgentToolContext:
        payload = ChatIn(message="playlist actions", music_state=music_state_fixture())
        return RoomAgentToolContext(
            music_state=payload.music_state,
            candidates={
                "netease-song-candidate": NeteaseSongSearchResult(
                    id="netease-song-candidate",
                    song_id="candidate",
                    title="Candidate Song",
                    creator="Fixture Artist",
                    duration_ms=210000,
                    playable=True,
                    popularity=55.0,
                    comment_count=100,
                    hot_comment_liked_count=25,
                    score=77.0,
                    evidence=["candidate evidence"],
                )
            },
            candidate_queries={"netease-song-candidate": "candidate query"},
        )

    context = make_context()
    _, action, payload = assert_successful_playlist_action(
        context,
        "create_music_playlist",
        {"name": "Focus", "description": "for revisions"},
    )
    assert action.type == "create_music_playlist"
    assert action.playlist_id == "playlist-focus"
    assert action.playlist_name == "Focus"
    assert action.description == "for revisions"
    assert payload["client_action"]["playlist_id"] == payload["playlist"]["id"]
    assert payload["client_action"]["playlist_name"] == "Focus"

    context = make_context()
    _, action, _ = assert_successful_playlist_action(
        context,
        "rename_music_playlist",
        {"playlist_id_or_name": "Night Writing", "name": "Late Desk"},
    )
    assert action.type == "rename_music_playlist"
    assert action.playlist_id == "playlist-night-writing"
    assert action.playlist_name == "Late Desk"

    context = make_context()
    _, action, _ = assert_successful_playlist_action(
        context,
        "delete_music_playlist",
        {"playlist_id_or_name": "playlist-night-writing"},
    )
    assert action.type == "delete_music_playlist"
    assert action.playlist_id == "playlist-night-writing"

    context = make_context()
    _, action, _ = assert_successful_playlist_action(
        context,
        "add_music_to_playlist",
        {
            "playlist_id_or_name": "playlist-night-writing",
            "item_id": "netease-song-candidate",
        },
    )
    assert action.type == "add_music_to_playlist"
    assert action.playlist_id == "playlist-night-writing"
    assert action.item is not None
    assert action.item.id == "netease-song-candidate"
    assert action.item.source_query == "candidate query"

    context = make_context()
    _, action, _ = assert_successful_playlist_action(
        context,
        "remove_music_from_playlist",
        {"playlist_id_or_name": "playlist-night-writing", "item_id": "saved"},
    )
    assert action.type == "remove_music_from_playlist"
    assert action.playlist_id == "playlist-night-writing"
    assert action.item_id == "saved"

    context = make_context()
    _, action, _ = assert_successful_playlist_action(
        context,
        "play_music_playlist",
        {"playlist_id_or_name": "playlist-night-writing"},
    )
    assert action.type == "play_music_playlist"
    assert action.playlist_id == "playlist-night-writing"
    assert action.playlist_name == "Night Writing"

    context = make_context()
    _, action, _ = assert_successful_playlist_action(
        context,
        "add_playlist_to_queue",
        {"playlist_id_or_name": "playlist-night-writing"},
    )
    assert action.type == "add_playlist_to_queue"
    assert action.playlist_id == "playlist-night-writing"
    assert action.playlist_name == "Night Writing"


def test_playlist_tools_validate_inputs_and_existing_state() -> None:
    state = music_state_fixture()
    state["playlists"].append(
        {
            "id": "playlist-empty",
            "name": "Empty",
            "description": None,
            "item_count": 0,
            "updated_at": "2026-06-15T00:03:00.000Z",
            "items": [],
        }
    )
    payload = ChatIn(message="playlist validation", music_state=state)
    context = RoomAgentToolContext(music_state=payload.music_state)

    create_result = dispatch_room_agent_tool(
        LLMToolCall(
            id="create",
            name="create_music_playlist",
            arguments={"name": "   "},
        ),
        context,
    )
    assert create_result.ok is False

    rename_result = dispatch_room_agent_tool(
        LLMToolCall(
            id="rename",
            name="rename_music_playlist",
            arguments={"playlist_id_or_name": "missing", "name": "New"},
        ),
        context,
    )
    assert rename_result.ok is False
    assert "playlist" in json.loads(rename_result.content)["error"]

    remove_result = dispatch_room_agent_tool(
        LLMToolCall(
            id="remove",
            name="remove_music_from_playlist",
            arguments={"playlist_id_or_name": "playlist-night-writing", "item_id": "recent"},
        ),
        context,
    )
    assert remove_result.ok is False
    assert "playlist" in json.loads(remove_result.content)["error"]

    play_result = dispatch_room_agent_tool(
        LLMToolCall(
            id="play",
            name="play_music_playlist",
            arguments={"playlist_id_or_name": "playlist-empty"},
        ),
        context,
    )
    assert play_result.ok is False
    assert "at least one" in json.loads(play_result.content)["error"]
    assert context.client_actions == []


def test_add_music_to_playlist_supports_playlist_state_items() -> None:
    payload = ChatIn(
        message="add playlist-only track",
        music_state=playlist_only_music_state_fixture(),
    )
    context = RoomAgentToolContext(music_state=payload.music_state)

    result = dispatch_room_agent_tool(
        LLMToolCall(
            id="add",
            name="add_music_to_playlist",
            arguments={
                "playlist_id_or_name": "playlist-night-writing",
                "item_id": "playlist-only",
            },
        ),
        context,
    )

    assert result.ok is True
    assert context.client_actions[-1].type == "add_music_to_playlist"
    assert context.client_actions[-1].item is not None
    assert context.client_actions[-1].item.id == "playlist-only"
    assert context.client_actions[-1].item.selection_evidence == [
        "music_state.playlists.playlist-deep-cuts.items"
    ]


def test_playlist_mutation_updates_music_state_for_same_turn_followup_tool() -> None:
    state = music_state_fixture()
    state["playlists"].append(
        {
            "id": "playlist-empty",
            "name": "Empty",
            "description": None,
            "item_count": 0,
            "updated_at": "2026-06-15T00:03:00.000Z",
            "items": [],
        }
    )
    payload = ChatIn(message="playlist followup", music_state=state)
    context = RoomAgentToolContext(
        music_state=payload.music_state,
        candidates={
            "netease-song-candidate": NeteaseSongSearchResult(
                id="netease-song-candidate",
                song_id="candidate",
                title="Candidate Song",
                creator="Fixture Artist",
                duration_ms=210000,
                playable=True,
                popularity=55.0,
                comment_count=100,
                hot_comment_liked_count=25,
                score=77.0,
                evidence=["candidate evidence"],
            )
        },
        candidate_queries={"netease-song-candidate": "candidate query"},
    )

    _, add_action, _ = assert_successful_playlist_action(
        context,
        "add_music_to_playlist",
        {
            "playlist_id_or_name": "playlist-empty",
            "item_id": "netease-song-candidate",
        },
    )
    assert add_action.type == "add_music_to_playlist"

    _, play_action, _ = assert_successful_playlist_action(
        context,
        "play_music_playlist",
        {"playlist_id_or_name": "playlist-empty"},
    )
    assert play_action.type == "play_music_playlist"
    assert [action.type for action in context.client_actions[-2:]] == [
        "add_music_to_playlist",
        "play_music_playlist",
    ]


def test_playlist_mutations_refresh_updated_at_for_same_turn_reads(monkeypatch) -> None:
    state = music_state_fixture()
    state["playlists"].append(
        {
            "id": "playlist-empty",
            "name": "Empty",
            "description": None,
            "item_count": 0,
            "updated_at": "2026-06-15T00:03:00.000Z",
            "items": [],
        }
    )
    payload = ChatIn(message="playlist timestamps", music_state=state)
    context = RoomAgentToolContext(
        music_state=payload.music_state,
        candidates={
            "netease-song-candidate": NeteaseSongSearchResult(
                id="netease-song-candidate",
                song_id="candidate",
                title="Candidate Song",
                creator="Fixture Artist",
                duration_ms=210000,
                playable=True,
                popularity=55.0,
                comment_count=100,
                hot_comment_liked_count=25,
                score=77.0,
                evidence=["candidate evidence"],
            )
        },
        candidate_queries={"netease-song-candidate": "candidate query"},
    )
    times = iter(
        [
            "2026-06-15T00:04:00.000Z",
            "2026-06-15T00:05:00.000Z",
            "2026-06-15T00:06:00.000Z",
        ]
    )
    monkeypatch.setattr(agent_tools, "_current_iso_time", lambda: next(times))

    assert_successful_playlist_action(
        context,
        "rename_music_playlist",
        {"playlist_id_or_name": "playlist-night-writing", "name": "Late Desk"},
    )
    get_result = dispatch_room_agent_tool(
        LLMToolCall(
            id="get-renamed",
            name="get_music_playlist",
            arguments={"playlist_id_or_name": "playlist-night-writing"},
        ),
        context,
    )
    renamed_payload = json.loads(get_result.content)
    assert renamed_payload["playlist"]["updated_at"] == "2026-06-15T00:04:00.000Z"
    assert renamed_payload["playlist"]["item_count"] == 1
    assert len(renamed_payload["playlist"]["items"]) == 1

    assert_successful_playlist_action(
        context,
        "add_music_to_playlist",
        {
            "playlist_id_or_name": "playlist-empty",
            "item_id": "netease-song-candidate",
        },
    )
    list_result = dispatch_room_agent_tool(
        LLMToolCall(id="list-added", name="list_music_playlists", arguments={}),
        context,
    )
    list_payload = json.loads(list_result.content)
    added_summary = next(
        playlist
        for playlist in list_payload["playlists"]
        if playlist["id"] == "playlist-empty"
    )
    assert added_summary["updated_at"] == "2026-06-15T00:05:00.000Z"
    assert added_summary["item_count"] == 1

    assert_successful_playlist_action(
        context,
        "remove_music_from_playlist",
        {
            "playlist_id_or_name": "playlist-empty",
            "item_id": "netease-song-candidate",
        },
    )
    removed_result = dispatch_room_agent_tool(
        LLMToolCall(
            id="get-removed",
            name="get_music_playlist",
            arguments={"playlist_id_or_name": "playlist-empty"},
        ),
        context,
    )
    removed_payload = json.loads(removed_result.content)
    assert removed_payload["playlist"]["updated_at"] == "2026-06-15T00:06:00.000Z"
    assert removed_payload["playlist"]["item_count"] == 0
    assert removed_payload["playlist"]["items"] == []


def test_add_music_to_queue_supports_search_candidates() -> None:
    context = RoomAgentToolContext(
        candidates={
            "netease-song-candidate": NeteaseSongSearchResult(
                id="netease-song-candidate",
                song_id="candidate",
                title="Candidate Song",
                creator="Fixture Artist",
                duration_ms=210000,
                playable=True,
                popularity=55.0,
                comment_count=100,
                hot_comment_liked_count=25,
                score=77.0,
                evidence=["candidate evidence"],
            )
        },
        candidate_queries={"netease-song-candidate": "candidate query"},
    )

    result = dispatch_room_agent_tool(
        LLMToolCall(
            id="add",
            name="add_music_to_queue",
            arguments={"item_id": "netease-song-candidate"},
        ),
        context,
    )

    assert result.ok is True
    assert context.client_actions[-1].type == "add_music_to_queue"
    assert context.client_actions[-1].item.id == "netease-song-candidate"
    assert context.client_actions[-1].item.source_query == "candidate query"
    assert "candidate evidence" in context.client_actions[-1].item.selection_evidence


def test_play_music_item_supports_known_music_state_item() -> None:
    payload = ChatIn(message="play saved", music_state=music_state_fixture())
    context = RoomAgentToolContext(music_state=payload.music_state)

    result = dispatch_room_agent_tool(
        LLMToolCall(
            id="play",
            name="play_music_item",
            arguments={"item_id": "saved"},
        ),
        context,
    )

    assert result.ok is True
    assert context.client_actions[-1].type == "play_music_item"
    assert context.client_actions[-1].item.id == "saved"
    assert context.client_actions[-1].item.title == "Saved Song"
    assert (
        context.client_actions[-1].item.platform_audio_url
        == "https://audio.example/saved.mp3"
    )


def test_remove_music_from_queue_rejects_recent_items() -> None:
    payload = ChatIn(message="remove recent", music_state=music_state_fixture())
    context = RoomAgentToolContext(music_state=payload.music_state)

    result = dispatch_room_agent_tool(
        LLMToolCall(
            id="remove",
            name="remove_music_from_queue",
            arguments={"item_id": "recent"},
        ),
        context,
    )

    assert result.ok is False
    payload = json.loads(result.content)
    assert "upcoming" in payload["error"]
    assert context.client_actions == []


def test_manager_persists_user_and_reply_messages(monkeypatch, tmp_path) -> None:
    monkeypatch.setenv("KUMIKOROOM_MEMORY_DB_PATH", str(tmp_path / "memory.sqlite3"))
    provider = FakeProvider("Kumiko reply")
    session_store = FakeSessionStore()
    manager = ConversationManager(
        settings=load_settings(),
        provider=provider,
        session_store=session_store,
    )

    result = manager.chat(ChatIn(message="hello", session_id="session-1"))

    assert [message.role for message in session_store.saved] == ["user", "kumiko"]
    assert session_store.saved[0].content == "hello"
    assert session_store.saved[1].content == "Kumiko reply"
    assert result.reply.id == "message-2"
    assert result.session.id == "session-1"


def test_manager_builds_default_provider_with_build_provider(
    monkeypatch,
    tmp_path,
) -> None:
    monkeypatch.setenv("KUMIKOROOM_LLM_PROVIDER", "mock")
    monkeypatch.delenv("DEEPSEEK_API_KEY", raising=False)
    monkeypatch.setenv("KUMIKOROOM_MEMORY_DB_PATH", str(tmp_path / "memory.sqlite3"))
    settings = load_settings()
    provider = FakeProvider()
    calls = []

    def fake_build_provider(*, runtime_config):
        calls.append(runtime_config)
        return provider

    monkeypatch.setattr("kumikoroom.conversation.build_provider", fake_build_provider)

    response = ConversationManager(settings=settings).chat(
        ChatIn(message="hello", memory_enabled=False)
    )

    assert len(calls) == 1
    assert calls[0].provider == "mock"
    assert provider.messages[-1] == {"role": "user", "content": "hello"}
    assert response.reply.role == "kumiko"


def test_manager_builds_persona_memory_and_user_prompt(monkeypatch, tmp_path) -> None:
    monkeypatch.setenv("KUMIKOROOM_MEMORY_DB_PATH", str(tmp_path / "memory.sqlite3"))
    provider = FakeProvider()
    manager = ConversationManager(settings=load_settings(), provider=provider)

    response = manager.chat(
        ChatIn(
            message="我喜欢安静的钢琴，这个 demo 明天继续编曲。",
            persona_strength="strong",
            memory_enabled=True,
        )
    )

    system_text = provider.messages[0]["content"]
    assert "黄前久美子" in system_text
    assert "更明显" in system_text
    assert provider.messages[-1] == {
        "role": "user",
        "content": "我喜欢安静的钢琴，这个 demo 明天继续编曲。",
    }
    assert response.reply.role == "kumiko"
    assert response.provider_status.provider == "deepseek"
    assert [event.category for event in response.memory_events] == [
        "preference",
        "creative_note",
    ]


def test_manager_disables_memory_when_requested(monkeypatch, tmp_path) -> None:
    monkeypatch.setenv("KUMIKOROOM_MEMORY_DB_PATH", str(tmp_path / "memory.sqlite3"))

    response = ConversationManager(
        settings=load_settings(),
        provider=FakeProvider(),
    ).chat(ChatIn(message="我喜欢安静的钢琴。", memory_enabled=False))

    assert response.memory_events == []


def test_manager_runs_music_tool_loop_and_returns_client_action(
    monkeypatch, tmp_path
) -> None:
    monkeypatch.setenv("KUMIKOROOM_MEMORY_DB_PATH", str(tmp_path / "memory.sqlite3"))
    provider = ToolCallingProvider()
    session_store = FakeSessionStore()

    monkeypatch.setattr(
        "kumikoroom.agent_tools.search_netease_songs",
        lambda query, limit=8: [
            NeteaseSongSearchResult(
                id="netease-song-1",
                song_id="1",
                title="晴天",
                creator="周杰伦-",
                duration_ms=120000,
                playable=True,
                popularity=20.0,
                comment_count=205,
                hot_comment_liked_count=248,
                score=88.0,
                evidence=["raw rank 1"],
            ),
            NeteaseSongSearchResult(
                id="netease-song-2",
                song_id="2",
                title="晴天 (原唱 周杰伦)",
                creator="RyaVocal",
                duration_ms=270738,
                playable=True,
                popularity=70.0,
                comment_count=5918,
                hot_comment_liked_count=14314,
                score=139.4,
                evidence=["comment_count=5918"],
            ),
        ],
    )

    response = ConversationManager(
        settings=load_settings(),
        provider=provider,
        session_store=session_store,
    ).chat(ChatIn(message="播放 晴天 周杰伦", memory_enabled=False))

    assert provider.calls[0]["tool_choice"] == "auto"
    assert provider.calls[0]["tools"][0]["function"]["name"] == "search_music"
    assert any(
        message["role"] == "tool" and message["tool_call_id"] == "call-search"
        for message in provider.calls[1]["messages"]
    )
    assert any(
        message["role"] == "tool" and message["tool_call_id"] == "call-play"
        for message in provider.calls[2]["messages"]
    )
    assert response.reply.content == "我找了一下，选了证据最稳的《晴天》。"
    assert response.client_actions[0].type == "play_music_item"
    assert response.client_actions[0].item.id == "netease-song-2"
    assert response.client_actions[0].item.title == "晴天 (原唱 周杰伦)"
    assert response.client_actions[0].item.source_query
    assert response.client_actions[0].item.selected_reason is not None
    assert "comment_count=5918" in response.client_actions[0].item.selection_evidence
    assert response.client_actions[0].item.selection_score == 139.4
    assert response.agent_trace.tool_calls == [
        {"id": "call-search", "name": "search_music", "ok": True},
        {"id": "call-play", "name": "play_music_item", "ok": True},
    ]
    assert [message.role for message in session_store.saved] == ["user", "kumiko"]


def test_search_music_tool_merges_sources_and_sorts_by_score(monkeypatch) -> None:
    monkeypatch.setattr(
        "kumikoroom.agent_tools.search_netease_songs",
        lambda query, limit=8: [
            NeteaseSongSearchResult(
                id="netease-song-1",
                song_id="1",
                title="晴天",
                creator="周杰伦",
                duration_ms=269000,
                playable=True,
                popularity=100.0,
                comment_count=30000,
                hot_comment_liked_count=15000,
                score=120.0,
                evidence=["netease score"],
            )
        ],
    )
    monkeypatch.setattr(
        "kumikoroom.agent_tools.search_bilibili_videos",
        lambda query, limit=8: [
            BilibiliVideoSearchResult(
                source="bilibili",
                id="bilibili-BV1best",
                bvid="BV1best",
                title="晴天 Live",
                creator="周杰伦",
                duration_ms=285000,
                playable=True,
                popularity=5600000,
                comment_count=42000,
                hot_comment_liked_count=310000,
                score=168.4,
                evidence=["bilibili score"],
            )
        ],
    )
    context = RoomAgentToolContext()

    result = dispatch_room_agent_tool(
        LLMToolCall(
            id="call-search",
            name="search_music",
            arguments={"query": "晴天 周杰伦", "source": "all", "limit": 5},
        ),
        context,
    )

    assert result.ok is True
    assert '"selected_id":"bilibili-BV1best"' in result.content
    assert result.content.index("bilibili-BV1best") < result.content.index(
        "netease-song-1"
    )
    assert list(context.candidates) == ["bilibili-BV1best", "netease-song-1"]


def test_search_music_tool_spec_supports_all_sources() -> None:
    specs = room_agent_tool_specs()

    search_spec = next(
        spec["function"] for spec in specs if spec["function"]["name"] == "search_music"
    )

    assert search_spec["parameters"]["properties"]["source"]["enum"] == [
        "all",
        "netease",
        "bilibili",
    ]


def test_play_music_item_returns_bilibili_client_action() -> None:
    context = RoomAgentToolContext(
        candidates={
            "bilibili-BV1best": BilibiliVideoSearchResult(
                source="bilibili",
                id="bilibili-BV1best",
                bvid="BV1best",
                title="晴天 Live",
                creator="周杰伦",
                duration_ms=285000,
                playable=True,
                popularity=5600000,
                comment_count=42000,
                hot_comment_liked_count=310000,
                score=168.4,
                evidence=["bilibili score"],
            )
        },
        candidate_queries={"bilibili-BV1best": "play sunny live"},
    )

    result = dispatch_room_agent_tool(
        LLMToolCall(
            id="call-play",
            name="play_music_item",
            arguments={"item_id": "bilibili-BV1best"},
        ),
        context,
    )

    assert result.ok is True
    assert '"source":"bilibili"' in result.content
    assert '"can_open_video":true' in result.content
    assert '"platform_audio_url":null' in result.content
    assert '"embed_url":"https://player.bilibili.com/player.html?bvid=BV1best"' in result.content
    assert context.client_actions[0].item.source == "bilibili"
    assert context.client_actions[0].item.can_open_video is True
    assert context.client_actions[0].item.platform_audio_url is None
    assert context.client_actions[0].item.source_query == "play sunny live"
    assert context.client_actions[0].item.selected_reason == "ranked score 168.4: bilibili score"
    assert context.client_actions[0].item.selection_evidence == ["bilibili score"]
    assert context.client_actions[0].item.selection_score == 168.4


def test_manager_falls_back_when_deepseek_is_unconfigured(monkeypatch, tmp_path) -> None:
    monkeypatch.setenv("KUMIKOROOM_LLM_PROVIDER", "deepseek")
    monkeypatch.delenv("DEEPSEEK_API_KEY", raising=False)
    monkeypatch.setenv("KUMIKOROOM_MEMORY_DB_PATH", str(tmp_path / "memory.sqlite3"))

    response = ConversationManager(settings=load_settings()).chat(
        ChatIn(message="晚上好")
    )

    assert response.provider_status.provider == "deepseek"
    assert response.provider_status.configured is False
    assert (
        response.reply.content
        == "DeepSeek 未配置 API Key，请先设置 DEEPSEEK_API_KEY。"
    )


def test_manager_keeps_configured_deepseek_status_when_provider_is_unavailable(
    monkeypatch,
    tmp_path,
) -> None:
    monkeypatch.setenv("KUMIKOROOM_LLM_PROVIDER", "deepseek")
    monkeypatch.setenv("DEEPSEEK_API_KEY", "test-key")
    monkeypatch.setenv("KUMIKOROOM_MEMORY_DB_PATH", str(tmp_path / "memory.sqlite3"))
    settings = load_settings()
    session_store = FakeSessionStore()

    response = ConversationManager(
        settings=settings,
        provider=UnavailableProvider(),
        session_store=session_store,
    ).chat(ChatIn(message="hello"))

    expected_label = f"DeepSeek {settings.deepseek_model}"
    assert [message.role for message in session_store.saved] == ["user", "kumiko"]
    assert session_store.saved[1].provider == "deepseek"
    assert session_store.saved[1].provider_model == settings.deepseek_model
    assert session_store.saved[1].provider_configured is True
    assert session_store.saved[1].provider_label == expected_label
    assert response.reply.id == "message-2"
    assert response.session.id == "session-1"
    assert response.provider_status.provider == "deepseek"
    assert response.provider_status.model == settings.deepseek_model
    assert response.provider_status.configured is True
    assert response.provider_status.label == expected_label
    assert response.reply.content == "DeepSeek 连接失败，请检查网络、Base URL 和 API Key。"
    assert "test-key" not in response.reply.content


def test_manager_maps_recent_kumiko_messages_to_assistant(
    monkeypatch,
    tmp_path,
) -> None:
    monkeypatch.setenv("KUMIKOROOM_MEMORY_DB_PATH", str(tmp_path / "memory.sqlite3"))
    provider = FakeProvider()

    ConversationManager(settings=load_settings(), provider=provider).chat(
        ChatIn(
            message="继续说",
            recent_messages=[
                ChatMessageOut(id="user-1", role="user", content="第一句"),
                ChatMessageOut(id="kumiko-1", role="kumiko", content="嗯，我在听。"),
            ],
        )
    )

    assert provider.messages[-3:] == [
        {"role": "user", "content": "第一句"},
        {"role": "assistant", "content": "嗯，我在听。"},
        {"role": "user", "content": "继续说"},
    ]


def test_manager_includes_existing_memories_in_system_prompt(
    monkeypatch,
    tmp_path,
) -> None:
    memory_path = tmp_path / "memory.sqlite3"
    monkeypatch.setenv("KUMIKOROOM_MEMORY_DB_PATH", str(memory_path))
    store = MemoryStore(memory_path)
    store.save(
        category="preference",
        text="用户喜欢安静的钢琴。",
        confidence=0.82,
        source="我喜欢安静的钢琴。",
    )
    provider = FakeProvider()

    ConversationManager(
        settings=load_settings(),
        provider=provider,
        memory_store=store,
    ).chat(ChatIn(message="今天继续聊音乐"))

    system_text = provider.messages[0]["content"]
    assert "参考记忆" in system_text
    assert "用户喜欢安静的钢琴。" in system_text


def test_manager_does_not_auto_route_novel_rag_with_injected_provider(
    monkeypatch,
    tmp_path,
) -> None:
    monkeypatch.setenv("KUMIKOROOM_MEMORY_DB_PATH", str(tmp_path / "memory.sqlite3"))
    rag_path = tmp_path / "existing-rag.sqlite3"
    rag_path.touch()
    settings = replace(
        load_settings(),
        llm_provider="deepseek",
        deepseek_api_key="test-key",
        novel_rag_db_path=rag_path,
    )
    provider = RecordingProvider()

    ConversationManager(settings=settings, provider=provider).chat(
        ChatIn(message="久美子在小说里是什么样？", memory_enabled=False)
    )

    assert len(provider.calls) == 1
    assert provider.calls[0]["kwargs"] == {
        "tools": room_agent_tool_specs(),
        "tool_choice": "auto",
    }
    assert "小说参考片段" not in provider.calls[0]["messages"][0]["content"]


def test_manager_routes_with_recent_six_user_messages_oldest_first(
    monkeypatch,
    tmp_path,
) -> None:
    monkeypatch.setenv("KUMIKOROOM_MEMORY_DB_PATH", str(tmp_path / "memory.sqlite3"))
    router = FakeNovelRouter(NovelRagDecision(False, "", reason="skip"))
    store = FakeNovelStore()

    ConversationManager(
        settings=load_settings(),
        provider=FakeProvider("Kumiko reply"),
        novel_rag_router=router,
        novel_rag_store=store,
    ).chat(
        ChatIn(
            message="继续说久美子",
            memory_enabled=False,
            recent_messages=[
                ChatMessageOut(id="u1", role="user", content="用户 1"),
                ChatMessageOut(id="a1", role="assistant", content="助手 1"),
                ChatMessageOut(id="u2", role="user", content="用户 2"),
                ChatMessageOut(id="k1", role="kumiko", content="久美子 1"),
                ChatMessageOut(id="u3", role="user", content="用户 3"),
                ChatMessageOut(id="a2", role="assistant", content="助手 2"),
                ChatMessageOut(id="u4", role="user", content="用户 4"),
                ChatMessageOut(id="k2", role="kumiko", content="久美子 2"),
                ChatMessageOut(id="u5", role="user", content="用户 5"),
                ChatMessageOut(id="u6", role="user", content="用户 6"),
                ChatMessageOut(id="a3", role="assistant", content="助手 3"),
                ChatMessageOut(id="u7", role="user", content="用户 7"),
                ChatMessageOut(id="u8", role="user", content="用户 8"),
            ],
        )
    )

    assert router.calls == [
        {
            "message": "继续说久美子",
            "recent_user_messages": [
                "用户 3",
                "用户 4",
                "用户 5",
                "用户 6",
                "用户 7",
                "用户 8",
            ],
        }
    ]


def test_manager_searches_novel_rag_with_trimmed_query(
    monkeypatch,
    tmp_path,
) -> None:
    monkeypatch.setenv("KUMIKOROOM_MEMORY_DB_PATH", str(tmp_path / "memory.sqlite3"))
    router = FakeNovelRouter(
        NovelRagDecision(True, "  久美子 性格  ", reason="source helps")
    )
    store = FakeNovelStore()

    ConversationManager(
        settings=load_settings(),
        provider=FakeProvider("Kumiko reply"),
        novel_rag_router=router,
        novel_rag_store=store,
    ).chat(ChatIn(message="久美子是什么性格？", memory_enabled=False))

    assert store.calls == [{"query": "久美子 性格", "limit": 5}]


def test_manager_continues_when_auto_novel_store_initialization_fails(
    monkeypatch,
    tmp_path,
) -> None:
    monkeypatch.setenv("KUMIKOROOM_MEMORY_DB_PATH", str(tmp_path / "memory.sqlite3"))
    rag_path = tmp_path / "rag.sqlite3"
    rag_path.touch()
    settings = replace(load_settings(), novel_rag_db_path=rag_path)
    provider = FakeProvider("Kumiko reply")

    def fail_store_init(db_path):
        raise RuntimeError("store unavailable")

    monkeypatch.setattr("kumikoroom.conversation.NovelRagStore", fail_store_init)

    response = ConversationManager(settings=settings, provider=provider).chat(
        ChatIn(message="久美子的小说设定？", memory_enabled=False)
    )

    assert response.reply.content == "Kumiko reply"
    assert "小说参考片段" not in provider.messages[0]["content"]


def test_manager_includes_novel_context_when_router_opts_in(
    monkeypatch,
    tmp_path,
) -> None:
    monkeypatch.setenv("KUMIKOROOM_MEMORY_DB_PATH", str(tmp_path / "memory.sqlite3"))
    router = FakeNovelRouter(
        NovelRagDecision(True, "久美子 说话方式", reason="source helps")
    )
    store = FakeNovelStore(
        [
            NovelSearchResult(
                source_id="vol1",
                source_title="響け！ユーフォニアム",
                chapter_path="chapter-01.xhtml",
                chapter_title="第1章",
                chunk_index=3,
                text="久美子は少し間を置いてから、相手の顔色を見ながら言葉を選んだ。",
                rank=0.12,
            )
        ]
    )
    provider = FakeProvider("Kumiko reply")

    ConversationManager(
        settings=load_settings(),
        provider=provider,
        novel_rag_router=router,
        novel_rag_store=store,
    ).chat(
        ChatIn(
            message="久美子在小说里说话有什么特点？",
            memory_enabled=False,
            recent_messages=[
                ChatMessageOut(id="old", role="user", content="太早的消息"),
                ChatMessageOut(id="u1", role="user", content="前面问过性格"),
                ChatMessageOut(id="k1", role="kumiko", content="嗯，我想想。"),
                ChatMessageOut(id="blank", role="user", content="   "),
                ChatMessageOut(id="u2", role="user", content="也想看原作依据"),
                ChatMessageOut(id="a1", role="assistant", content="可以。"),
                ChatMessageOut(id="u3", role="user", content="关注她的说话方式"),
            ],
        )
    )

    assert router.calls == [
        {
            "message": "久美子在小说里说话有什么特点？",
            "recent_user_messages": [
                "太早的消息",
                "前面问过性格",
                "也想看原作依据",
                "关注她的说话方式",
            ],
        }
    ]
    assert store.calls == [{"query": "久美子 说话方式", "limit": 5}]
    system_text = provider.messages[0]["content"]
    assert "小说参考片段" in system_text
    assert "響け！ユーフォニアム / 第1章" in system_text
    assert "久美子は少し間を置いてから" in system_text
    assert "使用规则" in system_text


def test_manager_skips_novel_search_when_router_opts_out(
    monkeypatch,
    tmp_path,
) -> None:
    monkeypatch.setenv("KUMIKOROOM_MEMORY_DB_PATH", str(tmp_path / "memory.sqlite3"))
    router = FakeNovelRouter(NovelRagDecision(False, "", reason="casual"))
    store = FakeNovelStore(
        [
            NovelSearchResult(
                source_id="vol1",
                source_title="響け！ユーフォニアム",
                chapter_path="chapter-01.xhtml",
                chapter_title="第1章",
                chunk_index=1,
                text="should not appear",
                rank=0.2,
            )
        ]
    )
    provider = FakeProvider("Kumiko reply")

    ConversationManager(
        settings=load_settings(),
        provider=provider,
        novel_rag_router=router,
        novel_rag_store=store,
    ).chat(ChatIn(message="今晚聊点轻松的", memory_enabled=False))

    assert len(router.calls) == 1
    assert store.calls == []
    assert "小说参考片段" not in provider.messages[0]["content"]


def test_manager_continues_when_novel_router_or_search_fails(
    monkeypatch,
    tmp_path,
) -> None:
    monkeypatch.setenv("KUMIKOROOM_MEMORY_DB_PATH", str(tmp_path / "memory.sqlite3"))

    router_error = FakeNovelRouter(error=RuntimeError("router down"))
    router_error_store = FakeNovelStore()
    router_error_provider = FakeProvider("Kumiko reply")
    router_error_response = ConversationManager(
        settings=load_settings(),
        provider=router_error_provider,
        novel_rag_router=router_error,
        novel_rag_store=router_error_store,
    ).chat(ChatIn(message="久美子的原作性格呢？", memory_enabled=False))

    assert router_error_response.reply.content == "Kumiko reply"
    assert len(router_error.calls) == 1
    assert router_error_store.calls == []
    assert "小说参考片段" not in router_error_provider.messages[0]["content"]

    search_error_router = FakeNovelRouter(
        NovelRagDecision(True, "久美子 性格", reason="source helps")
    )
    search_error_store = FakeNovelStore(error=RuntimeError("search down"))
    search_error_provider = FakeProvider("Kumiko reply")
    search_error_response = ConversationManager(
        settings=load_settings(),
        provider=search_error_provider,
        novel_rag_router=search_error_router,
        novel_rag_store=search_error_store,
    ).chat(ChatIn(message="久美子的原作性格呢？", memory_enabled=False))

    assert search_error_response.reply.content == "Kumiko reply"
    assert len(search_error_router.calls) == 1
    assert search_error_store.calls == [{"query": "久美子 性格", "limit": 5}]
    assert "小说参考片段" not in search_error_provider.messages[0]["content"]


def test_manager_skips_novel_rag_when_disabled(
    monkeypatch,
    tmp_path,
) -> None:
    monkeypatch.setenv("KUMIKOROOM_MEMORY_DB_PATH", str(tmp_path / "memory.sqlite3"))
    settings = replace(load_settings(), novel_rag_enabled=False)
    router = FakeNovelRouter(
        NovelRagDecision(True, "久美子 说话方式", reason="source helps")
    )
    store = FakeNovelStore(
        [
            NovelSearchResult(
                source_id="vol1",
                source_title="響け！ユーフォニアム",
                chapter_path="chapter-01.xhtml",
                chapter_title="第1章",
                chunk_index=1,
                text="should not appear",
                rank=0.2,
            )
        ]
    )
    provider = FakeProvider("Kumiko reply")

    ConversationManager(
        settings=settings,
        provider=provider,
        novel_rag_router=router,
        novel_rag_store=store,
    ).chat(ChatIn(message="久美子的原作性格呢？", memory_enabled=False))

    assert router.calls == []
    assert store.calls == []
    assert "小说参考片段" not in provider.messages[0]["content"]


def test_manager_includes_listening_context_in_system_prompt(
    monkeypatch,
    tmp_path,
) -> None:
    monkeypatch.setenv("KUMIKOROOM_MEMORY_DB_PATH", str(tmp_path / "memory.sqlite3"))
    provider = FakeProvider()
    manager = ConversationManager(settings=load_settings(), provider=provider)

    manager.chat(
        ChatIn(
            message="这首适合写什么？",
            memory_enabled=False,
            listening_context={
                "source": "bilibili",
                "title": "合奏前调音",
                "creator": "部室 · 木管声部",
                "is_playing": True,
                "page_url": "https://www.bilibili.com/video/BV1xx411c7mD",
                "tags": ["bilibili", "rehearsal"],
            },
        )
    )

    system_text = provider.messages[0]["content"]
    assert "Listening context" in system_text
    assert "bilibili" in system_text
    assert "合奏前调音" in system_text
    assert "部室 · 木管声部" in system_text
    assert "Playing: yes" in system_text
    assert "https://www.bilibili.com/video/BV1xx411c7mD" in system_text
    assert "Tags: bilibili, rehearsal" in system_text
    assert provider.messages[-1] == {"role": "user", "content": "这首适合写什么？"}


def test_manager_omits_empty_listening_context_fields_from_system_prompt(
    monkeypatch,
    tmp_path,
) -> None:
    monkeypatch.setenv("KUMIKOROOM_MEMORY_DB_PATH", str(tmp_path / "memory.sqlite3"))
    provider = FakeProvider()

    ConversationManager(settings=load_settings(), provider=provider).chat(
        ChatIn(
            message="这首先停一下。",
            memory_enabled=False,
            listening_context={
                "source": "netease",
                "title": "练习片段",
                "creator": "Kumiko",
                "is_playing": False,
                "page_url": None,
                "tags": [],
            },
        )
    )

    system_text = provider.messages[0]["content"]
    assert "Listening context" in system_text
    assert "Source: netease" in system_text
    assert "Track: 练习片段 - Kumiko" in system_text
    assert "Playing: no" in system_text
    assert "Page:" not in system_text
    assert "Tags:" not in system_text


def test_manager_uses_llm_config_override_to_build_runtime_config(
    monkeypatch,
    tmp_path,
) -> None:
    monkeypatch.setenv("KUMIKOROOM_LLM_PROVIDER", "mock")
    monkeypatch.delenv("DEEPSEEK_API_KEY", raising=False)
    monkeypatch.setenv("KUMIKOROOM_MEMORY_DB_PATH", str(tmp_path / "memory.sqlite3"))
    settings = load_settings()
    provider = FakeProvider()
    received_runtime_configs = []

    def fake_build_provider(*, runtime_config):
        received_runtime_configs.append(runtime_config)
        return provider

    monkeypatch.setattr("kumikoroom.conversation.build_provider", fake_build_provider)

    llm_config = LLMConfigIn(
        provider="openai_compatible",
        base_url="https://api.openai.com/v1",
        api_key="sk-override",
        model="gpt-4o-mini",
    )

    ConversationManager(settings=settings, llm_config=llm_config).chat(
        ChatIn(message="hello", memory_enabled=False)
    )

    assert len(received_runtime_configs) == 1
    runtime = received_runtime_configs[0]
    assert runtime.provider == "openai_compatible"
    assert runtime.base_url == "https://api.openai.com/v1"
    assert runtime.api_key == "sk-override"
    assert runtime.model == "gpt-4o-mini"


def test_manager_fallback_for_openai_compatible_uses_plain_error_prompt(
    monkeypatch,
    tmp_path,
) -> None:
    monkeypatch.setenv("KUMIKOROOM_LLM_PROVIDER", "mock")
    monkeypatch.delenv("DEEPSEEK_API_KEY", raising=False)
    monkeypatch.setenv("KUMIKOROOM_MEMORY_DB_PATH", str(tmp_path / "memory.sqlite3"))
    settings = load_settings()
    session_store = FakeSessionStore()

    llm_config = LLMConfigIn(
        provider="openai_compatible",
        base_url="https://api.openai.com/v1",
        api_key="sk-test",
        model="gpt-4o-mini",
    )

    response = ConversationManager(
        settings=settings,
        provider=UnavailableProvider(),
        session_store=session_store,
        llm_config=llm_config,
    ).chat(ChatIn(message="hello"))

    assert response.provider_status.provider == "openai_compatible"
    assert response.provider_status.model == "gpt-4o-mini"
    assert response.provider_status.configured is True
    assert (
        response.reply.content
        == "模型连接失败，请检查 Base URL、模型名称和 API Key。"
    )
    assert "sk-test" not in response.reply.content


def test_manager_fallback_for_mock_remains_mock(
    monkeypatch,
    tmp_path,
) -> None:
    monkeypatch.setenv("KUMIKOROOM_LLM_PROVIDER", "mock")
    monkeypatch.delenv("DEEPSEEK_API_KEY", raising=False)
    monkeypatch.setenv("KUMIKOROOM_MEMORY_DB_PATH", str(tmp_path / "memory.sqlite3"))
    settings = load_settings()
    session_store = FakeSessionStore()

    response = ConversationManager(
        settings=settings,
        provider=UnavailableProvider(),
        session_store=session_store,
    ).chat(ChatIn(message="hello"))

    assert response.provider_status.provider == "mock"
    assert response.provider_status.configured is False


# --- Planning-only construction tests (PR1: initialize_stores flag) ---


def _api_settings(tmp_path: Path) -> ApiSettings:
    return ApiSettings(
        llm_provider="mock",
        deepseek_api_key=None,
        deepseek_model="deepseek-v4-flash",
        deepseek_base_url="https://api.deepseek.com",
        memory_db_path=tmp_path / "memory.sqlite3",
    )


def test_default_construction_initializes_both_stores(tmp_path: Path) -> None:
    settings = _api_settings(tmp_path)
    manager = ConversationManager(settings=settings, provider=MockLLMProvider())
    assert manager.memory_store is not None
    assert manager.session_store is not None


def test_planning_only_construction_skips_both_stores(tmp_path: Path) -> None:
    settings = _api_settings(tmp_path)
    manager = ConversationManager(
        settings=settings, provider=MockLLMProvider(), initialize_stores=False
    )
    assert manager.memory_store is None
    assert manager.session_store is None
    assert not settings.memory_db_path.exists()


def test_planning_only_chat_raises(tmp_path: Path) -> None:
    manager = ConversationManager(
        settings=_api_settings(tmp_path),
        provider=MockLLMProvider(),
        initialize_stores=False,
    )
    with pytest.raises(RuntimeError, match="planning-only"):
        manager.chat(payload=None)  # type: ignore[arg-type]

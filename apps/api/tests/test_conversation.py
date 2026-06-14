from kumikoroom.config import load_settings
from kumikoroom.conversation import ConversationManager
from kumikoroom.llm import (
    LLMResult,
    LLMToolCall,
    ProviderStatus,
    ProviderUnavailable,
)
from kumikoroom.memory import MemoryStore
from kumikoroom.agent_tools import (
    RoomAgentToolContext,
    dispatch_room_agent_tool,
    room_agent_tool_specs,
)
from kumikoroom.music_search import (
    BilibiliVideoSearchResult,
    NeteaseSongSearchResult,
)
from kumikoroom.schemas import ChatIn, ChatMessageOut
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

    def fake_build_provider(received_settings):
        calls.append(received_settings)
        return provider

    monkeypatch.setattr("kumikoroom.conversation.build_provider", fake_build_provider)

    response = ConversationManager(settings=settings).chat(
        ChatIn(message="hello", memory_enabled=False)
    )

    assert calls == [settings]
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
    assert "还没有配置 DeepSeek" in response.reply.content


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

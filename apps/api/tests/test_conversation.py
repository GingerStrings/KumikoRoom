from kumikoroom.config import load_settings
from kumikoroom.conversation import ConversationManager
from kumikoroom.llm import (
    LLMResult,
    ProviderStatus,
    ProviderUnavailable,
)
from kumikoroom.memory import MemoryStore
from kumikoroom.schemas import ChatIn, ChatMessageOut
from kumikoroom.sessions import ChatSession, StoredChatMessage


class FakeProvider:
    def __init__(self, content="嗯，我在听。这个 demo 可以先保留一个安静的版本。"):
        self.messages = []
        self.content = content

    def generate(self, messages):
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
    def generate(self, messages):
        raise ProviderUnavailable("provider unavailable")


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

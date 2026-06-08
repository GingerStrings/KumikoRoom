from kumikoroom.config import load_settings
from kumikoroom.conversation import ConversationManager
from kumikoroom.llm import (
    LLMResult,
    ProviderStatus,
    ProviderUnavailable,
    unconfigured_deepseek_status,
)
from kumikoroom.memory import MemoryStore
from kumikoroom.schemas import ChatIn, ChatMessageOut


class FakeProvider:
    def __init__(self):
        self.messages = []

    def generate(self, messages):
        self.messages = messages
        return LLMResult(
            content="嗯，我在听。这个 demo 可以先保留一个安静的版本。",
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


def test_manager_uses_unconfigured_deepseek_status_for_unavailable_deepseek(
    monkeypatch,
    tmp_path,
) -> None:
    monkeypatch.setenv("KUMIKOROOM_LLM_PROVIDER", "deepseek")
    monkeypatch.setenv("DEEPSEEK_API_KEY", "test-key")
    monkeypatch.setenv("KUMIKOROOM_MEMORY_DB_PATH", str(tmp_path / "memory.sqlite3"))
    settings = load_settings()

    response = ConversationManager(
        settings=settings,
        provider=UnavailableProvider(),
    ).chat(ChatIn(message="hello"))

    expected = unconfigured_deepseek_status(settings)
    assert response.provider_status.provider == expected.provider
    assert response.provider_status.model == expected.model
    assert response.provider_status.configured == expected.configured
    assert response.provider_status.label == expected.label
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

from dataclasses import asdict
from typing import Any

from kumikoroom.config import ApiSettings, load_settings
from kumikoroom.llm import (
    LLMProvider,
    MockLLMProvider,
    ProviderUnavailable,
    build_provider,
    unconfigured_deepseek_status,
)
from kumikoroom.memory import MemoryStore, extract_memories
from kumikoroom.persona import build_persona_prompt
from kumikoroom.schemas import (
    ChatIn,
    ChatMessageOut,
    ChatOut,
    MemoryEventOut,
    ProviderStatusOut,
)


class ConversationManager:
    def __init__(
        self,
        settings: ApiSettings | None = None,
        provider: LLMProvider | None = None,
        memory_store: MemoryStore | None = None,
    ) -> None:
        self.settings = settings or load_settings()
        self.provider = provider or _default_provider(self.settings)
        self.memory_store = memory_store or MemoryStore(self.settings.memory_db_path)

    def chat(self, payload: ChatIn) -> ChatOut:
        message = payload.message.strip() or "今天的音乐"
        messages = self._build_messages(payload, message)

        try:
            result = self.provider.generate(messages)
        except ProviderUnavailable:
            return self._provider_unavailable_response()

        memory_events: list[MemoryEventOut] = []
        if payload.memory_enabled:
            for memory in extract_memories(
                user_message=message,
                assistant_reply=result.content,
            ):
                saved = self.memory_store.save(
                    category=memory.category,
                    text=memory.text,
                    confidence=memory.confidence,
                    source=memory.source,
                )
                memory_events.append(_memory_event_out(saved))

        return ChatOut(
            reply=ChatMessageOut(
                id="llm-kumiko-reply",
                role="kumiko",
                content=result.content,
            ),
            expression="listening",
            suggested_actions=(
                ["save_diary", "save_inspiration"] if memory_events else []
            ),
            provider_status=ProviderStatusOut(**asdict(result.provider_status)),
            memory_events=memory_events,
        )

    def _build_messages(self, payload: ChatIn, message: str) -> list[dict[str, str]]:
        system_parts = [build_persona_prompt(payload.persona_strength).strip()]

        memories = self.memory_store.list_recent(limit=8)
        if memories:
            memory_lines = ["参考记忆："]
            for memory in memories:
                memory_lines.append(f"- [{memory.category}] {memory.text}")
            system_parts.append("\n".join(memory_lines))

        room_state_context = _room_state_context(payload)
        if room_state_context:
            system_parts.append(room_state_context)

        messages: list[dict[str, str]] = [
            {"role": "system", "content": "\n\n".join(system_parts)}
        ]
        messages.extend(_recent_messages(payload))
        messages.append({"role": "user", "content": message})
        return messages

    def _provider_unavailable_response(self) -> ChatOut:
        return ChatOut(
            reply=ChatMessageOut(
                id=_fallback_reply_id(self.settings),
                role="kumiko",
                content=_fallback_content(self.settings),
            ),
            expression="thinking",
            suggested_actions=[],
            provider_status=_fallback_provider_status(self.settings),
            memory_events=[],
        )


def _default_provider(settings: ApiSettings) -> LLMProvider:
    if settings.llm_provider == "mock":
        return MockLLMProvider()
    return build_provider(settings)


def _fallback_reply_id(settings: ApiSettings) -> str:
    if settings.llm_provider == "deepseek" and not settings.is_deepseek_configured:
        return "deepseek-unconfigured"
    return "provider-unavailable"


def _fallback_content(settings: ApiSettings) -> str:
    if settings.llm_provider == "deepseek" and not settings.is_deepseek_configured:
        return (
            "DeepSeek 还没有配置好；这里还没有配置 DeepSeek API key。"
            "先用本地的安静版本陪你聊，等配置完成后再接上正式回复。"
        )
    return "DeepSeek 现在暂时没有接上。我先留在本地，陪你把这句话安静地接住。"


def _fallback_provider_status(settings: ApiSettings) -> ProviderStatusOut:
    if settings.llm_provider == "deepseek" and not settings.is_deepseek_configured:
        return ProviderStatusOut(**asdict(unconfigured_deepseek_status(settings)))
    if settings.llm_provider == "deepseek":
        return ProviderStatusOut(
            provider="deepseek",
            model=settings.deepseek_model,
            configured=False,
            label="DeepSeek 暂不可用",
        )
    return ProviderStatusOut(
        provider="mock",
        model=None,
        configured=False,
        label="本地 Mock API 暂不可用",
    )


def _memory_event_out(memory: Any) -> MemoryEventOut:
    data = asdict(memory)
    data.pop("source", None)
    return MemoryEventOut(**data)


def _recent_messages(payload: ChatIn) -> list[dict[str, str]]:
    messages: list[dict[str, str]] = []
    for recent in payload.recent_messages[-8:]:
        content = recent.content.strip()
        if not content:
            continue

        if recent.role == "kumiko" or recent.role == "assistant":
            messages.append({"role": "assistant", "content": content})
        elif recent.role == "user":
            messages.append({"role": "user", "content": content})

    return messages


def _room_state_context(payload: ChatIn) -> str:
    if payload.room_state is None:
        return ""

    room_state = payload.room_state
    lines: list[str] = []
    if room_state.music.listening_mood:
        lines.append(f"听歌心情：{room_state.music.listening_mood}")

    track = _current_track(
        room_state.music.current_track_title,
        room_state.music.current_artist,
    )
    if track:
        lines.append(f"当前曲目：{track}")

    lines.append(f"创作资料室未完成数量：{room_state.studio.unfinished_count}")
    return "房间状态参考：\n" + "\n".join(lines)


def _current_track(title: str | None, artist: str | None) -> str:
    if title and artist:
        return f"{title} - {artist}"
    if title:
        return title
    if artist:
        return artist
    return ""


__all__ = ["ConversationManager"]

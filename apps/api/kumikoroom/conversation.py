from dataclasses import asdict, dataclass
import json
import logging
from typing import Any

_logger = logging.getLogger(__name__)

from kumikoroom.auto_dj_planning import (
    AutoDjQueryPlan,
    AutoDjQueryPlanningContext,
    PlanningError,
    build_auto_dj_planning_system_prompt,
    build_auto_dj_planning_user_prompt,
    parse_and_validate_plan,
)
from kumikoroom.agent_tools import (
    RoomAgentToolContext,
    dispatch_room_agent_tool,
    room_agent_tool_specs,
)
from kumikoroom.config import (
    ApiSettings,
    LlmRuntimeConfig,
    load_settings,
    runtime_config_from_llm_config,
    runtime_config_from_settings,
)
from kumikoroom.llm import (
    LLMMessage,
    LLMProvider,
    LLMResult,
    LLMToolCall,
    ProviderUnavailable,
    ProviderStatus,
    build_provider,
    unconfigured_deepseek_status,
    unconfigured_runtime_status,
)
from kumikoroom.memory import MemoryStore, extract_memories
from kumikoroom.novel_rag import (
    NovelRagRouter,
    NovelRagStore,
    build_novel_reference_context,
)
from kumikoroom.persona import build_persona_prompt
from kumikoroom.schemas import (
    ChatIn,
    ChatMessageOut,
    ChatOut,
    ChatSessionOut,
    AgentTraceOut,
    MemoryEventOut,
    MusicAgentPlaylist,
    MusicAgentState,
    MusicAgentTrack,
    ProviderStatusOut,
    RoomClientActionOut,
)
from kumikoroom.sessions import ChatSession, SessionStore


MAX_AGENT_TOOL_STEPS = 5


@dataclass(frozen=True)
class AgentTurnResult:
    content: str
    provider_status: ProviderStatus
    client_actions: list[RoomClientActionOut]
    agent_trace: AgentTraceOut


class ConversationManager:
    def __init__(
        self,
        settings: ApiSettings | None = None,
        provider: LLMProvider | None = None,
        memory_store: MemoryStore | None = None,
        session_store: SessionStore | None = None,
        novel_rag_router: NovelRagRouter | None = None,
        novel_rag_store: NovelRagStore | None = None,
        llm_config=None,
        initialize_stores: bool = True,
        planner_timeout_seconds: float = 45.0,
    ) -> None:
        """``initialize_stores=False`` skips Memory/Session SQLite init for
        planning-only flows; ``chat()`` is unavailable in that mode."""
        self.settings = settings or load_settings()
        if llm_config is not None:
            normalized = llm_config.normalized() if hasattr(llm_config, "normalized") else llm_config
            self.runtime_config = runtime_config_from_llm_config(
                self.settings, normalized
            )
        else:
            self.runtime_config = runtime_config_from_settings(self.settings)
        self.provider = provider or build_provider(
            runtime_config=self.runtime_config
        )
        self.memory_store: MemoryStore | None
        self.session_store: SessionStore | None
        if initialize_stores or memory_store is not None or session_store is not None:
            self.memory_store = memory_store or MemoryStore(self.settings.memory_db_path)
            self.session_store = session_store or SessionStore(self.settings.memory_db_path)
        else:
            self.memory_store = None
            self.session_store = None
        self.novel_rag_router: NovelRagRouter | None = None
        self.novel_rag_store: NovelRagStore | None = None
        if self.settings.novel_rag_enabled:
            if novel_rag_router is not None:
                self.novel_rag_router = novel_rag_router
            elif self.runtime_config.provider != "mock":
                self.novel_rag_router = NovelRagRouter(self.provider)

            if novel_rag_store is not None:
                self.novel_rag_store = novel_rag_store
            elif self.settings.novel_rag_db_path.exists():
                self.novel_rag_store = NovelRagStore(self.settings.novel_rag_db_path)
        self.planner_timeout_seconds = planner_timeout_seconds

    def plan_auto_dj_queries(
        self, context: AutoDjQueryPlanningContext
    ) -> AutoDjQueryPlan:
        """Call the LLM to produce a search-query plan without touching stores."""
        if self.runtime_config.provider == "mock":
            raise PlanningError("planning is not available with the mock provider")

        system_prompt = build_auto_dj_planning_system_prompt(context.settings)
        user_prompt = build_auto_dj_planning_user_prompt(context)
        messages: list[LLMMessage] = [
            {"role": "system", "content": system_prompt},
            {"role": "user", "content": user_prompt},
        ]
        try:
            result = self.provider.generate(
                messages, timeout=self.planner_timeout_seconds
            )
        except Exception as exc:
            _logger.exception("auto dj planner provider call failed")
            raise PlanningError(f"LLM call failed: {exc}") from exc

        return parse_and_validate_plan(result.content, context.settings)

    def chat(self, payload: ChatIn) -> ChatOut:
        if self.memory_store is None or self.session_store is None:
            raise RuntimeError(
                "ConversationManager.chat() called on a planning-only instance"
            )
        message = payload.message.strip() or "今天的音乐"
        session = self._resolve_session(payload.session_id)
        saved_user_message = self.session_store.append_message(
            session_id=session.id,
            role="user",
            content=message,
        )
        messages = self._build_messages(payload, saved_user_message.content)

        try:
            result = self._run_agent_turn(messages, payload.music_state)
        except ProviderUnavailable:
            return self._provider_unavailable_response(session)

        saved_reply = self.session_store.append_message(
            session_id=session.id,
            role="kumiko",
            content=result.content,
            provider=result.provider_status.provider,
            provider_model=result.provider_status.model,
            provider_configured=result.provider_status.configured,
            provider_label=result.provider_status.label,
        )
        session = self.session_store.get_session(session.id)

        memory_events: list[MemoryEventOut] = []
        if payload.memory_enabled:
            for memory in extract_memories(
                user_message=saved_user_message.content,
                assistant_reply=saved_reply.content,
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
                id=saved_reply.id,
                role="kumiko",
                content=saved_reply.content,
            ),
            expression="listening",
            suggested_actions=["save_diary", "save_inspiration"],
            provider_status=ProviderStatusOut(**asdict(result.provider_status)),
            memory_events=memory_events,
            session=_session_out(session),
            client_actions=result.client_actions,
            agent_trace=result.agent_trace,
        )

    def _resolve_session(self, session_id: str | None) -> ChatSession:
        if session_id:
            return self.session_store.get_session(session_id)
        return self.session_store.ensure_default_session()

    def _build_messages(self, payload: ChatIn, message: str) -> list[LLMMessage]:
        system_parts = [build_persona_prompt(payload.persona_strength).strip()]

        memories = self.memory_store.list_recent(limit=8)
        if memories:
            memory_lines = ["参考记忆："]
            for memory in memories:
                memory_lines.append(f"- [{memory.category}] {memory.text}")
            system_parts.append("\n".join(memory_lines))

        novel_context = self._novel_context(payload, message)
        if novel_context:
            system_parts.append(novel_context)

        room_state_context = _room_state_context(payload)
        if room_state_context:
            system_parts.append(room_state_context)

        listening_context = _listening_context(payload)
        if listening_context:
            system_parts.append(listening_context)

        music_state_context = _music_state_context(payload)
        if music_state_context:
            system_parts.append(music_state_context)

        messages: list[LLMMessage] = [
            {"role": "system", "content": "\n\n".join(system_parts)}
        ]
        messages.extend(_recent_messages(payload))
        messages.append({"role": "user", "content": message})
        return messages

    def _novel_context(self, payload: ChatIn, message: str) -> str:
        if (
            not self.settings.novel_rag_enabled
            or self.novel_rag_router is None
            or self.novel_rag_store is None
        ):
            return ""

        recent_user_messages = [
            recent.content.strip()
            for recent in payload.recent_messages[-6:]
            if recent.role == "user" and recent.content.strip()
        ]
        try:
            decision = self.novel_rag_router.route(
                message,
                recent_user_messages=recent_user_messages,
            )
        except Exception:
            _logger.exception("novel RAG routing failed")
            return ""

        if not decision.use_novel_rag or not decision.query.strip():
            return ""

        try:
            results = self.novel_rag_store.search(decision.query, limit=5)
        except Exception:
            _logger.exception("novel RAG search failed")
            return ""

        return build_novel_reference_context(results)

    def _run_agent_turn(
        self,
        messages: list[LLMMessage],
        music_state: MusicAgentState | None,
    ) -> AgentTurnResult:
        tool_context = RoomAgentToolContext(music_state=music_state)
        trace: list[dict[str, str | bool]] = []
        working_messages = list(messages)
        tools = room_agent_tool_specs()
        last_result: LLMResult | None = None

        for _ in range(MAX_AGENT_TOOL_STEPS):
            result = self.provider.generate(
                working_messages,
                tools=tools,
                tool_choice="auto",
            )
            last_result = result
            if not result.tool_calls:
                return AgentTurnResult(
                    content=result.content,
                    provider_status=result.provider_status,
                    client_actions=list(tool_context.client_actions),
                    agent_trace=AgentTraceOut(tool_calls=trace),
                )

            working_messages.append(_assistant_tool_call_message(result))
            for tool_call in result.tool_calls:
                tool_result = dispatch_room_agent_tool(tool_call, tool_context)
                trace.append(
                    {
                        "id": tool_call.id,
                        "name": tool_call.name,
                        "ok": tool_result.ok,
                    }
                )
                working_messages.append(
                    {
                        "role": "tool",
                        "tool_call_id": tool_call.id,
                        "name": tool_call.name,
                        "content": tool_result.content,
                    }
                )

        provider_status = (
            last_result.provider_status
            if last_result is not None
            else _provider_status_from_runtime(self.runtime_config)
        )
        return AgentTurnResult(
            content=(
                "我已经尝试用工具找歌了，但这轮工具调用还没有收束。"
                "先停在这里，避免替你乱播放。"
            ),
            provider_status=provider_status,
            client_actions=list(tool_context.client_actions),
            agent_trace=AgentTraceOut(tool_calls=trace),
        )

    def _provider_unavailable_response(self, session: ChatSession) -> ChatOut:
        provider_status = _fallback_provider_status(self.runtime_config)
        saved_reply = self.session_store.append_message(
            session_id=session.id,
            role="kumiko",
            content=_fallback_content(self.runtime_config),
            provider=provider_status.provider,
            provider_model=provider_status.model,
            provider_configured=provider_status.configured,
            provider_label=provider_status.label,
        )
        session = self.session_store.get_session(session.id)
        return ChatOut(
            reply=ChatMessageOut(
                id=saved_reply.id,
                role="kumiko",
                content=saved_reply.content,
            ),
            expression="thinking",
            suggested_actions=[],
            provider_status=provider_status,
            memory_events=[],
            session=_session_out(session),
            client_actions=[],
            agent_trace=AgentTraceOut(),
        )


def _fallback_content(runtime_config: LlmRuntimeConfig) -> str:
    if runtime_config.provider == "openai_compatible":
        return "模型连接失败，请检查 Base URL、模型名称和 API Key。"
    if runtime_config.provider == "deepseek" and not runtime_config.api_key:
        return "DeepSeek 未配置 API Key，请先设置 DEEPSEEK_API_KEY。"
    return "DeepSeek 连接失败，请检查网络、Base URL 和 API Key。"


def _fallback_provider_status(runtime_config: LlmRuntimeConfig) -> ProviderStatusOut:
    if runtime_config.provider == "mock":
        return ProviderStatusOut(
            provider="mock",
            model=None,
            configured=False,
            label="本地 Mock API 暂不可用",
        )
    if runtime_config.provider == "deepseek" and not runtime_config.api_key:
        return ProviderStatusOut(**asdict(unconfigured_runtime_status(runtime_config)))
    if not runtime_config.api_key and runtime_config.provider != "openai_compatible":
        return ProviderStatusOut(**asdict(unconfigured_runtime_status(runtime_config)))
    return ProviderStatusOut(
        provider=runtime_config.provider,
        model=runtime_config.model,
        configured=True,
        label=_runtime_label(runtime_config),
    )


def _provider_status_from_runtime(
    runtime_config: LlmRuntimeConfig,
) -> ProviderStatus:
    if runtime_config.provider == "mock":
        return ProviderStatus(
            provider="mock",
            model=None,
            configured=False,
            label="Local Mock API unavailable",
        )
    if runtime_config.provider == "deepseek" and not runtime_config.api_key:
        return unconfigured_runtime_status(runtime_config)
    if not runtime_config.api_key and runtime_config.provider != "openai_compatible":
        return unconfigured_runtime_status(runtime_config)
    return ProviderStatus(
        provider=runtime_config.provider,
        model=runtime_config.model,
        configured=True,
        label=_runtime_label(runtime_config),
    )


def _runtime_label(runtime_config: LlmRuntimeConfig) -> str:
    if runtime_config.provider == "openai_compatible":
        return f"OpenAI 兼容 {runtime_config.model}"
    if runtime_config.provider == "deepseek":
        return f"DeepSeek {runtime_config.model}"
    return "本地 Mock API"


def _assistant_tool_call_message(result: LLMResult) -> LLMMessage:
    return {
        "role": "assistant",
        "content": result.content or "",
        "tool_calls": [
            {
                "id": tool_call.id,
                "type": "function",
                "function": {
                    "name": tool_call.name,
                    "arguments": json.dumps(
                        tool_call.arguments,
                        ensure_ascii=False,
                        separators=(",", ":"),
                    ),
                },
            }
            for tool_call in result.tool_calls
        ],
    }


def _memory_event_out(memory: Any) -> MemoryEventOut:
    data = asdict(memory)
    data.pop("source", None)
    return MemoryEventOut(**data)


def _session_out(session: ChatSession) -> ChatSessionOut:
    return ChatSessionOut(**asdict(session))


def _recent_messages(payload: ChatIn) -> list[LLMMessage]:
    messages: list[LLMMessage] = []
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


def _listening_context(payload: ChatIn) -> str:
    if payload.listening_context is None:
        return ""

    context = payload.listening_context
    lines = [
        "Listening context:",
        f"- Source: {context.source}",
        f"- Track: {_current_track(context.title, context.creator)}",
        f"- Playing: {'yes' if context.is_playing else 'no'}",
    ]
    if context.page_url:
        lines.append(f"- Page: {context.page_url}")
    if context.tags:
        lines.append(f"- Tags: {', '.join(context.tags)}")
    return "\n".join(lines)


def _music_state_context(payload: ChatIn) -> str:
    state = payload.music_state
    if state is None:
        return ""

    lines = [
        "Music state:",
        f"- Playing: {'yes' if state.is_playing else 'no'}",
        f"- Progress: {state.current_time_ms}/{state.duration_ms} ms",
    ]
    if state.current is not None:
        lines.append(f"- Current: {_music_track_label(state.current)}")
    if state.previous is not None:
        lines.append(f"- Previous: {_music_track_label(state.previous)}")
    if state.next is not None:
        lines.append(f"- Next: {_music_track_label(state.next)}")
    if state.upcoming:
        lines.append(f"- Upcoming: {_music_track_list(state.upcoming)}")
    if state.recent:
        lines.append(f"- Recent: {_music_track_list(state.recent)}")
    if state.saved:
        lines.append(f"- Saved: {_music_track_list(state.saved)}")
    if state.playlists:
        lines.append(f"- Playlists: {_music_playlist_list(state.playlists)}")
    return "\n".join(lines)


def _music_playlist_list(playlists: list[MusicAgentPlaylist], limit: int = 5) -> str:
    visible = playlists[:limit]
    labels = [
        f"{playlist.name} ({playlist.item_count} {_track_count_label(playlist.item_count)}, {playlist.id})"
        for playlist in visible
    ]
    if len(playlists) > limit:
        labels.append(f"+{len(playlists) - limit} more")
    return "; ".join(labels)


def _track_count_label(count: int) -> str:
    return "track" if count == 1 else "tracks"


def _music_track_list(tracks: list[MusicAgentTrack], limit: int = 5) -> str:
    visible = tracks[:limit]
    labels = [_music_track_label(track) for track in visible]
    if len(tracks) > limit:
        labels.append(f"+{len(tracks) - limit} more")
    return "; ".join(labels)


def _music_track_label(track: MusicAgentTrack) -> str:
    return f"{_current_track(track.title, track.creator)} ({track.id})"


def _current_track(title: str | None, artist: str | None) -> str:
    if title and artist:
        return f"{title} - {artist}"
    if title:
        return title
    if artist:
        return artist
    return ""


__all__ = ["ConversationManager"]

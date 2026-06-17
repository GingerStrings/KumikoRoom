from typing import Literal

from pydantic import BaseModel, Field, model_validator


PersonaStrength = Literal["medium", "strong"]
MemoryCategory = Literal["preference", "diary", "creative_note", "profile_fact"]
MusicSourceKind = Literal["bilibili", "netease"]
LlmProviderKind = Literal["mock", "deepseek", "openai_compatible"]


class CharacterStateOut(BaseModel):
    display_name: str
    romanized_name: str
    expression: str
    status_text: str


class MusicContextOut(BaseModel):
    current_track_title: str | None = None
    current_artist: str | None = None
    listening_mood: str | None = None


class StudioSummaryOut(BaseModel):
    label: str
    route: str
    unfinished_count: int


class RoomStateOut(BaseModel):
    app_name: str
    room_name: str
    character: CharacterStateOut
    music: MusicContextOut
    diary_summary: str
    inspiration_count: int
    studio: StudioSummaryOut


class ChatMessageOut(BaseModel):
    id: str
    role: str
    content: str


class ListeningContextIn(BaseModel):
    source: MusicSourceKind
    title: str
    creator: str
    is_playing: bool
    page_url: str | None = None
    tags: list[str] = Field(default_factory=list)


class MusicAgentTrack(BaseModel):
    id: str
    source: MusicSourceKind
    title: str
    creator: str
    duration_ms: int
    page_url: str | None = None
    platform_audio_url: str | None = None
    tags: list[str] = Field(default_factory=list)
    can_open_video: bool = False
    saved: bool = False


class MusicAgentPlaylist(BaseModel):
    id: str
    name: str
    description: str | None = None
    item_count: int
    updated_at: str
    items: list[MusicAgentTrack] = Field(default_factory=list)


class MusicAgentState(BaseModel):
    is_playing: bool = False
    current_time_ms: int = 0
    duration_ms: int = 0
    current: MusicAgentTrack | None = None
    previous: MusicAgentTrack | None = None
    next: MusicAgentTrack | None = None
    upcoming: list[MusicAgentTrack] = Field(default_factory=list)
    recent: list[MusicAgentTrack] = Field(default_factory=list)
    saved: list[MusicAgentTrack] = Field(default_factory=list)
    playlists: list[MusicAgentPlaylist] = Field(default_factory=list)


class MusicSearchResultOut(BaseModel):
    source: Literal["netease"]
    id: str
    song_id: str
    title: str
    creator: str
    duration_ms: int
    page_url: str
    platform_audio_url: str
    tags: list[str] = Field(default_factory=list)
    playable: bool
    popularity: float | None = None
    comment_count: int | None = None
    hot_comment_liked_count: int | None = None
    score: float
    evidence: list[str] = Field(default_factory=list)


class ClientMusicItemOut(BaseModel):
    id: str
    source: MusicSourceKind
    title: str
    creator: str
    duration_ms: int
    page_url: str | None = None
    platform_audio_url: str | None = None
    tags: list[str] = Field(default_factory=list)
    can_open_video: bool = False
    source_query: str | None = None
    selected_reason: str | None = None
    selection_evidence: list[str] = Field(default_factory=list)
    selection_score: float | None = None


class RoomClientActionOut(BaseModel):
    type: Literal[
        "play_music_item",
        "add_music_to_queue",
        "remove_music_from_queue",
        "save_music_item",
        "unsave_music_item",
        "clear_music_queue",
        "open_video_window",
        "create_music_playlist",
        "rename_music_playlist",
        "delete_music_playlist",
        "add_music_to_playlist",
        "remove_music_from_playlist",
        "play_music_playlist",
        "add_playlist_to_queue",
    ]
    item: ClientMusicItemOut | None = None
    item_id: str | None = None
    playlist_id: str | None = None
    playlist_name: str | None = None
    description: str | None = None


class AgentTraceOut(BaseModel):
    tool_calls: list[dict[str, str | bool]] = Field(default_factory=list)


class LLMConfigIn(BaseModel):
    provider: LlmProviderKind
    base_url: str | None = None
    api_key: str | None = None
    model: str | None = None

    @model_validator(mode="after")
    def _validate_provider_fields(self) -> "LLMConfigIn":
        if self.provider == "mock":
            return self

        if self.provider == "openai_compatible":
            if not (self.base_url and self.base_url.strip()):
                raise ValueError(
                    "openai_compatible provider requires a base_url"
                )
            if not (self.model and self.model.strip()):
                raise ValueError(
                    "openai_compatible provider requires a model"
                )
            self._assert_http_scheme(self.base_url)
            return self

        if self.provider == "deepseek":
            if not (self.api_key and self.api_key.strip()):
                raise ValueError("deepseek provider requires an api_key")
            if self.base_url:
                self._assert_http_scheme(self.base_url)
            return self

        return self

    @staticmethod
    def _assert_http_scheme(base_url: str) -> None:
        stripped = base_url.strip().lower()
        if not (stripped.startswith("http://") or stripped.startswith("https://")):
            raise ValueError("base_url must use http or https scheme")

    def normalized(self) -> "LLMConfigIn":
        return LLMConfigIn(
            provider=self.provider,
            base_url=self.base_url.strip() if self.base_url else None,
            api_key=self.api_key.strip() if self.api_key else None,
            model=self.model.strip() if self.model else None,
        )


class LLMTestOut(BaseModel):
    ok: bool
    error: str | None = None
    model: str | None = None
    latency_ms: int | None = None


class ChatIn(BaseModel):
    message: str
    session_id: str | None = None
    room_state: RoomStateOut | None = None
    listening_context: ListeningContextIn | None = None
    music_state: MusicAgentState | None = None
    recent_messages: list[ChatMessageOut] = Field(default_factory=list)
    persona_strength: PersonaStrength = "medium"
    memory_enabled: bool = True
    llm_config: LLMConfigIn | None = None


class ProviderStatusOut(BaseModel):
    provider: LlmProviderKind
    model: str | None
    configured: bool
    label: str


class MemoryEventOut(BaseModel):
    id: str
    category: MemoryCategory
    text: str
    confidence: float
    created_at: str


class ChatSessionOut(BaseModel):
    id: str
    title: str
    created_at: str
    updated_at: str
    latest_message_preview: str | None = None


class StoredChatMessageOut(BaseModel):
    id: str
    session_id: str
    role: Literal["user", "kumiko"]
    content: str
    created_at: str
    provider: str | None = None
    provider_model: str | None = None
    provider_configured: bool | None = None
    provider_label: str | None = None


class SessionRenameIn(BaseModel):
    title: str


class ChatOut(BaseModel):
    reply: ChatMessageOut
    expression: str
    suggested_actions: list[str]
    provider_status: ProviderStatusOut
    memory_events: list[MemoryEventOut] = Field(default_factory=list)
    session: ChatSessionOut | None = None
    client_actions: list[RoomClientActionOut] = Field(default_factory=list)
    agent_trace: AgentTraceOut = Field(default_factory=AgentTraceOut)

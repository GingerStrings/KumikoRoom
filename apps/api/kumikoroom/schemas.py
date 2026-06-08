from typing import Literal

from pydantic import BaseModel, Field


PersonaStrength = Literal["medium", "strong"]
MemoryCategory = Literal["preference", "diary", "creative_note", "profile_fact"]


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


class ChatIn(BaseModel):
    message: str
    room_state: RoomStateOut | None = None
    recent_messages: list[ChatMessageOut] = Field(default_factory=list)
    persona_strength: PersonaStrength = "medium"
    memory_enabled: bool = True


class ProviderStatusOut(BaseModel):
    provider: Literal["mock", "deepseek"]
    model: str | None
    configured: bool
    label: str


class MemoryEventOut(BaseModel):
    id: str
    category: MemoryCategory
    text: str
    confidence: float
    created_at: str


class ChatOut(BaseModel):
    reply: ChatMessageOut
    expression: str
    suggested_actions: list[str]
    provider_status: ProviderStatusOut
    memory_events: list[MemoryEventOut] = Field(default_factory=list)

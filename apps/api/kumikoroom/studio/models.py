from dataclasses import dataclass, field
from enum import Enum
from typing import Literal

from pydantic import TypeAdapter


class AnalysisStatus(str, Enum):
    DISCOVERED = "discovered"
    QUEUED = "queued"
    PARSING = "parsing"
    READY = "ready"
    PARTIAL = "partial"
    FAILED = "failed"
    STALE = "stale"


@dataclass(frozen=True)
class ProjectInfo:
    title: str | None = None
    author: str | None = None
    fl_version: str | None = None
    tempo: float | None = None
    ppq: int | None = None
    time_signature_numerator: int | None = None
    time_signature_denominator: int | None = None
    created_at: str | None = None
    time_spent_seconds: int | None = None


@dataclass(frozen=True)
class NoteSummary:
    key: int
    position: int
    length: int
    velocity: int
    channel_id: str | None


@dataclass(frozen=True)
class PatternSummary:
    id: str
    name: str
    notes: list[NoteSummary] = field(default_factory=list)
    used_in_playlist: bool = False


@dataclass(frozen=True)
class ChannelSummary:
    id: str
    name: str
    plugin_name: str | None = None
    channel_type: str = "unknown"


@dataclass(frozen=True)
class PlaylistClipSummary:
    id: str
    track_index: int
    start: int
    length: int
    clip_type: str
    source_id: str | None = None


@dataclass(frozen=True)
class PluginInstance:
    id: str
    name: str
    kind: str
    location: str
    state_supported: bool


@dataclass(frozen=True)
class MixerInsertSummary:
    id: str
    name: str
    slot_plugin_ids: list[str] = field(default_factory=list)
    route_target_ids: list[str] = field(default_factory=list)


@dataclass(frozen=True)
class AutomationSummary:
    id: str
    name: str
    target_name: str | None = None
    point_count: int = 0


@dataclass(frozen=True)
class ProjectAsset:
    path: str
    kind: Literal["render", "audio", "backup"]
    modified_at: str | None = None
    size: int | None = None


@dataclass(frozen=True)
class DependencyReference:
    path: str
    kind: str
    exists: bool


@dataclass(frozen=True)
class AnalysisDiagnostic:
    code: str
    severity: Literal["error", "warning", "notice"]
    message: str
    target_type: str | None = None
    target_id: str | None = None


@dataclass(frozen=True)
class MusicalFingerprint:
    note_min: int | None = None
    note_max: int | None = None
    note_density: float = 0.0
    velocity_mean: float | None = None
    pattern_reuse: float = 0.0
    inferred_key: str | None = None
    inferred_key_confidence: float = 0.0
    inferred_key_evidence: list[str] = field(default_factory=list)


@dataclass(frozen=True)
class FlpAnalysisSnapshot:
    source_path: str
    source_hash: str
    status: AnalysisStatus
    project: ProjectInfo
    patterns: list[PatternSummary] = field(default_factory=list)
    channels: list[ChannelSummary] = field(default_factory=list)
    playlist_clips: list[PlaylistClipSummary] = field(default_factory=list)
    plugins: list[PluginInstance] = field(default_factory=list)
    mixer_inserts: list[MixerInsertSummary] = field(default_factory=list)
    automations: list[AutomationSummary] = field(default_factory=list)
    related_assets: list[ProjectAsset] = field(default_factory=list)
    dependencies: list[DependencyReference] = field(default_factory=list)
    fingerprint: MusicalFingerprint = field(default_factory=MusicalFingerprint)
    diagnostics: list[AnalysisDiagnostic] = field(default_factory=list)
    unknown_event_count: int = 0

    def to_json(self) -> str:
        return TypeAdapter(FlpAnalysisSnapshot).dump_json(self).decode("utf-8")

    @classmethod
    def from_json(cls, payload: str) -> "FlpAnalysisSnapshot":
        return TypeAdapter(cls).validate_json(payload)

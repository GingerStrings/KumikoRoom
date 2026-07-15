from __future__ import annotations

from collections.abc import Callable
from pathlib import Path
import re
import sys
from threading import Lock
from typing import Any, TypeVar

import pyflp

from ..models import (
    AnalysisDiagnostic,
    AnalysisStatus,
    AutomationSummary,
    ChannelSummary,
    DependencyReference,
    FlpAnalysisSnapshot,
    MixerInsertSummary,
    NoteSummary,
    PatternSummary,
    PlaylistClipSummary,
    PluginInstance,
    ProjectInfo,
)
from .base import FlpParseError


_MISSING = object()
_NOTE_NAMES = ("C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B")
_T = TypeVar("_T")
_PYFLP_ENUM_COMPATIBILITY_LOCK = Lock()
_PYFLP_ENUM_COMPATIBILITY_MEMBER = "_KumikoRoomPython313Compatibility"


class PyFlpParser:
    def parse(self, path: Path, *, source_hash: str) -> FlpAnalysisSnapshot:
        source_path = Path(path).expanduser().resolve(strict=False)
        if not source_path.is_file():
            raise FlpParseError(
                source_path,
                "open",
                f"FLP source is missing or is not a regular file: {source_path}",
            )

        try:
            _ensure_pyflp_event_enum_compatibility()
            project = pyflp.parse(source_path)
        except Exception as cause:
            raise FlpParseError(
                source_path,
                "open",
                f"Unable to parse FLP project: {source_path}",
                cause,
            ) from cause

        diagnostics: list[AnalysisDiagnostic] = []

        def map_section(
            name: str, mapper: Callable[[], _T], default: _T
        ) -> _T:
            try:
                return mapper()
            except Exception as cause:
                diagnostics.append(
                    AnalysisDiagnostic(
                        code="unsupported_structure",
                        severity="warning",
                        message=f"Unable to map {name}: {cause}",
                        target_type=name,
                    )
                )
                return default

        project_info = map_section("project", lambda: _project_info(project), ProjectInfo())
        playlist_clips = map_section(
            "playlist", lambda: _playlist_clips(project), []
        )
        used_pattern_ids = {
            clip.source_id
            for clip in playlist_clips
            if clip.clip_type == "pattern" and clip.source_id is not None
        }
        patterns = map_section(
            "patterns", lambda: _patterns(project, used_pattern_ids), []
        )
        channels = map_section("channels", lambda: _channels(project), [])
        plugins = map_section("plugins", lambda: _plugins(project), [])
        mixer_inserts = map_section(
            "mixer", lambda: _mixer(project, diagnostics), []
        )
        automations = map_section(
            "automations", lambda: _automations(project), []
        )
        dependencies = map_section(
            "dependencies",
            lambda: _dependencies(project, source_path, diagnostics),
            [],
        )
        unknown_event_count = map_section(
            "unknown_events", lambda: _unknown_event_count(project), 0
        )

        return FlpAnalysisSnapshot(
            source_path=str(source_path),
            source_hash=source_hash,
            status=(
                AnalysisStatus.PARTIAL if diagnostics else AnalysisStatus.READY
            ),
            project=project_info,
            patterns=patterns,
            channels=channels,
            playlist_clips=playlist_clips,
            plugins=plugins,
            mixer_inserts=mixer_inserts,
            automations=automations,
            dependencies=dependencies,
            diagnostics=diagnostics,
            unknown_event_count=unknown_event_count,
        )


def _ensure_pyflp_event_enum_compatibility() -> None:
    """Keep PyFLP 2.x's empty event base enum callable on Python 3.13+."""
    if sys.version_info < (3, 13):
        return

    from pyflp._events import EventEnum

    if EventEnum._member_map_:
        return

    with _PYFLP_ENUM_COMPATIBILITY_LOCK:
        if EventEnum._member_map_:
            return

        member = int.__new__(EventEnum, -1)
        member._name_ = _PYFLP_ENUM_COMPATIBILITY_MEMBER
        member._value_ = -1
        member.type = None
        type.__setattr__(
            EventEnum,
            _PYFLP_ENUM_COMPATIBILITY_MEMBER,
            member,
        )
        EventEnum._member_names_.append(_PYFLP_ENUM_COMPATIBILITY_MEMBER)
        EventEnum._value2member_map_[-1] = member
        EventEnum._member_map_[_PYFLP_ENUM_COMPATIBILITY_MEMBER] = member


def _project_info(project: Any) -> ProjectInfo:
    arrangements = _public_attr(project, "arrangements", None)
    time_signature = _public_attr(arrangements, "time_signature", None)
    created_on = _public_attr(project, "created_on", None)
    time_spent = _public_attr(project, "time_spent", None)
    version = _public_attr(project, "version", None)

    return ProjectInfo(
        title=_optional_text(_public_attr(project, "title", None)),
        author=_optional_text(_public_attr(project, "artists", None)),
        fl_version=None if version is None else str(version),
        tempo=_optional_float(_public_attr(project, "tempo", None)),
        ppq=_optional_int(_public_attr(project, "ppq", None)),
        time_signature_numerator=_optional_int(
            _public_attr(time_signature, "num", None)
        ),
        time_signature_denominator=_optional_int(
            _public_attr(time_signature, "beat", None)
        ),
        created_at=(
            created_on.isoformat()
            if created_on is not None and hasattr(created_on, "isoformat")
            else _optional_text(created_on)
        ),
        time_spent_seconds=(
            int(time_spent.total_seconds())
            if time_spent is not None and hasattr(time_spent, "total_seconds")
            else _optional_int(time_spent)
        ),
    )


def _patterns(project: Any, used_pattern_ids: set[str]) -> list[PatternSummary]:
    summaries: list[PatternSummary] = []
    for index, pattern in enumerate(_public_items(project, "patterns"), start=1):
        pattern_id = _identifier(_public_attr(pattern, "iid", None), str(index))
        notes = [
            NoteSummary(
                key=_note_key(_public_attr(note, "key", None)),
                position=_required_int(_public_attr(note, "position", 0)),
                length=_required_int(_public_attr(note, "length", 0)),
                velocity=_required_int(_public_attr(note, "velocity", 0)),
                channel_id=_optional_identifier(
                    _public_attr(note, "rack_channel", None)
                ),
            )
            for note in _public_items(pattern, "notes")
        ]
        summaries.append(
            PatternSummary(
                id=pattern_id,
                name=_name(pattern, f"Pattern {pattern_id}"),
                notes=notes,
                used_in_playlist=pattern_id in used_pattern_ids,
            )
        )
    return summaries


def _channels(project: Any) -> list[ChannelSummary]:
    summaries: list[ChannelSummary] = []
    for index, channel in enumerate(_public_items(project, "channels")):
        channel_id = _identifier(_public_attr(channel, "iid", None), str(index))
        plugin = _public_attr(channel, "plugin", None)
        summaries.append(
            ChannelSummary(
                id=channel_id,
                name=_name(channel, f"Channel {channel_id}"),
                plugin_name=(
                    _plugin_name(plugin, channel) if plugin is not None else None
                ),
                channel_type=_channel_type(channel),
            )
        )
    return summaries


def _playlist_clips(project: Any) -> list[PlaylistClipSummary]:
    clips: list[PlaylistClipSummary] = []
    for arrangement_index, arrangement in enumerate(
        _public_items(project, "arrangements"), start=1
    ):
        arrangement_id = _identifier(
            _public_attr(arrangement, "iid", None), str(arrangement_index)
        )
        for track_index, track in enumerate(
            _public_items(arrangement, "tracks"), start=1
        ):
            public_track_index = _required_int(
                _public_attr(track, "iid", track_index)
            )
            for clip_index, item in enumerate(_public_items(track)):
                pattern = _public_attr(item, "pattern", _MISSING)
                channel = _public_attr(item, "channel", _MISSING)
                if pattern is not _MISSING:
                    clip_type = "pattern"
                    source_id = _optional_identifier(
                        _public_attr(pattern, "iid", None)
                    )
                elif channel is not _MISSING:
                    clip_type = "channel"
                    source_id = _optional_identifier(
                        _public_attr(channel, "iid", None)
                    )
                else:
                    clip_type = "unknown"
                    source_id = None

                clips.append(
                    PlaylistClipSummary(
                        id=f"{arrangement_id}:{public_track_index}:{clip_index}",
                        track_index=public_track_index,
                        start=_required_int(_public_attr(item, "position", 0)),
                        length=_required_int(_public_attr(item, "length", 0)),
                        clip_type=clip_type,
                        source_id=source_id,
                    )
                )
    return clips


def _plugins(project: Any) -> list[PluginInstance]:
    plugins: list[PluginInstance] = []
    for index, channel in enumerate(_public_items(project, "channels")):
        plugin = _public_attr(channel, "plugin", None)
        if plugin is None:
            continue
        channel_id = _identifier(_public_attr(channel, "iid", None), str(index))
        location = f"channel:{channel_id}"
        plugins.append(
            PluginInstance(
                id=location,
                name=_plugin_name(plugin, channel),
                kind="generator",
                location=location,
                state_supported=_has_public_attr(plugin, "state"),
            )
        )

    mixer = _public_attr(project, "mixer", None)
    for insert_index, insert in enumerate(_public_items(mixer)):
        insert_id = _identifier(
            _public_attr(insert, "iid", None), str(insert_index)
        )
        for slot_index, slot in enumerate(_public_items(insert)):
            plugin = _public_attr(slot, "plugin", None)
            if plugin is None:
                continue
            public_slot_index = _identifier(
                _public_attr(
                    slot,
                    "index",
                    _public_attr(slot, "iid", slot_index),
                ),
                str(slot_index),
            )
            location = f"mixer:{insert_id}:slot:{public_slot_index}"
            plugins.append(
                PluginInstance(
                    id=location,
                    name=_plugin_name(plugin, slot),
                    kind="effect",
                    location=location,
                    state_supported=_has_public_attr(plugin, "state"),
                )
            )
    return plugins


def _mixer(
    project: Any, diagnostics: list[AnalysisDiagnostic]
) -> list[MixerInsertSummary]:
    summaries: list[MixerInsertSummary] = []
    route_limitation_reported = False
    mixer = _public_attr(project, "mixer", None)
    for insert_index, insert in enumerate(_public_items(mixer)):
        insert_id = _identifier(
            _public_attr(insert, "iid", None), str(insert_index)
        )
        slot_plugin_ids: list[str] = []
        for slot_index, slot in enumerate(_public_items(insert)):
            if _public_attr(slot, "plugin", None) is None:
                continue
            public_slot_index = _identifier(
                _public_attr(
                    slot,
                    "index",
                    _public_attr(slot, "iid", slot_index),
                ),
                str(slot_index),
            )
            slot_plugin_ids.append(
                f"mixer:{insert_id}:slot:{public_slot_index}"
            )
        if _public_items(insert, "routes") and not route_limitation_reported:
            diagnostics.append(
                AnalysisDiagnostic(
                    code="unsupported_structure",
                    severity="warning",
                    message=(
                        "PyFLP public API only exposes mixer route send levels; "
                        "route target IDs are unavailable"
                    ),
                    target_type="mixer",
                    target_id=insert_id,
                )
            )
            route_limitation_reported = True
        summaries.append(
            MixerInsertSummary(
                id=insert_id,
                name=_name(insert, f"Insert {insert_id}"),
                slot_plugin_ids=slot_plugin_ids,
                route_target_ids=[],
            )
        )
    return summaries


def _automations(project: Any) -> list[AutomationSummary]:
    summaries: list[AutomationSummary] = []
    channels = _public_attr(project, "channels", None)
    for index, automation in enumerate(
        _public_items(channels, "automations")
    ):
        automation_id = _identifier(
            _public_attr(automation, "iid", None), str(index)
        )
        summaries.append(
            AutomationSummary(
                id=automation_id,
                name=_name(automation, f"Automation {automation_id}"),
                target_name=None,
                point_count=sum(1 for _point in _public_items(automation)),
            )
        )
    return summaries


def _dependencies(
    project: Any,
    source_path: Path,
    diagnostics: list[AnalysisDiagnostic],
) -> list[DependencyReference]:
    references: list[DependencyReference] = []
    seen: set[tuple[str, str]] = set()

    def add(path_value: Any, kind: str) -> None:
        if path_value in (None, ""):
            return
        raw_path = str(path_value)
        if "%flstudiofactorydata%" in raw_path.casefold():
            key = (kind, raw_path)
            if key in seen:
                return
            seen.add(key)
            references.append(
                DependencyReference(path=raw_path, kind=kind, exists=False)
            )
            diagnostics.append(
                AnalysisDiagnostic(
                    code="unresolved_dependency",
                    severity="warning",
                    message=(
                        "Dependency requires the FL Studio factory data root "
                        "to resolve"
                    ),
                    target_type="dependency",
                    target_id=raw_path,
                )
            )
            return
        path = Path(path_value).expanduser()
        if not path.is_absolute():
            path = source_path.parent / path
        path = path.resolve(strict=False)
        key = (kind, str(path))
        if key in seen:
            return
        seen.add(key)
        references.append(
            DependencyReference(path=str(path), kind=kind, exists=path.exists())
        )

    for channel in _public_items(project, "channels"):
        add(_public_attr(channel, "sample_path", None), "sample")
        plugin = _public_attr(channel, "plugin", None)
        if plugin is not None:
            add(_public_attr(plugin, "plugin_path", None), "plugin")

    mixer = _public_attr(project, "mixer", None)
    for insert in _public_items(mixer):
        for slot in _public_items(insert):
            plugin = _public_attr(slot, "plugin", None)
            if plugin is not None:
                add(_public_attr(plugin, "plugin_path", None), "plugin")
    return references


def _public_attr(obj: Any, name: str, default: Any) -> Any:
    if obj is None:
        return default
    try:
        return getattr(obj, name)
    except (AttributeError, KeyError):
        return default


def _has_public_attr(obj: Any, name: str) -> bool:
    return _public_attr(obj, name, _MISSING) is not _MISSING


def _public_items(obj: Any, name: str | None = None) -> tuple[Any, ...]:
    value = obj if name is None else _public_attr(obj, name, _MISSING)
    if value is None or value is _MISSING:
        return ()
    return tuple(item for item in value)


def _optional_text(value: Any) -> str | None:
    if value is None:
        return None
    return str(value)


def _optional_float(value: Any) -> float | None:
    if value is None:
        return None
    return float(value)


def _optional_int(value: Any) -> int | None:
    if value is None:
        return None
    return int(value)


def _required_int(value: Any) -> int:
    return 0 if value is None else int(value)


def _identifier(value: Any, fallback: str) -> str:
    return fallback if value is None else str(value)


def _optional_identifier(value: Any) -> str | None:
    return None if value is None else str(value)


def _name(obj: Any, fallback: str) -> str:
    for attribute in ("name", "display_name", "internal_name"):
        value = _public_attr(obj, attribute, None)
        if value not in (None, ""):
            return str(value)
    return fallback


def _plugin_name(plugin: Any, owner: Any) -> str:
    name = _public_attr(plugin, "name", None)
    if name not in (None, ""):
        return str(name)
    internal_name = _public_attr(owner, "internal_name", None)
    if internal_name not in (None, ""):
        return str(internal_name)
    return _name(owner, "Unknown plugin")


def _channel_type(channel: Any) -> str:
    public_types = (
        (pyflp.channel.Automation, "automation"),
        (pyflp.channel.Layer, "layer"),
        (pyflp.channel.Instrument, "instrument"),
        (pyflp.channel.Sampler, "sampler"),
        (pyflp.channel.Channel, "channel"),
    )
    for channel_class, name in public_types:
        if isinstance(channel, channel_class):
            return name

    for attribute in ("channel_type", "type"):
        value = _public_attr(channel, attribute, None)
        if value is not None:
            enum_value = _public_attr(value, "value", value)
            return str(enum_value).lower()
    return "unknown"


def _note_key(value: Any) -> int:
    if value is None:
        return 0
    if isinstance(value, int):
        return value
    text = str(value)
    if text.lstrip("-").isdigit():
        return int(text)
    match = re.fullmatch(r"([A-G])(#?)(-?\d+)", text)
    if match is None:
        raise ValueError(f"Unsupported note key: {text}")
    pitch_name = match.group(1) + match.group(2)
    return int(match.group(3)) * 12 + _NOTE_NAMES.index(pitch_name)


def _unknown_event_count(project: Any) -> int:
    value = _public_attr(project, "unknown_event_count", 0)
    if value is None:
        return 0
    return int(value)

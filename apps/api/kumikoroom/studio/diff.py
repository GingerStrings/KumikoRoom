from __future__ import annotations

import re
from dataclasses import asdict
from datetime import datetime
from difflib import SequenceMatcher
from pathlib import Path
from typing import Any, Callable, Iterable

from .models import FlpAnalysisSnapshot


AUTO_CONFIRM_SCORE = 0.8


def score_backup_association(
    main: FlpAnalysisSnapshot,
    candidate: FlpAnalysisSnapshot,
    *,
    main_modified_at: str | None = None,
    candidate_modified_at: str | None = None,
) -> float:
    """Return a deterministic structural confidence score in the range 0..1."""
    stem_score = SequenceMatcher(
        None,
        _normalized_stem(main.source_path),
        _normalized_stem(candidate.source_path),
    ).ratio()
    main_title = _normalized_text(main.project.title)
    candidate_title = _normalized_text(candidate.project.title)
    title_score = (
        SequenceMatcher(None, main_title, candidate_title).ratio()
        if main_title and candidate_title
        else 0.0
    )
    time_score = _time_proximity(main_modified_at, candidate_modified_at)
    pattern_score = _set_overlap(
        {_normalized_text(item.name) or item.id for item in main.patterns},
        {_normalized_text(item.name) or item.id for item in candidate.patterns},
    )
    channel_score = _set_overlap(
        {_normalized_text(item.name) or item.id for item in main.channels},
        {_normalized_text(item.name) or item.id for item in candidate.channels},
    )
    plugin_score = _set_overlap(
        {_normalized_text(item.name) or item.id for item in main.plugins},
        {_normalized_text(item.name) or item.id for item in candidate.plugins},
    )
    score = (
        stem_score * 0.30
        + title_score * 0.20
        + time_score * 0.15
        + pattern_score * 0.15
        + channel_score * 0.10
        + plugin_score * 0.10
    )
    return round(max(0.0, min(1.0, score)), 6)


def diff_snapshots(
    before: FlpAnalysisSnapshot,
    after: FlpAnalysisSnapshot,
) -> dict[str, Any]:
    project_metrics = _metric_changes(before, after)
    patterns = _entity_diff(before.patterns, after.patterns, lambda item: item.id)
    channels = _entity_diff(before.channels, after.channels, lambda item: item.id)
    plugins = _entity_diff(before.plugins, after.plugins, lambda item: item.id)
    playlist = _entity_diff(
        before.playlist_clips, after.playlist_clips, lambda item: item.id
    )
    mixer = _entity_diff(
        before.mixer_inserts, after.mixer_inserts, lambda item: item.id
    )
    dependencies = _entity_diff(
        before.dependencies,
        after.dependencies,
        lambda item: _path_key(item.path),
    )
    notes = _note_diff(before, after)
    sections = {
        "project_metrics": project_metrics,
        "patterns": patterns,
        "notes": notes,
        "channels": channels,
        "plugins": plugins,
        "playlist_clips": playlist,
        "mixer_inserts": mixer,
        "dependencies": dependencies,
    }
    change_count = sum(
        len(items)
        for section in sections.values()
        for items in section.values()
    )
    return {
        "from_snapshot_id": None,
        "to_snapshot_id": None,
        "summary": {"change_count": change_count},
        **sections,
    }


def _metric_changes(
    before: FlpAnalysisSnapshot,
    after: FlpAnalysisSnapshot,
) -> dict[str, list[dict[str, Any]]]:
    metrics = {
        "tempo": (before.project.tempo, after.project.tempo),
        "ppq": (before.project.ppq, after.project.ppq),
        "time_signature_numerator": (
            before.project.time_signature_numerator,
            after.project.time_signature_numerator,
        ),
        "time_signature_denominator": (
            before.project.time_signature_denominator,
            after.project.time_signature_denominator,
        ),
        "pattern_count": (len(before.patterns), len(after.patterns)),
        "channel_count": (len(before.channels), len(after.channels)),
        "plugin_count": (len(before.plugins), len(after.plugins)),
        "playlist_clip_count": (
            len(before.playlist_clips),
            len(after.playlist_clips),
        ),
        "mixer_insert_count": (
            len(before.mixer_inserts),
            len(after.mixer_inserts),
        ),
        "dependency_count": (len(before.dependencies), len(after.dependencies)),
        "note_min": (before.fingerprint.note_min, after.fingerprint.note_min),
        "note_max": (before.fingerprint.note_max, after.fingerprint.note_max),
        "note_density": (
            before.fingerprint.note_density,
            after.fingerprint.note_density,
        ),
        "velocity_mean": (
            before.fingerprint.velocity_mean,
            after.fingerprint.velocity_mean,
        ),
        "pattern_reuse": (
            before.fingerprint.pattern_reuse,
            after.fingerprint.pattern_reuse,
        ),
    }
    changed = [
        {"field": field, "before": old, "after": new}
        for field, (old, new) in sorted(metrics.items())
        if _normalized_value(old) != _normalized_value(new)
    ]
    return {"added": [], "removed": [], "changed": changed}


def _entity_diff(
    before: Iterable[Any],
    after: Iterable[Any],
    key: Callable[[Any], str],
) -> dict[str, list[dict[str, Any]]]:
    old = _indexed_entities(before, key)
    new = _indexed_entities(after, key)
    added = [new[item_key] for item_key in sorted(new.keys() - old.keys())]
    removed = [old[item_key] for item_key in sorted(old.keys() - new.keys())]
    changed = [
        {"id": item_key, "before": old[item_key], "after": new[item_key]}
        for item_key in sorted(old.keys() & new.keys())
        if old[item_key] != new[item_key]
    ]
    return {"added": added, "removed": removed, "changed": changed}


def _indexed_entities(
    values: Iterable[Any],
    key: Callable[[Any], str],
) -> dict[str, dict[str, Any]]:
    groups: dict[str, list[dict[str, Any]]] = {}
    for value in values:
        groups.setdefault(key(value), []).append(_stable_entity(value))
    indexed: dict[str, dict[str, Any]] = {}
    for base_key, members in sorted(groups.items()):
        ordered = sorted(members, key=_sort_dict)
        if len(ordered) == 1:
            indexed[base_key] = ordered[0]
            continue
        for index, member in enumerate(ordered):
            indexed[f"{base_key}#{index}"] = member
    return indexed


def _note_diff(
    before: FlpAnalysisSnapshot,
    after: FlpAnalysisSnapshot,
) -> dict[str, list[dict[str, Any]]]:
    old = _flatten_notes(before)
    new = _flatten_notes(after)
    old_groups = _note_groups(old)
    new_groups = _note_groups(new)
    added: list[dict[str, Any]] = []
    removed: list[dict[str, Any]] = []
    changed: list[dict[str, Any]] = []
    for group_key in sorted(old_groups.keys() | new_groups.keys(), key=str):
        old_notes = list(old_groups.get(group_key, []))
        new_notes = list(new_groups.get(group_key, []))
        for exact in sorted(
            set(map(_note_exact_key, old_notes)) & set(map(_note_exact_key, new_notes)),
            key=str,
        ):
            matches = min(
                sum(_note_exact_key(item) == exact for item in old_notes),
                sum(_note_exact_key(item) == exact for item in new_notes),
            )
            for _ in range(matches):
                old_notes.remove(next(item for item in old_notes if _note_exact_key(item) == exact))
                new_notes.remove(next(item for item in new_notes if _note_exact_key(item) == exact))
        old_notes.sort(key=_sort_dict)
        new_notes.sort(key=_sort_dict)
        pair_count = min(len(old_notes), len(new_notes))
        changed.extend(
            {"pattern_id": group_key[0], "before": old_notes[index], "after": new_notes[index]}
            for index in range(pair_count)
        )
        removed.extend(old_notes[pair_count:])
        added.extend(new_notes[pair_count:])
    return {
        "added": sorted(added, key=_sort_dict),
        "removed": sorted(removed, key=_sort_dict),
        "changed": changed,
    }


def _flatten_notes(snapshot: FlpAnalysisSnapshot) -> list[dict[str, Any]]:
    return [
        {"pattern_id": pattern.id, **_stable_entity(note)}
        for pattern in snapshot.patterns
        for note in pattern.notes
    ]


def _note_groups(
    notes: list[dict[str, Any]],
) -> dict[tuple[Any, ...], list[dict[str, Any]]]:
    groups: dict[tuple[Any, ...], list[dict[str, Any]]] = {}
    for note in notes:
        key = (
            note["pattern_id"],
            note["key"],
            note["position"],
            note["channel_id"] or "",
        )
        groups.setdefault(key, []).append(note)
    return groups


def _note_exact_key(note: dict[str, Any]) -> tuple[tuple[str, str], ...]:
    return tuple((key, repr(note[key])) for key in sorted(note))


def _stable_entity(value: Any) -> dict[str, Any]:
    result = asdict(value)
    return {key: _stable_value(item) for key, item in sorted(result.items())}


def _stable_value(value: Any) -> Any:
    if isinstance(value, float):
        return round(value, 9)
    if isinstance(value, list):
        return [_stable_value(item) for item in value]
    if isinstance(value, dict):
        return {key: _stable_value(item) for key, item in sorted(value.items())}
    return value


def _sort_dict(value: dict[str, Any]) -> tuple[str, ...]:
    return tuple(f"{key}={value[key]!r}" for key in sorted(value))


def _normalized_value(value: Any) -> Any:
    return round(value, 9) if isinstance(value, float) else value


def _normalized_stem(path: str) -> str:
    stem = Path(path).stem.casefold()
    stem = re.sub(r"\b(?:backup|autosave|auto save|bak|copy)\b", " ", stem)
    stem = re.sub(r"\b\d{4}[-_. ]?\d{1,2}[-_. ]?\d{1,2}\b", " ", stem)
    stem = re.sub(r"\b\d{1,2}[-_. ]?\d{2}(?:[-_. ]?\d{2})?\b", " ", stem)
    stem = re.sub(r"\s*[-_( ]+\d+[) ]*$", "", stem)
    return _normalized_text(stem)


def _normalized_text(value: str | None) -> str:
    if not value:
        return ""
    return " ".join(re.sub(r"[^\w]+", " ", value.casefold()).split())


def _path_key(path: str) -> str:
    return str(Path(path)).replace("\\", "/").casefold()


def _set_overlap(left: set[str], right: set[str]) -> float:
    if not left and not right:
        return 1.0
    if not left or not right:
        return 0.0
    return len(left & right) / len(left | right)


def _time_proximity(left: str | None, right: str | None) -> float:
    if not left or not right:
        return 0.0
    try:
        delta = abs((datetime.fromisoformat(left.replace("Z", "+00:00")) - datetime.fromisoformat(right.replace("Z", "+00:00"))).total_seconds())
    except (TypeError, ValueError):
        return 0.0
    if delta <= 24 * 3600:
        return 1.0
    if delta <= 7 * 24 * 3600:
        return 0.7
    if delta <= 30 * 24 * 3600:
        return 0.3
    return 0.0

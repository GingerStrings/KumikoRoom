from __future__ import annotations

from dataclasses import replace
from math import sqrt
from typing import Iterable, Sequence

from .models import (
    AnalysisDiagnostic,
    ChannelSummary,
    DependencyReference,
    FlpAnalysisSnapshot,
    NoteSummary,
    PatternSummary,
    PlaylistClipSummary,
)


_PITCH_CLASS_NAMES = (
    "C",
    "C#",
    "D",
    "Eb",
    "E",
    "F",
    "F#",
    "G",
    "Ab",
    "A",
    "Bb",
    "B",
)
_MAJOR_PROFILE = (
    6.35,
    2.23,
    3.48,
    2.33,
    4.38,
    4.09,
    2.52,
    5.19,
    2.39,
    3.66,
    2.29,
    2.88,
)
_MINOR_PROFILE = (
    6.33,
    2.68,
    3.52,
    5.38,
    2.60,
    3.53,
    2.54,
    4.75,
    3.98,
    2.69,
    3.34,
    3.17,
)
_MINIMUM_KEY_NOTES = 12
_MINIMUM_KEY_CONFIDENCE = 0.55


def _notes(patterns: Iterable[PatternSummary]) -> list[NoteSummary]:
    return [note for pattern in patterns for note in pattern.notes]


def note_range(
    patterns: Iterable[PatternSummary],
) -> tuple[int | None, int | None]:
    keys = [note.key for note in _notes(patterns)]
    if not keys:
        return None, None
    return min(keys), max(keys)


def mean_velocity(patterns: Iterable[PatternSummary]) -> float | None:
    velocities = [note.velocity for note in _notes(patterns)]
    if not velocities:
        return None
    return sum(velocities) / len(velocities)


def arrangement_end_position(clips: Iterable[PlaylistClipSummary]) -> int:
    return max(
        (clip.start + max(clip.length, 0) for clip in clips),
        default=0,
    )


def note_density_per_beat(
    patterns: Iterable[PatternSummary],
    clips: Iterable[PlaylistClipSummary],
    ppq: int | None,
) -> float:
    pattern_list = list(patterns)
    clip_list = list(clips)
    end_position = arrangement_end_position(clip_list)
    if ppq is None or ppq <= 0 or end_position <= 0:
        return 0.0
    return len(_notes(pattern_list)) / (end_position / ppq)


def pattern_reuse_ratio(clips: Iterable[PlaylistClipSummary]) -> float:
    source_ids = [
        clip.source_id
        for clip in clips
        if clip.clip_type.lower() == "pattern" and clip.source_id
    ]
    if not source_ids:
        return 0.0
    reuse = (len(source_ids) - len(set(source_ids))) / len(source_ids)
    return min(1.0, max(0.0, reuse))


def _pearson_correlation(left: Sequence[float], right: Sequence[float]) -> float:
    left_mean = sum(left) / len(left)
    right_mean = sum(right) / len(right)
    left_offsets = [value - left_mean for value in left]
    right_offsets = [value - right_mean for value in right]
    denominator = sqrt(
        sum(value * value for value in left_offsets)
        * sum(value * value for value in right_offsets)
    )
    if denominator == 0.0:
        return 0.0
    return sum(
        left_value * right_value
        for left_value, right_value in zip(left_offsets, right_offsets)
    ) / denominator


def _key_inference(
    notes: Sequence[NoteSummary],
) -> tuple[str | None, float, list[str]]:
    note_count = len(notes)
    if note_count < _MINIMUM_KEY_NOTES:
        return (
            None,
            0.0,
            [
                f"Pitched note count: {note_count}; "
                f"at least {_MINIMUM_KEY_NOTES} required."
            ],
        )

    histogram = [0.0] * 12
    for note in notes:
        histogram[note.key % 12] += 1.0

    scored_keys: list[tuple[float, int, str]] = []
    stable_order = 0
    for tonic, tonic_name in enumerate(_PITCH_CLASS_NAMES):
        for mode, profile in (
            ("major", _MAJOR_PROFILE),
            ("minor", _MINOR_PROFILE),
        ):
            rotated_profile = [
                profile[(pitch_class - tonic) % 12]
                for pitch_class in range(12)
            ]
            correlation = _pearson_correlation(histogram, rotated_profile)
            confidence = min(1.0, max(0.0, (correlation + 1.0) / 2.0))
            scored_keys.append((confidence, stable_order, f"{tonic_name} {mode}"))
            stable_order += 1

    ranked = sorted(scored_keys, key=lambda item: (-item[0], item[1]))
    winning_score, _, winning_key = ranked[0]
    runner_up_score, _, runner_up_key = ranked[1]
    evidence = [
        f"Pitched note count: {note_count}.",
        (
            f"Winning profile: {winning_key} ({winning_score:.4f}); "
            f"runner-up: {runner_up_key} ({runner_up_score:.4f})."
        ),
    ]
    if winning_score < _MINIMUM_KEY_CONFIDENCE:
        evidence.append(
            f"Winning confidence is below {_MINIMUM_KEY_CONFIDENCE:.2f}."
        )
        return None, winning_score, evidence
    return winning_key, winning_score, evidence


def _pattern_diagnostics(
    patterns: Iterable[PatternSummary],
    clips: Iterable[PlaylistClipSummary],
) -> list[AnalysisDiagnostic]:
    used_pattern_ids = {
        clip.source_id
        for clip in clips
        if clip.clip_type.lower() == "pattern" and clip.source_id
    }
    diagnostics: list[AnalysisDiagnostic] = []
    for pattern in sorted(patterns, key=lambda item: item.id):
        if not pattern.used_in_playlist and pattern.id not in used_pattern_ids:
            diagnostics.append(
                AnalysisDiagnostic(
                    code="unused_pattern",
                    severity="notice",
                    message=f"Pattern {pattern.id} is not used in the playlist.",
                    target_type="pattern",
                    target_id=pattern.id,
                )
            )
        if not pattern.notes:
            diagnostics.append(
                AnalysisDiagnostic(
                    code="empty_pattern",
                    severity="notice",
                    message=f"Pattern {pattern.id} contains no notes.",
                    target_type="pattern",
                    target_id=pattern.id,
                )
            )
    return diagnostics


def _channel_diagnostics(
    channels: Iterable[ChannelSummary],
    patterns: Iterable[PatternSummary],
    clips: Iterable[PlaylistClipSummary],
) -> list[AnalysisDiagnostic]:
    used_channel_ids = {
        note.channel_id
        for note in _notes(patterns)
        if note.channel_id
    }
    used_channel_ids.update(
        clip.source_id
        for clip in clips
        if clip.clip_type.lower() == "channel" and clip.source_id
    )
    return [
        AnalysisDiagnostic(
            code="unused_channel",
            severity="notice",
            message=(
                f"Channel {channel.id} is not referenced by notes or "
                "playlist clips."
            ),
            target_type="channel",
            target_id=channel.id,
        )
        for channel in sorted(channels, key=lambda item: item.id)
        if channel.id not in used_channel_ids
    ]


def _dependency_diagnostics(
    dependencies: Iterable[DependencyReference],
    existing: Iterable[AnalysisDiagnostic],
) -> list[AnalysisDiagnostic]:
    unresolved_paths = {
        diagnostic.target_id
        for diagnostic in existing
        if diagnostic.code == "unresolved_dependency" and diagnostic.target_id
    }
    return [
        AnalysisDiagnostic(
            code="missing_dependency",
            severity="warning",
            message=f"Dependency does not exist: {dependency.path}",
            target_type="dependency",
            target_id=dependency.path,
        )
        for dependency in sorted(
            dependencies, key=lambda item: (item.path, item.kind)
        )
        if not dependency.exists and dependency.path not in unresolved_paths
    ]


def _occupied_intervals(
    clips: Iterable[PlaylistClipSummary],
) -> list[tuple[int, int]]:
    intervals: list[tuple[int, int]] = []
    for clip in clips:
        length = max(clip.length, 0)
        start = max(clip.start, 0)
        end = max(clip.start + length, 0)
        if end > start:
            intervals.append((start, end))
    return sorted(intervals)


def _long_empty_region_diagnostics(
    clips: Iterable[PlaylistClipSummary], ppq: int | None
) -> list[AnalysisDiagnostic]:
    if ppq is None or ppq <= 0:
        return []
    intervals = _occupied_intervals(clips)
    if not intervals:
        return []

    merged: list[tuple[int, int]] = []
    for start, end in intervals:
        if not merged or start > merged[-1][1]:
            merged.append((start, end))
            continue
        previous_start, previous_end = merged[-1]
        merged[-1] = (previous_start, max(previous_end, end))

    minimum_gap = 8 * ppq
    diagnostics: list[AnalysisDiagnostic] = []
    for (_, previous_end), (next_start, _) in zip(merged, merged[1:]):
        if next_start - previous_end < minimum_gap:
            continue
        target_id = f"{previous_end}-{next_start}"
        diagnostics.append(
            AnalysisDiagnostic(
                code="long_empty_region",
                severity="notice",
                message=(
                    f"Playlist has an empty region from tick {previous_end} "
                    f"to {next_start}."
                ),
                target_type="playlist",
                target_id=target_id,
            )
        )
    return diagnostics


def _append_new_diagnostics(
    existing: Iterable[AnalysisDiagnostic],
    generated: Iterable[AnalysisDiagnostic],
) -> list[AnalysisDiagnostic]:
    diagnostics = list(existing)
    identities = {
        (diagnostic.code, diagnostic.target_type, diagnostic.target_id)
        for diagnostic in diagnostics
    }
    for diagnostic in generated:
        identity = (diagnostic.code, diagnostic.target_type, diagnostic.target_id)
        if identity not in identities:
            diagnostics.append(diagnostic)
            identities.add(identity)
    return diagnostics


def analyze_snapshot(snapshot: FlpAnalysisSnapshot) -> FlpAnalysisSnapshot:
    notes = _notes(snapshot.patterns)
    note_min, note_max = note_range(snapshot.patterns)
    inferred_key, confidence, evidence = _key_inference(notes)
    fingerprint = replace(
        snapshot.fingerprint,
        note_min=note_min,
        note_max=note_max,
        note_density=note_density_per_beat(
            snapshot.patterns,
            snapshot.playlist_clips,
            snapshot.project.ppq,
        ),
        velocity_mean=mean_velocity(snapshot.patterns),
        pattern_reuse=pattern_reuse_ratio(snapshot.playlist_clips),
        inferred_key=inferred_key,
        inferred_key_confidence=confidence,
        inferred_key_evidence=evidence,
    )
    generated_diagnostics = [
        *_pattern_diagnostics(snapshot.patterns, snapshot.playlist_clips),
        *_channel_diagnostics(
            snapshot.channels, snapshot.patterns, snapshot.playlist_clips
        ),
        *_dependency_diagnostics(snapshot.dependencies, snapshot.diagnostics),
        *_long_empty_region_diagnostics(
            snapshot.playlist_clips, snapshot.project.ppq
        ),
    ]
    diagnostics = _append_new_diagnostics(
        snapshot.diagnostics, generated_diagnostics
    )
    return replace(snapshot, fingerprint=fingerprint, diagnostics=diagnostics)

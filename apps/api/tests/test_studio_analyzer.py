import pytest

from kumikoroom.studio.analyzer import (
    analyze_snapshot,
    arrangement_end_position,
    note_density_per_beat,
    pattern_reuse_ratio,
)
from kumikoroom.studio.models import (
    AnalysisDiagnostic,
    AnalysisStatus,
    ChannelSummary,
    DependencyReference,
    FlpAnalysisSnapshot,
    MusicalFingerprint,
    NoteSummary,
    PatternSummary,
    PlaylistClipSummary,
    ProjectInfo,
)


def _snapshot(**overrides: object) -> FlpAnalysisSnapshot:
    values = {
        "source_path": "song.flp",
        "source_hash": "hash",
        "status": AnalysisStatus.READY,
        "project": ProjectInfo(ppq=96),
    }
    values.update(overrides)
    return FlpAnalysisSnapshot(**values)  # type: ignore[arg-type]


def test_analyze_snapshot_builds_a_deterministic_musical_fingerprint() -> None:
    keys = [62, 65, 69, 62, 65, 69, 60, 62, 65, 69, 62, 65, 69, 60]
    velocities = [
        80,
        90,
        100,
        85,
        95,
        105,
        70,
        80,
        90,
        100,
        85,
        95,
        105,
        70,
    ]
    notes = [
        NoteSummary(
            key=key,
            position=index * 24,
            length=24,
            velocity=velocity,
            channel_id=None,
        )
        for index, (key, velocity) in enumerate(zip(keys, velocities))
    ]
    snapshot = _snapshot(
        patterns=[
            PatternSummary(id="1", name="Harmony", notes=notes),
            PatternSummary(id="2", name="Empty"),
        ],
        playlist_clips=[
            PlaylistClipSummary(
                id="clip-1",
                track_index=0,
                start=0,
                length=384,
                clip_type="pattern",
                source_id="1",
            )
        ],
    )

    analyzed = analyze_snapshot(snapshot)

    assert analyzed.fingerprint.note_min == 60
    assert analyzed.fingerprint.note_max == 69
    assert analyzed.fingerprint.velocity_mean == pytest.approx(89.2857)
    assert analyzed.fingerprint.note_density == pytest.approx(3.5)
    assert analyzed.fingerprint.pattern_reuse == 0.0
    assert analyzed.fingerprint.inferred_key == "D minor"
    assert 0.0 <= analyzed.fingerprint.inferred_key_confidence <= 1.0
    assert any("14" in item for item in analyzed.fingerprint.inferred_key_evidence)
    assert any(
        diagnostic.code == "unused_pattern" and diagnostic.target_id == "2"
        for diagnostic in analyzed.diagnostics
    )
    assert any(
        diagnostic.code == "empty_pattern" and diagnostic.target_id == "2"
        for diagnostic in analyzed.diagnostics
    )


def test_metric_helpers_lock_ppq_density_and_pattern_reuse_formulas() -> None:
    patterns = [
        PatternSummary(
            id="1",
            name="Notes",
            notes=[
                NoteSummary(60 + index, index * 24, 24, 80, None)
                for index in range(4)
            ],
        )
    ]
    clips = [
        PlaylistClipSummary("1", 0, 0, 96, "pattern", "1"),
        PlaylistClipSummary("2", 0, 96, 96, "pattern", "1"),
        PlaylistClipSummary("3", 0, 192, 96, "pattern", "2"),
        PlaylistClipSummary("4", 0, -100, -20, "pattern", None),
        PlaylistClipSummary("5", 0, 288, 96, "channel", "3"),
    ]

    assert arrangement_end_position(clips) == 384
    assert note_density_per_beat(patterns, clips, ppq=96) == pytest.approx(1.0)
    assert note_density_per_beat(patterns, clips, ppq=None) == 0.0
    assert note_density_per_beat(patterns, clips, ppq=0) == 0.0
    assert pattern_reuse_ratio(clips) == pytest.approx(0.5)
    assert pattern_reuse_ratio([clips[3]]) == 0.0
    assert arrangement_end_position([clips[3]]) == -100


def test_empty_patterns_produce_empty_note_metrics() -> None:
    analyzed = analyze_snapshot(_snapshot(patterns=[]))

    assert analyzed.fingerprint.note_min is None
    assert analyzed.fingerprint.note_max is None
    assert analyzed.fingerprint.velocity_mean is None
    assert analyzed.fingerprint.note_density == 0.0


def test_pattern_usage_combines_playlist_sources_and_parser_usage_flags() -> None:
    analyzed = analyze_snapshot(
        _snapshot(
            patterns=[
                PatternSummary(id="1", name="Playlist", notes=[]),
                PatternSummary(
                    id="2", name="Parser", notes=[], used_in_playlist=True
                ),
                PatternSummary(id="3", name="Unused", notes=[]),
            ],
            playlist_clips=[
                PlaylistClipSummary("clip", 0, 0, 96, "pattern", "1")
            ],
        )
    )

    unused_ids = {
        item.target_id
        for item in analyzed.diagnostics
        if item.code == "unused_pattern"
    }
    empty_ids = {
        item.target_id for item in analyzed.diagnostics if item.code == "empty_pattern"
    }
    assert unused_ids == {"3"}
    assert empty_ids == {"1", "2", "3"}


def test_channels_referenced_by_notes_or_channel_clips_are_not_unused() -> None:
    analyzed = analyze_snapshot(
        _snapshot(
            patterns=[
                PatternSummary(
                    id="1",
                    name="Notes",
                    notes=[NoteSummary(60, 0, 96, 100, "note-channel")],
                    used_in_playlist=True,
                )
            ],
            channels=[
                ChannelSummary(id="note-channel", name="From note"),
                ChannelSummary(id="clip-channel", name="From clip"),
                ChannelSummary(id="unused-channel", name="Unused"),
            ],
            playlist_clips=[
                PlaylistClipSummary(
                    "clip", 0, 0, 96, "channel", "clip-channel"
                )
            ],
        )
    )

    unused_ids = {
        item.target_id
        for item in analyzed.diagnostics
        if item.code == "unused_channel"
    }
    assert unused_ids == {"unused-channel"}


def test_missing_dependencies_preserve_factory_token_parser_diagnostic() -> None:
    factory_path = r"%FLStudioFactoryData%\Packs\Drums\Kick.wav"
    parser_diagnostics = [
        AnalysisDiagnostic(
            code="unsupported_structure",
            severity="warning",
            message="Parser detail",
            target_type="mixer",
            target_id="1",
        ),
        AnalysisDiagnostic(
            code="unresolved_dependency",
            severity="warning",
            message="Factory root is unresolved",
            target_type="dependency",
            target_id=factory_path,
        ),
    ]
    analyzed = analyze_snapshot(
        _snapshot(
            dependencies=[
                DependencyReference(factory_path, "sample", False),
                DependencyReference("missing.wav", "sample", False),
                DependencyReference("present.wav", "sample", True),
            ],
            diagnostics=parser_diagnostics,
        )
    )

    assert analyzed.diagnostics[:2] == parser_diagnostics
    assert [
        item.target_id
        for item in analyzed.diagnostics
        if item.code == "unresolved_dependency"
    ] == [factory_path]
    assert [
        item.target_id
        for item in analyzed.diagnostics
        if item.code == "missing_dependency"
    ] == ["missing.wav"]


def test_long_empty_regions_merge_clip_intervals_and_use_eight_beat_threshold() -> None:
    clips = [
        PlaylistClipSummary("1", 0, 0, 96, "pattern", "1"),
        PlaylistClipSummary("2", 1, 50, 100, "channel", "1"),
        PlaylistClipSummary("3", 0, 918, 32, "pattern", "2"),
        PlaylistClipSummary("4", 0, 950, 100, "pattern", "2"),
        PlaylistClipSummary("5", 0, 1800, 96, "pattern", "3"),
    ]

    analyzed = analyze_snapshot(_snapshot(playlist_clips=clips))

    gaps = [
        item
        for item in analyzed.diagnostics
        if item.code == "long_empty_region"
    ]
    assert [(item.severity, item.target_type, item.target_id) for item in gaps] == [
        ("notice", "playlist", "150-918")
    ]
    assert not any(
        item.code == "long_empty_region"
        for item in analyze_snapshot(
            _snapshot(project=ProjectInfo(ppq=0), playlist_clips=clips)
        ).diagnostics
    )


def test_long_empty_regions_keep_negative_tick_intervals() -> None:
    analyzed = analyze_snapshot(
        _snapshot(
            playlist_clips=[
                PlaylistClipSummary("negative", 0, -100, 10, "pattern", "1"),
                PlaylistClipSummary("positive", 0, 700, 10, "pattern", "2"),
            ]
        )
    )

    assert [
        item.target_id
        for item in analyzed.diagnostics
        if item.code == "long_empty_region"
    ] == ["-90-700"]


def test_key_inference_requires_enough_notes_and_minimum_confidence() -> None:
    too_few = analyze_snapshot(
        _snapshot(
            patterns=[
                PatternSummary(
                    id="1",
                    name="Few",
                    notes=[
                        NoteSummary(62, index, 1, 80, None)
                        for index in range(11)
                    ],
                    used_in_playlist=True,
                )
            ]
        )
    )
    flat_histogram = analyze_snapshot(
        _snapshot(
            patterns=[
                PatternSummary(
                    id="1",
                    name="Chromatic",
                    notes=[
                        NoteSummary(60 + index, index, 1, 80, None)
                        for index in range(12)
                    ],
                    used_in_playlist=True,
                )
            ]
        )
    )

    assert too_few.fingerprint.inferred_key is None
    assert too_few.fingerprint.inferred_key_confidence == 0.0
    assert "at least 12 required" in too_few.fingerprint.inferred_key_evidence[0]
    assert flat_histogram.fingerprint.inferred_key is None
    assert flat_histogram.fingerprint.inferred_key_confidence == pytest.approx(0.5)
    assert (
        "Winning profile: C major (0.5000)"
        in flat_histogram.fingerprint.inferred_key_evidence[1]
    )


def test_analysis_is_pure_and_idempotent_while_preserving_parser_state() -> None:
    parser_diagnostic = AnalysisDiagnostic(
        code="unsupported_structure",
        severity="warning",
        message="Parser detail",
        target_type="patterns",
    )
    snapshot = _snapshot(
        source_path="original.flp",
        source_hash="original-hash",
        status=AnalysisStatus.PARTIAL,
        project=ProjectInfo(title="Original", ppq=96),
        patterns=[PatternSummary(id="2", name="Empty")],
        channels=[ChannelSummary(id="2", name="Unused")],
        dependencies=[DependencyReference("missing.wav", "sample", False)],
        fingerprint=MusicalFingerprint(inferred_key="Previous"),
        diagnostics=[parser_diagnostic],
    )
    before = snapshot.to_json()

    first = analyze_snapshot(snapshot)
    second = analyze_snapshot(first)

    assert snapshot.to_json() == before
    assert second == first
    assert first.source_path == snapshot.source_path
    assert first.source_hash == snapshot.source_hash
    assert first.status is snapshot.status
    assert first.project is snapshot.project
    assert first.diagnostics[0] == parser_diagnostic

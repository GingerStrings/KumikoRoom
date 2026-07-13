import json
from dataclasses import FrozenInstanceError

import pytest

import kumikoroom.studio as studio
import kumikoroom.studio.models as studio_models
from kumikoroom.studio.models import (
    AnalysisDiagnostic,
    AnalysisStatus,
    AutomationSummary,
    ChannelSummary,
    DependencyReference,
    FlpAnalysisSnapshot,
    MixerInsertSummary,
    MusicalFingerprint,
    NoteSummary,
    PatternSummary,
    PlaylistClipSummary,
    PluginInstance,
    ProjectAsset,
    ProjectInfo,
)


def _full_snapshot() -> FlpAnalysisSnapshot:
    note = NoteSummary(key=60, position=0, length=96, velocity=100, channel_id="1")
    return FlpAnalysisSnapshot(
        source_path=r"D:\Music\Blue Hour.flp",
        source_hash="abc123",
        status=AnalysisStatus.READY,
        project=ProjectInfo(title="Blue Hour", fl_version="21.2.3", tempo=128.0),
        patterns=[
            PatternSummary(
                id="pattern-1",
                name="Chords",
                notes=[note],
                used_in_playlist=True,
            )
        ],
        channels=[
            ChannelSummary(
                id="1",
                name="Keys",
                plugin_name="FLEX",
                channel_type="instrument",
            )
        ],
        playlist_clips=[
            PlaylistClipSummary(
                id="clip-1",
                track_index=0,
                start=0,
                length=384,
                clip_type="pattern",
                source_id="pattern-1",
            )
        ],
        plugins=[
            PluginInstance(
                id="plugin-1",
                name="FLEX",
                kind="generator",
                location="channel:1",
                state_supported=True,
            )
        ],
        mixer_inserts=[
            MixerInsertSummary(
                id="insert-1",
                name="Keys Bus",
                slot_plugin_ids=["plugin-2"],
                route_target_ids=["master"],
            )
        ],
        automations=[
            AutomationSummary(
                id="automation-1",
                name="Filter Sweep",
                target_name="FLEX cutoff",
                point_count=4,
            )
        ],
        related_assets=[
            ProjectAsset(
                path=r"D:\Music\Blue Hour.wav",
                kind="render",
                modified_at="2026-07-13T12:00:00+08:00",
                size=1024,
            )
        ],
        dependencies=[
            DependencyReference(path=r"D:\Samples\kick.wav", kind="sample", exists=True)
        ],
        fingerprint=MusicalFingerprint(
            note_min=48,
            note_max=72,
            note_density=0.25,
            velocity_mean=96.5,
            pattern_reuse=0.5,
            inferred_key="C major",
            inferred_key_confidence=0.8,
            inferred_key_evidence=["C major pitch-class profile"],
        ),
        diagnostics=[
            AnalysisDiagnostic(
                code="unused_pattern",
                severity="notice",
                message="Pattern 4 is not used in the arrangement.",
                target_type="pattern",
                target_id="4",
            )
        ],
        unknown_event_count=2,
    )


def test_snapshot_round_trips_through_json() -> None:
    snapshot = _full_snapshot()

    payload = snapshot.to_json()
    restored = FlpAnalysisSnapshot.from_json(payload)

    assert json.loads(payload)["status"] == "ready"
    assert restored == snapshot
    assert restored.status is AnalysisStatus.READY


def test_snapshot_serialization_reuses_the_module_adapter(monkeypatch) -> None:
    snapshot = _full_snapshot()

    def fail_if_adapter_is_rebuilt(*args, **kwargs):
        pytest.fail("TypeAdapter was rebuilt during snapshot serialization")

    monkeypatch.setattr(studio_models, "TypeAdapter", fail_if_adapter_is_rebuilt)

    payload = snapshot.to_json()

    assert FlpAnalysisSnapshot.from_json(payload) == snapshot


def test_mutable_defaults_are_not_shared_between_instances() -> None:
    first = FlpAnalysisSnapshot(
        source_path="first.flp",
        source_hash="first",
        status=AnalysisStatus.DISCOVERED,
        project=ProjectInfo(),
    )
    second = FlpAnalysisSnapshot(
        source_path="second.flp",
        source_hash="second",
        status=AnalysisStatus.QUEUED,
        project=ProjectInfo(),
    )

    first.patterns.append(PatternSummary(id="1", name="Pattern 1"))
    first.fingerprint.inferred_key_evidence.append("C major pitch-class profile")

    assert second.patterns == []
    assert second.fingerprint.inferred_key_evidence == []
    assert PatternSummary(id="2", name="Pattern 2").notes == []
    assert MixerInsertSummary(id="1", name="Insert 1").slot_plugin_ids == []
    assert MusicalFingerprint().inferred_key_evidence == []


def test_analysis_status_exposes_all_pipeline_states() -> None:
    assert [status.value for status in AnalysisStatus] == [
        "discovered",
        "queued",
        "parsing",
        "ready",
        "partial",
        "failed",
        "stale",
    ]


def test_studio_package_exports_public_models() -> None:
    expected_exports = {
        "AnalysisDiagnostic": AnalysisDiagnostic,
        "AnalysisStatus": AnalysisStatus,
        "AutomationSummary": AutomationSummary,
        "ChannelSummary": ChannelSummary,
        "DependencyReference": DependencyReference,
        "FlpAnalysisSnapshot": FlpAnalysisSnapshot,
        "MixerInsertSummary": MixerInsertSummary,
        "MusicalFingerprint": MusicalFingerprint,
        "NoteSummary": NoteSummary,
        "PatternSummary": PatternSummary,
        "PlaylistClipSummary": PlaylistClipSummary,
        "PluginInstance": PluginInstance,
        "ProjectAsset": ProjectAsset,
        "ProjectInfo": ProjectInfo,
    }

    assert {name: getattr(studio, name) for name in expected_exports} == expected_exports
    assert set(studio.__all__) == set(expected_exports)


def test_domain_models_expose_the_stable_field_contract() -> None:
    project = ProjectInfo()
    note = NoteSummary(key=60, position=0, length=96, velocity=100, channel_id="1")
    pattern = PatternSummary(id="1", name="Pattern 1", notes=[note])
    channel = ChannelSummary(id="1", name="Keys")
    clip = PlaylistClipSummary(
        id="clip-1",
        track_index=0,
        start=0,
        length=384,
        clip_type="pattern",
    )
    plugin = PluginInstance(
        id="plugin-1",
        name="FLEX",
        kind="generator",
        location="channel:1",
        state_supported=True,
    )
    mixer = MixerInsertSummary(id="1", name="Insert 1")
    automation = AutomationSummary(id="1", name="Filter Sweep")
    asset = ProjectAsset(path="Blue Hour.wav", kind="render")
    dependency = DependencyReference(path="kick.wav", kind="sample", exists=True)
    diagnostic = AnalysisDiagnostic(
        code="missing_sample",
        severity="warning",
        message="A sample could not be found.",
    )
    fingerprint = MusicalFingerprint()

    assert project == ProjectInfo(
        title=None,
        author=None,
        fl_version=None,
        tempo=None,
        ppq=None,
        time_signature_numerator=None,
        time_signature_denominator=None,
        created_at=None,
        time_spent_seconds=None,
    )
    assert pattern.used_in_playlist is False
    assert channel == ChannelSummary(
        id="1", name="Keys", plugin_name=None, channel_type="unknown"
    )
    assert clip.source_id is None
    assert mixer.route_target_ids == []
    assert automation.target_name is None and automation.point_count == 0
    assert asset.modified_at is None and asset.size is None
    assert dependency.exists is True
    assert diagnostic.target_type is None and diagnostic.target_id is None
    assert fingerprint.note_density == 0.0 and fingerprint.pattern_reuse == 0.0
    assert plugin.state_supported is True

    with pytest.raises(FrozenInstanceError):
        project.title = "Changed"  # type: ignore[misc]

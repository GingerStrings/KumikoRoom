from datetime import datetime, timedelta
from pathlib import Path
from typing import Any, Iterator

import pytest

from kumikoroom.studio.parsers.base import FlpParseError


class PublicObject:
    """Tiny iterable object graph which rejects adapter access to private state."""

    def __init__(self, items: tuple[Any, ...] = (), **attributes: Any) -> None:
        object.__setattr__(self, "_items", items)
        for name, value in attributes.items():
            object.__setattr__(self, name, value)

    def __getattribute__(self, name: str) -> Any:
        if name.startswith("_") and not name.startswith("__"):
            raise AssertionError(f"private attribute accessed: {name}")
        return object.__getattribute__(self, name)

    def __iter__(self) -> Iterator[Any]:
        return iter(object.__getattribute__(self, "_items"))


def test_parse_error_preserves_path_stage_and_cause() -> None:
    path = Path("broken.flp")
    cause = ValueError("invalid FLP")

    error = FlpParseError(path, "open", "Unable to parse project", cause)

    assert error.path == path
    assert error.stage == "open"
    assert error.message == "Unable to parse project"
    assert error.cause is cause
    assert error.__cause__ is cause
    assert "Unable to parse project" in str(error)


def test_parser_maps_the_public_pyflp_object_graph(
    tmp_path: Path, monkeypatch: Any
) -> None:
    from kumikoroom.studio.parsers import pyflp_adapter

    source = tmp_path / "session.flp"
    source.write_bytes(b"FLhd")
    sample = tmp_path / "kick.wav"
    sample.write_bytes(b"RIFF")
    plugin_binary = tmp_path / "synth.dll"
    plugin_binary.write_bytes(b"MZ")

    synth = PublicObject(name="Vital", state=b"preset", plugin_path=str(plugin_binary))
    effect = PublicObject(name="Delay 3", state=b"state")
    channel = PublicObject(
        iid=4,
        name="Lead",
        display_name="Lead",
        internal_name="Fruity Wrapper",
        plugin=synth,
        sample_path=sample,
    )
    note = PublicObject(
        key="C5", position=96, length=48, velocity=111, rack_channel=4
    )
    pattern = PublicObject(iid=2, name="Hook", notes=(note,))

    pattern_clip = PublicObject(pattern=pattern, position=192, length=96)
    channel_clip = PublicObject(channel=channel, position=384, length=192)
    track = PublicObject(items=(pattern_clip, channel_clip), iid=7)
    arrangement = PublicObject(iid=1, tracks=(track,))
    arrangements = PublicObject(
        items=(arrangement,),
        time_signature=PublicObject(num=3, beat=4),
    )

    automation = PublicObject(
        items=(PublicObject(), PublicObject(), PublicObject()),
        iid=8,
        name="Filter sweep",
    )
    channels = PublicObject(items=(channel,), automations=(automation,))
    slot = PublicObject(index=1, iid=31, name="Delay 3", plugin=effect)
    insert = PublicObject(items=(slot,), iid=5, name="FX", routes=())
    mixer = PublicObject(items=(insert,))
    project = PublicObject(
        title="Public API Project",
        artists="Kumiko",
        version="21.2.3",
        tempo=132.5,
        ppq=96,
        created_on=datetime(2025, 1, 2, 3, 4, 5),
        time_spent=timedelta(seconds=75),
        patterns=(pattern,),
        channels=channels,
        arrangements=arrangements,
        mixer=mixer,
        unknown_event_count=7,
    )
    parse_calls: list[Path] = []

    def fake_parse(path: Path) -> PublicObject:
        parse_calls.append(path)
        return project

    monkeypatch.setattr(pyflp_adapter.pyflp, "parse", fake_parse)
    monkeypatch.setattr(
        pyflp_adapter.pyflp,
        "save",
        lambda *_args, **_kwargs: (_ for _ in ()).throw(
            AssertionError("parser must remain read-only")
        ),
        raising=False,
    )

    relative_source = source.relative_to(Path.cwd())
    snapshot = pyflp_adapter.PyFlpParser().parse(
        relative_source, source_hash="hash-1"
    )

    assert parse_calls == [source.resolve()]
    assert snapshot.source_path == str(source.resolve())
    assert snapshot.source_hash == "hash-1"
    assert snapshot.status.value == "ready"
    assert snapshot.project.title == "Public API Project"
    assert snapshot.project.author == "Kumiko"
    assert snapshot.project.fl_version == "21.2.3"
    assert snapshot.project.tempo == 132.5
    assert snapshot.project.ppq == 96
    assert snapshot.project.time_signature_numerator == 3
    assert snapshot.project.time_signature_denominator == 4
    assert snapshot.project.created_at == "2025-01-02T03:04:05"
    assert snapshot.project.time_spent_seconds == 75
    assert snapshot.patterns[0].id == "2"
    assert snapshot.patterns[0].name == "Hook"
    assert snapshot.patterns[0].used_in_playlist is True
    assert snapshot.patterns[0].notes[0].key == 60
    assert snapshot.patterns[0].notes[0].position == 96
    assert snapshot.patterns[0].notes[0].length == 48
    assert snapshot.patterns[0].notes[0].velocity == 111
    assert snapshot.patterns[0].notes[0].channel_id == "4"
    assert snapshot.channels[0].id == "4"
    assert snapshot.channels[0].name == "Lead"
    assert snapshot.channels[0].plugin_name == "Vital"
    assert snapshot.channels[0].channel_type == "unknown"
    assert [clip.id for clip in snapshot.playlist_clips] == ["1:7:0", "1:7:1"]
    assert [clip.track_index for clip in snapshot.playlist_clips] == [7, 7]
    assert [clip.start for clip in snapshot.playlist_clips] == [192, 384]
    assert [clip.length for clip in snapshot.playlist_clips] == [96, 192]
    assert [clip.source_id for clip in snapshot.playlist_clips] == ["2", "4"]
    assert [clip.clip_type for clip in snapshot.playlist_clips] == [
        "pattern",
        "channel",
    ]
    plugins = {plugin.id: plugin for plugin in snapshot.plugins}
    assert plugins["channel:4"].name == "Vital"
    assert plugins["channel:4"].kind == "generator"
    assert plugins["channel:4"].location == "channel:4"
    assert plugins["channel:4"].state_supported is True
    assert plugins["mixer:5:slot:1"].name == "Delay 3"
    assert plugins["mixer:5:slot:1"].kind == "effect"
    assert plugins["mixer:5:slot:1"].state_supported is True
    assert snapshot.mixer_inserts[0].id == "5"
    assert snapshot.mixer_inserts[0].name == "FX"
    assert snapshot.mixer_inserts[0].route_target_ids == []
    assert snapshot.mixer_inserts[0].slot_plugin_ids == ["mixer:5:slot:1"]
    assert snapshot.automations[0].id == "8"
    assert snapshot.automations[0].name == "Filter sweep"
    assert snapshot.automations[0].point_count == 3
    assert snapshot.automations[0].target_name is None
    dependencies = {dependency.kind: dependency for dependency in snapshot.dependencies}
    assert dependencies["sample"].path == str(sample.resolve())
    assert dependencies["sample"].exists is True
    assert dependencies["plugin"].path == str(plugin_binary.resolve())
    assert dependencies["plugin"].exists is True
    assert snapshot.unknown_event_count == 7
    assert snapshot.diagnostics == []


def test_mixer_send_levels_do_not_become_route_target_ids(
    tmp_path: Path, monkeypatch: Any
) -> None:
    from kumikoroom.studio.parsers import pyflp_adapter

    source = tmp_path / "routes.flp"
    source.write_bytes(b"FLhd")
    effect = PublicObject(name="Delay", state=b"state")
    slot = PublicObject(index=2, plugin=effect)
    insert = PublicObject(
        items=(slot,), iid=6, name="Send source", routes=(6400, 12800)
    )
    project = PublicObject(
        mixer=PublicObject(items=(insert,)),
        unknown_event_count=0,
    )
    monkeypatch.setattr(pyflp_adapter.pyflp, "parse", lambda _path: project)

    snapshot = pyflp_adapter.PyFlpParser().parse(source, source_hash="hash")

    assert snapshot.status.value == "partial"
    assert snapshot.mixer_inserts[0].id == "6"
    assert snapshot.mixer_inserts[0].slot_plugin_ids == ["mixer:6:slot:2"]
    assert snapshot.mixer_inserts[0].route_target_ids == []
    assert len(snapshot.diagnostics) == 1
    assert snapshot.diagnostics[0].code == "unsupported_structure"
    assert snapshot.diagnostics[0].target_type == "mixer"
    assert snapshot.diagnostics[0].target_id == "6"
    assert "send levels" in snapshot.diagnostics[0].message


def test_factory_data_token_remains_unresolved_dependency(
    tmp_path: Path, monkeypatch: Any
) -> None:
    from kumikoroom.studio.parsers import pyflp_adapter

    source = tmp_path / "factory-sample.flp"
    source.write_bytes(b"FLhd")
    factory_path = r"%fLsTuDiOfAcToRyDaTa%\Packs\Drums\Kick.wav"
    channel = PublicObject(iid=1, name="Factory kick", sample_path=factory_path)
    project = PublicObject(
        channels=PublicObject(items=(channel,), automations=()),
        mixer=PublicObject(items=()),
        unknown_event_count=0,
    )
    monkeypatch.setattr(pyflp_adapter.pyflp, "parse", lambda _path: project)

    snapshot = pyflp_adapter.PyFlpParser().parse(source, source_hash="hash")

    assert snapshot.status.value == "partial"
    assert snapshot.dependencies[0].path == factory_path
    assert snapshot.dependencies[0].kind == "sample"
    assert snapshot.dependencies[0].exists is False
    assert len(snapshot.diagnostics) == 1
    assert snapshot.diagnostics[0].code == "unresolved_dependency"
    assert snapshot.diagnostics[0].target_type == "dependency"
    assert snapshot.diagnostics[0].target_id == factory_path
    assert "factory data root" in snapshot.diagnostics[0].message.lower()


@pytest.mark.parametrize(
    "project", [PublicObject(), PublicObject(unknown_event_count=None)]
)
def test_missing_public_attributes_degrade_to_safe_defaults(
    tmp_path: Path, monkeypatch: Any, project: PublicObject
) -> None:
    from kumikoroom.studio.parsers import pyflp_adapter

    source = tmp_path / "sparse.flp"
    source.write_bytes(b"FLhd")
    monkeypatch.setattr(pyflp_adapter.pyflp, "parse", lambda _path: project)

    snapshot = pyflp_adapter.PyFlpParser().parse(
        source, source_hash="sparse-hash"
    )

    assert snapshot.status.value == "ready"
    assert snapshot.project.title is None
    assert snapshot.project.tempo is None
    assert snapshot.patterns == []
    assert snapshot.channels == []
    assert snapshot.playlist_clips == []
    assert snapshot.unknown_event_count == 0
    assert snapshot.diagnostics == []


class RaisingUnknownEventCountProject(PublicObject):
    @property
    def unknown_event_count(self) -> int:
        raise RuntimeError("unknown event inspection failed")


@pytest.mark.parametrize(
    "project",
    [
        RaisingUnknownEventCountProject(),
        PublicObject(unknown_event_count="invalid count"),
    ],
)
def test_unknown_event_count_failure_is_isolated(
    tmp_path: Path, monkeypatch: Any, project: PublicObject
) -> None:
    from kumikoroom.studio.parsers import pyflp_adapter

    source = tmp_path / "unknown-events.flp"
    source.write_bytes(b"FLhd")
    monkeypatch.setattr(pyflp_adapter.pyflp, "parse", lambda _path: project)

    snapshot = pyflp_adapter.PyFlpParser().parse(source, source_hash="hash")

    assert snapshot.status.value == "partial"
    assert snapshot.unknown_event_count == 0
    assert len(snapshot.diagnostics) == 1
    assert snapshot.diagnostics[0].code == "unsupported_structure"
    assert snapshot.diagnostics[0].target_type == "unknown_events"


class EmptyCollectionWithBrokenLength:
    def __iter__(self) -> Iterator[Any]:
        return iter(())

    def __len__(self) -> int:
        raise RuntimeError("NoModelsFound")


def test_empty_public_collections_ignore_broken_length_hint(
    tmp_path: Path, monkeypatch: Any
) -> None:
    from kumikoroom.studio.parsers import pyflp_adapter

    source = tmp_path / "empty-collections.flp"
    source.write_bytes(b"FLhd")
    empty = EmptyCollectionWithBrokenLength()
    project = PublicObject(
        patterns=empty,
        channels=PublicObject(items=(), automations=()),
        arrangements=PublicObject(items=()),
        mixer=empty,
        unknown_event_count=0,
    )
    monkeypatch.setattr(pyflp_adapter.pyflp, "parse", lambda _path: project)

    snapshot = pyflp_adapter.PyFlpParser().parse(source, source_hash="hash")

    assert snapshot.status.value == "ready"
    assert snapshot.patterns == []
    assert snapshot.mixer_inserts == []
    assert snapshot.plugins == []
    assert snapshot.dependencies == []
    assert snapshot.diagnostics == []


@pytest.mark.parametrize(
    ("class_name", "expected_type"),
    [
        ("Automation", "automation"),
        ("Layer", "layer"),
        ("Instrument", "instrument"),
        ("Sampler", "sampler"),
        ("Channel", "channel"),
    ],
)
def test_channel_type_uses_public_pyflp_concrete_types(
    class_name: str, expected_type: str
) -> None:
    from kumikoroom.studio.parsers import pyflp_adapter

    channel_class = getattr(pyflp_adapter.pyflp.channel, class_name)
    channel = object.__new__(channel_class)

    assert pyflp_adapter._channel_type(channel) == expected_type


@pytest.mark.parametrize("source_kind", ["missing", "directory"])
def test_parser_rejects_missing_and_non_regular_sources_before_pyflp(
    tmp_path: Path, monkeypatch: Any, source_kind: str
) -> None:
    from kumikoroom.studio.parsers import pyflp_adapter

    source = tmp_path / "source.flp"
    if source_kind == "directory":
        source.mkdir()
    parse_called = False

    def fail_if_called(_path: Path) -> PublicObject:
        nonlocal parse_called
        parse_called = True
        raise AssertionError("pyflp.parse must not receive an invalid source")

    monkeypatch.setattr(pyflp_adapter.pyflp, "parse", fail_if_called)

    with pytest.raises(FlpParseError) as raised:
        pyflp_adapter.PyFlpParser().parse(source, source_hash="hash")

    assert raised.value.path == source.resolve()
    assert raised.value.stage == "open"
    assert raised.value.cause is None
    assert parse_called is False


def test_pyflp_parse_failure_is_wrapped_with_its_cause(
    tmp_path: Path, monkeypatch: Any
) -> None:
    from kumikoroom.studio.parsers import pyflp_adapter

    source = tmp_path / "broken.flp"
    source.write_bytes(b"bad")
    cause = ValueError("invalid event stream")

    def fail_parse(_path: Path) -> PublicObject:
        raise cause

    monkeypatch.setattr(pyflp_adapter.pyflp, "parse", fail_parse)

    with pytest.raises(FlpParseError) as raised:
        pyflp_adapter.PyFlpParser().parse(source, source_hash="hash")

    assert raised.value.path == source.resolve()
    assert raised.value.stage == "open"
    assert raised.value.cause is cause
    assert raised.value.__cause__ is cause


class ExplodingIterable:
    def __init__(self, exception_type: type[Exception]) -> None:
        self.exception_type = exception_type

    def __iter__(self) -> Iterator[Any]:
        raise self.exception_type("unsupported pattern notes")


@pytest.mark.parametrize("exception_type", [ValueError, TypeError])
def test_child_mapping_failure_returns_partial_and_preserves_other_sections(
    tmp_path: Path, monkeypatch: Any, exception_type: type[Exception]
) -> None:
    from kumikoroom.studio.parsers import pyflp_adapter

    source = tmp_path / "partial.flp"
    source.write_bytes(b"FLhd")
    bad_pattern = PublicObject(
        iid=9,
        name="Unreadable",
        notes=ExplodingIterable(exception_type),
    )
    good_channel = PublicObject(iid=3, name="Still here")
    project = PublicObject(
        title="Partial project",
        patterns=(bad_pattern,),
        channels=PublicObject(items=(good_channel,), automations=()),
        arrangements=PublicObject(items=()),
        mixer=PublicObject(items=()),
        unknown_event_count=0,
    )
    monkeypatch.setattr(pyflp_adapter.pyflp, "parse", lambda _path: project)

    snapshot = pyflp_adapter.PyFlpParser().parse(source, source_hash="hash")

    assert snapshot.status.value == "partial"
    assert snapshot.project.title == "Partial project"
    assert snapshot.patterns == []
    assert snapshot.channels[0].id == "3"
    assert snapshot.channels[0].name == "Still here"
    assert len(snapshot.diagnostics) == 1
    assert snapshot.diagnostics[0].code == "unsupported_structure"
    assert snapshot.diagnostics[0].severity == "warning"
    assert snapshot.diagnostics[0].target_type == "patterns"

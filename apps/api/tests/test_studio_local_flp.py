from __future__ import annotations

import os
from pathlib import Path

import pytest

from kumikoroom.studio.parsers import FlpParseError, PyFlpParser
from kumikoroom.studio.scanner import sha256_file


ENV_NAME = "KUMIKOROOM_TEST_FLP_PATH"


def _configured_flp_path() -> Path:
    raw_path = os.environ.get(ENV_NAME)
    if not raw_path:
        pytest.skip(f"{ENV_NAME} is not configured")

    path = Path(raw_path).expanduser()
    if not path.exists():
        pytest.fail(f"{ENV_NAME} does not exist: {path}")
    if not path.is_file():
        pytest.fail(f"{ENV_NAME} must point to a regular file: {path}")
    if path.suffix.casefold() != ".flp":
        pytest.fail(f"{ENV_NAME} must point to an .flp file: {path}")
    return path.resolve(strict=True)


def test_real_flp_is_read_only_and_has_core_structure() -> None:
    path = _configured_flp_path()
    before = sha256_file(path)

    try:
        snapshot = PyFlpParser().parse(path, source_hash=before)
    except FlpParseError as error:
        pytest.fail(
            f"Configured FLP could not be parsed during {error.stage}: {error}"
        )
    finally:
        after = sha256_file(path)

    assert after == before, "The parser changed the source FLP"
    assert snapshot.source_hash == before
    assert snapshot.project.fl_version, "FL Studio save version was not parsed"
    assert snapshot.project.tempo is not None, "Project tempo was not parsed"
    assert snapshot.project.tempo > 0
    assert snapshot.patterns, "No Pattern structure was parsed"
    assert snapshot.channels, "No Channel Rack structure was parsed"

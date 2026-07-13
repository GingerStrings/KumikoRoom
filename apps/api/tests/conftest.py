from collections.abc import Generator
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from kumikoroom.main import app


@pytest.fixture(autouse=True)
def isolate_api_settings(
    monkeypatch: pytest.MonkeyPatch,
    tmp_path: Path,
) -> None:
    for env_name in (
        "KUMIKOROOM_LLM_PROVIDER",
        "DEEPSEEK_API_KEY",
        "DEEPSEEK_MODEL",
        "DEEPSEEK_BASE_URL",
        "KUMIKOROOM_NOVEL_CORPUS_DIR",
        "KUMIKOROOM_NOVEL_RAG_DB_PATH",
        "KUMIKOROOM_NOVEL_RAG_ENABLED",
        "KUMIKOROOM_STUDIO_DB_PATH",
    ):
        monkeypatch.delenv(env_name, raising=False)

    monkeypatch.setenv(
        "KUMIKOROOM_MEMORY_DB_PATH",
        str(tmp_path / "memory.sqlite3"),
    )
    monkeypatch.setenv(
        "KUMIKOROOM_NOVEL_CORPUS_DIR",
        str(tmp_path / "jc"),
    )
    monkeypatch.setenv(
        "KUMIKOROOM_NOVEL_RAG_DB_PATH",
        str(tmp_path / "rag.sqlite3"),
    )
    monkeypatch.setenv(
        "KUMIKOROOM_STUDIO_DB_PATH",
        str(tmp_path / "studio.sqlite3"),
    )


@pytest.fixture
def client() -> Generator[TestClient, None, None]:
    with TestClient(app) as test_client:
        yield test_client

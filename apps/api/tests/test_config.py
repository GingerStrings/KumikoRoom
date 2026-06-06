from pathlib import Path

from kumikoroom.config import load_settings


def test_defaults_to_mock_provider_without_deepseek_key() -> None:
    settings = load_settings()

    assert settings.llm_provider == "mock"
    assert settings.deepseek_model == "deepseek-v4-flash"
    assert settings.deepseek_base_url == "https://api.deepseek.com"


def test_infers_deepseek_provider_when_key_is_present(
    monkeypatch,
) -> None:
    monkeypatch.setenv("DEEPSEEK_API_KEY", "test-deepseek-key")

    settings = load_settings()

    assert settings.llm_provider == "deepseek"
    assert settings.is_deepseek_configured is True


def test_explicit_deepseek_provider_without_key_is_unconfigured(
    monkeypatch,
) -> None:
    monkeypatch.setenv("KUMIKOROOM_LLM_PROVIDER", "deepseek")
    monkeypatch.delenv("DEEPSEEK_API_KEY", raising=False)

    settings = load_settings()

    assert settings.llm_provider == "deepseek"
    assert settings.is_deepseek_configured is False


def test_memory_db_path_can_be_overridden(monkeypatch, tmp_path: Path) -> None:
    memory_path = tmp_path / "custom-memory.sqlite3"
    monkeypatch.setenv("KUMIKOROOM_MEMORY_DB_PATH", str(memory_path))

    settings = load_settings()

    assert settings.memory_db_path == memory_path
    assert isinstance(settings.memory_db_path, Path)

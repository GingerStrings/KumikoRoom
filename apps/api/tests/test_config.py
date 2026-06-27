from dataclasses import dataclass
from pathlib import Path

import pytest

from kumikoroom.config import (
    LlmRuntimeConfig,
    load_settings,
    runtime_config_from_llm_config,
    runtime_config_from_settings,
)


def _llm_config(provider: str, base_url=None, api_key=None, model=None):
    @dataclass
    class _Cfg:
        provider: str
        base_url: str | None
        api_key: str | None
        model: str | None

    return _Cfg(provider=provider, base_url=base_url, api_key=api_key, model=model)


def test_defaults_to_mock_provider_without_deepseek_key(monkeypatch) -> None:
    monkeypatch.delenv("KUMIKOROOM_MEMORY_DB_PATH", raising=False)

    settings = load_settings()

    assert settings.llm_provider == "mock"
    assert settings.deepseek_api_key is None
    assert settings.deepseek_model == "deepseek-v4-flash"
    assert settings.deepseek_base_url == "https://api.deepseek.com"
    assert settings.memory_db_path == Path("user-data/memory/kumikoroom-memory.sqlite3")


def test_infers_deepseek_provider_when_key_is_present(
    monkeypatch,
) -> None:
    monkeypatch.setenv("DEEPSEEK_API_KEY", "test-key")

    settings = load_settings()

    assert settings.llm_provider == "deepseek"
    assert settings.deepseek_api_key == "test-key"
    assert settings.is_deepseek_configured is True


def test_explicit_deepseek_provider_without_key_is_unconfigured(
    monkeypatch,
) -> None:
    monkeypatch.setenv("KUMIKOROOM_LLM_PROVIDER", "deepseek")
    monkeypatch.delenv("DEEPSEEK_API_KEY", raising=False)

    settings = load_settings()

    assert settings.llm_provider == "deepseek"
    assert settings.is_deepseek_configured is False


def test_invalid_explicit_provider_raises_value_error(monkeypatch) -> None:
    monkeypatch.setenv("KUMIKOROOM_LLM_PROVIDER", " OpenAI ")

    with pytest.raises(ValueError, match="KUMIKOROOM_LLM_PROVIDER"):
        load_settings()


def test_blank_explicit_provider_raises_value_error(monkeypatch) -> None:
    monkeypatch.setenv("KUMIKOROOM_LLM_PROVIDER", "   ")
    monkeypatch.setenv("DEEPSEEK_API_KEY", "test-key")

    with pytest.raises(ValueError, match="KUMIKOROOM_LLM_PROVIDER"):
        load_settings()


def test_explicit_mock_provider_overrides_deepseek_key(monkeypatch) -> None:
    monkeypatch.setenv("KUMIKOROOM_LLM_PROVIDER", " MoCk ")
    monkeypatch.setenv("DEEPSEEK_API_KEY", "test-key")

    settings = load_settings()

    assert settings.llm_provider == "mock"
    assert settings.deepseek_api_key == "test-key"


def test_deepseek_base_url_override_strips_trailing_slash(monkeypatch) -> None:
    monkeypatch.setenv("DEEPSEEK_BASE_URL", "https://api.deepseek.com/")

    settings = load_settings()

    assert settings.deepseek_base_url == "https://api.deepseek.com"


def test_memory_db_path_can_be_overridden(monkeypatch, tmp_path: Path) -> None:
    memory_path = tmp_path / "custom-memory.sqlite3"
    monkeypatch.setenv("KUMIKOROOM_MEMORY_DB_PATH", str(memory_path))

    settings = load_settings()

    assert settings.memory_db_path == memory_path
    assert isinstance(settings.memory_db_path, Path)


def test_runtime_config_from_settings_uses_deepseek_defaults(monkeypatch) -> None:
    monkeypatch.setenv("DEEPSEEK_API_KEY", "env-key")
    monkeypatch.setenv("DEEPSEEK_MODEL", "env-model")
    monkeypatch.setenv("DEEPSEEK_BASE_URL", "https://env.example.com/")

    settings = load_settings()

    runtime = runtime_config_from_settings(settings)

    assert isinstance(runtime, LlmRuntimeConfig)
    assert runtime.provider == "deepseek"
    assert runtime.api_key == "env-key"
    assert runtime.model == "env-model"
    assert runtime.base_url == "https://env.example.com"


def test_runtime_config_from_llm_config_openai_compatible_overrides_env(
    monkeypatch,
) -> None:
    monkeypatch.setenv("DEEPSEEK_API_KEY", "env-key")
    settings = load_settings()

    llm_config = _llm_config(
        provider="openai_compatible",
        base_url="https://api.openai.com/v1/",
        api_key="user-key",
        model="gpt-4o-mini",
    )

    runtime = runtime_config_from_llm_config(settings, llm_config)

    assert runtime.provider == "openai_compatible"
    assert runtime.base_url == "https://api.openai.com/v1"
    assert runtime.api_key == "user-key"
    assert runtime.model == "gpt-4o-mini"


def test_runtime_config_from_llm_config_openai_compatible_does_not_borrow_env_credentials(
    monkeypatch,
) -> None:
    """openai_compatible must NEVER fall back to DEEPSEEK_* env values.

    Borrowing DEEPSEEK_API_KEY for an arbitrary endpoint would forward
    credentials to a third-party URL the user did not authorize.
    """
    monkeypatch.setenv("DEEPSEEK_API_KEY", "deepseek-secret")
    monkeypatch.setenv("DEEPSEEK_BASE_URL", "https://api.deepseek.com")
    monkeypatch.setenv("DEEPSEEK_MODEL", "deepseek-v4-flash")
    settings = load_settings()

    llm_config = _llm_config(
        provider="openai_compatible",
        base_url="http://localhost:11434/v1",
        api_key=None,
        model="qwen2.5:7b",
    )

    runtime = runtime_config_from_llm_config(settings, llm_config)

    assert runtime.provider == "openai_compatible"
    assert runtime.base_url == "http://localhost:11434/v1"
    assert runtime.api_key is None
    assert runtime.model == "qwen2.5:7b"


def test_runtime_config_from_llm_config_openai_compatible_uses_only_explicit_fields(
    monkeypatch,
) -> None:
    monkeypatch.setenv("DEEPSEEK_API_KEY", "deepseek-secret")
    monkeypatch.setenv("DEEPSEEK_BASE_URL", "https://api.deepseek.com")
    monkeypatch.setenv("DEEPSEEK_MODEL", "deepseek-v4-flash")
    settings = load_settings()

    llm_config = _llm_config(
        provider="openai_compatible",
        base_url="https://api.openai.com/v1",
        api_key="sk-explicit",
        model="gpt-4o-mini",
    )

    runtime = runtime_config_from_llm_config(settings, llm_config)

    assert runtime.provider == "openai_compatible"
    assert runtime.base_url == "https://api.openai.com/v1"
    assert runtime.api_key == "sk-explicit"
    assert runtime.model == "gpt-4o-mini"


def test_runtime_config_from_llm_config_deepseek_uses_defaults_when_missing(
    monkeypatch,
) -> None:
    monkeypatch.delenv("DEEPSEEK_BASE_URL", raising=False)
    monkeypatch.delenv("DEEPSEEK_MODEL", raising=False)
    settings = load_settings()

    llm_config = _llm_config(provider="deepseek", api_key="user-key")

    runtime = runtime_config_from_llm_config(settings, llm_config)

    assert runtime.provider == "deepseek"
    assert runtime.base_url == "https://api.deepseek.com"
    assert runtime.model == "deepseek-v4-flash"
    assert runtime.api_key == "user-key"


def test_runtime_config_from_llm_config_mock_ignores_other_fields() -> None:
    settings = load_settings()

    llm_config = _llm_config(
        provider="mock",
        base_url="https://should-be-ignored.example.com",
        api_key="should-be-ignored",
        model="should-be-ignored",
    )

    runtime = runtime_config_from_llm_config(settings, llm_config)

    assert runtime.provider == "mock"
    assert runtime.base_url == ""
    assert runtime.api_key is None
    assert runtime.model == "mock"


def test_runtime_config_strips_trailing_slash_in_base_url(monkeypatch) -> None:
    monkeypatch.setenv("DEEPSEEK_API_KEY", "env-key")
    settings = load_settings()

    llm_config = _llm_config(
        provider="openai_compatible",
        base_url="https://api.siliconflow.cn/v1//",
        api_key="user-key",
        model="Qwen/Qwen2.5-7B-Instruct",
    )

    runtime = runtime_config_from_llm_config(settings, llm_config)

    assert runtime.base_url == "https://api.siliconflow.cn/v1"


def test_novel_rag_defaults_to_local_paths(monkeypatch) -> None:
    monkeypatch.delenv("KUMIKOROOM_NOVEL_CORPUS_DIR", raising=False)
    monkeypatch.delenv("KUMIKOROOM_NOVEL_RAG_DB_PATH", raising=False)
    monkeypatch.delenv("KUMIKOROOM_NOVEL_RAG_ENABLED", raising=False)

    settings = load_settings()

    assert settings.novel_corpus_dir == Path(r"D:\555\codex\jc")
    assert settings.novel_rag_db_path == Path("user-data/rag/kumiko-novels.sqlite3")
    assert settings.novel_rag_enabled is True


def test_novel_rag_paths_can_be_overridden(monkeypatch, tmp_path: Path) -> None:
    corpus_dir = tmp_path / "jc"
    rag_path = tmp_path / "rag.sqlite3"
    monkeypatch.setenv("KUMIKOROOM_NOVEL_CORPUS_DIR", str(corpus_dir))
    monkeypatch.setenv("KUMIKOROOM_NOVEL_RAG_DB_PATH", str(rag_path))

    settings = load_settings()

    assert settings.novel_corpus_dir == corpus_dir
    assert settings.novel_rag_db_path == rag_path


@pytest.mark.parametrize(
    ("raw_value", "expected"),
    [
        ("1", True),
        ("true", True),
        ("yes", True),
        ("on", True),
        ("0", False),
        ("false", False),
        ("no", False),
        ("off", False),
    ],
)
def test_novel_rag_enabled_parses_boolean_values(
    monkeypatch,
    raw_value: str,
    expected: bool,
) -> None:
    monkeypatch.setenv("KUMIKOROOM_NOVEL_RAG_ENABLED", raw_value)

    settings = load_settings()

    assert settings.novel_rag_enabled is expected


def test_invalid_novel_rag_enabled_raises_value_error(monkeypatch) -> None:
    monkeypatch.setenv("KUMIKOROOM_NOVEL_RAG_ENABLED", "maybe")

    with pytest.raises(ValueError, match="KUMIKOROOM_NOVEL_RAG_ENABLED"):
        load_settings()

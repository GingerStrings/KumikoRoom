from dataclasses import dataclass
import os
from pathlib import Path
from typing import Literal


LlmProvider = Literal["mock", "deepseek", "openai_compatible"]

DEFAULT_DEEPSEEK_MODEL = "deepseek-v4-flash"
DEFAULT_DEEPSEEK_BASE_URL = "https://api.deepseek.com"
DEFAULT_MEMORY_DB_PATH = Path("user-data/memory/kumikoroom-memory.sqlite3")


@dataclass(frozen=True)
class ApiSettings:
    llm_provider: LlmProvider
    deepseek_api_key: str | None
    deepseek_model: str
    deepseek_base_url: str
    memory_db_path: Path

    @property
    def is_deepseek_configured(self) -> bool:
        return bool(self.deepseek_api_key)


@dataclass(frozen=True)
class LlmRuntimeConfig:
    provider: LlmProvider
    base_url: str
    api_key: str | None
    model: str


def load_settings() -> ApiSettings:
    deepseek_api_key = _env_value("DEEPSEEK_API_KEY")
    llm_provider = _resolve_llm_provider(
        provider_value=_explicit_env_value("KUMIKOROOM_LLM_PROVIDER"),
        deepseek_api_key=deepseek_api_key,
    )

    return ApiSettings(
        llm_provider=llm_provider,
        deepseek_api_key=deepseek_api_key,
        deepseek_model=_env_value("DEEPSEEK_MODEL") or DEFAULT_DEEPSEEK_MODEL,
        deepseek_base_url=_deepseek_base_url(),
        memory_db_path=Path(
            _env_value("KUMIKOROOM_MEMORY_DB_PATH") or DEFAULT_MEMORY_DB_PATH
        ),
    )


def runtime_config_from_settings(settings: ApiSettings) -> LlmRuntimeConfig:
    return LlmRuntimeConfig(
        provider=settings.llm_provider,
        base_url=settings.deepseek_base_url,
        api_key=settings.deepseek_api_key,
        model=settings.deepseek_model,
    )


def runtime_config_from_llm_config(
    settings: ApiSettings,
    llm_config,
) -> LlmRuntimeConfig:
    provider = llm_config.provider

    if provider == "mock":
        return LlmRuntimeConfig(
            provider="mock",
            base_url="",
            api_key=None,
            model="mock",
        )

    if provider == "openai_compatible":
        base_url = _coalesce(llm_config.base_url)
        api_key = _coalesce(llm_config.api_key) or None
        model = _coalesce(llm_config.model)
        return LlmRuntimeConfig(
            provider="openai_compatible",
            base_url=base_url.rstrip("/"),
            api_key=api_key,
            model=model,
        )

    base_url = _coalesce(llm_config.base_url, settings.deepseek_base_url)
    api_key = _coalesce(llm_config.api_key, settings.deepseek_api_key)
    model = _coalesce(llm_config.model, settings.deepseek_model)

    base_url = base_url or DEFAULT_DEEPSEEK_BASE_URL
    model = model or DEFAULT_DEEPSEEK_MODEL

    return LlmRuntimeConfig(
        provider="deepseek",
        base_url=base_url.rstrip("/"),
        api_key=api_key or None,
        model=model,
    )


def _coalesce(*values: str | None) -> str:
    for value in values:
        if value is not None and value.strip():
            return value.strip()
    return ""


def _env_value(name: str) -> str | None:
    value = os.environ.get(name)
    if value is None:
        return None

    stripped = value.strip()
    return stripped or None


def _explicit_env_value(name: str) -> str | None:
    if name not in os.environ:
        return None

    return os.environ[name]


def _deepseek_base_url() -> str:
    return (_env_value("DEEPSEEK_BASE_URL") or DEFAULT_DEEPSEEK_BASE_URL).rstrip("/")


def _resolve_llm_provider(
    provider_value: str | None,
    deepseek_api_key: str | None,
) -> LlmProvider:
    if provider_value is not None:
        normalized_provider = provider_value.strip().lower()
        if normalized_provider in ("mock", "deepseek"):
            return normalized_provider
        raise ValueError(
            "KUMIKOROOM_LLM_PROVIDER must be either 'mock' or 'deepseek'"
        )

    if deepseek_api_key:
        return "deepseek"

    return "mock"

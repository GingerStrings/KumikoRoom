from dataclasses import dataclass
import os
from pathlib import Path
from typing import Literal


LlmProvider = Literal["mock", "deepseek"]

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


def load_settings() -> ApiSettings:
    deepseek_api_key = _env_value("DEEPSEEK_API_KEY")
    llm_provider = _resolve_llm_provider(
        provider_value=_env_value("KUMIKOROOM_LLM_PROVIDER"),
        deepseek_api_key=deepseek_api_key,
    )

    return ApiSettings(
        llm_provider=llm_provider,
        deepseek_api_key=deepseek_api_key,
        deepseek_model=_env_value("DEEPSEEK_MODEL") or DEFAULT_DEEPSEEK_MODEL,
        deepseek_base_url=_env_value("DEEPSEEK_BASE_URL") or DEFAULT_DEEPSEEK_BASE_URL,
        memory_db_path=Path(
            _env_value("KUMIKOROOM_MEMORY_DB_PATH") or DEFAULT_MEMORY_DB_PATH
        ),
    )


def _env_value(name: str) -> str | None:
    value = os.environ.get(name)
    if value is None:
        return None

    stripped = value.strip()
    return stripped or None


def _resolve_llm_provider(
    provider_value: str | None,
    deepseek_api_key: str | None,
) -> LlmProvider:
    if provider_value is not None:
        normalized_provider = provider_value.lower()
        if normalized_provider in ("mock", "deepseek"):
            return normalized_provider

    if deepseek_api_key:
        return "deepseek"

    return "mock"

from __future__ import annotations

from dataclasses import dataclass
from typing import Literal, Protocol, TypedDict

import httpx

from kumikoroom.config import ApiSettings


class LLMMessage(TypedDict):
    role: Literal["system", "user", "assistant"]
    content: str


@dataclass(frozen=True)
class ProviderStatus:
    provider: Literal["mock", "deepseek"]
    model: str | None
    configured: bool
    label: str


@dataclass(frozen=True)
class LLMResult:
    content: str
    provider_status: ProviderStatus


class LLMProvider(Protocol):
    def generate(self, messages: list[LLMMessage]) -> LLMResult:
        ...


class ProviderUnavailable(RuntimeError):
    pass


class MockLLMProvider:
    def generate(self, messages: list[LLMMessage]) -> LLMResult:
        user_message = _last_user_message(messages) or "今天的音乐"
        return LLMResult(
            content=(
                f"嗯，我听到了。你说的是「{user_message}」。"
                "先把这句放进今天的音乐里也不错。"
            ),
            provider_status=ProviderStatus(
                provider="mock",
                model=None,
                configured=True,
                label="本地 Mock API",
            ),
        )


class DeepSeekLLMProvider:
    def __init__(
        self,
        settings: ApiSettings,
        transport: httpx.BaseTransport | None = None,
    ) -> None:
        self.settings = settings
        self.transport = transport

    def generate(self, messages: list[LLMMessage]) -> LLMResult:
        api_key = self.settings.deepseek_api_key
        if not api_key or not api_key.strip():
            raise ProviderUnavailable("DEEPSEEK_API_KEY is not configured")

        api_key = api_key.strip()
        try:
            with httpx.Client(timeout=45.0, transport=self.transport) as client:
                response = client.post(
                    f"{self.settings.deepseek_base_url.rstrip('/')}/chat/completions",
                    headers={
                        "Authorization": f"Bearer {api_key}",
                        "Content-Type": "application/json",
                    },
                    json={
                        "model": self.settings.deepseek_model,
                        "messages": messages,
                        "temperature": 0.8,
                    },
                )
                response.raise_for_status()
        except httpx.HTTPError as exc:
            raise ProviderUnavailable("DeepSeek request failed") from exc

        try:
            content = response.json()["choices"][0]["message"]["content"]
            if not isinstance(content, str):
                raise TypeError("DeepSeek message content must be a string")
            content = content.strip()
        except (ValueError, KeyError, IndexError, TypeError) as exc:
            raise ProviderUnavailable(
                "DeepSeek response was malformed"
            ) from exc

        return LLMResult(
            content=content,
            provider_status=ProviderStatus(
                provider="deepseek",
                model=self.settings.deepseek_model,
                configured=True,
                label=f"DeepSeek {self.settings.deepseek_model}",
            ),
        )


def build_provider(settings: ApiSettings) -> LLMProvider:
    if settings.llm_provider == "deepseek":
        return DeepSeekLLMProvider(settings)

    return MockLLMProvider()


def unconfigured_deepseek_status(settings: ApiSettings) -> ProviderStatus:
    return ProviderStatus(
        provider="deepseek",
        model=settings.deepseek_model,
        configured=False,
        label="DeepSeek 未配置",
    )


def _last_user_message(messages: list[LLMMessage]) -> str | None:
    for message in reversed(messages):
        if message["role"] == "user" and message["content"].strip():
            return message["content"]

    return None

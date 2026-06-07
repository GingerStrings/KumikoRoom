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
        if not self.settings.deepseek_api_key:
            raise ProviderUnavailable("DEEPSEEK_API_KEY is not configured")

        with httpx.Client(timeout=45.0, transport=self.transport) as client:
            response = client.post(
                f"{self.settings.deepseek_base_url.rstrip('/')}/chat/completions",
                headers={
                    "Authorization": f"Bearer {self.settings.deepseek_api_key}",
                    "Content-Type": "application/json",
                },
                json={
                    "model": self.settings.deepseek_model,
                    "messages": messages,
                    "temperature": 0.8,
                },
            )
            response.raise_for_status()

        return LLMResult(
            content=response.json()["choices"][0]["message"]["content"].strip(),
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

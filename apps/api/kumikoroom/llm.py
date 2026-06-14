from __future__ import annotations

import json
from dataclasses import dataclass, field
from typing import Any, Literal, NotRequired, Protocol, TypedDict

import httpx

from kumikoroom.config import ApiSettings


class LLMMessage(TypedDict, total=False):
    role: Literal["system", "user", "assistant", "tool"]
    content: str | None
    tool_call_id: NotRequired[str]
    name: NotRequired[str]
    tool_calls: NotRequired[list[dict[str, Any]]]


@dataclass(frozen=True)
class ProviderStatus:
    provider: Literal["mock", "deepseek"]
    model: str | None
    configured: bool
    label: str


@dataclass(frozen=True)
class LLMToolCall:
    id: str
    name: str
    arguments: dict[str, Any]


@dataclass(frozen=True)
class LLMResult:
    content: str
    provider_status: ProviderStatus
    tool_calls: list[LLMToolCall] = field(default_factory=list)


class LLMProvider(Protocol):
    def generate(
        self,
        messages: list[LLMMessage],
        tools: list[dict[str, Any]] | None = None,
        tool_choice: str | None = None,
    ) -> LLMResult:
        ...


class ProviderUnavailable(RuntimeError):
    pass


class MockLLMProvider:
    def generate(
        self,
        messages: list[LLMMessage],
        tools: list[dict[str, Any]] | None = None,
        tool_choice: str | None = None,
    ) -> LLMResult:
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

    def generate(
        self,
        messages: list[LLMMessage],
        tools: list[dict[str, Any]] | None = None,
        tool_choice: str | None = None,
    ) -> LLMResult:
        api_key = self.settings.deepseek_api_key
        if not api_key or not api_key.strip():
            raise ProviderUnavailable("DEEPSEEK_API_KEY is not configured")

        api_key = api_key.strip()
        request_body: dict[str, Any] = {
            "model": self.settings.deepseek_model,
            "messages": messages,
            "temperature": 0.8,
        }
        if tools is not None:
            request_body["tools"] = tools
        if tool_choice is not None:
            request_body["tool_choice"] = tool_choice

        try:
            with httpx.Client(timeout=45.0, transport=self.transport) as client:
                response = client.post(
                    f"{self.settings.deepseek_base_url.rstrip('/')}/chat/completions",
                    headers={
                        "Authorization": f"Bearer {api_key}",
                        "Content-Type": "application/json",
                    },
                    json=request_body,
                )
                response.raise_for_status()
        except httpx.HTTPError as exc:
            raise ProviderUnavailable("DeepSeek request failed") from exc

        try:
            message = response.json()["choices"][0]["message"]
            tool_calls = parse_tool_calls(message.get("tool_calls", []))
            if "content" not in message and not tool_calls:
                raise KeyError("content")
            content_value = message.get("content", "")
            if content_value is None:
                content_value = ""
            if not isinstance(content_value, str):
                raise TypeError("DeepSeek message content must be a string")
            content = content_value.strip()
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
            tool_calls=tool_calls,
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


def parse_tool_calls(raw_tool_calls: Any) -> list[LLMToolCall]:
    if raw_tool_calls in (None, []):
        return []
    if not isinstance(raw_tool_calls, list):
        raise TypeError("DeepSeek tool_calls must be a list")

    tool_calls: list[LLMToolCall] = []
    for raw_call in raw_tool_calls:
        if not isinstance(raw_call, dict):
            raise TypeError("DeepSeek tool call must be an object")
        function = raw_call.get("function")
        if not isinstance(function, dict):
            raise TypeError("DeepSeek tool call function must be an object")
        call_id = raw_call.get("id")
        name = function.get("name")
        raw_arguments = function.get("arguments", "{}")
        if not isinstance(call_id, str) or not call_id:
            raise TypeError("DeepSeek tool call id must be a string")
        if not isinstance(name, str) or not name:
            raise TypeError("DeepSeek tool call name must be a string")
        if not isinstance(raw_arguments, str):
            raise TypeError("DeepSeek tool call arguments must be a JSON string")
        arguments = json.loads(raw_arguments or "{}")
        if not isinstance(arguments, dict):
            raise TypeError("DeepSeek tool call arguments must decode to an object")
        tool_calls.append(LLMToolCall(id=call_id, name=name, arguments=arguments))

    return tool_calls

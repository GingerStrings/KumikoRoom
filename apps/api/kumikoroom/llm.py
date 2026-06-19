from __future__ import annotations

import json
import time
from dataclasses import dataclass, field
from typing import Any, Literal, NotRequired, Protocol, TypedDict

import httpx

from kumikoroom.config import (
    ApiSettings,
    LlmProvider,
    LlmRuntimeConfig,
    runtime_config_from_llm_config,
    runtime_config_from_settings,
)


class LLMMessage(TypedDict, total=False):
    role: Literal["system", "user", "assistant", "tool"]
    content: str | None
    tool_call_id: NotRequired[str]
    name: NotRequired[str]
    tool_calls: NotRequired[list[dict[str, Any]]]


@dataclass(frozen=True)
class ProviderStatus:
    provider: LlmProvider
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


@dataclass(frozen=True)
class LLMTestResult:
    ok: bool
    error: str | None
    model: str | None
    latency_ms: int | None


class LLMProvider(Protocol):
    def generate(
        self,
        messages: list[LLMMessage],
        tools: list[dict[str, Any]] | None = None,
        tool_choice: str | None = None,
        timeout: float | None = None,
    ) -> LLMResult:
        ...


class ProviderUnavailable(RuntimeError):
    pass


def _provider_label(provider: LlmProvider, model: str) -> str:
    if provider == "openai_compatible":
        return f"OpenAI 兼容 {model}"
    if provider == "deepseek":
        return f"DeepSeek {model}"
    return "本地 Mock API"


class MockLLMProvider:
    def __init__(self, runtime_config: LlmRuntimeConfig | None = None) -> None:
        self.runtime_config = runtime_config or LlmRuntimeConfig(
            provider="mock",
            base_url="",
            api_key=None,
            model="mock",
        )

    def generate(
        self,
        messages: list[LLMMessage],
        tools: list[dict[str, Any]] | None = None,
        tool_choice: str | None = None,
        timeout: float | None = None,
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
    """OpenAI-compatible chat completions client.

    Historically named after DeepSeek; now serves any OpenAI-compatible
    endpoint (OpenAI, Moonshot, SiliconFlow, Volcengine Ark, local Ollama,
    etc.) via runtime config.
    """

    def __init__(
        self,
        runtime_config: LlmRuntimeConfig | None = None,
        transport: httpx.BaseTransport | None = None,
        *,
        settings: ApiSettings | None = None,
    ) -> None:
        if runtime_config is None and settings is None:
            raise ValueError(
                "DeepSeekLLMProvider requires either runtime_config or settings"
            )
        if runtime_config is None:
            runtime_config = runtime_config_from_settings(settings)  # type: ignore[arg-type]
        self.runtime_config = runtime_config
        self.transport = transport

    def generate(
        self,
        messages: list[LLMMessage],
        tools: list[dict[str, Any]] | None = None,
        tool_choice: str | None = None,
        timeout: float | None = None,
    ) -> LLMResult:
        runtime = self.runtime_config
        api_key = runtime.api_key
        has_key = bool(api_key and api_key.strip())

        if runtime.provider != "openai_compatible" and not has_key:
            raise ProviderUnavailable("DEEPSEEK_API_KEY is not configured")

        request_body: dict[str, Any] = {
            "model": runtime.model,
            "messages": messages,
            "temperature": 0.8,
        }
        if tools is not None:
            request_body["tools"] = tools
        if tool_choice is not None:
            request_body["tool_choice"] = tool_choice

        headers: dict[str, str] = {"Content-Type": "application/json"}
        if has_key:
            headers["Authorization"] = f"Bearer {api_key.strip()}"

        try:
            with httpx.Client(
                timeout=45.0 if timeout is None else timeout,
                transport=self.transport,
                trust_env=False,
            ) as client:
                response = client.post(
                    f"{runtime.base_url.rstrip('/')}/chat/completions",
                    headers=headers,
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
                provider=runtime.provider,
                model=runtime.model,
                configured=True,
                label=_provider_label(runtime.provider, runtime.model),
            ),
            tool_calls=tool_calls,
        )


def build_provider(
    settings: ApiSettings | None = None,
    runtime_config: LlmRuntimeConfig | None = None,
    transport: httpx.BaseTransport | None = None,
) -> LLMProvider:
    if runtime_config is None:
        if settings is None:
            raise ValueError("build_provider requires either settings or runtime_config")
        runtime_config = runtime_config_from_settings(settings)

    if runtime_config.provider == "mock":
        return MockLLMProvider(runtime_config)

    return DeepSeekLLMProvider(runtime_config=runtime_config, transport=transport)


def unconfigured_deepseek_status(settings: ApiSettings) -> ProviderStatus:
    return ProviderStatus(
        provider=settings.llm_provider,
        model=settings.deepseek_model,
        configured=False,
        label="DeepSeek 未配置",
    )


def unconfigured_runtime_status(runtime_config: LlmRuntimeConfig) -> ProviderStatus:
    return ProviderStatus(
        provider=runtime_config.provider,
        model=runtime_config.model,
        configured=False,
        label=_provider_label(runtime_config.provider, runtime_config.model),
    )


def test_llm_connection(
    runtime_config: LlmRuntimeConfig,
    transport: httpx.BaseTransport | None = None,
) -> LLMTestResult:
    if runtime_config.provider == "mock":
        return LLMTestResult(ok=True, error=None, model=None, latency_ms=0)

    base_url = runtime_config.base_url.rstrip("/")
    request_body: dict[str, Any] = {
        "model": runtime_config.model,
        "messages": [{"role": "user", "content": "ping"}],
        "max_tokens": 1,
    }
    headers: dict[str, str] = {"Content-Type": "application/json"}
    if runtime_config.api_key:
        headers["Authorization"] = f"Bearer {runtime_config.api_key.strip()}"

    started = time.perf_counter()
    try:
        with httpx.Client(
            timeout=10.0,
            transport=transport,
            trust_env=False,
        ) as client:
            response = client.post(
                f"{base_url}/chat/completions",
                headers=headers,
                json=request_body,
            )
            response.raise_for_status()
    except httpx.HTTPStatusError as exc:
        latency_ms = int((time.perf_counter() - started) * 1000)
        status_code = exc.response.status_code if exc.response is not None else None
        return LLMTestResult(
            ok=False,
            error=f"HTTP {status_code}" if status_code is not None else "HTTP error",
            model=runtime_config.model,
            latency_ms=latency_ms,
        )
    except httpx.HTTPError as exc:
        latency_ms = int((time.perf_counter() - started) * 1000)
        reason = _scrub_error_message(str(exc))
        return LLMTestResult(
            ok=False,
            error=reason,
            model=runtime_config.model,
            latency_ms=latency_ms,
        )

    latency_ms = int((time.perf_counter() - started) * 1000)
    return LLMTestResult(
        ok=True,
        error=None,
        model=runtime_config.model,
        latency_ms=latency_ms,
    )


SSL_PROTOCOL_ERROR_MESSAGE = "连接失败，请检查 Base URL 的协议（http/https）和地址是否正确。"


def _scrub_error_message(message: str) -> str:
    normalized_message = message.lower()
    if (
        "unexpected_eof_while_reading" in normalized_message
        or "wrong version number" in normalized_message
        or ("ssl" in normalized_message and "protocol" in normalized_message)
    ):
        return SSL_PROTOCOL_ERROR_MESSAGE

    scrubbed = message
    for needle in ("Bearer ", "authorization", "Authorization"):
        scrubbed = scrubbed.replace(needle, "[redacted]")
    return scrubbed[:200]


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

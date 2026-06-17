import json
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from threading import Thread

import httpx
import pytest

from kumikoroom.config import ApiSettings, LlmRuntimeConfig
from kumikoroom.llm import (
    DeepSeekLLMProvider,
    LLMTestResult,
    LLMToolCall,
    MockLLMProvider,
    ProviderUnavailable,
    build_provider,
    test_llm_connection as run_llm_connection_test,
    unconfigured_deepseek_status,
    unconfigured_runtime_status,
)


def _runtime_config(
    provider: str = "deepseek",
    base_url: str = "https://api.deepseek.com",
    api_key: str | None = "test-key",
    model: str = "deepseek-v4-flash",
) -> LlmRuntimeConfig:
    return LlmRuntimeConfig(
        provider=provider,  # type: ignore[arg-type]
        base_url=base_url,
        api_key=api_key,
        model=model,
    )


def _deepseek_provider(
    tmp_path: Path,
    transport: httpx.BaseTransport | None = None,
    api_key: str | None = "test-key",
) -> DeepSeekLLMProvider:
    return DeepSeekLLMProvider(
        runtime_config=LlmRuntimeConfig(
            provider="deepseek",
            base_url="https://api.deepseek.com",
            api_key=api_key,
            model="deepseek-v4-flash",
        ),
        transport=transport,
    )


def test_mock_provider_mentions_user_message() -> None:
    provider = MockLLMProvider()

    result = provider.generate([{"role": "user", "content": "晚上好"}])

    assert "晚上好" in result.content
    assert result.provider_status.provider == "mock"
    assert result.provider_status.configured is True


def test_mock_provider_uses_last_nonblank_user_message() -> None:
    provider = MockLLMProvider()

    result = provider.generate(
        [
            {"role": "user", "content": "第一句"},
            {"role": "assistant", "content": "我在听。"},
            {"role": "user", "content": "   "},
            {"role": "user", "content": "最后一句"},
            {"role": "user", "content": "\n\t"},
        ]
    )

    assert "最后一句" in result.content
    assert "第一句" not in result.content


def test_mock_provider_falls_back_without_user_message() -> None:
    provider = MockLLMProvider()

    result = provider.generate([{"role": "assistant", "content": "嗯。"}])

    assert "今天的音乐" in result.content
    assert result.provider_status.label == "本地 Mock API"


def test_deepseek_provider_posts_openai_compatible_payload(tmp_path) -> None:
    requests: list[httpx.Request] = []

    def handler(request: httpx.Request) -> httpx.Response:
        requests.append(request)
        assert str(request.url) == "https://api.deepseek.com/chat/completions"
        assert request.headers["authorization"] == "Bearer test-key"
        payload = json.loads(request.content.decode("utf-8"))
        assert payload["model"] == "deepseek-v4-flash"
        assert payload["messages"][-1] == {"role": "user", "content": "晚上好"}
        assert payload["temperature"] == 0.8
        return httpx.Response(
            200,
            json={
                "choices": [
                    {"message": {"content": "嗯，晚上好。今天想听点什么？"}}
                ]
            },
        )

    provider = DeepSeekLLMProvider(
        runtime_config=LlmRuntimeConfig(
            provider="deepseek",
            base_url="https://api.deepseek.com",
            api_key=" test-key ",
            model="deepseek-v4-flash",
        ),
        transport=httpx.MockTransport(handler),
    )

    result = provider.generate([{"role": "user", "content": "晚上好"}])

    assert len(requests) == 1
    assert result.content == "嗯，晚上好。今天想听点什么？"
    assert result.provider_status.provider == "deepseek"
    assert result.provider_status.model == "deepseek-v4-flash"
    assert result.provider_status.configured is True


def test_deepseek_provider_ignores_system_proxy(monkeypatch) -> None:
    class Handler(BaseHTTPRequestHandler):
        seen_paths: list[str] = []

        def do_POST(self) -> None:
            type(self).seen_paths.append(self.path)
            content_length = int(self.headers.get("content-length", "0"))
            self.rfile.read(content_length)
            self.send_response(200)
            self.send_header("Content-Type", "application/json")
            self.end_headers()
            self.wfile.write(b'{"choices":[{"message":{"content":"p"}}]}')

        def log_message(self, format: str, *args: object) -> None:
            return None

    server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
    thread = Thread(target=server.serve_forever, daemon=True)
    thread.start()

    try:
        monkeypatch.setenv("HTTP_PROXY", "http://127.0.0.1:1")
        monkeypatch.setenv("HTTPS_PROXY", "http://127.0.0.1:1")
        monkeypatch.setenv("NO_PROXY", "")

        provider = DeepSeekLLMProvider(
            runtime_config=LlmRuntimeConfig(
                provider="openai_compatible",
                base_url=f"http://127.0.0.1:{server.server_port}/v1",
                api_key=None,
                model="mimo-v2.5",
            )
        )
        result = provider.generate([{"role": "user", "content": "ping"}])
    finally:
        server.shutdown()
        server.server_close()
        thread.join(timeout=2)

    assert result.content == "p"
    assert Handler.seen_paths == ["/v1/chat/completions"]


def test_deepseek_provider_posts_tools_and_parses_tool_calls(tmp_path) -> None:
    requests: list[httpx.Request] = []

    def handler(request: httpx.Request) -> httpx.Response:
        requests.append(request)
        payload = json.loads(request.content.decode("utf-8"))
        assert payload["tools"] == [
            {
                "type": "function",
                "function": {
                    "name": "search_music",
                    "description": "Search playable music candidates.",
                    "parameters": {
                        "type": "object",
                        "properties": {"query": {"type": "string"}},
                        "required": ["query"],
                    },
                },
            }
        ]
        assert payload["tool_choice"] == "auto"
        return httpx.Response(
            200,
            json={
                "choices": [
                    {
                        "message": {
                            "content": "",
                            "tool_calls": [
                                {
                                    "id": "call-search",
                                    "type": "function",
                                    "function": {
                                        "name": "search_music",
                                        "arguments": '{"query":"晴天"}',
                                    },
                                }
                            ],
                        },
                        "finish_reason": "tool_calls",
                    }
                ]
            },
        )

    provider = _deepseek_provider(
        tmp_path=tmp_path,
        transport=httpx.MockTransport(handler),
    )

    result = provider.generate(
        [{"role": "user", "content": "播放 晴天"}],
        tools=[
            {
                "type": "function",
                "function": {
                    "name": "search_music",
                    "description": "Search playable music candidates.",
                    "parameters": {
                        "type": "object",
                        "properties": {"query": {"type": "string"}},
                        "required": ["query"],
                    },
                },
            }
        ],
        tool_choice="auto",
    )

    assert len(requests) == 1
    assert result.content == ""
    assert result.tool_calls == [
        LLMToolCall(id="call-search", name="search_music", arguments={"query": "晴天"})
    ]


def test_deepseek_provider_requires_key(tmp_path) -> None:
    provider = DeepSeekLLMProvider(
        runtime_config=LlmRuntimeConfig(
            provider="deepseek",
            base_url="https://api.deepseek.com",
            api_key=None,
            model="deepseek-v4-flash",
        )
    )

    with pytest.raises(ProviderUnavailable, match="DEEPSEEK_API_KEY"):
        provider.generate([{"role": "user", "content": "晚上好"}])


def test_deepseek_provider_requires_key_before_network_call(tmp_path) -> None:
    call_count = 0

    def handler(request: httpx.Request) -> httpx.Response:
        nonlocal call_count
        call_count += 1
        raise AssertionError("DeepSeek transport should not be called without a key")

    provider = DeepSeekLLMProvider(
        runtime_config=LlmRuntimeConfig(
            provider="deepseek",
            base_url="https://api.deepseek.com",
            api_key=None,
            model="deepseek-v4-flash",
        ),
        transport=httpx.MockTransport(handler),
    )

    with pytest.raises(ProviderUnavailable, match="DEEPSEEK_API_KEY"):
        provider.generate([{"role": "user", "content": "晚上好"}])

    assert call_count == 0


def test_deepseek_provider_requires_nonblank_key_before_network_call(tmp_path) -> None:
    call_count = 0

    def handler(request: httpx.Request) -> httpx.Response:
        nonlocal call_count
        call_count += 1
        raise AssertionError("DeepSeek transport should not be called without a key")

    provider = _deepseek_provider(
        tmp_path=tmp_path,
        api_key="   ",
        transport=httpx.MockTransport(handler),
    )

    with pytest.raises(ProviderUnavailable, match="DEEPSEEK_API_KEY"):
        provider.generate([{"role": "user", "content": "hello"}])

    assert call_count == 0


def test_openai_compatible_provider_allows_missing_key(tmp_path) -> None:
    """Ollama and other unauthenticated OpenAI-compatible endpoints
    must work without an API key. The chat path must mirror the
    test_llm_connection behavior of omitting Authorization."""
    seen: list[httpx.Request] = []

    def handler(request: httpx.Request) -> httpx.Response:
        seen.append(request)
        return httpx.Response(
            200,
            json={"choices": [{"message": {"content": "hello back"}}]},
        )

    provider = DeepSeekLLMProvider(
        runtime_config=LlmRuntimeConfig(
            provider="openai_compatible",
            base_url="http://localhost:11434/v1",
            api_key=None,
            model="qwen2.5:7b",
        ),
        transport=httpx.MockTransport(handler),
    )

    result = provider.generate([{"role": "user", "content": "hello"}])

    assert result.content == "hello back"
    assert len(seen) == 1
    auth_keys = {k.lower() for k in seen[0].headers.keys()}
    assert "authorization" not in auth_keys


def test_openai_compatible_provider_uses_explicit_key_when_present(tmp_path) -> None:
    seen: list[httpx.Request] = []

    def handler(request: httpx.Request) -> httpx.Response:
        seen.append(request)
        return httpx.Response(
            200,
            json={"choices": [{"message": {"content": "ok"}}]},
        )

    provider = DeepSeekLLMProvider(
        runtime_config=LlmRuntimeConfig(
            provider="openai_compatible",
            base_url="https://api.openai.com/v1",
            api_key="sk-explicit",
            model="gpt-4o-mini",
        ),
        transport=httpx.MockTransport(handler),
    )

    provider.generate([{"role": "user", "content": "hi"}])

    assert seen[0].headers["authorization"] == "Bearer sk-explicit"


@pytest.mark.parametrize("status_code", [401, 500])
def test_deepseek_provider_wraps_http_status_errors(
    tmp_path, status_code: int
) -> None:
    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(
            status_code,
            request=request,
            json={"error": "upstream details should stay private"},
        )

    provider = _deepseek_provider(
        tmp_path=tmp_path,
        transport=httpx.MockTransport(handler),
    )

    with pytest.raises(ProviderUnavailable, match="DeepSeek request failed") as exc_info:
        provider.generate([{"role": "user", "content": "hello"}])

    assert isinstance(exc_info.value.__cause__, httpx.HTTPStatusError)


def test_deepseek_provider_wraps_request_failures(tmp_path) -> None:
    def handler(request: httpx.Request) -> httpx.Response:
        raise httpx.ConnectError("connection failed", request=request)

    provider = _deepseek_provider(
        tmp_path=tmp_path,
        transport=httpx.MockTransport(handler),
    )

    with pytest.raises(ProviderUnavailable, match="DeepSeek request failed") as exc_info:
        provider.generate([{"role": "user", "content": "hello"}])

    assert isinstance(exc_info.value.__cause__, httpx.HTTPError)


def test_deepseek_provider_wraps_invalid_json_response(tmp_path) -> None:
    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(200, request=request, text="not json")

    provider = _deepseek_provider(
        tmp_path=tmp_path,
        transport=httpx.MockTransport(handler),
    )

    with pytest.raises(
        ProviderUnavailable, match="DeepSeek response was malformed"
    ) as exc_info:
        provider.generate([{"role": "user", "content": "hello"}])

    assert isinstance(exc_info.value.__cause__, ValueError)


def test_deepseek_provider_wraps_empty_choices_response(tmp_path) -> None:
    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(200, request=request, json={"choices": []})

    provider = _deepseek_provider(
        tmp_path=tmp_path,
        transport=httpx.MockTransport(handler),
    )

    with pytest.raises(
        ProviderUnavailable, match="DeepSeek response was malformed"
    ) as exc_info:
        provider.generate([{"role": "user", "content": "hello"}])

    assert isinstance(exc_info.value.__cause__, IndexError)


def test_deepseek_provider_wraps_missing_message_content(tmp_path) -> None:
    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(
            200,
            request=request,
            json={"choices": [{"message": {}}]},
        )

    provider = _deepseek_provider(
        tmp_path=tmp_path,
        transport=httpx.MockTransport(handler),
    )

    with pytest.raises(
        ProviderUnavailable, match="DeepSeek response was malformed"
    ) as exc_info:
        provider.generate([{"role": "user", "content": "hello"}])

    assert isinstance(exc_info.value.__cause__, KeyError)


def test_build_provider_uses_deepseek_when_configured(tmp_path) -> None:
    provider = build_provider(
        ApiSettings(
            llm_provider="deepseek",
            deepseek_api_key="test-key",
            deepseek_model="deepseek-v4-flash",
            deepseek_base_url="https://api.deepseek.com",
            memory_db_path=tmp_path / "memory.sqlite3",
        )
    )

    assert isinstance(provider, DeepSeekLLMProvider)


def test_build_provider_defaults_to_mock(tmp_path) -> None:
    provider = build_provider(
        ApiSettings(
            llm_provider="mock",
            deepseek_api_key=None,
            deepseek_model="deepseek-v4-flash",
            deepseek_base_url="https://api.deepseek.com",
            memory_db_path=tmp_path / "memory.sqlite3",
        )
    )

    assert isinstance(provider, MockLLMProvider)


def test_build_provider_uses_runtime_config_for_openai_compatible() -> None:
    provider = build_provider(
        runtime_config=LlmRuntimeConfig(
            provider="openai_compatible",
            base_url="https://api.openai.com/v1",
            api_key="sk-test",
            model="gpt-4o-mini",
        )
    )

    assert isinstance(provider, DeepSeekLLMProvider)
    assert provider.runtime_config.provider == "openai_compatible"
    assert provider.runtime_config.base_url == "https://api.openai.com/v1"


def test_build_provider_requires_settings_or_runtime_config() -> None:
    with pytest.raises(ValueError, match="build_provider"):
        build_provider()


def test_build_provider_mock_with_runtime_config() -> None:
    provider = build_provider(
        runtime_config=LlmRuntimeConfig(
            provider="mock",
            base_url="",
            api_key=None,
            model="mock",
        )
    )

    assert isinstance(provider, MockLLMProvider)


def test_deepseek_provider_openai_compatible_label() -> None:
    provider = DeepSeekLLMProvider(
        runtime_config=LlmRuntimeConfig(
            provider="openai_compatible",
            base_url="https://api.openai.com/v1",
            api_key="sk-test",
            model="gpt-4o-mini",
        ),
        transport=httpx.MockTransport(
            lambda request: httpx.Response(
                200,
                json={"choices": [{"message": {"content": "ok"}}]},
            )
        ),
    )

    result = provider.generate([{"role": "user", "content": "ping"}])

    assert result.provider_status.provider == "openai_compatible"
    assert result.provider_status.label == "OpenAI 兼容 gpt-4o-mini"
    assert result.provider_status.model == "gpt-4o-mini"


def test_unconfigured_runtime_status_for_openai_compatible() -> None:
    status = unconfigured_runtime_status(
        LlmRuntimeConfig(
            provider="openai_compatible",
            base_url="https://api.openai.com/v1",
            api_key=None,
            model="gpt-4o-mini",
        )
    )

    assert status.provider == "openai_compatible"
    assert status.model == "gpt-4o-mini"
    assert status.configured is False
    assert status.label == "OpenAI 兼容 gpt-4o-mini"


def test_unconfigured_deepseek_status(tmp_path) -> None:
    status = unconfigured_deepseek_status(
        ApiSettings(
            llm_provider="deepseek",
            deepseek_api_key=None,
            deepseek_model="deepseek-v4-flash",
            deepseek_base_url="https://api.deepseek.com",
            memory_db_path=tmp_path / "memory.sqlite3",
        )
    )

    assert status.provider == "deepseek"
    assert status.model == "deepseek-v4-flash"
    assert status.configured is False
    assert status.label == "DeepSeek 未配置"


def test_test_llm_connection_success_for_openai_compatible() -> None:
    requests: list[httpx.Request] = []

    def handler(request: httpx.Request) -> httpx.Response:
        requests.append(request)
        payload = json.loads(request.content.decode("utf-8"))
        assert payload["messages"] == [{"role": "user", "content": "ping"}]
        assert payload["max_tokens"] == 1
        assert request.headers["authorization"] == "Bearer sk-test"
        return httpx.Response(
            200,
            json={"choices": [{"message": {"content": "p"}}]},
        )

    result = run_llm_connection_test(
        LlmRuntimeConfig(
            provider="openai_compatible",
            base_url="https://api.openai.com/v1",
            api_key="sk-test",
            model="gpt-4o-mini",
        ),
        transport=httpx.MockTransport(handler),
    )

    assert isinstance(result, LLMTestResult)
    assert result.ok is True
    assert result.error is None
    assert result.model == "gpt-4o-mini"
    assert result.latency_ms is not None
    assert result.latency_ms >= 0
    assert len(requests) == 1
    assert str(requests[0].url) == "https://api.openai.com/v1/chat/completions"


def test_test_llm_connection_omits_authorization_when_no_key() -> None:
    def handler(request: httpx.Request) -> httpx.Response:
        assert "authorization" not in {k.lower() for k in request.headers}
        return httpx.Response(
            200,
            json={"choices": [{"message": {"content": "p"}}]},
        )

    result = run_llm_connection_test(
        LlmRuntimeConfig(
            provider="openai_compatible",
            base_url="http://localhost:11434/v1",
            api_key=None,
            model="qwen2.5:7b",
        ),
        transport=httpx.MockTransport(handler),
    )

    assert result.ok is True
    assert result.model == "qwen2.5:7b"


def test_test_llm_connection_returns_http_error_status() -> None:
    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(
            401,
            request=request,
            json={"error": "Invalid API key"},
        )

    result = run_llm_connection_test(
        _runtime_config(),
        transport=httpx.MockTransport(handler),
    )

    assert result.ok is False
    assert result.error == "HTTP 401"
    assert result.model == "deepseek-v4-flash"
    assert result.latency_ms is not None


def test_test_llm_connection_returns_connection_error_without_key() -> None:
    def handler(request: httpx.Request) -> httpx.Response:
        raise httpx.ConnectError("connection refused", request=request)

    result = run_llm_connection_test(
        _runtime_config(),
        transport=httpx.MockTransport(handler),
    )

    assert result.ok is False
    assert "connection refused" in (result.error or "")
    assert "Bearer" not in (result.error or "")
    assert "test-key" not in (result.error or "")


def test_test_llm_connection_simplifies_ssl_protocol_errors() -> None:
    def handler(request: httpx.Request) -> httpx.Response:
        raise httpx.ConnectError(
            "[SSL: UNEXPECTED_EOF_WHILE_READING] EOF occurred in violation of protocol (_ssl.c:1032)",
            request=request,
        )

    result = run_llm_connection_test(
        LlmRuntimeConfig(
            provider="openai_compatible",
            base_url="https://example.invalid/v1",
            api_key=None,
            model="mimo-v2.5",
        ),
        transport=httpx.MockTransport(handler),
    )

    assert result.ok is False
    assert result.error == "连接失败，请检查 Base URL 的协议（http/https）和地址是否正确。"


def test_test_llm_connection_ignores_system_proxy(monkeypatch) -> None:
    class Handler(BaseHTTPRequestHandler):
        seen_paths: list[str] = []

        def do_POST(self) -> None:
            type(self).seen_paths.append(self.path)
            content_length = int(self.headers.get("content-length", "0"))
            self.rfile.read(content_length)
            self.send_response(200)
            self.send_header("Content-Type", "application/json")
            self.end_headers()
            self.wfile.write(b'{"choices":[{"message":{"content":"p"}}]}')

        def log_message(self, format: str, *args: object) -> None:
            return None

    server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
    thread = Thread(target=server.serve_forever, daemon=True)
    thread.start()

    try:
        monkeypatch.setenv("HTTP_PROXY", "http://127.0.0.1:1")
        monkeypatch.setenv("HTTPS_PROXY", "http://127.0.0.1:1")
        monkeypatch.setenv("NO_PROXY", "")

        result = run_llm_connection_test(
            LlmRuntimeConfig(
                provider="openai_compatible",
                base_url=f"http://127.0.0.1:{server.server_port}/v1",
                api_key=None,
                model="mimo-v2.5",
            )
        )
    finally:
        server.shutdown()
        server.server_close()
        thread.join(timeout=2)

    assert result.ok is True
    assert Handler.seen_paths == ["/v1/chat/completions"]


def test_test_llm_connection_mock_provider_short_circuits() -> None:
    result = run_llm_connection_test(
        LlmRuntimeConfig(
            provider="mock",
            base_url="",
            api_key=None,
            model="mock",
        )
    )

    assert result.ok is True
    assert result.latency_ms == 0
    assert result.model is None

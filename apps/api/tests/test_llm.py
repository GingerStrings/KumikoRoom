import json
from pathlib import Path

import httpx
import pytest

from kumikoroom.config import ApiSettings
from kumikoroom.llm import (
    DeepSeekLLMProvider,
    LLMToolCall,
    MockLLMProvider,
    ProviderUnavailable,
    build_provider,
    unconfigured_deepseek_status,
)


def _deepseek_provider(
    tmp_path: Path,
    transport: httpx.BaseTransport | None = None,
    api_key: str | None = "test-key",
) -> DeepSeekLLMProvider:
    return DeepSeekLLMProvider(
        settings=ApiSettings(
            llm_provider="deepseek",
            deepseek_api_key=api_key,
            deepseek_model="deepseek-v4-flash",
            deepseek_base_url="https://api.deepseek.com",
            memory_db_path=tmp_path / "memory.sqlite3",
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
        settings=ApiSettings(
            llm_provider="deepseek",
            deepseek_api_key=" test-key ",
            deepseek_model="deepseek-v4-flash",
            deepseek_base_url="https://api.deepseek.com",
            memory_db_path=tmp_path / "memory.sqlite3",
        ),
        transport=httpx.MockTransport(handler),
    )

    result = provider.generate([{"role": "user", "content": "晚上好"}])

    assert len(requests) == 1
    assert result.content == "嗯，晚上好。今天想听点什么？"
    assert result.provider_status.provider == "deepseek"
    assert result.provider_status.model == "deepseek-v4-flash"
    assert result.provider_status.configured is True


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
        settings=ApiSettings(
            llm_provider="deepseek",
            deepseek_api_key=None,
            deepseek_model="deepseek-v4-flash",
            deepseek_base_url="https://api.deepseek.com",
            memory_db_path=tmp_path / "memory.sqlite3",
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
        settings=ApiSettings(
            llm_provider="deepseek",
            deepseek_api_key=None,
            deepseek_model="deepseek-v4-flash",
            deepseek_base_url="https://api.deepseek.com",
            memory_db_path=tmp_path / "memory.sqlite3",
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

import json

import httpx
import pytest

from kumikoroom.config import ApiSettings
from kumikoroom.llm import (
    DeepSeekLLMProvider,
    MockLLMProvider,
    ProviderUnavailable,
    build_provider,
    unconfigured_deepseek_status,
)


def test_mock_provider_mentions_user_message() -> None:
    provider = MockLLMProvider()

    result = provider.generate([{"role": "user", "content": "晚上好"}])

    assert "晚上好" in result.content
    assert result.provider_status.provider == "mock"
    assert result.provider_status.configured is True


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
            deepseek_api_key="test-key",
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

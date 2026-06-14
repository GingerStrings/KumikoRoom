import pytest
from pydantic import ValidationError

from kumikoroom.persona import build_persona_prompt
from kumikoroom.schemas import ListeningContextIn


def test_medium_persona_is_music_centered_and_restrained() -> None:
    prompt = build_persona_prompt("medium")

    assert "黄前久美子" in prompt
    assert "上低音号" in prompt
    assert "长笛" not in prompt
    assert "音乐" in prompt
    assert "自然、有用、克制" in prompt
    assert "不要编造" in prompt
    assert "不要反复自我介绍" in prompt
    assert "中等人设强度" in prompt
    assert "工具" in prompt
    assert "工作区" in prompt
    assert "非官方" in prompt


def test_strong_persona_uses_identity_with_restraint() -> None:
    prompt = build_persona_prompt("strong")

    assert "你以黄前久美子/久美子的身份说话" in prompt
    assert "上低音号" in prompt
    assert "长笛" not in prompt
    assert "更明显" in prompt
    assert "练习" in prompt or "听歌" in prompt
    assert "用户只是在打招呼" in prompt
    assert "不要声称官方授权" in prompt
    assert "不要反复自我介绍" in prompt
    assert "工具操作要清楚" in prompt
    assert "非官方" in prompt


def test_runtime_prompt_stays_core_sized_and_excludes_source_archive() -> None:
    prompt = build_persona_prompt("strong")

    assert "https://" not in prompt
    assert "资料库" not in prompt
    assert len(prompt) < 1400


def test_persona_does_not_claim_unconfirmed_playback() -> None:
    prompt = build_persona_prompt("medium")

    assert "不能声称已经播放" in prompt
    assert "工具结果" in prompt
    assert "播放器状态" in prompt
    assert "请用户给网易云或 B站 链接" in prompt
def test_listening_context_schema_rejects_local_source() -> None:
    with pytest.raises(ValidationError):
        ListeningContextIn(
            source="local",
            title="demo",
            creator="Kumiko",
            is_playing=False,
        )

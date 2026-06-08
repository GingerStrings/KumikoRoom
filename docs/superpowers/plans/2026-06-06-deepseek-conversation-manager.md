# DeepSeek Conversation Manager Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Connect KumikoRoom chat to DeepSeek and add a lightweight conversation manager with persona strength settings and automatic local memory.

**Architecture:** Keep `/api/room/chat` as the public endpoint, but move prompt assembly, provider selection, persona rules, and memory writes into focused backend modules. Keep the frontend small: send persona and memory settings with each chat request, then display provider status and newly saved memories in the right-side workspace.

**Tech Stack:** FastAPI, Pydantic, Python stdlib `sqlite3`, `httpx`, Next.js 14, React 18, Vitest, Testing Library, DeepSeek OpenAI-compatible Chat Completions.

---

## Source Notes

DeepSeek official docs checked on 2026-06-06:

- `https://api-docs.deepseek.com/`
- `https://api-docs.deepseek.com/quick_start/pricing`
- `https://api-docs.deepseek.com/api/list-models`
- `https://api-docs.deepseek.com/updates/`

Implementation choices from those docs:

- Use OpenAI-compatible Chat Completions format.
- Use `https://api.deepseek.com` as the base URL.
- Default to `deepseek-v4-flash`.
- Allow `deepseek-v4-pro`.
- Do not use `deepseek-chat` or `deepseek-reasoner`, because DeepSeek docs mark them for deprecation on 2026-07-24.
- Never commit a real API key. Use local `DEEPSEEK_API_KEY`.

## File Structure

Backend:

- Create `apps/api/kumikoroom/config.py`: loads provider, model, base URL, API key, memory DB path.
- Create `apps/api/kumikoroom/persona.py`: owns medium and strong Kumiko persona prompts.
- Create `apps/api/kumikoroom/memory.py`: SQLite-backed memory store and deterministic medium-sensitivity extractor.
- Create `apps/api/kumikoroom/llm.py`: mock and DeepSeek provider implementations behind a narrow interface.
- Create `apps/api/kumikoroom/conversation.py`: conversation manager and prompt message assembly.
- Modify `apps/api/kumikoroom/schemas.py`: chat request fields, provider status, memory events, memory API types.
- Modify `apps/api/kumikoroom/routers/room.py`: delegate chat to manager and add memory list/delete/clear endpoints.
- Modify `apps/api/pyproject.toml`: move `httpx` into runtime dependencies.
- Modify `apps/api/tests/conftest.py`: isolate memory DB and env settings per test.
- Create focused backend tests:
  - `apps/api/tests/test_config.py`
  - `apps/api/tests/test_persona.py`
  - `apps/api/tests/test_memory.py`
  - `apps/api/tests/test_llm.py`
  - `apps/api/tests/test_conversation.py`
- Modify `apps/api/tests/test_room_api.py`.

Frontend:

- Modify `apps/web/src/api/types.ts`: add persona strength, provider status, memory event types.
- Modify `apps/web/src/api/client.ts`: map new chat fields and add memory API functions.
- Modify `apps/web/tests/client.test.ts`: cover new request and response mapping.
- Modify `apps/web/src/components/RoomShell.tsx`: add persona toggle, memory toggle, provider status, recent memory events.
- Modify `apps/web/tests/RoomShell.test.tsx`: cover settings UI and payloads.
- Modify `apps/web/app/globals.css`: add compact AI settings styles.

Docs:

- Create `.env.example`: safe DeepSeek and memory environment variable template.
- Modify `README.md`: add DeepSeek setup and local verification.

---

### Task 1: Backend Settings and Chat Schema

**Files:**
- Create: `apps/api/kumikoroom/config.py`
- Modify: `apps/api/kumikoroom/schemas.py`
- Modify: `apps/api/pyproject.toml`
- Modify: `apps/api/tests/conftest.py`
- Create: `apps/api/tests/test_config.py`
- Modify: `apps/api/tests/test_room_api.py`

- [ ] **Step 1: Write the failing settings tests**

Create `apps/api/tests/test_config.py`:

```python
from pathlib import Path

from kumikoroom.config import load_settings


def test_settings_default_to_mock_without_key(monkeypatch):
    monkeypatch.delenv("KUMIKOROOM_LLM_PROVIDER", raising=False)
    monkeypatch.delenv("DEEPSEEK_API_KEY", raising=False)

    settings = load_settings()

    assert settings.llm_provider == "mock"
    assert settings.deepseek_api_key is None
    assert settings.deepseek_model == "deepseek-v4-flash"
    assert settings.deepseek_base_url == "https://api.deepseek.com"


def test_settings_auto_select_deepseek_when_key_exists(monkeypatch):
    monkeypatch.delenv("KUMIKOROOM_LLM_PROVIDER", raising=False)
    monkeypatch.setenv("DEEPSEEK_API_KEY", "test-key")

    settings = load_settings()

    assert settings.llm_provider == "deepseek"
    assert settings.deepseek_api_key == "test-key"
    assert settings.is_deepseek_configured is True


def test_settings_keep_explicit_deepseek_unconfigured(monkeypatch):
    monkeypatch.setenv("KUMIKOROOM_LLM_PROVIDER", "deepseek")
    monkeypatch.delenv("DEEPSEEK_API_KEY", raising=False)

    settings = load_settings()

    assert settings.llm_provider == "deepseek"
    assert settings.is_deepseek_configured is False


def test_settings_support_memory_db_override(monkeypatch, tmp_path):
    db_path = tmp_path / "memory.sqlite3"
    monkeypatch.setenv("KUMIKOROOM_MEMORY_DB_PATH", str(db_path))

    settings = load_settings()

    assert settings.memory_db_path == db_path
    assert isinstance(settings.memory_db_path, Path)
```

- [ ] **Step 2: Update the room API test expectations before implementation**

Modify `apps/api/tests/test_room_api.py` so the chat test expects provider and memory fields:

```python
def test_mock_chat_returns_kumiko_reply(client: TestClient):
    response = client.post(
        "/api/room/chat",
        json={
            "message": "想听安静的歌",
            "persona_strength": "medium",
            "memory_enabled": True,
        },
    )

    assert response.status_code == 200
    body = response.json()
    assert body["reply"]["role"] == "kumiko"
    assert "想听安静的歌" in body["reply"]["content"]
    assert body["expression"] == "listening"
    assert body["suggested_actions"] == ["save_diary", "save_inspiration"]
    assert body["provider_status"] == {
        "provider": "mock",
        "model": None,
        "configured": True,
        "label": "本地 Mock API",
    }
    assert body["memory_events"] == []
```

- [ ] **Step 3: Run the failing tests**

Run:

```powershell
cd apps\api
python -m pytest tests\test_config.py tests\test_room_api.py
```

Expected: FAIL because `kumikoroom.config` does not exist and `ChatOut` does not include the new fields.

- [ ] **Step 4: Add runtime `httpx` dependency**

Modify `apps/api/pyproject.toml`:

```toml
[project]
name = "kumikoroom-api"
version = "0.1.0"
requires-python = ">=3.11"
dependencies = [
  "fastapi>=0.115.0",
  "uvicorn[standard]>=0.30.0",
  "pydantic>=2.8.0",
  "httpx>=0.27.0"
]

[project.optional-dependencies]
dev = [
  "pytest>=8.2.0"
]
```

- [ ] **Step 5: Implement settings**

Create `apps/api/kumikoroom/config.py`:

```python
from __future__ import annotations

import os
from dataclasses import dataclass
from pathlib import Path
from typing import Literal

LLMProviderName = Literal["mock", "deepseek"]


@dataclass(frozen=True)
class ApiSettings:
    llm_provider: LLMProviderName
    deepseek_api_key: str | None
    deepseek_model: str
    deepseek_base_url: str
    memory_db_path: Path

    @property
    def is_deepseek_configured(self) -> bool:
        return bool(self.deepseek_api_key)


def load_settings() -> ApiSettings:
    api_key = _clean_env("DEEPSEEK_API_KEY")
    explicit_provider = _clean_env("KUMIKOROOM_LLM_PROVIDER")
    provider = _resolve_provider(explicit_provider, api_key)

    return ApiSettings(
        llm_provider=provider,
        deepseek_api_key=api_key,
        deepseek_model=_clean_env("DEEPSEEK_MODEL") or "deepseek-v4-flash",
        deepseek_base_url=(_clean_env("DEEPSEEK_BASE_URL") or "https://api.deepseek.com").rstrip("/"),
        memory_db_path=Path(_clean_env("KUMIKOROOM_MEMORY_DB_PATH") or "user-data/memory/kumikoroom-memory.sqlite3"),
    )


def _clean_env(name: str) -> str | None:
    value = os.environ.get(name)
    if value is None:
        return None

    cleaned = value.strip()
    return cleaned or None


def _resolve_provider(explicit_provider: str | None, api_key: str | None) -> LLMProviderName:
    if explicit_provider in {"mock", "deepseek"}:
        return explicit_provider

    return "deepseek" if api_key else "mock"
```

- [ ] **Step 6: Update schemas**

Modify `apps/api/kumikoroom/schemas.py`:

```python
from typing import Literal

from pydantic import BaseModel, Field

PersonaStrength = Literal["medium", "strong"]
MemoryCategory = Literal["preference", "diary", "creative_note", "profile_fact"]


class CharacterStateOut(BaseModel):
    display_name: str
    romanized_name: str
    expression: str
    status_text: str


class MusicContextOut(BaseModel):
    current_track_title: str | None = None
    current_artist: str | None = None
    listening_mood: str | None = None


class StudioSummaryOut(BaseModel):
    label: str
    route: str
    unfinished_count: int


class RoomStateOut(BaseModel):
    app_name: str
    room_name: str
    character: CharacterStateOut
    music: MusicContextOut
    diary_summary: str
    inspiration_count: int
    studio: StudioSummaryOut


class ChatMessageOut(BaseModel):
    id: str
    role: str
    content: str


class ChatIn(BaseModel):
    message: str
    room_state: RoomStateOut | None = None
    recent_messages: list[ChatMessageOut] = Field(default_factory=list)
    persona_strength: PersonaStrength = "medium"
    memory_enabled: bool = True


class ProviderStatusOut(BaseModel):
    provider: Literal["mock", "deepseek"]
    model: str | None
    configured: bool
    label: str


class MemoryEventOut(BaseModel):
    id: str
    category: MemoryCategory
    text: str
    confidence: float
    created_at: str


class ChatOut(BaseModel):
    reply: ChatMessageOut
    expression: str
    suggested_actions: list[str]
    provider_status: ProviderStatusOut
    memory_events: list[MemoryEventOut] = Field(default_factory=list)
```

- [ ] **Step 7: Add test isolation for memory env**

Modify `apps/api/tests/conftest.py`:

```python
from collections.abc import Generator

import pytest
from fastapi.testclient import TestClient

from kumikoroom.main import app


@pytest.fixture(autouse=True)
def isolated_environment(monkeypatch: pytest.MonkeyPatch, tmp_path):
    monkeypatch.delenv("KUMIKOROOM_LLM_PROVIDER", raising=False)
    monkeypatch.delenv("DEEPSEEK_API_KEY", raising=False)
    monkeypatch.delenv("DEEPSEEK_MODEL", raising=False)
    monkeypatch.delenv("DEEPSEEK_BASE_URL", raising=False)
    monkeypatch.setenv("KUMIKOROOM_MEMORY_DB_PATH", str(tmp_path / "memory.sqlite3"))


@pytest.fixture
def client() -> Generator[TestClient, None, None]:
    with TestClient(app) as test_client:
        yield test_client
```

- [ ] **Step 8: Temporarily update mock route output**

Modify `apps/api/kumikoroom/routers/room.py` so `post_chat` returns the new fields:

```python
@router.post("/chat", response_model=ChatOut)
def post_chat(payload: ChatIn) -> ChatOut:
    message = payload.message.strip()
    quoted = message if message else "今天的音乐"
    return ChatOut(
        reply=ChatMessageOut(
            id="mock-kumiko-reply",
            role="kumiko",
            content=f"嗯，我听到了。你说的是「{quoted}」。先把这句话记下来也不错。",
        ),
        expression="listening",
        suggested_actions=["save_diary", "save_inspiration"],
        provider_status={
            "provider": "mock",
            "model": None,
            "configured": True,
            "label": "本地 Mock API",
        },
        memory_events=[],
    )
```

- [ ] **Step 9: Run the tests to verify green**

Run:

```powershell
cd apps\api
python -m pytest tests\test_config.py tests\test_room_api.py
```

Expected: PASS.

- [ ] **Step 10: Commit**

```powershell
git add apps/api/pyproject.toml apps/api/kumikoroom/config.py apps/api/kumikoroom/schemas.py apps/api/kumikoroom/routers/room.py apps/api/tests/conftest.py apps/api/tests/test_config.py apps/api/tests/test_room_api.py
git commit -m "feat: add chat settings schema"
```

---

### Task 2: Persona Prompt Profiles

**Files:**
- Create: `apps/api/kumikoroom/persona.py`
- Create: `apps/api/tests/test_persona.py`

- [ ] **Step 1: Write failing persona tests**

Create `apps/api/tests/test_persona.py`:

```python
from kumikoroom.persona import build_persona_prompt


def test_medium_persona_is_music_centered_and_restrained():
    prompt = build_persona_prompt("medium")

    assert "黄前久美子" in prompt
    assert "音乐" in prompt
    assert "不要反复自我介绍" in prompt
    assert "中等人设强度" in prompt


def test_strong_persona_uses_identity_with_restraint():
    prompt = build_persona_prompt("strong")

    assert "你以黄前久美子/久美子的身份说话" in prompt
    assert "更明显" in prompt
    assert "不要声称官方授权" in prompt
    assert "工具操作要清楚" in prompt
```

- [ ] **Step 2: Run the failing tests**

Run:

```powershell
cd apps\api
python -m pytest tests\test_persona.py
```

Expected: FAIL because `kumikoroom.persona` does not exist.

- [ ] **Step 3: Implement persona profiles**

Create `apps/api/kumikoroom/persona.py`:

```python
from __future__ import annotations

from typing import Literal

PersonaStrength = Literal["medium", "strong"]

BASE_PERSONA_RULES = """你是 KumikoRoom 里的黄前久美子。
这是一个本地个人使用的非官方 fan project。你不要声称官方授权，也不要声称自己是真实人物。
你要围绕音乐、听歌、创作资料、灵感和日常对话提供陪伴。
回复要自然、具体、克制，避免长篇设定解释。
工具操作要清楚：整理资料、记忆、工程状态、模型连接这些内容要用明确语言说明。
不要反复自我介绍。
"""

MEDIUM_PERSONA_RULES = """当前是中等人设强度。
你要保留久美子的气质：细腻、稍微犹豫、会观察对方的语气，偶尔有轻微吐槽感。
你可以使用“久美子”的身份，但不要把每次回复都变成角色表演。
音乐语境要自然出现，重点仍然是帮用户把聊天、听歌日记和创作资料推进下去。
"""

STRONG_PERSONA_RULES = """当前是强人设强度。
你以黄前久美子/久美子的身份说话，语气可以更明显地贴近她：谨慎、轻微自我意识、偶尔干脆地吐槽，和音乐练习或听歌体验联系更强。
你可以更明确地表达关系感和陪伴感，但不要反复解释背景，不要把每个工具动作都戏剧化。
不要声称官方授权。
工具操作要清楚，不能因为人设更强而降低可用性。
"""


def build_persona_prompt(strength: PersonaStrength) -> str:
    if strength == "strong":
        return f"{BASE_PERSONA_RULES}\n{STRONG_PERSONA_RULES}".strip()

    return f"{BASE_PERSONA_RULES}\n{MEDIUM_PERSONA_RULES}".strip()
```

- [ ] **Step 4: Run persona tests**

Run:

```powershell
cd apps\api
python -m pytest tests\test_persona.py
```

Expected: PASS.

- [ ] **Step 5: Commit**

```powershell
git add apps/api/kumikoroom/persona.py apps/api/tests/test_persona.py
git commit -m "feat: add kumiko persona prompts"
```

---

### Task 3: Local Memory Store and Extractor

**Files:**
- Create: `apps/api/kumikoroom/memory.py`
- Create: `apps/api/tests/test_memory.py`

- [ ] **Step 1: Write failing memory tests**

Create `apps/api/tests/test_memory.py`:

```python
from kumikoroom.memory import MemoryStore, extract_memories


def test_memory_store_saves_lists_deletes_and_clears(tmp_path):
    store = MemoryStore(tmp_path / "memory.sqlite3")

    saved = store.save(category="preference", text="用户喜欢安静的钢琴曲。", confidence=0.82, source="喜欢安静的钢琴")

    assert saved.category == "preference"
    assert saved.text == "用户喜欢安静的钢琴曲。"
    assert saved.confidence == 0.82
    assert len(store.list_recent(limit=10)) == 1

    assert store.delete(saved.id) is True
    assert store.list_recent(limit=10) == []

    store.save(category="diary", text="用户今天听歌时心情平静。", confidence=0.78, source="今天听歌")
    store.clear()
    assert store.list_recent(limit=10) == []


def test_extract_memories_captures_medium_sensitivity_items():
    memories = extract_memories(
        user_message="我喜欢安静的钢琴，也想把这个 demo 明天继续编曲。",
        assistant_reply="嗯，我记一下。",
    )

    assert [memory.category for memory in memories] == ["preference", "creative_note"]
    assert any("安静的钢琴" in memory.text for memory in memories)
    assert any("demo" in memory.text for memory in memories)


def test_extract_memories_filters_secrets_and_casual_text():
    fake_secret = "sk-" + "abc12345678900000000"
    assert extract_memories(f"我的 key 是 {fake_secret}", "别保存。") == []
    assert extract_memories("哈哈，随便聊聊。", "嗯。") == []
```

- [ ] **Step 2: Run the failing tests**

Run:

```powershell
cd apps\api
python -m pytest tests\test_memory.py
```

Expected: FAIL because `kumikoroom.memory` does not exist.

- [ ] **Step 3: Implement memory store and extractor**

Create `apps/api/kumikoroom/memory.py`:

```python
from __future__ import annotations

import re
import sqlite3
import uuid
from dataclasses import dataclass
from datetime import UTC, datetime
from pathlib import Path
from typing import Literal

MemoryCategory = Literal["preference", "diary", "creative_note", "profile_fact"]

SECRET_PATTERNS = [
    re.compile(r"sk-[A-Za-z0-9]{16,}"),
    re.compile(r"(api[_-]?key|密码|口令|token)", re.IGNORECASE),
]


@dataclass(frozen=True)
class NewMemory:
    category: MemoryCategory
    text: str
    confidence: float
    source: str


@dataclass(frozen=True)
class MemoryRecord:
    id: str
    category: MemoryCategory
    text: str
    confidence: float
    source: str
    created_at: str


class MemoryStore:
    def __init__(self, db_path: Path | str):
        self.db_path = Path(db_path)
        self.db_path.parent.mkdir(parents=True, exist_ok=True)
        self._ensure_schema()

    def save(self, *, category: MemoryCategory, text: str, confidence: float, source: str) -> MemoryRecord:
        record = MemoryRecord(
            id=str(uuid.uuid4()),
            category=category,
            text=text.strip(),
            confidence=round(float(confidence), 2),
            source=source.strip(),
            created_at=datetime.now(UTC).isoformat(),
        )
        with self._connect() as connection:
            connection.execute(
                """
                INSERT INTO memories (id, category, text, confidence, source, created_at)
                VALUES (?, ?, ?, ?, ?, ?)
                """,
                (record.id, record.category, record.text, record.confidence, record.source, record.created_at),
            )
        return record

    def list_recent(self, *, limit: int = 20) -> list[MemoryRecord]:
        with self._connect() as connection:
            rows = connection.execute(
                """
                SELECT id, category, text, confidence, source, created_at
                FROM memories
                ORDER BY created_at DESC
                LIMIT ?
                """,
                (limit,),
            ).fetchall()
        return [_row_to_memory(row) for row in rows]

    def delete(self, memory_id: str) -> bool:
        with self._connect() as connection:
            cursor = connection.execute("DELETE FROM memories WHERE id = ?", (memory_id,))
        return cursor.rowcount > 0

    def clear(self) -> None:
        with self._connect() as connection:
            connection.execute("DELETE FROM memories")

    def _connect(self) -> sqlite3.Connection:
        connection = sqlite3.connect(self.db_path)
        connection.row_factory = sqlite3.Row
        return connection

    def _ensure_schema(self) -> None:
        with self._connect() as connection:
            connection.execute(
                """
                CREATE TABLE IF NOT EXISTS memories (
                    id TEXT PRIMARY KEY,
                    category TEXT NOT NULL,
                    text TEXT NOT NULL,
                    confidence REAL NOT NULL,
                    source TEXT NOT NULL,
                    created_at TEXT NOT NULL
                )
                """
            )


def extract_memories(user_message: str, assistant_reply: str) -> list[NewMemory]:
    message = user_message.strip()
    if not message or _contains_secret(message):
        return []

    memories: list[NewMemory] = []

    if _contains_any(message, ["喜欢", "不喜欢", "偏好", "希望你", "更想要"]):
        memories.append(
            NewMemory(
                category="preference",
                text=f"用户偏好：{message}",
                confidence=0.78,
                source=message,
            )
        )

    if _contains_any(message, ["今天", "听歌", "心情", "日记"]):
        memories.append(
            NewMemory(
                category="diary",
                text=f"听歌日记线索：{message}",
                confidence=0.72,
                source=message,
            )
        )

    if _contains_any(message, ["demo", "Demo", "FLP", "工程", "歌词", "旋律", "编曲", "创作"]):
        memories.append(
            NewMemory(
                category="creative_note",
                text=f"创作线索：{message}",
                confidence=0.8,
                source=message,
            )
        )

    if _contains_any(message, ["我叫", "我是", "我的项目", "我的工作流"]):
        memories.append(
            NewMemory(
                category="profile_fact",
                text=f"用户背景：{message}",
                confidence=0.74,
                source=message,
            )
        )

    return _dedupe_memories(memories)


def _row_to_memory(row: sqlite3.Row) -> MemoryRecord:
    return MemoryRecord(
        id=row["id"],
        category=row["category"],
        text=row["text"],
        confidence=row["confidence"],
        source=row["source"],
        created_at=row["created_at"],
    )


def _contains_secret(text: str) -> bool:
    return any(pattern.search(text) for pattern in SECRET_PATTERNS)


def _contains_any(text: str, needles: list[str]) -> bool:
    return any(needle in text for needle in needles)


def _dedupe_memories(memories: list[NewMemory]) -> list[NewMemory]:
    seen: set[tuple[str, str]] = set()
    result: list[NewMemory] = []
    for memory in memories:
        key = (memory.category, memory.text)
        if key in seen:
            continue
        seen.add(key)
        result.append(memory)
    return result
```

- [ ] **Step 4: Run memory tests**

Run:

```powershell
cd apps\api
python -m pytest tests\test_memory.py
```

Expected: PASS.

- [ ] **Step 5: Commit**

```powershell
git add apps/api/kumikoroom/memory.py apps/api/tests/test_memory.py
git commit -m "feat: add automatic memory store"
```

---

### Task 4: Mock and DeepSeek LLM Providers

**Files:**
- Create: `apps/api/kumikoroom/llm.py`
- Create: `apps/api/tests/test_llm.py`

- [ ] **Step 1: Write failing provider tests**

Create `apps/api/tests/test_llm.py`:

```python
import json

import httpx
import pytest

from kumikoroom.config import ApiSettings
from kumikoroom.llm import DeepSeekLLMProvider, MockLLMProvider, ProviderUnavailable


def test_mock_provider_mentions_user_message():
    provider = MockLLMProvider()

    result = provider.generate([{"role": "user", "content": "晚上好"}])

    assert "晚上好" in result.content
    assert result.provider_status.provider == "mock"
    assert result.provider_status.configured is True


def test_deepseek_provider_posts_openai_compatible_payload(tmp_path):
    requests: list[httpx.Request] = []

    def handler(request: httpx.Request) -> httpx.Response:
        requests.append(request)
        assert request.url == "https://api.deepseek.com/chat/completions"
        assert request.headers["authorization"] == "Bearer test-key"
        payload = json.loads(request.content.decode("utf-8"))
        assert payload["model"] == "deepseek-v4-flash"
        assert payload["messages"][-1] == {"role": "user", "content": "晚上好"}
        return httpx.Response(
            200,
            json={
                "choices": [
                    {
                        "message": {
                            "content": "嗯，晚上好。今天想听点什么？"
                        }
                    }
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


def test_deepseek_provider_requires_key(tmp_path):
    provider = DeepSeekLLMProvider(
        settings=ApiSettings(
            llm_provider="deepseek",
            deepseek_api_key=None,
            deepseek_model="deepseek-v4-flash",
            deepseek_base_url="https://api.deepseek.com",
            memory_db_path=tmp_path / "memory.sqlite3",
        )
    )

    with pytest.raises(ProviderUnavailable):
        provider.generate([{"role": "user", "content": "晚上好"}])
```

- [ ] **Step 2: Run the failing tests**

Run:

```powershell
cd apps\api
python -m pytest tests\test_llm.py
```

Expected: FAIL because `kumikoroom.llm` does not exist.

- [ ] **Step 3: Implement providers**

Create `apps/api/kumikoroom/llm.py`:

```python
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
            content=f"嗯，我听到了。你说的是「{user_message}」。先把这句话记下来也不错。",
            provider_status=ProviderStatus(
                provider="mock",
                model=None,
                configured=True,
                label="本地 Mock API",
            ),
        )


class DeepSeekLLMProvider:
    def __init__(self, settings: ApiSettings, transport: httpx.BaseTransport | None = None):
        self.settings = settings
        self.transport = transport

    def generate(self, messages: list[LLMMessage]) -> LLMResult:
        if not self.settings.deepseek_api_key:
            raise ProviderUnavailable("DEEPSEEK_API_KEY is not configured")

        with httpx.Client(timeout=45.0, transport=self.transport) as client:
            response = client.post(
                f"{self.settings.deepseek_base_url}/chat/completions",
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
            body = response.json()

        content = body["choices"][0]["message"]["content"].strip()
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
        if message["role"] == "user":
            return message["content"]
    return None
```

- [ ] **Step 4: Run provider tests**

Run:

```powershell
cd apps\api
python -m pytest tests\test_llm.py
```

Expected: PASS.

- [ ] **Step 5: Commit**

```powershell
git add apps/api/kumikoroom/llm.py apps/api/tests/test_llm.py
git commit -m "feat: add deepseek llm provider"
```

---

### Task 5: Conversation Manager and Chat Route Integration

**Files:**
- Create: `apps/api/kumikoroom/conversation.py`
- Create: `apps/api/tests/test_conversation.py`
- Modify: `apps/api/kumikoroom/routers/room.py`
- Modify: `apps/api/tests/test_room_api.py`

- [ ] **Step 1: Write failing conversation tests**

Create `apps/api/tests/test_conversation.py`:

```python
from kumikoroom.config import load_settings
from kumikoroom.conversation import ConversationManager
from kumikoroom.llm import LLMResult, ProviderStatus
from kumikoroom.schemas import ChatIn


class FakeProvider:
    def __init__(self):
        self.messages = []

    def generate(self, messages):
        self.messages = messages
        return LLMResult(
            content="嗯，我在听。这个 demo 可以先保留一个安静的版本。",
            provider_status=ProviderStatus(
                provider="deepseek",
                model="deepseek-v4-flash",
                configured=True,
                label="DeepSeek deepseek-v4-flash",
            ),
        )


def test_manager_builds_persona_memory_and_user_prompt(tmp_path, monkeypatch):
    monkeypatch.setenv("KUMIKOROOM_MEMORY_DB_PATH", str(tmp_path / "memory.sqlite3"))
    provider = FakeProvider()
    manager = ConversationManager(settings=load_settings(), provider=provider)

    response = manager.chat(
        ChatIn(
            message="我喜欢安静的钢琴，这个 demo 明天继续编曲。",
            persona_strength="strong",
            memory_enabled=True,
        )
    )

    system_text = "\n".join(message["content"] for message in provider.messages if message["role"] == "system")
    assert "你以黄前久美子/久美子的身份说话" in system_text
    assert provider.messages[-1] == {"role": "user", "content": "我喜欢安静的钢琴，这个 demo 明天继续编曲。"}
    assert response.reply.role == "kumiko"
    assert response.provider_status.provider == "deepseek"
    assert [event.category for event in response.memory_events] == ["preference", "creative_note"]


def test_manager_disables_memory_when_requested(tmp_path, monkeypatch):
    monkeypatch.setenv("KUMIKOROOM_MEMORY_DB_PATH", str(tmp_path / "memory.sqlite3"))
    manager = ConversationManager(settings=load_settings(), provider=FakeProvider())

    response = manager.chat(ChatIn(message="我喜欢安静的钢琴。", memory_enabled=False))

    assert response.memory_events == []


def test_manager_falls_back_when_deepseek_is_unconfigured(tmp_path, monkeypatch):
    monkeypatch.setenv("KUMIKOROOM_MEMORY_DB_PATH", str(tmp_path / "memory.sqlite3"))
    monkeypatch.setenv("KUMIKOROOM_LLM_PROVIDER", "deepseek")
    monkeypatch.delenv("DEEPSEEK_API_KEY", raising=False)

    manager = ConversationManager(settings=load_settings())

    response = manager.chat(ChatIn(message="晚上好"))

    assert response.provider_status.provider == "deepseek"
    assert response.provider_status.configured is False
    assert "还没有配置 DeepSeek" in response.reply.content
```

- [ ] **Step 2: Run the failing tests**

Run:

```powershell
cd apps\api
python -m pytest tests\test_conversation.py
```

Expected: FAIL because `kumikoroom.conversation` does not exist.

- [ ] **Step 3: Implement conversation manager**

Create `apps/api/kumikoroom/conversation.py`:

```python
from __future__ import annotations

from dataclasses import asdict

from kumikoroom.config import ApiSettings, load_settings
from kumikoroom.llm import LLMProvider, MockLLMProvider, ProviderUnavailable, build_provider, unconfigured_deepseek_status
from kumikoroom.memory import MemoryStore, extract_memories
from kumikoroom.persona import build_persona_prompt
from kumikoroom.schemas import ChatIn, ChatMessageOut, ChatOut, MemoryEventOut, ProviderStatusOut


class ConversationManager:
    def __init__(
        self,
        settings: ApiSettings | None = None,
        provider: LLMProvider | None = None,
        memory_store: MemoryStore | None = None,
    ):
        self.settings = settings or load_settings()
        self.provider = provider or build_provider(self.settings)
        self.memory_store = memory_store or MemoryStore(self.settings.memory_db_path)

    def chat(self, payload: ChatIn) -> ChatOut:
        message = payload.message.strip()
        if not message:
            message = "今天的音乐"

        messages = self._build_messages(payload, message)

        try:
            result = self.provider.generate(messages)
        except ProviderUnavailable:
            result = MockLLMProvider().generate(messages)
            return ChatOut(
                reply=ChatMessageOut(
                    id="deepseek-unconfigured",
                    role="kumiko",
                    content="DeepSeek 还没有配置好。先用本地回复陪你聊，等 DEEPSEEK_API_KEY 配好后我就能接上真实模型。",
                ),
                expression="thinking",
                suggested_actions=[],
                provider_status=ProviderStatusOut(**asdict(unconfigured_deepseek_status(self.settings))),
                memory_events=[],
            )

        memory_events = []
        if payload.memory_enabled:
            for memory in extract_memories(user_message=message, assistant_reply=result.content):
                saved = self.memory_store.save(
                    category=memory.category,
                    text=memory.text,
                    confidence=memory.confidence,
                    source=memory.source,
                )
                memory_events.append(MemoryEventOut(**asdict(saved)))

        return ChatOut(
            reply=ChatMessageOut(id="llm-kumiko-reply", role="kumiko", content=result.content),
            expression="listening",
            suggested_actions=["save_diary", "save_inspiration"] if memory_events else [],
            provider_status=ProviderStatusOut(**asdict(result.provider_status)),
            memory_events=memory_events,
        )

    def _build_messages(self, payload: ChatIn, message: str):
        system_parts = [build_persona_prompt(payload.persona_strength)]

        memories = self.memory_store.list_recent(limit=8)
        if memories:
            memory_text = "\n".join(f"- [{memory.category}] {memory.text}" for memory in memories)
            system_parts.append(f"可参考的长期记忆：\n{memory_text}")

        if payload.room_state:
            system_parts.append(
                "当前本地状态："
                f"听歌心情={payload.room_state.music.listening_mood}; "
                f"当前曲目={payload.room_state.music.current_track_title or '未选择'}; "
                f"创作资料待整理={payload.room_state.studio.unfinished_count}"
            )

        messages = [{"role": "system", "content": "\n\n".join(system_parts)}]
        for recent in payload.recent_messages[-8:]:
            role = "assistant" if recent.role == "kumiko" else "user"
            messages.append({"role": role, "content": recent.content})
        messages.append({"role": "user", "content": message})
        return messages
```

- [ ] **Step 4: Update route integration and memory endpoints**

Modify `apps/api/kumikoroom/routers/room.py`:

```python
from dataclasses import asdict

from fastapi import APIRouter, Response, status

from kumikoroom.config import load_settings
from kumikoroom.conversation import ConversationManager
from kumikoroom.memory import MemoryStore
from kumikoroom.schemas import ChatIn, ChatOut, MemoryEventOut, RoomStateOut

router = APIRouter(prefix="/api/room", tags=["room"])


def default_room_state() -> RoomStateOut:
    return RoomStateOut(
        app_name="KumikoRoom",
        room_name="陪伴房间",
        character={
            "display_name": "黄前久美子",
            "romanized_name": "Kumiko Oumae",
            "expression": "listening",
            "status_text": "正在听你今天想说的音乐",
        },
        music={
            "current_track_title": None,
            "current_artist": None,
            "listening_mood": "还没记录",
        },
        diary_summary="今天还没有写听歌日记。",
        inspiration_count=0,
        studio={
            "label": "创作资料室",
            "route": "/studio",
            "unfinished_count": 0,
        },
    )


def memory_store() -> MemoryStore:
    return MemoryStore(load_settings().memory_db_path)


@router.get("/state", response_model=RoomStateOut)
def get_room_state() -> RoomStateOut:
    return default_room_state()


@router.post("/chat", response_model=ChatOut)
def post_chat(payload: ChatIn) -> ChatOut:
    return ConversationManager(settings=load_settings()).chat(payload)


@router.get("/memory", response_model=list[MemoryEventOut])
def list_memory() -> list[MemoryEventOut]:
    return [MemoryEventOut(**asdict(record)) for record in memory_store().list_recent(limit=50)]


@router.delete("/memory/{memory_id}", status_code=status.HTTP_204_NO_CONTENT)
def delete_memory(memory_id: str) -> Response:
    memory_store().delete(memory_id)
    return Response(status_code=status.HTTP_204_NO_CONTENT)


@router.delete("/memory", status_code=status.HTTP_204_NO_CONTENT)
def clear_memory() -> Response:
    memory_store().clear()
    return Response(status_code=status.HTTP_204_NO_CONTENT)
```

- [ ] **Step 5: Add memory endpoint API test**

Append to `apps/api/tests/test_room_api.py`:

```python
def test_memory_endpoints_list_delete_and_clear(client: TestClient):
    chat = client.post(
        "/api/room/chat",
        json={
            "message": "我喜欢安静的钢琴，这个 demo 明天继续编曲。",
            "memory_enabled": True,
        },
    )
    assert chat.status_code == 200

    memories = client.get("/api/room/memory")
    assert memories.status_code == 200
    body = memories.json()
    assert len(body) == 2

    delete_response = client.delete(f"/api/room/memory/{body[0]['id']}")
    assert delete_response.status_code == 204
    assert len(client.get("/api/room/memory").json()) == 1

    clear_response = client.delete("/api/room/memory")
    assert clear_response.status_code == 204
    assert client.get("/api/room/memory").json() == []
```

- [ ] **Step 6: Run backend integration tests**

Run:

```powershell
cd apps\api
python -m pytest tests\test_conversation.py tests\test_room_api.py
```

Expected: PASS.

- [ ] **Step 7: Commit**

```powershell
git add apps/api/kumikoroom/conversation.py apps/api/kumikoroom/routers/room.py apps/api/tests/test_conversation.py apps/api/tests/test_room_api.py
git commit -m "feat: add conversation manager"
```

---

### Task 6: Frontend API Types and Client Mapping

**Files:**
- Modify: `apps/web/src/api/types.ts`
- Modify: `apps/web/src/api/client.ts`
- Modify: `apps/web/tests/client.test.ts`

- [ ] **Step 1: Write failing client tests**

Modify the `posts chat messages` test in `apps/web/tests/client.test.ts`:

```ts
  it("posts chat messages with persona and memory settings", async () => {
    const fetchMock = vi.fn(async () => ({
      ok: true,
      status: 200,
      statusText: "OK",
      text: async () =>
        JSON.stringify({
          reply: { id: "1", role: "kumiko", content: "嗯，我在听。" },
          expression: "listening",
          suggested_actions: ["save_diary"],
          provider_status: {
            provider: "deepseek",
            model: "deepseek-v4-flash",
            configured: true,
            label: "DeepSeek deepseek-v4-flash"
          },
          memory_events: [
            {
              id: "memory-1",
              category: "preference",
              text: "用户喜欢安静的钢琴。",
              confidence: 0.78,
              created_at: "2026-06-06T00:00:00+00:00"
            }
          ]
        })
    }));
    vi.stubGlobal("fetch", fetchMock);

    await expect(
      postChat({
        message: "晚上好",
        roomState: DEFAULT_ROOM_STATE,
        recentMessages: [{ id: "recent", role: "kumiko", content: "今天想从哪首歌开始聊？" }],
        personaStrength: "strong",
        memoryEnabled: false
      })
    ).resolves.toMatchObject({
      reply: { role: "kumiko" },
      expression: "listening",
      suggestedActions: ["save_diary"],
      providerStatus: {
        provider: "deepseek",
        model: "deepseek-v4-flash",
        configured: true
      },
      memoryEvents: [{ id: "memory-1", category: "preference" }]
    });

    expect(JSON.parse(String(fetchMock.mock.calls[0][1]?.body))).toMatchObject({
      message: "晚上好",
      persona_strength: "strong",
      memory_enabled: false,
      recent_messages: [{ id: "recent", role: "kumiko", content: "今天想从哪首歌开始聊？" }],
      room_state: {
        app_name: "KumikoRoom",
        character: { display_name: "黄前久美子" }
      }
    });
  });
```

Add memory API tests:

```ts
  it("loads and clears memories", async () => {
    const fetchMock = vi.fn(async (url: string, init?: RequestInit) => ({
      ok: true,
      status: init?.method === "DELETE" ? 204 : 200,
      statusText: "OK",
      text: async () =>
        init?.method === "DELETE"
          ? ""
          : JSON.stringify([
              {
                id: "memory-1",
                category: "creative_note",
                text: "用户想继续 demo 编曲。",
                confidence: 0.8,
                created_at: "2026-06-06T00:00:00+00:00"
              }
            ])
    }));
    vi.stubGlobal("fetch", fetchMock);

    await expect(getMemories()).resolves.toEqual([
      {
        id: "memory-1",
        category: "creative_note",
        text: "用户想继续 demo 编曲。",
        confidence: 0.8,
        createdAt: "2026-06-06T00:00:00+00:00"
      }
    ]);
    await expect(clearMemories()).resolves.toBeUndefined();
  });
```

- [ ] **Step 2: Run the failing client tests**

Run:

```powershell
npm --prefix apps/web test -- client.test.ts
```

Expected: FAIL because the new types and client functions are missing.

- [ ] **Step 3: Update web API types**

Modify `apps/web/src/api/types.ts`:

```ts
export type PersonaStrength = "medium" | "strong";
export type MemoryCategory = "preference" | "diary" | "creative_note" | "profile_fact";

export interface CharacterState {
  displayName: string;
  romanizedName: string;
  expression: "neutral" | "listening" | "thinking" | "encouraging";
  statusText: string;
}

export interface MusicContext {
  currentTrackTitle: string | null;
  currentArtist: string | null;
  listeningMood: string | null;
}

export interface StudioSummary {
  label: string;
  route: string;
  unfinishedCount: number;
}

export interface RoomState {
  appName: string;
  roomName: string;
  character: CharacterState;
  music: MusicContext;
  diarySummary: string;
  inspirationCount: number;
  studio: StudioSummary;
}

export interface ChatMessage {
  id: string;
  role: "user" | "kumiko";
  content: string;
}

export interface ProviderStatus {
  provider: "mock" | "deepseek";
  model: string | null;
  configured: boolean;
  label: string;
}

export interface MemoryEvent {
  id: string;
  category: MemoryCategory;
  text: string;
  confidence: number;
  createdAt: string;
}

export interface ChatRequest {
  message: string;
  roomState: RoomState;
  recentMessages?: ChatMessage[];
  personaStrength?: PersonaStrength;
  memoryEnabled?: boolean;
}

export interface ChatResponse {
  reply: ChatMessage;
  expression: CharacterState["expression"];
  suggestedActions: Array<"save_diary" | "save_inspiration" | "open_studio">;
  providerStatus: ProviderStatus;
  memoryEvents: MemoryEvent[];
}
```

- [ ] **Step 4: Update client mapping**

Modify `apps/web/src/api/client.ts`:

```ts
import type { ChatMessage, ChatRequest, ChatResponse, MemoryEvent, RoomState } from "./types";
```

In `postChat`, send the new fields:

```ts
export function postChat(payload: ChatRequest): Promise<ChatResponse> {
  return request<ChatResponseApi>("/api/room/chat", {
    method: "POST",
    body: JSON.stringify({
      message: payload.message,
      room_state: mapRoomStateToApi(payload.roomState),
      recent_messages: payload.recentMessages ?? [],
      persona_strength: payload.personaStrength ?? "medium",
      memory_enabled: payload.memoryEnabled ?? true
    })
  }).then(mapChatResponse);
}
```

Add memory functions:

```ts
export function getMemories(): Promise<MemoryEvent[]> {
  return request<MemoryEventApi[]>("/api/room/memory").then((items) => items.map(mapMemoryEvent));
}

export function deleteMemory(memoryId: string): Promise<void> {
  return request<void>(`/api/room/memory/${memoryId}`, { method: "DELETE" });
}

export function clearMemories(): Promise<void> {
  return request<void>("/api/room/memory", { method: "DELETE" });
}
```

Add API interfaces and mappers:

```ts
interface MemoryEventApi {
  id: string;
  category: MemoryEvent["category"];
  text: string;
  confidence: number;
  created_at: string;
}

interface ChatResponseApi {
  reply: ChatResponse["reply"];
  expression: ChatResponse["expression"];
  suggested_actions: ChatResponse["suggestedActions"];
  provider_status: ChatResponse["providerStatus"];
  memory_events: MemoryEventApi[];
}

function mapRoomStateToApi(value: RoomState): RoomStateApi {
  return {
    app_name: value.appName,
    room_name: value.roomName,
    character: {
      display_name: value.character.displayName,
      romanized_name: value.character.romanizedName,
      expression: value.character.expression,
      status_text: value.character.statusText
    },
    music: {
      current_track_title: value.music.currentTrackTitle,
      current_artist: value.music.currentArtist,
      listening_mood: value.music.listeningMood
    },
    diary_summary: value.diarySummary,
    inspiration_count: value.inspirationCount,
    studio: {
      label: value.studio.label,
      route: value.studio.route,
      unfinished_count: value.studio.unfinishedCount
    }
  };
}

function mapChatResponse(value: ChatResponseApi): ChatResponse {
  return {
    reply: value.reply,
    expression: value.expression,
    suggestedActions: value.suggested_actions,
    providerStatus: value.provider_status,
    memoryEvents: value.memory_events.map(mapMemoryEvent)
  };
}

function mapMemoryEvent(value: MemoryEventApi): MemoryEvent {
  return {
    id: value.id,
    category: value.category,
    text: value.text,
    confidence: value.confidence,
    createdAt: value.created_at
  };
}
```

- [ ] **Step 5: Run client tests**

Run:

```powershell
npm --prefix apps/web test -- client.test.ts
```

Expected: PASS.

- [ ] **Step 6: Commit**

```powershell
git add apps/web/src/api/types.ts apps/web/src/api/client.ts apps/web/tests/client.test.ts
git commit -m "feat: map chat provider and memory api"
```

---

### Task 7: Room UI Persona and Memory Controls

**Files:**
- Modify: `apps/web/src/components/RoomShell.tsx`
- Modify: `apps/web/tests/RoomShell.test.tsx`
- Modify: `apps/web/app/globals.css`

- [ ] **Step 1: Write failing RoomShell tests**

Modify the `"shows local music and connection status as calm utility panels"` test in `apps/web/tests/RoomShell.test.tsx` to include:

```tsx
    expect(screen.getByLabelText("AI 设置")).toBeTruthy();
    expect(screen.getByRole("button", { name: "中" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "强" })).toBeTruthy();
    expect(screen.getByRole("checkbox", { name: "自动记忆" })).toBeTruthy();
```

Modify the send test mock response:

```tsx
    apiMocks.postChat.mockResolvedValue({
      reply: { id: "api-reply", role: "kumiko", content: "嗯，我在听。" },
      expression: "thinking",
      suggestedActions: ["save_diary"],
      providerStatus: {
        provider: "deepseek",
        model: "deepseek-v4-flash",
        configured: true,
        label: "DeepSeek deepseek-v4-flash"
      },
      memoryEvents: [
        {
          id: "memory-1",
          category: "preference",
          text: "用户喜欢安静的钢琴。",
          confidence: 0.78,
          createdAt: "2026-06-06T00:00:00+00:00"
        }
      ]
    });
```

In the same test, click `强` and disable memory before sending:

```tsx
    fireEvent.click(screen.getByRole("button", { name: "强" }));
    fireEvent.click(screen.getByRole("checkbox", { name: "自动记忆" }));
```

Update expected payload:

```tsx
    expect(apiMocks.postChat).toHaveBeenCalledWith({
      message: "晚上好",
      roomState: DEFAULT_ROOM_STATE,
      recentMessages: expect.any(Array),
      personaStrength: "strong",
      memoryEnabled: false
    });
    expect(screen.getByText("DeepSeek deepseek-v4-flash")).toBeTruthy();
    expect(screen.getByText("用户喜欢安静的钢琴。")).toBeTruthy();
```

- [ ] **Step 2: Run the failing RoomShell test**

Run:

```powershell
npm --prefix apps/web test -- RoomShell.test.tsx
```

Expected: FAIL because the controls and new payload fields are missing.

- [ ] **Step 3: Update RoomShell state and request payload**

Modify imports in `apps/web/src/components/RoomShell.tsx`:

```tsx
import { FormEvent, useEffect, useState } from "react";
import type { ChatMessage, MemoryEvent, PersonaStrength, ProviderStatus, RoomState } from "../api/types";
```

Add state after `sendError`:

```tsx
  const [personaStrength, setPersonaStrength] = useState<PersonaStrength>("medium");
  const [memoryEnabled, setMemoryEnabled] = useState(true);
  const [providerStatus, setProviderStatus] = useState<ProviderStatus | null>(null);
  const [recentMemoryEvents, setRecentMemoryEvents] = useState<MemoryEvent[]>([]);

  useEffect(() => {
    const savedPersona = window.localStorage.getItem("kumikoroom.personaStrength");
    if (savedPersona === "medium" || savedPersona === "strong") {
      setPersonaStrength(savedPersona);
    }

    const savedMemoryEnabled = window.localStorage.getItem("kumikoroom.memoryEnabled");
    if (savedMemoryEnabled === "false") {
      setMemoryEnabled(false);
    }
  }, []);

  useEffect(() => {
    window.localStorage.setItem("kumikoroom.personaStrength", personaStrength);
  }, [personaStrength]);

  useEffect(() => {
    window.localStorage.setItem("kumikoroom.memoryEnabled", String(memoryEnabled));
  }, [memoryEnabled]);
```

Update `postChat` call:

```tsx
      const response = await postChat({
        message,
        roomState: initialState,
        recentMessages: messages.slice(-8),
        personaStrength,
        memoryEnabled
      });
      setProviderStatus(response.providerStatus);
      setRecentMemoryEvents(response.memoryEvents);
```

- [ ] **Step 4: Add the AI settings card**

Inside `<aside className="workspace-side">`, after the local music status section, add:

```tsx
        <section className="workspace-card ai-card" aria-label="AI 设置">
          <p className="eyebrow">AI</p>
          <h2>模型与记忆</h2>
          <div className="utility-row">
            <span>模型连接</span>
            <strong>{providerStatus?.label ?? connectionStatus.label}</strong>
          </div>
          <div className="ai-setting-row">
            <span>人设强度</span>
            <div className="segmented-control" role="group" aria-label="人设强度">
              <button
                type="button"
                aria-pressed={personaStrength === "medium"}
                onClick={() => setPersonaStrength("medium")}
              >
                中
              </button>
              <button
                type="button"
                aria-pressed={personaStrength === "strong"}
                onClick={() => setPersonaStrength("strong")}
              >
                强
              </button>
            </div>
          </div>
          <label className="memory-toggle">
            <input
              type="checkbox"
              checked={memoryEnabled}
              onChange={(event) => setMemoryEnabled(event.target.checked)}
            />
            自动记忆
          </label>
          <div className="memory-events" aria-label="最近记住的内容">
            {recentMemoryEvents.length === 0 ? (
              <p>还没有新的记忆。</p>
            ) : (
              recentMemoryEvents.map((event) => <p key={event.id}>{event.text}</p>)
            )}
          </div>
        </section>
```

- [ ] **Step 5: Add styles**

Append to `apps/web/app/globals.css` near the utility card styles:

```css
.ai-card {
  display: grid;
  gap: 12px;
  padding: 24px;
}

.ai-setting-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 14px;
  padding: 13px 14px;
  border: 1px solid var(--color-line);
  border-radius: 8px;
  background: var(--color-surface-strong);
}

.ai-setting-row > span {
  color: var(--color-muted);
}

.segmented-control {
  display: inline-grid;
  grid-template-columns: repeat(2, 44px);
  gap: 4px;
  padding: 4px;
  border: 1px solid var(--color-line);
  border-radius: 8px;
  background: var(--color-fog-soft);
}

.segmented-control button {
  min-height: 34px;
  border-color: transparent;
  background: transparent;
  font-weight: 800;
}

.segmented-control button[aria-pressed="true"] {
  background: var(--color-surface-strong);
  color: var(--color-rose);
  box-shadow: var(--shadow-tight);
}

.memory-toggle {
  display: flex;
  align-items: center;
  gap: 10px;
  color: var(--color-text);
  font-weight: 700;
}

.memory-toggle input {
  width: 18px;
  height: 18px;
  accent-color: var(--color-rose);
}

.memory-events {
  display: grid;
  gap: 8px;
}

.memory-events p {
  margin-bottom: 0;
  color: var(--color-muted);
}
```

- [ ] **Step 6: Run RoomShell tests**

Run:

```powershell
npm --prefix apps/web test -- RoomShell.test.tsx
```

Expected: PASS.

- [ ] **Step 7: Commit**

```powershell
git add apps/web/src/components/RoomShell.tsx apps/web/tests/RoomShell.test.tsx apps/web/app/globals.css
git commit -m "feat: add room ai settings"
```

---

### Task 8: Documentation and Environment Template

**Files:**
- Create: `.env.example`
- Modify: `README.md`

- [ ] **Step 1: Create the safe environment template**

Create `.env.example`:

```env
KUMIKOROOM_LLM_PROVIDER=deepseek
DEEPSEEK_API_KEY=
DEEPSEEK_MODEL=deepseek-v4-flash
DEEPSEEK_BASE_URL=https://api.deepseek.com
KUMIKOROOM_MEMORY_DB_PATH=user-data/memory/kumikoroom-memory.sqlite3
NEXT_PUBLIC_KUMIKOROOM_API_BASE_URL=http://127.0.0.1:8000
```

- [ ] **Step 2: Update README DeepSeek setup**

Modify `README.md` to include:

````markdown
## DeepSeek Chat Setup

KumikoRoom uses DeepSeek for the first real LLM provider. Keep credentials local.

1. Copy `.env.example` to `.env.local` or set the same variables in your shell.
2. Set `DEEPSEEK_API_KEY` locally.
3. Keep `DEEPSEEK_MODEL=deepseek-v4-flash` unless you want to test `deepseek-v4-pro`.
4. Start the API and web app.

PowerShell API example:

```powershell
$env:KUMIKOROOM_LLM_PROVIDER="deepseek"
$env:DEEPSEEK_API_KEY="<your-local-key>"
$env:DEEPSEEK_MODEL="deepseek-v4-flash"
cd apps\api
uvicorn kumikoroom.main:app --reload --port 8000
```

The repository ignores `.env`, `.env.local`, `user-data/`, and `*.sqlite3`.
````

- [ ] **Step 3: Run secret scan**

Run:

```powershell
git grep -I -E "sk-[A-Za-z0-9]{20,}" HEAD -- .
```

Expected: no output and exit code 1.

- [ ] **Step 4: Commit**

```powershell
git add .env.example README.md
git commit -m "docs: add deepseek setup"
```

---

### Task 9: Full Verification and Local Acceptance

**Files:**
- No source files should change unless verification exposes a specific issue.

- [ ] **Step 1: Run backend tests**

Run:

```powershell
cd apps\api
python -m pytest
```

Expected: PASS for all API tests.

- [ ] **Step 2: Run web tests**

Run:

```powershell
npm --prefix apps/web test
```

Expected: PASS for all web tests.

- [ ] **Step 3: Run web build**

Run:

```powershell
npm --prefix apps/web run build
```

Expected: PASS and routes include `/`, `/room`, and `/studio`.

- [ ] **Step 4: Run mock-mode HTTP smoke test**

Start API without `DEEPSEEK_API_KEY`, then call:

```powershell
Invoke-WebRequest -UseBasicParsing `
  -Method POST `
  -ContentType "application/json" `
  -Body '{"message":"晚上好","persona_strength":"strong","memory_enabled":true}' `
  http://127.0.0.1:8000/api/room/chat
```

Expected:

- HTTP 200.
- `provider_status.provider` is `mock`.
- Reply includes the user message.

- [ ] **Step 5: Run DeepSeek-mode HTTP smoke test with local key**

Set the key only in the current shell:

```powershell
$env:KUMIKOROOM_LLM_PROVIDER="deepseek"
$env:DEEPSEEK_API_KEY="<local key already provided outside source control>"
$env:DEEPSEEK_MODEL="deepseek-v4-flash"
```

Start API, then call:

```powershell
Invoke-WebRequest -UseBasicParsing `
  -Method POST `
  -ContentType "application/json" `
  -Body '{"message":"晚上好，今天想听一首安静的歌。","persona_strength":"strong","memory_enabled":true}' `
  http://127.0.0.1:8000/api/room/chat
```

Expected:

- HTTP 200.
- `provider_status.provider` is `deepseek`.
- `provider_status.model` is `deepseek-v4-flash`.
- Reply is generated by DeepSeek.
- `memory_events` includes a `diary` or `preference` item when extractor rules match.

- [ ] **Step 6: Browser acceptance**

Open:

```text
http://127.0.0.1:3000/room
```

Expected:

- AI settings card is visible.
- Persona can switch between `中` and `强`.
- Automatic memory can be toggled.
- Sending a message updates the chat.
- DeepSeek status appears after a successful DeepSeek-backed reply.
- Newly saved memory text appears in the AI settings card.
- No API key appears in the UI, logs, screenshots, or committed files.

- [ ] **Step 7: Final git checks**

Run:

```powershell
git status --short
git grep -I -E "sk-[A-Za-z0-9]{20,}" HEAD -- .
```

Expected:

- `git status --short` is empty.
- secret scan has no matches.

---

## Self-Review

- Spec coverage: Tasks cover DeepSeek provider, provider status, persona medium/strong, strong identity with restraint, automatic medium-sensitivity memory, local memory storage, memory management endpoints, frontend controls, docs, mock fallback, and future-safe manager boundaries.
- Placeholder scan: The plan contains no placeholder steps, no committed API key, and no instruction to place a secret in tracked files.
- Type consistency: Backend `persona_strength`, `provider_status`, and `memory_events` map to frontend `personaStrength`, `providerStatus`, and `memoryEvents`.
- Scope check: The plan builds Conversation Manager MVP only. Streaming, tool execution, embeddings, and multi-step agent loops remain future expansion points.

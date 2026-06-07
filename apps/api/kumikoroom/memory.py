import re
import sqlite3
import uuid
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path
from typing import Literal


MemoryCategory = Literal["preference", "diary", "creative_note", "profile_fact"]


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


_VALID_CATEGORIES: tuple[MemoryCategory, ...] = (
    "preference",
    "diary",
    "creative_note",
    "profile_fact",
)
_SECRET_PATTERNS: tuple[re.Pattern[str], ...] = (
    re.compile(r"sk-[A-Za-z0-9]{16,}"),
    re.compile(
        r"(api[\s_]*key|apikey|密码|口令|token|密钥|(?<![A-Za-z0-9])key(?![A-Za-z0-9]))",
        re.IGNORECASE,
    ),
)
_CLAUSE_SPLIT_RE = re.compile(r"[，。！？；,.!?;\n]+")
_WHITESPACE_RE = re.compile(r"\s+")


class MemoryStore:
    def __init__(self, db_path: Path | str) -> None:
        self._db_path = Path(db_path)
        self._db_path.parent.mkdir(parents=True, exist_ok=True)
        self._initialize_schema()

    def save(
        self,
        *,
        category: MemoryCategory,
        text: str,
        confidence: float,
        source: str,
    ) -> MemoryRecord:
        if category not in _VALID_CATEGORIES:
            raise ValueError(f"Unknown memory category: {category}")

        memory_id = str(uuid.uuid4())
        clean_text = text.strip()
        clean_source = source.strip()
        clean_confidence = round(float(confidence), 2)
        created_at = datetime.now(timezone.utc).isoformat()

        connection = self._connect()
        try:
            connection.execute(
                """
                INSERT INTO memories (id, category, text, confidence, source, created_at)
                VALUES (?, ?, ?, ?, ?, ?)
                """,
                (
                    memory_id,
                    category,
                    clean_text,
                    clean_confidence,
                    clean_source,
                    created_at,
                ),
            )
            connection.commit()
        finally:
            connection.close()

        return MemoryRecord(
            id=memory_id,
            category=category,
            text=clean_text,
            confidence=clean_confidence,
            source=clean_source,
            created_at=created_at,
        )

    def list_recent(self, *, limit: int = 20) -> list[MemoryRecord]:
        connection = self._connect()
        try:
            rows = connection.execute(
                """
                SELECT id, category, text, confidence, source, created_at
                FROM memories
                ORDER BY created_at DESC, rowid DESC
                LIMIT ?
                """,
                (max(0, int(limit)),),
            ).fetchall()
        finally:
            connection.close()

        return [self._record_from_row(row) for row in rows]

    def delete(self, memory_id: str) -> bool:
        connection = self._connect()
        try:
            cursor = connection.execute(
                "DELETE FROM memories WHERE id = ?",
                (memory_id,),
            )
            connection.commit()
            return cursor.rowcount > 0
        finally:
            connection.close()

    def clear(self) -> None:
        connection = self._connect()
        try:
            connection.execute("DELETE FROM memories")
            connection.commit()
        finally:
            connection.close()

    def _initialize_schema(self) -> None:
        connection = self._connect()
        try:
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
            connection.commit()
        finally:
            connection.close()

    def _connect(self) -> sqlite3.Connection:
        connection = sqlite3.connect(self._db_path)
        connection.row_factory = sqlite3.Row
        return connection

    @staticmethod
    def _record_from_row(row: sqlite3.Row) -> MemoryRecord:
        return MemoryRecord(
            id=row["id"],
            category=row["category"],
            text=row["text"],
            confidence=row["confidence"],
            source=row["source"],
            created_at=row["created_at"],
        )


def extract_memories(user_message: str, assistant_reply: str) -> list[NewMemory]:
    del assistant_reply

    source = _normalize_spaces(user_message)
    if not source or _contains_secret(source):
        return []

    candidates: list[NewMemory] = []

    preference_text = _preference_text(source)
    if preference_text:
        candidates.append(
            NewMemory(
                category="preference",
                text=preference_text,
                confidence=0.82,
                source=source,
            )
        )

    diary_text = _diary_text(source)
    if diary_text:
        candidates.append(
            NewMemory(
                category="diary",
                text=diary_text,
                confidence=0.78,
                source=source,
            )
        )

    creative_text = _creative_note_text(source)
    if creative_text:
        candidates.append(
            NewMemory(
                category="creative_note",
                text=creative_text,
                confidence=0.8,
                source=source,
            )
        )

    profile_text = _profile_fact_text(source)
    if profile_text:
        candidates.append(
            NewMemory(
                category="profile_fact",
                text=profile_text,
                confidence=0.8,
                source=source,
            )
        )

    return _deduplicate(candidates)


def _contains_secret(text: str) -> bool:
    return any(pattern.search(text) for pattern in _SECRET_PATTERNS)


def _preference_text(source: str) -> str | None:
    trigger = _first_trigger(source, ("不喜欢", "喜欢", "偏好", "希望你", "更想要"))
    if not trigger:
        return None

    clause = _clause_from_trigger(source, trigger)
    if not clause:
        return None

    if clause.startswith(("我", "俺", "本人")):
        clause = clause[1:].strip()
    return _memory_sentence(f"用户{clause}")


def _diary_text(source: str) -> str | None:
    trigger = _first_trigger(source, ("今天", "听歌", "心情", "日记"))
    if not trigger:
        return None

    clause = _clause_containing(source, trigger)
    if not clause:
        return None

    return _memory_sentence(f"用户日记：{_strip_soft_prefixes(clause)}")


def _creative_note_text(source: str) -> str | None:
    trigger = _first_trigger(
        source,
        ("demo", "Demo", "FLP", "工程", "歌词", "旋律", "编曲", "创作"),
    )
    if not trigger:
        return None

    clause = _clause_containing(source, trigger)
    if not clause:
        return None

    return _memory_sentence(f"用户创作记录：{_strip_soft_prefixes(clause)}")


def _profile_fact_text(source: str) -> str | None:
    trigger = _first_trigger(source, ("我叫", "我是", "我的项目", "我的工作流"))
    if not trigger:
        return None

    clause = _clause_from_trigger(source, trigger)
    if not clause:
        return None

    return _memory_sentence(f"用户资料：{clause}")


def _first_trigger(source: str, triggers: tuple[str, ...]) -> str | None:
    best_trigger = None
    best_index = len(source)
    for trigger in triggers:
        index = source.find(trigger)
        if index != -1 and index < best_index:
            best_trigger = trigger
            best_index = index
    return best_trigger


def _clause_from_trigger(source: str, trigger: str) -> str:
    start = source.find(trigger)
    if start == -1:
        return ""
    tail = source[start:]
    return _normalize_clause(_CLAUSE_SPLIT_RE.split(tail, maxsplit=1)[0])


def _clause_containing(source: str, trigger: str) -> str:
    for clause in _CLAUSE_SPLIT_RE.split(source):
        normalized = _normalize_clause(clause)
        if trigger in normalized:
            return normalized
    return ""


def _normalize_clause(text: str) -> str:
    return _normalize_spaces(text).strip(" ：:，。！？；,.!?;")


def _strip_soft_prefixes(text: str) -> str:
    text = text.strip()
    while text.startswith(("我", "也", "然后", "另外", "还想", "想")):
        if text.startswith("然后"):
            text = text[2:].strip()
        elif text.startswith("另外"):
            text = text[2:].strip()
        elif text.startswith("还想"):
            text = text[2:].strip()
        else:
            text = text[1:].strip()
    return text


def _memory_sentence(text: str) -> str:
    text = _normalize_clause(text)
    if not text:
        return ""
    if text.endswith(("。", "！", "？", ".", "!", "?")):
        return text
    return f"{text}。"


def _normalize_spaces(text: str) -> str:
    return _WHITESPACE_RE.sub(" ", text.strip())


def _deduplicate(memories: list[NewMemory]) -> list[NewMemory]:
    seen: set[tuple[MemoryCategory, str]] = set()
    unique: list[NewMemory] = []
    for memory in memories:
        key = (memory.category, memory.text)
        if key in seen:
            continue
        seen.add(key)
        unique.append(memory)
    return unique

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
    re.compile(r"sk-(?:proj-)?[A-Za-z0-9_-]{16,}"),
    re.compile(r"Bearer\s+[A-Za-z0-9._~+/=-]{16,}", re.IGNORECASE),
    re.compile(r"ghp_[A-Za-z0-9_]{20,}"),
    re.compile(r"AKIA[0-9A-Z]{16}"),
    re.compile(
        r"(?<![A-Za-z0-9_-])"
        r"[A-Za-z0-9_-]{16,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}"
        r"(?![A-Za-z0-9_-])"
    ),
)
_CREDENTIAL_CONTEXT_RE = re.compile(
    r"(?<![A-Za-z0-9_])"
    r"(?P<label>password|secret|token|api[\s_-]*key|apikey|密码|口令|密钥)"
    r"(?![A-Za-z0-9_])"
    r"\s*(?P<operator>[:=：]|is|是)?\s*"
    r"(?P<value>[A-Za-z0-9._~+/=-]{3,})",
    re.IGNORECASE,
)
_KEY_ASSIGNMENT_RE = re.compile(
    r"(?<![A-Za-z0-9])"
    r"(?P<api_prefix>api[\s_-]*)?key"
    r"(?![A-Za-z0-9])"
    r"\s*(?:[:=：]|is|是)\s*"
    r"(?P<value>[A-Za-z0-9._~+/=#-]{2,})",
    re.IGNORECASE,
)
_MUSICAL_KEY_VALUE_RE = re.compile(
    r"[A-G](?:#|b)?(?:major|minor|maj|min)?",
    re.IGNORECASE,
)
_MUSIC_CONTEXT_TERMS = (
    "歌",
    "音乐",
    "旋律",
    "编曲",
    "和弦",
    "调",
    "major",
    "minor",
    "cmajor",
    "f#",
)
_PREFERENCE_TRIGGERS = ("不喜欢", "喜欢", "偏好", "希望你", "更想要")
_CREATIVE_TRIGGERS = ("demo", "Demo", "FLP", "工程", "歌词", "旋律", "编曲", "创作")
_PROFILE_TRIGGERS = ("我叫", "我的项目", "我的工作流")
_TRANSIENT_TERMS = (
    "接口",
    "按钮",
    "没反应",
    "报错",
    "刚才",
    "页面",
    "请求",
    "链接",
)
_QUESTION_TERMS = ("怎么", "如何", "为什么", "吗", "?", "？")
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
    if _is_transient_message(source):
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
    if any(pattern.search(text) for pattern in _SECRET_PATTERNS):
        return True
    if _contains_key_assignment_secret(text):
        return True
    return _contains_credential_context_secret(text)


def _contains_key_assignment_secret(text: str) -> bool:
    for match in _KEY_ASSIGNMENT_RE.finditer(text):
        if match.group("api_prefix"):
            return True

        value = match.group("value")
        if _has_music_context(text) and _looks_like_musical_key_value(value):
            continue
        return True
    return False


def _contains_credential_context_secret(text: str) -> bool:
    for match in _CREDENTIAL_CONTEXT_RE.finditer(text):
        label = match.group("label").lower().replace("_", "").replace("-", "")
        label = label.replace(" ", "")
        if match.group("operator") or label in {"apikey", "密钥"}:
            return True
        if _looks_like_credential_value(match.group("value")):
            return True
    return False


def _has_music_context(text: str) -> bool:
    folded = text.lower()
    return any(term in folded for term in _MUSIC_CONTEXT_TERMS)


def _looks_like_musical_key_value(value: str) -> bool:
    return bool(_MUSICAL_KEY_VALUE_RE.fullmatch(value.strip()))


def _looks_like_credential_value(value: str) -> bool:
    value = value.strip(".,;!?，。！？；")
    if any(pattern.fullmatch(value) for pattern in _SECRET_PATTERNS):
        return True
    if len(value) < 12:
        return False

    has_letter = any(character.isalpha() for character in value)
    has_digit = any(character.isdigit() for character in value)
    has_symbol = any(character in "._~+/=-" for character in value)
    return has_letter and (has_digit or has_symbol)


def _is_transient_message(source: str) -> bool:
    has_persistent_signal = _has_preference_creative_or_profile_signal(source)
    if has_persistent_signal:
        return False

    if source.startswith("我是说"):
        return True

    has_question = source.endswith(("?", "？")) or any(
        term in source for term in _QUESTION_TERMS
    )
    if has_question:
        return True

    return any(term in source for term in _TRANSIENT_TERMS)


def _has_preference_creative_or_profile_signal(source: str) -> bool:
    if _first_trigger(source, _PREFERENCE_TRIGGERS + _CREATIVE_TRIGGERS):
        return True
    return bool(_profile_clause(source))


def _preference_text(source: str) -> str | None:
    trigger = _first_trigger(source, _PREFERENCE_TRIGGERS)
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
    trigger = _first_trigger(source, _CREATIVE_TRIGGERS)
    if not trigger:
        return None

    clause = _clause_containing(source, trigger)
    if not clause:
        return None

    return _memory_sentence(f"用户创作记录：{_strip_soft_prefixes(clause)}")


def _profile_fact_text(source: str) -> str | None:
    clause = _profile_clause(source)
    if not clause:
        return None

    return _memory_sentence(f"用户资料：{clause}")


def _profile_clause(source: str) -> str:
    trigger_start: int | None = None
    for trigger in _PROFILE_TRIGGERS:
        start = source.find(trigger)
        if start != -1 and (trigger_start is None or start < trigger_start):
            trigger_start = start

    start = source.find("我是")
    while start != -1:
        if not source.startswith("我是说", start) and (
            trigger_start is None or start < trigger_start
        ):
            trigger_start = start
            break
        start = source.find("我是", start + len("我是"))

    if trigger_start is None:
        return ""

    return _clause_from_start(source, trigger_start)


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
    return _clause_from_start(source, start)


def _clause_from_start(source: str, start: int) -> str:
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

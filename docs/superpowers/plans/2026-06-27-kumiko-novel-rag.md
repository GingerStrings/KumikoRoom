# Kumiko Novel RAG Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add local novel-backed RAG and a tighter Kumiko persona logic card so source-detail answers are grounded and everyday replies stay character-consistent.

**Architecture:** Add a backend-only `novel_rag.py` module for EPUB extraction, local SQLite FTS5 indexing, LLM-driven RAG intent routing, and prompt-context formatting. Wire it into `ConversationManager` through an optional `NovelRagRouter`/`NovelRagStore` pair that silently skips when routing or search is unavailable. Keep frontend and chat request schemas unchanged for this slice.

**Tech Stack:** Python 3.11, FastAPI backend, standard-library `zipfile`, `xml.etree.ElementTree`, `sqlite3` with FTS5, pytest.

---

## File Structure

- Create `apps/api/kumikoroom/novel_rag.py`
  - Owns novel chunk data classes, EPUB discovery/extraction, SQLite FTS5 schema, search, LLM RAG router, prompt-context formatting, rebuild command.
- Modify `apps/api/kumikoroom/config.py`
  - Adds local RAG defaults and env-backed settings.
- Modify `apps/api/kumikoroom/conversation.py`
  - Adds optional `NovelRagRouter` and `NovelRagStore` collaborators, then appends formatted novel context after user memory when the router opts in.
- Modify `apps/api/kumikoroom/persona.py`
  - Adds a compact always-on speaking logic card to the existing core prompt.
- Modify `apps/api/tests/conftest.py`
  - Isolates novel RAG environment variables and DB path during tests.
- Modify `apps/api/tests/test_config.py`
  - Covers new defaults and env overrides.
- Create `apps/api/tests/test_novel_rag.py`
  - Covers fixture EPUB extraction, indexing, search, LLM router/parser, formatter, and rebuild stats.
- Modify `apps/api/tests/test_conversation.py`
  - Covers prompt assembly with RAG hits, router skips, disabled/missing index, route failure fallback, and search failure fallback.
- Modify `apps/api/tests/test_persona.py`
  - Covers persona logic card and updated compact prompt size.
- Modify `.env.example`
  - Documents optional local RAG env variables without committing local novel paths as required config.
- Modify `README.zh-CN.md` and `README.md`
  - Adds short local-only rebuild instructions.

## Task 1: Configuration and Test Isolation

**Files:**
- Modify: `apps/api/kumikoroom/config.py`
- Modify: `apps/api/tests/conftest.py`
- Modify: `apps/api/tests/test_config.py`
- Modify: `.env.example`

- [x] **Step 1: Write failing config tests**

Append these tests to `apps/api/tests/test_config.py`:

```python
def test_novel_rag_defaults_to_local_paths(monkeypatch) -> None:
    monkeypatch.delenv("KUMIKOROOM_NOVEL_CORPUS_DIR", raising=False)
    monkeypatch.delenv("KUMIKOROOM_NOVEL_RAG_DB_PATH", raising=False)
    monkeypatch.delenv("KUMIKOROOM_NOVEL_RAG_ENABLED", raising=False)

    settings = load_settings()

    assert settings.novel_corpus_dir == Path(r"D:\555\codex\jc")
    assert settings.novel_rag_db_path == Path("user-data/rag/kumiko-novels.sqlite3")
    assert settings.novel_rag_enabled is True


def test_novel_rag_paths_can_be_overridden(monkeypatch, tmp_path: Path) -> None:
    corpus_dir = tmp_path / "jc"
    rag_path = tmp_path / "rag.sqlite3"
    monkeypatch.setenv("KUMIKOROOM_NOVEL_CORPUS_DIR", str(corpus_dir))
    monkeypatch.setenv("KUMIKOROOM_NOVEL_RAG_DB_PATH", str(rag_path))

    settings = load_settings()

    assert settings.novel_corpus_dir == corpus_dir
    assert settings.novel_rag_db_path == rag_path


@pytest.mark.parametrize(
    ("raw_value", "expected"),
    [
        ("1", True),
        ("true", True),
        ("yes", True),
        ("on", True),
        ("0", False),
        ("false", False),
        ("no", False),
        ("off", False),
    ],
)
def test_novel_rag_enabled_parses_boolean_values(
    monkeypatch,
    raw_value: str,
    expected: bool,
) -> None:
    monkeypatch.setenv("KUMIKOROOM_NOVEL_RAG_ENABLED", raw_value)

    settings = load_settings()

    assert settings.novel_rag_enabled is expected


def test_invalid_novel_rag_enabled_raises_value_error(monkeypatch) -> None:
    monkeypatch.setenv("KUMIKOROOM_NOVEL_RAG_ENABLED", "maybe")

    with pytest.raises(ValueError, match="KUMIKOROOM_NOVEL_RAG_ENABLED"):
        load_settings()
```

- [x] **Step 2: Run config tests to verify they fail**

Run:

```powershell
cd apps\api
python -m pytest tests/test_config.py -q
```

Expected: FAIL with `AttributeError` for `novel_corpus_dir`, `novel_rag_db_path`, or `novel_rag_enabled`.

- [x] **Step 3: Add settings fields and parser**

In `apps/api/kumikoroom/config.py`, add these constants near the existing defaults:

```python
DEFAULT_NOVEL_CORPUS_DIR = Path(r"D:\555\codex\jc")
DEFAULT_NOVEL_RAG_DB_PATH = Path("user-data/rag/kumiko-novels.sqlite3")
```

Extend `ApiSettings`:

```python
@dataclass(frozen=True)
class ApiSettings:
    llm_provider: LlmProvider
    deepseek_api_key: str | None
    deepseek_model: str
    deepseek_base_url: str
    memory_db_path: Path
    novel_corpus_dir: Path
    novel_rag_db_path: Path
    novel_rag_enabled: bool
```

Add the new values inside `load_settings()`:

```python
        novel_corpus_dir=Path(
            _env_value("KUMIKOROOM_NOVEL_CORPUS_DIR") or DEFAULT_NOVEL_CORPUS_DIR
        ),
        novel_rag_db_path=Path(
            _env_value("KUMIKOROOM_NOVEL_RAG_DB_PATH")
            or DEFAULT_NOVEL_RAG_DB_PATH
        ),
        novel_rag_enabled=_env_bool("KUMIKOROOM_NOVEL_RAG_ENABLED", True),
```

Add this helper below `_explicit_env_value()`:

```python
def _env_bool(name: str, default: bool) -> bool:
    raw_value = _env_value(name)
    if raw_value is None:
        return default

    normalized = raw_value.lower()
    if normalized in {"1", "true", "yes", "on"}:
        return True
    if normalized in {"0", "false", "no", "off"}:
        return False
    raise ValueError(
        f"{name} must be one of 1, true, yes, on, 0, false, no, or off"
    )
```

- [x] **Step 4: Isolate RAG env vars in tests**

In `apps/api/tests/conftest.py`, extend the env deletion loop:

```python
        "KUMIKOROOM_NOVEL_CORPUS_DIR",
        "KUMIKOROOM_NOVEL_RAG_DB_PATH",
        "KUMIKOROOM_NOVEL_RAG_ENABLED",
```

Then set test-only RAG paths after the memory DB path:

```python
    monkeypatch.setenv(
        "KUMIKOROOM_NOVEL_CORPUS_DIR",
        str(tmp_path / "jc"),
    )
    monkeypatch.setenv(
        "KUMIKOROOM_NOVEL_RAG_DB_PATH",
        str(tmp_path / "rag.sqlite3"),
    )
```

- [x] **Step 5: Document env variables**

Append this block to `.env.example`:

```text
# Optional local novel RAG. Keep indexes and source material local.
KUMIKOROOM_NOVEL_CORPUS_DIR=D:\555\codex\jc
KUMIKOROOM_NOVEL_RAG_DB_PATH=user-data/rag/kumiko-novels.sqlite3
KUMIKOROOM_NOVEL_RAG_ENABLED=true
```

- [x] **Step 6: Run config tests to verify they pass**

Run:

```powershell
cd apps\api
python -m pytest tests/test_config.py -q
```

Expected: PASS.

- [x] **Step 7: Commit**

```powershell
git add apps/api/kumikoroom/config.py apps/api/tests/conftest.py apps/api/tests/test_config.py .env.example
git commit -m "feat: add novel RAG settings"
```

## Task 2: EPUB Discovery and Extraction

**Files:**
- Create: `apps/api/kumikoroom/novel_rag.py`
- Create: `apps/api/tests/test_novel_rag.py`

- [x] **Step 1: Write failing EPUB extraction tests**

Create `apps/api/tests/test_novel_rag.py` with:

```python
from pathlib import Path
from zipfile import ZIP_DEFLATED, ZipFile

import pytest

from kumikoroom.novel_rag import (
    NovelChunk,
    discover_epubs,
    extract_epub_chunks,
)


def write_epub(path: Path, chapters: dict[str, str]) -> None:
    with ZipFile(path, "w", ZIP_DEFLATED) as archive:
        archive.writestr("mimetype", "application/epub+zip")
        archive.writestr("META-INF/container.xml", "<container />")
        for chapter_path, body in chapters.items():
            archive.writestr(chapter_path, body)


def test_discover_epubs_returns_only_sorted_epubs(tmp_path: Path) -> None:
    (tmp_path / "note.pdf").write_text("ignore", encoding="utf-8")
    (tmp_path / "02.second.epub").write_bytes(b"epub")
    (tmp_path / "01.first.epub").write_bytes(b"epub")

    assert [path.name for path in discover_epubs(tmp_path)] == [
        "01.first.epub",
        "02.second.epub",
    ]


def test_discover_epubs_missing_directory_returns_empty_list(tmp_path: Path) -> None:
    assert discover_epubs(tmp_path / "missing") == []


def test_extract_epub_chunks_reads_ordered_xhtml_text(tmp_path: Path) -> None:
    epub_path = tmp_path / "01.fixture.epub"
    write_epub(
        epub_path,
        {
            "OEBPS/Text/chapter1.xhtml": """
                <html xmlns="http://www.w3.org/1999/xhtml">
                  <body>
                    <h1>第一章</h1>
                    <p>久美子先看着大家，没有立刻插话。</p>
                    <p>她想了一下，才用很平的声音回答。</p>
                  </body>
                </html>
            """,
            "OEBPS/Text/chapter2.xhtml": """
                <html xmlns="http://www.w3.org/1999/xhtml">
                  <body>
                    <h1>第二章</h1>
                    <p>丽奈提到合奏的时候，久美子没有把话说得太满。</p>
                  </body>
                </html>
            """,
        },
    )

    chunks = extract_epub_chunks(
        epub_path,
        source_id="01-fixture",
        source_title="Fixture Novel",
        max_chars=80,
    )

    assert [chunk.chapter_path for chunk in chunks] == [
        "OEBPS/Text/chapter1.xhtml",
        "OEBPS/Text/chapter2.xhtml",
    ]
    assert chunks[0].source_id == "01-fixture"
    assert chunks[0].source_title == "Fixture Novel"
    assert chunks[0].chapter_title == "第一章"
    assert "久美子先看着大家" in chunks[0].text
    assert "丽奈提到合奏" in chunks[1].text


def test_extract_epub_chunks_uses_fallback_for_malformed_xhtml(tmp_path: Path) -> None:
    epub_path = tmp_path / "broken.epub"
    write_epub(
        epub_path,
        {
            "OEBPS/Text/chapter.xhtml": (
                "<html><body><p>久美子没有急着接话。<p>这段 XHTML 没有闭合。"
            ),
        },
    )

    chunks = extract_epub_chunks(
        epub_path,
        source_id="broken",
        source_title="Broken",
        max_chars=80,
    )

    assert len(chunks) == 1
    assert "久美子没有急着接话" in chunks[0].text
```

- [x] **Step 2: Run tests to verify module is missing**

Run:

```powershell
cd apps\api
python -m pytest tests/test_novel_rag.py -q
```

Expected: FAIL with `ModuleNotFoundError: No module named 'kumikoroom.novel_rag'`.

- [x] **Step 3: Add data model and EPUB helpers**

Create `apps/api/kumikoroom/novel_rag.py` with:

```python
from __future__ import annotations

import html
import re
import sqlite3
import sys
from argparse import ArgumentParser
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path
from typing import Sequence
from xml.etree import ElementTree
from zipfile import BadZipFile, ZipFile


@dataclass(frozen=True)
class NovelChunk:
    source_id: str
    source_title: str
    source_path: str
    chapter_path: str
    chapter_title: str
    chunk_index: int
    text: str


@dataclass(frozen=True)
class NovelSearchResult:
    source_id: str
    source_title: str
    chapter_path: str
    chapter_title: str
    chunk_index: int
    text: str
    rank: float


@dataclass(frozen=True)
class NovelIndexStats:
    source_count: int
    chunk_count: int
    skipped_files: tuple[str, ...] = ()
    errors: tuple[str, ...] = ()


_TEXT_EXTENSIONS = (".xhtml", ".html", ".htm")
_WHITESPACE_RE = re.compile(r"\s+")
_TAG_RE = re.compile(r"<[^>]+>")
_SCRIPT_STYLE_RE = re.compile(
    r"<(script|style)\b[^>]*>.*?</\1>",
    re.IGNORECASE | re.DOTALL,
)


def discover_epubs(corpus_dir: Path) -> list[Path]:
    if not corpus_dir.exists() or not corpus_dir.is_dir():
        return []
    return sorted(
        path
        for path in corpus_dir.iterdir()
        if path.is_file() and path.suffix.lower() == ".epub"
    )


def extract_epub_chunks(
    epub_path: Path,
    *,
    source_id: str,
    source_title: str,
    max_chars: int = 700,
) -> list[NovelChunk]:
    chunks: list[NovelChunk] = []
    chunk_index = 0
    with ZipFile(epub_path) as archive:
        chapter_paths = sorted(
            name
            for name in archive.namelist()
            if name.lower().endswith(_TEXT_EXTENSIONS)
        )
        for chapter_path in chapter_paths:
            raw = archive.read(chapter_path)
            chapter_title, paragraphs = _extract_xhtml_paragraphs(raw)
            for text in _chunk_paragraphs(paragraphs, max_chars=max_chars):
                chunks.append(
                    NovelChunk(
                        source_id=source_id,
                        source_title=source_title,
                        source_path=str(epub_path),
                        chapter_path=chapter_path,
                        chapter_title=chapter_title or _chapter_title_from_path(
                            chapter_path
                        ),
                        chunk_index=chunk_index,
                        text=text,
                    )
                )
                chunk_index += 1
    return chunks


def _extract_xhtml_paragraphs(raw: bytes) -> tuple[str, list[str]]:
    decoded = raw.decode("utf-8", errors="ignore")
    try:
        root = ElementTree.fromstring(decoded)
    except ElementTree.ParseError:
        paragraphs = _fallback_extract_paragraphs(decoded)
        return _first_text(paragraphs), paragraphs

    paragraphs: list[str] = []
    title = ""
    for element in root.iter():
        tag = _local_name(element.tag)
        if tag in {"script", "style"}:
            continue
        if tag in {"h1", "h2", "h3"}:
            text = _normalize_text("".join(element.itertext()))
            if text and not title:
                title = text
            if text:
                paragraphs.append(text)
        elif tag == "p":
            text = _normalize_text("".join(element.itertext()))
            if text:
                paragraphs.append(text)
    if not paragraphs:
        paragraphs = _fallback_extract_paragraphs(decoded)
    return title or _first_text(paragraphs), paragraphs


def _fallback_extract_paragraphs(document: str) -> list[str]:
    cleaned = _SCRIPT_STYLE_RE.sub(" ", document)
    cleaned = re.sub(r"</(?:p|div|h1|h2|h3|br)\s*>", "\n", cleaned, flags=re.I)
    cleaned = _TAG_RE.sub(" ", cleaned)
    cleaned = html.unescape(cleaned)
    return [
        normalized
        for line in cleaned.splitlines()
        if (normalized := _normalize_text(line))
    ]


def _chunk_paragraphs(paragraphs: Sequence[str], *, max_chars: int) -> list[str]:
    chunks: list[str] = []
    current: list[str] = []
    current_len = 0
    for paragraph in paragraphs:
        paragraph = _normalize_text(paragraph)
        if not paragraph:
            continue
        if current and current_len + len(paragraph) + 1 > max_chars:
            chunks.append("\n".join(current))
            current = []
            current_len = 0
        current.append(paragraph)
        current_len += len(paragraph) + 1
    if current:
        chunks.append("\n".join(current))
    return chunks


def _chapter_title_from_path(chapter_path: str) -> str:
    return Path(chapter_path).stem


def _first_text(paragraphs: Sequence[str]) -> str:
    return paragraphs[0] if paragraphs else ""


def _local_name(tag: str) -> str:
    return tag.rsplit("}", 1)[-1].lower()


def _normalize_text(text: str) -> str:
    return _WHITESPACE_RE.sub(" ", text).strip()
```

This file will grow in later tasks. Keep the imports that later tasks use so patching stays small.

- [x] **Step 4: Run extraction tests**

Run:

```powershell
cd apps\api
python -m pytest tests/test_novel_rag.py -q
```

Expected: PASS for the four tests in this file.

- [x] **Step 5: Commit**

```powershell
git add apps/api/kumikoroom/novel_rag.py apps/api/tests/test_novel_rag.py
git commit -m "feat: extract local novel EPUB text"
```

## Task 3: SQLite FTS5 Index and Rebuild Stats

**Files:**
- Modify: `apps/api/kumikoroom/novel_rag.py`
- Modify: `apps/api/tests/test_novel_rag.py`

- [x] **Step 1: Write failing index and search tests**

Append to `apps/api/tests/test_novel_rag.py`:

```python
from kumikoroom.novel_rag import NovelRagStore, rebuild_novel_index


def test_store_searches_cjk_terms_with_generated_search_text(tmp_path: Path) -> None:
    store = NovelRagStore(tmp_path / "novels.sqlite3")
    store.clear()
    store.upsert_chunks(
        [
            NovelChunk(
                source_id="01",
                source_title="第一卷",
                source_path="local.epub",
                chapter_path="OEBPS/Text/chapter1.xhtml",
                chapter_title="第一章",
                chunk_index=0,
                text="黄前久美子没有急着回答丽奈的问题。",
            ),
            NovelChunk(
                source_id="02",
                source_title="第二卷",
                source_path="local2.epub",
                chapter_path="OEBPS/Text/chapter2.xhtml",
                chapter_title="第二章",
                chunk_index=0,
                text="这一段只是在说长号声部。",
            ),
        ]
    )

    results = store.search("久美子 丽奈", limit=5)

    assert len(results) == 1
    assert results[0].source_title == "第一卷"
    assert "久美子没有急着回答" in results[0].text


def test_store_search_empty_query_returns_empty_list(tmp_path: Path) -> None:
    store = NovelRagStore(tmp_path / "novels.sqlite3")

    assert store.search("   ") == []


def test_rebuild_novel_index_indexes_epubs_and_skips_other_files(tmp_path: Path) -> None:
    corpus_dir = tmp_path / "corpus"
    corpus_dir.mkdir()
    write_epub(
        corpus_dir / "01.fixture.epub",
        {
            "OEBPS/Text/chapter.xhtml": """
                <html xmlns="http://www.w3.org/1999/xhtml">
                  <body><p>久美子和丽奈站在一起。</p></body>
                </html>
            """,
        },
    )
    (corpus_dir / "ignore.pdf").write_text("ignore", encoding="utf-8")
    db_path = tmp_path / "rag.sqlite3"

    stats = rebuild_novel_index(corpus_dir, db_path)

    assert stats.source_count == 1
    assert stats.chunk_count == 1
    assert stats.skipped_files == ("ignore.pdf",)
    assert stats.errors == ()
    assert NovelRagStore(db_path).search("久美子", limit=1)[0].source_id == "01-fixture"


def test_rebuild_novel_index_reports_broken_epub_and_continues(tmp_path: Path) -> None:
    corpus_dir = tmp_path / "corpus"
    corpus_dir.mkdir()
    (corpus_dir / "01.broken.epub").write_bytes(b"not an epub")
    db_path = tmp_path / "rag.sqlite3"

    stats = rebuild_novel_index(corpus_dir, db_path)

    assert stats.source_count == 0
    assert stats.chunk_count == 0
    assert stats.errors
    assert "01.broken.epub" in stats.errors[0]
```

- [x] **Step 2: Run tests to verify missing store**

Run:

```powershell
cd apps\api
python -m pytest tests/test_novel_rag.py -q
```

Expected: FAIL with `ImportError` or `AttributeError` for `NovelRagStore` and `rebuild_novel_index`.

- [x] **Step 3: Add FTS5 store and rebuild implementation**

Append this code to `apps/api/kumikoroom/novel_rag.py`:

```python
class NovelRagStore:
    def __init__(self, db_path: Path | str) -> None:
        self._db_path = Path(db_path)
        self._db_path.parent.mkdir(parents=True, exist_ok=True)
        self.initialize_schema()

    def initialize_schema(self) -> None:
        connection = self._connect()
        try:
            connection.execute(
                """
                CREATE TABLE IF NOT EXISTS novel_sources (
                    source_id TEXT PRIMARY KEY,
                    source_title TEXT NOT NULL,
                    source_path TEXT NOT NULL,
                    indexed_at TEXT NOT NULL
                )
                """
            )
            connection.execute(
                """
                CREATE TABLE IF NOT EXISTS novel_chunks (
                    source_id TEXT NOT NULL,
                    source_title TEXT NOT NULL,
                    source_path TEXT NOT NULL,
                    chapter_path TEXT NOT NULL,
                    chapter_title TEXT NOT NULL,
                    chunk_index INTEGER NOT NULL,
                    text TEXT NOT NULL
                )
                """
            )
            connection.execute(
                """
                CREATE VIRTUAL TABLE IF NOT EXISTS novel_chunks_fts
                USING fts5(search_text, content='novel_chunks', content_rowid='rowid')
                """
            )
            connection.commit()
        finally:
            connection.close()

    def clear(self) -> None:
        connection = self._connect()
        try:
            connection.execute("DELETE FROM novel_chunks_fts")
            connection.execute("DELETE FROM novel_chunks")
            connection.execute("DELETE FROM novel_sources")
            connection.commit()
        finally:
            connection.close()

    def upsert_chunks(self, chunks: list[NovelChunk]) -> None:
        if not chunks:
            return

        indexed_at = datetime.now(timezone.utc).isoformat()
        connection = self._connect()
        try:
            for chunk in chunks:
                connection.execute(
                    """
                    INSERT OR REPLACE INTO novel_sources
                        (source_id, source_title, source_path, indexed_at)
                    VALUES (?, ?, ?, ?)
                    """,
                    (
                        chunk.source_id,
                        chunk.source_title,
                        chunk.source_path,
                        indexed_at,
                    ),
                )
                cursor = connection.execute(
                    """
                    INSERT INTO novel_chunks
                        (
                            source_id,
                            source_title,
                            source_path,
                            chapter_path,
                            chapter_title,
                            chunk_index,
                            text
                        )
                    VALUES (?, ?, ?, ?, ?, ?, ?)
                    """,
                    (
                        chunk.source_id,
                        chunk.source_title,
                        chunk.source_path,
                        chunk.chapter_path,
                        chunk.chapter_title,
                        chunk.chunk_index,
                        chunk.text,
                    ),
                )
                connection.execute(
                    "INSERT INTO novel_chunks_fts(rowid, search_text) VALUES (?, ?)",
                    (cursor.lastrowid, _search_text(chunk.text)),
                )
            connection.commit()
        finally:
            connection.close()

    def search(self, query: str, *, limit: int = 5) -> list[NovelSearchResult]:
        fts_query = _fts_query(query)
        if not fts_query:
            return []

        connection = self._connect()
        try:
            rows = connection.execute(
                """
                SELECT
                    novel_chunks.source_id,
                    novel_chunks.source_title,
                    novel_chunks.chapter_path,
                    novel_chunks.chapter_title,
                    novel_chunks.chunk_index,
                    novel_chunks.text,
                    bm25(novel_chunks_fts) AS rank
                FROM novel_chunks_fts
                JOIN novel_chunks ON novel_chunks_fts.rowid = novel_chunks.rowid
                WHERE novel_chunks_fts MATCH ?
                ORDER BY rank ASC, novel_chunks.source_id ASC, novel_chunks.chunk_index ASC
                LIMIT ?
                """,
                (fts_query, max(0, int(limit))),
            ).fetchall()
        finally:
            connection.close()

        return [
            NovelSearchResult(
                source_id=row["source_id"],
                source_title=row["source_title"],
                chapter_path=row["chapter_path"],
                chapter_title=row["chapter_title"],
                chunk_index=row["chunk_index"],
                text=row["text"],
                rank=float(row["rank"]),
            )
            for row in rows
        ]

    def _connect(self) -> sqlite3.Connection:
        connection = sqlite3.connect(self._db_path)
        connection.row_factory = sqlite3.Row
        return connection


def rebuild_novel_index(corpus_dir: Path, db_path: Path) -> NovelIndexStats:
    store = NovelRagStore(db_path)
    store.clear()

    skipped_files: list[str] = []
    errors: list[str] = []
    source_count = 0
    chunk_count = 0

    if not corpus_dir.exists() or not corpus_dir.is_dir():
        return NovelIndexStats(source_count=0, chunk_count=0)

    for path in sorted(corpus_dir.iterdir()):
        if not path.is_file():
            continue
        if path.suffix.lower() != ".epub":
            skipped_files.append(path.name)
            continue

        source_id = _source_id_from_path(path)
        try:
            chunks = extract_epub_chunks(
                path,
                source_id=source_id,
                source_title=_source_title_from_path(path),
            )
        except (BadZipFile, OSError, ValueError) as exc:
            errors.append(f"{path.name}: {exc}")
            continue

        store.upsert_chunks(chunks)
        source_count += 1
        chunk_count += len(chunks)

    return NovelIndexStats(
        source_count=source_count,
        chunk_count=chunk_count,
        skipped_files=tuple(skipped_files),
        errors=tuple(errors),
    )


def _source_id_from_path(path: Path) -> str:
    stem = path.stem
    prefix = stem.split(".", 1)[0]
    normalized = re.sub(r"[^0-9A-Za-z_-]+", "-", prefix).strip("-").lower()
    if normalized:
        return normalized
    return re.sub(r"[^0-9A-Za-z_-]+", "-", stem).strip("-").lower() or "novel"


def _source_title_from_path(path: Path) -> str:
    return path.stem


def _search_text(text: str) -> str:
    tokens = _search_tokens(text)
    return " ".join(tokens)


def _fts_query(query: str) -> str:
    tokens = _search_tokens(query)
    unique_tokens = list(dict.fromkeys(tokens))
    if not unique_tokens:
        return ""
    return " OR ".join(f'"{token}"' for token in unique_tokens[:24])


def _search_tokens(text: str) -> list[str]:
    normalized = _normalize_text(text).lower()
    tokens: list[str] = []
    tokens.extend(re.findall(r"[a-z0-9_+-]{2,}", normalized))
    cjk_runs = re.findall(r"[\u3400-\u9fff]+", normalized)
    for run in cjk_runs:
        if len(run) == 1:
            tokens.append(run)
            continue
        for size in (2, 3, 4):
            if len(run) < size:
                continue
            tokens.extend(run[index : index + size] for index in range(len(run) - size + 1))
    return tokens
```

- [x] **Step 4: Run novel RAG tests**

Run:

```powershell
cd apps\api
python -m pytest tests/test_novel_rag.py -q
```

Expected: PASS.

- [x] **Step 5: Commit**

```powershell
git add apps/api/kumikoroom/novel_rag.py apps/api/tests/test_novel_rag.py
git commit -m "feat: index novel chunks with sqlite fts"
```

## Task 4: LLM Novel RAG Router, Context Formatter, and CLI

**Files:**
- Modify: `apps/api/kumikoroom/novel_rag.py`
- Modify: `apps/api/tests/test_novel_rag.py`

- [x] **Step 1: Write failing router, parser, and formatter tests**

Append to `apps/api/tests/test_novel_rag.py`:

```python
from kumikoroom.llm import LLMMessage, LLMResult, ProviderStatus
from kumikoroom.novel_rag import (
    NovelRagDecision,
    NovelRagRouter,
    NovelRagRoutingError,
    NovelSearchResult,
    build_novel_reference_context,
    parse_novel_rag_decision,
)


class FakeRouterProvider:
    def __init__(self, responses=None, *, error=None):
        self.responses = responses or []
        self.error = error
        self.calls = []

    def generate(
        self,
        messages: list[LLMMessage],
        tools=None,
        tool_choice=None,
        timeout=None,
    ) -> LLMResult:
        self.calls.append({"messages": messages, "timeout": timeout})
        if self.error is not None:
            raise self.error
        return LLMResult(
            content=self.responses.pop(0),
            provider_status=ProviderStatus(
                provider="mock",
                model=None,
                configured=True,
                label="mock",
            ),
        )


def test_parse_novel_rag_decision_accepts_true_json() -> None:
    decision = parse_novel_rag_decision(
        '{"use_novel_rag": true, "query": "久美子 说话方式 性格", "reason": "source question"}',
        fallback_query="fallback query",
    )

    assert decision == NovelRagDecision(
        use_novel_rag=True,
        query="久美子 说话方式 性格",
        reason="source question",
    )


def test_parse_novel_rag_decision_accepts_false_without_query() -> None:
    decision = parse_novel_rag_decision(
        '{"use_novel_rag": false, "reason": "casual"}',
        fallback_query="久美子",
    )

    assert decision.use_novel_rag is False
    assert decision.query == ""
    assert decision.reason == "casual"


def test_parse_novel_rag_decision_rejects_fences_or_trailing_prose() -> None:
    with pytest.raises(NovelRagRoutingError):
        parse_novel_rag_decision(
            '```json\n{"use_novel_rag": true, "query": "久美子"}\n```',
            fallback_query="久美子",
        )

    with pytest.raises(NovelRagRoutingError):
        parse_novel_rag_decision(
            '{"use_novel_rag": true, "query": "久美子"}\nextra',
            fallback_query="久美子",
        )


def test_router_uses_provider_decision_for_source_question() -> None:
    provider = FakeRouterProvider(
        [
            '{"use_novel_rag": true, "query": "久美子 说话方式", "reason": "source question"}'
        ]
    )

    decision = NovelRagRouter(provider, timeout_seconds=3.5).route(
        "久美子的说话方式为什么会这样？",
        recent_user_messages=("之前聊到丽奈", "刚才说北宇治"),
    )

    assert decision.use_novel_rag is True
    assert decision.query == "久美子 说话方式"
    assert len(provider.calls) == 1
    assert provider.calls[0]["timeout"] == 3.5
    prompt_text = "\n\n".join(
        message["content"] or "" for message in provider.calls[0]["messages"]
    )
    assert "JSON only" in prompt_text
    assert "之前聊到丽奈" in prompt_text
    assert "刚才说北宇治" in prompt_text


def test_router_uses_provider_decision_to_skip_false_positive_like_commands() -> None:
    provider = FakeRouterProvider(
        ['{"use_novel_rag": false, "reason": "provider skipped"}']
    )

    decision = NovelRagRouter(provider).route("播放京吹角色歌为什么没声音")

    assert decision.use_novel_rag is False
    assert decision.query == ""
    assert provider.calls


def test_router_allows_provider_to_override_old_rules() -> None:
    provider = FakeRouterProvider(
        [
            '{"use_novel_rag": true, "query": "京吹 角色歌 场景", "reason": "provider wants source"}'
        ]
    )

    decision = NovelRagRouter(provider).route("播放京吹角色歌为什么没声音")

    assert decision.use_novel_rag is True
    assert decision.query == "京吹 角色歌 场景"


def test_router_falls_back_to_skip_on_provider_or_parse_failure() -> None:
    provider = FakeRouterProvider(["not json"])

    decision = NovelRagRouter(provider).route("久美子的性格为什么会这样？")

    assert decision.use_novel_rag is False
    assert decision.query == ""
    assert decision.reason


def test_build_novel_reference_context_formats_bounded_results() -> None:
    results = [
        NovelSearchResult(
            source_id="01",
            source_title="第一卷",
            chapter_path="OEBPS/Text/chapter1.xhtml",
            chapter_title="第一章",
            chunk_index=0,
            text="久美子先沉默了一下，然后才回答。她没有把话说得很满。",
            rank=-1.0,
        ),
        NovelSearchResult(
            source_id="11",
            source_title="最终乐章前篇",
            chapter_path="OEBPS/Text/chapter9.xhtml",
            chapter_title="第九章",
            chunk_index=2,
            text="丽奈的名字出现在这一段里。",
            rank=-0.5,
        ),
    ]

    context = build_novel_reference_context(results, max_chars=120)

    assert "小说参考片段" in context
    assert "[第一卷 / 第一章]" in context
    assert "久美子先沉默了一下" in context
    assert "不要长段复述原文" in context
    assert len(context) < 420


def test_build_novel_reference_context_empty_results_returns_empty_string() -> None:
    assert build_novel_reference_context([]) == ""
```

- [x] **Step 2: Run tests to verify missing functions**

Run:

```powershell
cd apps\api
python -m pytest tests/test_novel_rag.py -q
```

Expected: FAIL with missing imports for `NovelRagDecision`, `NovelRagRouter`, `NovelRagRoutingError`, and `parse_novel_rag_decision`.

- [x] **Step 3: Add router parser and provider-backed router**

Add these pieces to `apps/api/kumikoroom/novel_rag.py`:

- `NovelRagDecision(use_novel_rag: bool, query: str, reason: str = "")`.
- `NovelRagRoutingError` for strict parse/validation failures.
- `parse_novel_rag_decision(raw, fallback_query)`, accepting one bare JSON object only, requiring boolean `use_novel_rag`, requiring a normalized 2-200 character query when true, using a valid fallback query only when needed, and bounding optional `reason` to 200 chars.
- `build_novel_rag_router_messages(message, recent_user_messages)`, with a local Hibike/Kumiko RAG router system prompt, JSON-only output requirements, current message, and the last 6 recent user messages in oldest-first order.
- `NovelRagRouter(provider, timeout_seconds=8.0)`, calling `provider.generate(messages, timeout=timeout_seconds)`, returning the parsed decision, and falling back to a false `NovelRagDecision` with a short reason on empty input, provider failure, parse failure, or malformed JSON.
- Do not inspect the message for local yes/no route rules. The provider JSON controls the route.

- [x] **Step 4: Keep formatter behavior**

Keep or append:

```python
def build_novel_reference_context(
    results: Sequence[NovelSearchResult],
    *,
    max_chars: int = 1800,
) -> str:
    if not results:
        return ""

    lines = ["小说参考片段："]
    used_chars = 0
    seen: set[tuple[str, str, int]] = set()
    for result in results[:5]:
        key = (result.source_id, result.chapter_path, result.chunk_index)
        if key in seen:
            continue
        seen.add(key)

        snippet = _trim_snippet(result.text, max_chars=max(80, max_chars - used_chars))
        if not snippet:
            continue
        used_chars += len(snippet)
        lines.append(f"- [{result.source_title} / {result.chapter_title}] {snippet}")
        if used_chars >= max_chars:
            break

    if len(lines) == 1:
        return ""

    lines.extend(
        [
            "",
            "使用规则：",
            "- 这些片段只作为事实和性格依据。",
            "- 不要长段复述原文。",
            "- 如果片段不足以支持结论，要说明依据有限。",
        ]
    )
    return "\n".join(lines)


def _trim_snippet(text: str, *, max_chars: int) -> str:
    normalized = _normalize_text(text)
    if len(normalized) <= max_chars:
        return normalized
    trimmed = normalized[: max(0, max_chars - 1)].rstrip()
    punctuation_positions = [
        trimmed.rfind(mark)
        for mark in ("。", "！", "？", ".", "!", "?")
        if trimmed.rfind(mark) >= 40
    ]
    if punctuation_positions:
        trimmed = trimmed[: max(punctuation_positions) + 1]
    return trimmed.rstrip() + "…"
```

- [x] **Step 5: Add CLI command**

Append to `apps/api/kumikoroom/novel_rag.py`:

```python
def main(argv: Sequence[str] | None = None) -> int:
    parser = ArgumentParser(description="Manage local KumikoRoom novel RAG index")
    subparsers = parser.add_subparsers(dest="command", required=True)
    subparsers.add_parser("rebuild", help="Rebuild the local novel RAG index")
    args = parser.parse_args(argv)

    if args.command == "rebuild":
        from kumikoroom.config import load_settings

        settings = load_settings()
        stats = rebuild_novel_index(
            settings.novel_corpus_dir,
            settings.novel_rag_db_path,
        )
        print(f"Indexed sources: {stats.source_count}")
        print(f"Indexed chunks: {stats.chunk_count}")
        print(f"Skipped files: {len(stats.skipped_files)}")
        for name in stats.skipped_files:
            print(f"  skipped: {name}")
        print(f"Errors: {len(stats.errors)}")
        for error in stats.errors:
            print(f"  error: {error}")
        return 0 if not stats.errors else 1

    return 2


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))
```

- [x] **Step 6: Run focused tests and CLI smoke check**

Run:

```powershell
cd apps\api
python -m pytest tests/test_novel_rag.py -q
python -m kumikoroom.novel_rag rebuild
```

Expected:

- pytest PASS.
- CLI prints counts. In the isolated test shell it may show `Indexed sources: 0` if `D:\555\codex\jc` is unavailable or env vars point elsewhere.

- [x] **Step 7: Commit**

```powershell
git add apps/api/kumikoroom/novel_rag.py apps/api/tests/test_novel_rag.py
git commit -m "feat: format novel retrieval context"
```

## Task 5: ConversationManager Integration with NovelRagRouter

**Files:**
- Modify: `apps/api/kumikoroom/conversation.py`
- Modify: `apps/api/tests/test_conversation.py`

- [x] **Step 1: Write failing conversation tests**

Append to `apps/api/tests/test_conversation.py`:

```python
from kumikoroom.novel_rag import NovelRagDecision, NovelSearchResult


class FakeNovelRagRouter:
    def __init__(self, decision=None, *, fail=False):
        self.decision = decision or NovelRagDecision(False, "", reason="skip")
        self.fail = fail
        self.calls = []

    def route(self, message, *, recent_user_messages=()):
        self.calls.append(
            {"message": message, "recent_user_messages": tuple(recent_user_messages)}
        )
        if self.fail:
            raise RuntimeError("route failed")
        return self.decision


class FakeNovelRagStore:
    def __init__(self, results=None, *, fail=False):
        self.results = results or []
        self.fail = fail
        self.calls = []

    def search(self, query, limit=5):
        self.calls.append({"query": query, "limit": limit})
        if self.fail:
            raise RuntimeError("search failed")
        return self.results


def test_manager_includes_novel_context_when_router_uses_rag(monkeypatch, tmp_path) -> None:
    monkeypatch.setenv("KUMIKOROOM_MEMORY_DB_PATH", str(tmp_path / "memory.sqlite3"))
    provider = FakeProvider()
    router = FakeNovelRagRouter(
        NovelRagDecision(
            True,
            "久美子 说话方式",
            reason="source question",
        )
    )
    novel_store = FakeNovelRagStore(
        [
            NovelSearchResult(
                source_id="01",
                source_title="第一卷",
                chapter_path="OEBPS/Text/chapter1.xhtml",
                chapter_title="第一章",
                chunk_index=0,
                text="久美子先沉默了一下，然后才回答。",
                rank=-1.0,
            )
        ]
    )

    ConversationManager(
        settings=load_settings(),
        provider=provider,
        novel_rag_router=router,
        novel_rag_store=novel_store,
    ).chat(ChatIn(message="久美子的说话方式为什么会这样？", memory_enabled=False))

    system_text = provider.messages[0]["content"]
    assert router.calls
    assert novel_store.calls == [{"query": "久美子 说话方式", "limit": 5}]
    assert "小说参考片段" in system_text
    assert "[第一卷 / 第一章]" in system_text
    assert "久美子先沉默了一下" in system_text
    assert "不要长段复述原文" in system_text


def test_manager_skips_novel_search_when_router_declines(
    monkeypatch,
    tmp_path,
) -> None:
    monkeypatch.setenv("KUMIKOROOM_MEMORY_DB_PATH", str(tmp_path / "memory.sqlite3"))
    provider = FakeProvider()
    router = FakeNovelRagRouter(NovelRagDecision(False, "", reason="provider skipped"))
    novel_store = FakeNovelRagStore(
        [
            NovelSearchResult(
                source_id="01",
                source_title="第一卷",
                chapter_path="chapter.xhtml",
                chapter_title="第一章",
                chunk_index=0,
                text="久美子片段",
                rank=-1.0,
            )
        ]
    )

    ConversationManager(
        settings=load_settings(),
        provider=provider,
        novel_rag_router=router,
        novel_rag_store=novel_store,
    ).chat(ChatIn(message="播放 晴天 周杰伦", memory_enabled=False))

    assert router.calls
    assert novel_store.calls == []
    assert "小说参考片段" not in provider.messages[0]["content"]


def test_manager_continues_when_router_or_novel_search_fails(monkeypatch, tmp_path) -> None:
    monkeypatch.setenv("KUMIKOROOM_MEMORY_DB_PATH", str(tmp_path / "memory.sqlite3"))
    provider = FakeProvider()

    response = ConversationManager(
        settings=load_settings(),
        provider=provider,
        novel_rag_router=FakeNovelRagRouter(fail=True),
        novel_rag_store=FakeNovelRagStore(fail=True),
    ).chat(ChatIn(message="久美子在原作里是什么性格？", memory_enabled=False))

    assert response.reply.role == "kumiko"
    assert "小说参考片段" not in provider.messages[0]["content"]
```

- [x] **Step 2: Run tests to verify constructor argument is missing**

Run:

```powershell
cd apps\api
python -m pytest tests/test_conversation.py::test_manager_includes_novel_context_when_router_uses_rag -q
```

Expected: FAIL with `TypeError: ConversationManager.__init__() got an unexpected keyword argument 'novel_rag_router'`.

- [x] **Step 3: Add imports and constructor collaborator**

In `apps/api/kumikoroom/conversation.py`, add imports:

```python
from kumikoroom.novel_rag import (
    NovelRagRouter,
    NovelRagStore,
    build_novel_reference_context,
)
```

Extend `ConversationManager.__init__` signature:

```python
        novel_rag_router: NovelRagRouter | None = None,
        novel_rag_store: NovelRagStore | None = None,
```

After session store initialization, add:

```python
        self.novel_rag_router: NovelRagRouter | None = None
        self.novel_rag_store: NovelRagStore | None = None
        if self.settings.novel_rag_enabled:
            if novel_rag_router is not None:
                self.novel_rag_router = novel_rag_router
            elif not provider_was_injected and self.runtime_config.provider != "mock":
                self.novel_rag_router = NovelRagRouter(self.provider)

            if novel_rag_store is not None:
                self.novel_rag_store = novel_rag_store
            elif self.settings.novel_rag_db_path.exists():
                try:
                    self.novel_rag_store = NovelRagStore(
                        self.settings.novel_rag_db_path
                    )
                except Exception:
                    _logger.exception("novel RAG store initialization failed")
```

Final strategy: `NovelRagStore` may still be auto-created when local RAG is enabled and the SQLite DB file exists, with initialization failures degrading silently. `NovelRagRouter` is auto-created only when no provider was explicitly injected and the runtime provider is not mock. When a caller injects a provider explicitly, it must also inject a router explicitly if novel routing is desired.

- [x] **Step 4: Add prompt context helper**

In `_build_messages()`, after the memory block and before room state:

```python
        novel_context = self._novel_context(payload, message)
        if novel_context:
            system_parts.append(novel_context)
```

Add this method to `ConversationManager`:

```python
    def _novel_context(self, payload: ChatIn, message: str) -> str:
        if self.novel_rag_router is None or self.novel_rag_store is None:
            return ""

        recent_user_messages = [
            recent.content.strip()
            for recent in payload.recent_messages[-6:]
            if recent.role == "user" and recent.content.strip()
        ]
        try:
            decision = self.novel_rag_router.route(
                message,
                recent_user_messages=recent_user_messages,
            )
        except Exception:
            _logger.exception("novel RAG routing failed")
            return ""
        if not decision.use_novel_rag:
            return ""

        try:
            results = self.novel_rag_store.search(decision.query, limit=5)
        except Exception:
            _logger.exception("novel RAG search failed")
            return ""
        return build_novel_reference_context(results)
```

- [x] **Step 5: Run focused conversation tests**

Run:

```powershell
cd apps\api
python -m pytest tests/test_conversation.py::test_manager_includes_novel_context_when_router_uses_rag tests/test_conversation.py::test_manager_skips_novel_search_when_router_declines tests/test_conversation.py::test_manager_continues_when_router_or_novel_search_fails -q
```

Expected: PASS.

- [x] **Step 6: Run the full conversation test file**

Run:

```powershell
cd apps\api
python -m pytest tests/test_conversation.py -q
```

Expected: PASS.

- [x] **Step 7: Commit**

```powershell
git add apps/api/kumikoroom/conversation.py apps/api/tests/test_conversation.py
git commit -m "feat: add novel context to chat prompts"
```

## Task 6: Persona Logic Card

**Files:**
- Modify: `apps/api/kumikoroom/persona.py`
- Modify: `apps/api/tests/test_persona.py`

- [x] **Step 1: Write failing persona logic test**

Add this test to `apps/api/tests/test_persona.py` before the prompt-size test:

```python
def test_persona_includes_speaking_logic_card() -> None:
    prompt = build_persona_prompt("medium")

    assert "说话逻辑" in prompt
    assert "先回答用户当前真正的问题" in prompt
    assert "先听懂，再表达" in prompt
    assert "轻微吐槽" in prompt
    assert "不要突然变成热血演讲" in prompt
    assert "技术、文件、工具问题" in prompt
```

Update the compact-size assertion:

```python
    assert len(prompt) < 1800
```

- [x] **Step 2: Run persona tests to verify failure**

Run:

```powershell
cd apps\api
python -m pytest tests/test_persona.py -q
```

Expected: FAIL because the prompt lacks the speaking logic phrases.

- [x] **Step 3: Add compact logic card**

In `apps/api/kumikoroom/persona.py`, add this constant after `_CORE_PROFILE`:

```python
_SPEAKING_LOGIC = """\
说话逻辑：
先回答用户当前真正的问题；先听懂，再表达，不要急着把话题拉回自己。
语气保持平实、有一点自我意识，可以偶尔轻微吐槽，但不要突然变成热血演讲或舞台独白。
聊关系、社团压力、练习和选择时，要细腻一点，承认犹豫和别扭感。
技术、文件、工具问题要清楚可靠，角色感只做轻微调味。
"""
```

Append it to both prompt variants before `_CORE_PROFILE`:

```python
""" + _SPEAKING_LOGIC + "\n" + _CORE_PROFILE
```

- [x] **Step 4: Run persona tests**

Run:

```powershell
cd apps\api
python -m pytest tests/test_persona.py -q
```

Expected: PASS.

- [x] **Step 5: Commit**

```powershell
git add apps/api/kumikoroom/persona.py apps/api/tests/test_persona.py
git commit -m "feat: tighten Kumiko speaking logic"
```

## Task 7: Documentation and End-to-End Verification

**Files:**
- Modify: `README.md`
- Modify: `README.zh-CN.md`
- Modify: `docs/superpowers/plans/2026-06-27-kumiko-novel-rag.md` only to tick completed boxes during execution

- [x] **Step 1: Add README instructions**

Add this short section to `README.md` near the model/memory configuration material:

````markdown
## Local Novel RAG

KumikoRoom can optionally build a local-only SQLite index from the Hibike! Euphonium EPUB files used for persona grounding.

```powershell
cd apps\api
python -m kumikoroom.novel_rag rebuild
```

The default corpus path is `D:\555\codex\jc` when it exists. Override it with `KUMIKOROOM_NOVEL_CORPUS_DIR`. The generated index defaults to `user-data/rag/kumiko-novels.sqlite3`, which is ignored by git.
````

Add this matching section to `README.zh-CN.md`:

````markdown
## 本地小说 RAG

KumikoRoom 可以从本地《吹响吧！上低音号》EPUB 建一个只在本机使用的 SQLite 索引，用来增强人物和原作细节回答。

```powershell
cd apps\api
python -m kumikoroom.novel_rag rebuild
```

默认语料目录是存在时的 `D:\555\codex\jc`。可以用 `KUMIKOROOM_NOVEL_CORPUS_DIR` 覆盖。索引默认写到 `user-data/rag/kumiko-novels.sqlite3`，这个路径已经被 git 忽略。
````

- [ ] **Step 2: Run focused backend tests**

Run:

```powershell
cd apps\api
python -m pytest tests/test_config.py tests/test_novel_rag.py tests/test_persona.py tests/test_conversation.py -q
```

Expected: PASS.

- [ ] **Step 3: Run full API test suite**

Run:

```powershell
cd apps\api
python -m pytest -q
```

Expected: PASS. If permission warnings appear for old pytest cache folders, record them in the final handoff only when they affect the exit code.

- [ ] **Step 4: Rebuild the real local index**

Run:

```powershell
cd apps\api
python -m kumikoroom.novel_rag rebuild
```

Expected in this workspace: indexed source count should be `12`; chunk count should be greater than `0`; unrelated PDFs/images/videos in `D:\555\codex\jc` should be skipped.

- [ ] **Step 5: Smoke test search against the real index**

Run this inline Python command:

```powershell
@'
from kumikoroom.config import load_settings
from kumikoroom.novel_rag import NovelRagStore

settings = load_settings()
store = NovelRagStore(settings.novel_rag_db_path)
results = store.search("久美子 丽奈 性格", limit=3)
print(len(results))
for result in results:
    print(result.source_title, result.chapter_title, result.text[:80])
'@ | python -
```

Expected: prints at least one result with a source title and snippet text.

- [ ] **Step 6: Run workspace tests if time allows**

Run from repo root:

```powershell
npm test
```

Expected: PASS. If frontend or desktop tests fail for an unrelated existing reason, capture the failing command and first relevant error lines.

- [x] **Step 7: Commit docs and final verification**

```powershell
git add README.md README.zh-CN.md docs/superpowers/plans/2026-06-27-kumiko-novel-rag.md
git commit -m "docs: explain local novel RAG"
```

## Self-Review Notes

- Spec coverage: configuration, EPUB extraction, local-only FTS index, LLM-driven retrieval routing, bounded prompt context, persona logic card, no frontend change, failure fallback, and tests all have tasks.
- No live LLM calls are required for test coverage.
- The plan uses a synthetic EPUB fixture and does not commit local novel excerpts.
- The real index path stays under `user-data/rag/`, already ignored by git through `user-data/` and `*.sqlite3`.

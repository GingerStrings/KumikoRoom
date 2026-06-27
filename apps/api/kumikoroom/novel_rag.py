from __future__ import annotations

import html
import posixpath
import re
import sqlite3
import sys
from argparse import ArgumentParser
from contextlib import closing
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path
from typing import Sequence
from urllib.parse import unquote, urlsplit
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


class NovelRagStore:
    def __init__(self, db_path: Path | str) -> None:
        self.db_path = Path(db_path)
        self.db_path.parent.mkdir(parents=True, exist_ok=True)
        self.initialize_schema()

    def _connect(self) -> sqlite3.Connection:
        connection = sqlite3.connect(self.db_path)
        connection.row_factory = sqlite3.Row
        connection.execute("PRAGMA foreign_keys = ON")
        return connection

    def initialize_schema(self) -> None:
        with closing(self._connect()) as connection:
            with connection:
                connection.executescript(
                    """
                    CREATE TABLE IF NOT EXISTS novel_sources (
                        source_id TEXT PRIMARY KEY,
                        title TEXT NOT NULL,
                        path TEXT NOT NULL,
                        updated_at TEXT NOT NULL
                    );

                    CREATE TABLE IF NOT EXISTS novel_chunks (
                        source_id TEXT NOT NULL REFERENCES novel_sources(source_id)
                            ON DELETE CASCADE,
                        chapter_path TEXT NOT NULL,
                        chapter_title TEXT NOT NULL,
                        chunk_index INTEGER NOT NULL,
                        text TEXT NOT NULL,
                        search_text TEXT NOT NULL,
                        UNIQUE(source_id, chapter_path, chunk_index)
                    );

                    CREATE VIRTUAL TABLE IF NOT EXISTS novel_chunks_fts
                    USING fts5(
                        search_text,
                        content='novel_chunks',
                        content_rowid='rowid'
                    );
                    """
                )

    def clear(self) -> None:
        with closing(self._connect()) as connection:
            with connection:
                connection.execute("DELETE FROM novel_chunks")
                connection.execute("DELETE FROM novel_sources")
                connection.execute(
                    "INSERT INTO novel_chunks_fts(novel_chunks_fts) VALUES('rebuild')"
                )

    def upsert_chunks(self, chunks: Sequence[NovelChunk]) -> None:
        if not chunks:
            return

        chunks_by_source: dict[str, list[NovelChunk]] = {}
        for chunk in chunks:
            chunks_by_source.setdefault(chunk.source_id, []).append(chunk)

        updated_at = datetime.now(timezone.utc).isoformat()
        with closing(self._connect()) as connection:
            with connection:
                for source_chunks in chunks_by_source.values():
                    first_chunk = source_chunks[0]
                    connection.execute(
                        """
                        INSERT INTO novel_sources (source_id, title, path, updated_at)
                        VALUES (?, ?, ?, ?)
                        ON CONFLICT(source_id) DO UPDATE SET
                            title = excluded.title,
                            path = excluded.path,
                            updated_at = excluded.updated_at
                        """,
                        (
                            first_chunk.source_id,
                            first_chunk.source_title,
                            first_chunk.source_path,
                            updated_at,
                        ),
                    )
                    connection.execute(
                        "DELETE FROM novel_chunks WHERE source_id = ?",
                        (first_chunk.source_id,),
                    )
                    connection.executemany(
                        """
                        INSERT INTO novel_chunks (
                            source_id,
                            chapter_path,
                            chapter_title,
                            chunk_index,
                            text,
                            search_text
                        )
                        VALUES (?, ?, ?, ?, ?, ?)
                        """,
                        [
                            (
                                chunk.source_id,
                                chunk.chapter_path,
                                chunk.chapter_title,
                                chunk.chunk_index,
                                chunk.text,
                                _search_text(chunk),
                            )
                            for chunk in source_chunks
                        ],
                    )
                connection.execute(
                    "INSERT INTO novel_chunks_fts(novel_chunks_fts) VALUES('rebuild')"
                )

    def search(self, query: str, limit: int = 5) -> list[NovelSearchResult]:
        fts_query = _fts_query(query)
        if not fts_query or limit <= 0:
            return []

        with closing(self._connect()) as connection:
            rows = connection.execute(
                """
                SELECT
                    c.source_id,
                    s.title AS source_title,
                    c.chapter_path,
                    c.chapter_title,
                    c.chunk_index,
                    c.text,
                    bm25(novel_chunks_fts) AS rank
                FROM novel_chunks_fts
                JOIN novel_chunks AS c ON c.rowid = novel_chunks_fts.rowid
                JOIN novel_sources AS s ON s.source_id = c.source_id
                WHERE novel_chunks_fts MATCH ?
                ORDER BY rank, c.source_id, c.chunk_index
                LIMIT ?
                """,
                (fts_query, limit),
            ).fetchall()

        return [
            NovelSearchResult(
                source_id=row["source_id"],
                source_title=row["source_title"],
                chapter_path=row["chapter_path"],
                chapter_title=row["chapter_title"],
                chunk_index=row["chunk_index"],
                text=row["text"],
                rank=row["rank"],
            )
            for row in rows
        ]


_TEXT_EXTENSIONS = (".xhtml", ".html", ".htm")
_XHTML_BLOCK_TAGS = {"h1", "h2", "h3", "p", "div", "li"}
_IGNORED_TEXT_TAGS = {"script", "style"}
_NAVIGATION_STEMS = {"nav", "toc", "contents", "cover"}
_WHITESPACE_RE = re.compile(r"\s+")
_SEARCH_TOKEN_RE = re.compile(
    r"[\u3040-\u30ff\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff"
    r"\uac00-\ud7af]+|[A-Za-z0-9_]+"
)
_MAX_FTS_QUERY_TERMS = 24
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


def rebuild_novel_index(corpus_dir: Path | str, db_path: Path | str) -> NovelIndexStats:
    corpus_path = Path(corpus_dir)
    store = NovelRagStore(db_path)
    store.clear()

    source_count = 0
    chunk_count = 0
    skipped_files: list[str] = []
    errors: list[str] = []
    used_source_ids: set[str] = set()

    if not corpus_path.exists() or not corpus_path.is_dir():
        return NovelIndexStats(source_count=0, chunk_count=0)

    for path in sorted(corpus_path.iterdir()):
        if not path.is_file():
            continue
        if path.suffix.lower() != ".epub":
            skipped_files.append(path.name)
            continue

        try:
            source_id = _unique_source_id_from_path(path, used_source_ids)
            chunks = extract_epub_chunks(
                path,
                source_id=source_id,
                source_title=_source_title_from_path(path),
            )
        except Exception as exc:
            errors.append(f"{path.name}: {exc}")
            continue

        used_source_ids.add(source_id)
        store.upsert_chunks(chunks)
        source_count += 1
        chunk_count += len(chunks)

    return NovelIndexStats(
        source_count=source_count,
        chunk_count=chunk_count,
        skipped_files=tuple(skipped_files),
        errors=tuple(errors),
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
        chapter_paths = _epub_text_paths(archive)
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


def _epub_text_paths(archive: ZipFile) -> list[str]:
    archive_names = set(archive.namelist())
    spine_paths = _opf_spine_text_paths(archive, archive_names)
    if spine_paths:
        return spine_paths
    return sorted(
        name
        for name in archive_names
        if _is_text_path(name) and not _is_navigation_path(name)
    )


def _opf_spine_text_paths(archive: ZipFile, archive_names: set[str]) -> list[str]:
    for opf_path in _opf_paths(archive, archive_names):
        try:
            root = ElementTree.fromstring(archive.read(opf_path))
        except (ElementTree.ParseError, KeyError):
            continue

        manifest_paths: dict[str, str] = {}
        navigation_idrefs: set[str] = set()
        spine_idrefs: list[str] = []
        for element in root.iter():
            tag = _local_name(element.tag)
            if tag == "item":
                item_id = element.attrib.get("id")
                href = element.attrib.get("href")
                if item_id and _has_property_token(
                    element.attrib.get("properties"), "nav"
                ):
                    navigation_idrefs.add(item_id)
                    continue
                if item_id and href:
                    manifest_paths[item_id] = _resolve_epub_href(opf_path, href)
            elif tag == "itemref":
                if element.attrib.get("linear", "yes").strip().lower() == "no":
                    continue
                idref = element.attrib.get("idref")
                if idref:
                    spine_idrefs.append(idref)

        spine_paths: list[str] = []
        seen: set[str] = set()
        for idref in spine_idrefs:
            if idref in navigation_idrefs:
                continue
            chapter_path = manifest_paths.get(idref)
            if not chapter_path:
                spine_paths = []
                break
            if chapter_path not in archive_names:
                spine_paths = []
                break
            if not _is_text_path(chapter_path):
                spine_paths = []
                break
            if _is_navigation_path(chapter_path):
                continue
            if chapter_path not in seen:
                spine_paths.append(chapter_path)
                seen.add(chapter_path)
        if spine_paths:
            return spine_paths
    return []


def _opf_paths(archive: ZipFile, archive_names: set[str]) -> list[str]:
    opf_paths: list[str] = []
    try:
        container_root = ElementTree.fromstring(archive.read("META-INF/container.xml"))
    except (ElementTree.ParseError, KeyError):
        container_root = None

    if container_root is not None:
        for element in container_root.iter():
            if _local_name(element.tag) != "rootfile":
                continue
            full_path = element.attrib.get("full-path")
            if full_path and full_path in archive_names:
                opf_paths.append(full_path)

    for name in sorted(archive_names):
        if name.lower().endswith(".opf") and name not in opf_paths:
            opf_paths.append(name)
    return opf_paths


def _resolve_epub_href(opf_path: str, href: str) -> str:
    href_path = unquote(urlsplit(href).path).lstrip("/")
    if not href_path:
        return ""
    return posixpath.normpath(posixpath.join(posixpath.dirname(opf_path), href_path))


def _is_text_path(path: str) -> bool:
    return path.lower().endswith(_TEXT_EXTENSIONS)


def _is_navigation_path(path: str) -> bool:
    stem = posixpath.splitext(posixpath.basename(path))[0].lower()
    return stem in _NAVIGATION_STEMS


def _has_property_token(properties: str | None, token: str) -> bool:
    if not properties:
        return False
    expected = token.lower()
    return any(part.lower() == expected for part in properties.split())


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
        if tag in _IGNORED_TEXT_TAGS:
            continue
        if tag not in _XHTML_BLOCK_TAGS or _has_descendant_block(element):
            continue
        if tag in {"h1", "h2", "h3"}:
            text = _normalize_text(_visible_element_text(element))
            if text and not title:
                title = text
            if text:
                paragraphs.append(text)
        else:
            text = _normalize_text(_visible_element_text(element))
            if text:
                paragraphs.append(text)
    if not paragraphs:
        paragraphs = _fallback_extract_paragraphs(decoded)
    return title or _first_text(paragraphs), paragraphs


def _fallback_extract_paragraphs(document: str) -> list[str]:
    cleaned = _SCRIPT_STYLE_RE.sub(" ", document)
    cleaned = re.sub(r"</(?:p|div|li|h1|h2|h3|br)\s*>", "\n", cleaned, flags=re.I)
    cleaned = _TAG_RE.sub(" ", cleaned)
    cleaned = html.unescape(cleaned)
    return [
        normalized
        for line in cleaned.splitlines()
        if (normalized := _normalize_text(line))
    ]


def _chunk_paragraphs(paragraphs: Sequence[str], *, max_chars: int) -> list[str]:
    if max_chars <= 0:
        raise ValueError("max_chars must be positive")

    chunks: list[str] = []
    current: list[str] = []
    current_len = 0
    for paragraph in paragraphs:
        paragraph = _normalize_text(paragraph)
        if not paragraph:
            continue
        if len(paragraph) > max_chars:
            if current:
                chunks.append("\n".join(current))
                current = []
                current_len = 0
            chunks.extend(
                paragraph[start : start + max_chars]
                for start in range(0, len(paragraph), max_chars)
            )
            continue

        separator_len = 1 if current else 0
        if current and current_len + separator_len + len(paragraph) > max_chars:
            chunks.append("\n".join(current))
            current = []
            current_len = 0
            separator_len = 0
        current.append(paragraph)
        current_len += separator_len + len(paragraph)
    if current:
        chunks.append("\n".join(current))
    return chunks


def _chapter_title_from_path(chapter_path: str) -> str:
    return Path(chapter_path).stem


def _first_text(paragraphs: Sequence[str]) -> str:
    return paragraphs[0] if paragraphs else ""


def _source_id_from_path(path: Path) -> str:
    source_id = re.sub(r"[^\w-]+", "-", path.stem, flags=re.UNICODE).strip("-")
    return source_id or path.stem


def _unique_source_id_from_path(path: Path, used_source_ids: set[str]) -> str:
    base_source_id = _source_id_from_path(path)
    source_id = base_source_id
    suffix = 2
    while source_id in used_source_ids:
        source_id = f"{base_source_id}-{suffix}"
        suffix += 1
    return source_id


def _source_title_from_path(path: Path) -> str:
    return path.stem


def _search_text(chunk: NovelChunk) -> str:
    text = " ".join(
        [
            chunk.source_title,
            chunk.chapter_title,
            chunk.text,
        ]
    )
    return " ".join([text, *_search_tokens(text)])


def _fts_query(query: str) -> str:
    terms = _query_tokens(query, max_terms=_MAX_FTS_QUERY_TERMS)
    return " OR ".join(_quote_fts_token(term) for term in terms)


def _query_tokens(query: str, *, max_terms: int) -> list[str]:
    term_groups: list[list[str]] = []
    for token in _iter_search_terms(query):
        if _is_cjk_token(token) and len(token) > 1:
            term_groups.append(
                _cjk_query_token_candidates(token, max_terms=max_terms)
            )
        else:
            term_groups.append([token])
    return _merge_query_token_groups(term_groups, max_terms=max_terms)


def _cjk_query_token_candidates(
    token: str,
    *,
    max_terms: int,
) -> list[str]:
    tokens: list[str] = []
    seen: set[str] = set()
    for min_size, max_size in ((2, 4), (5, 6)):
        largest = min(max_size, len(token))
        for size in range(min_size, largest + 1):
            for start in _sampled_ngram_starts(len(token), size):
                _append_unique_token(
                    token[start : start + size],
                    tokens,
                    seen,
                    max_terms=max_terms,
                )
                if len(tokens) >= max_terms:
                    return tokens
    return tokens


def _merge_query_token_groups(
    term_groups: Sequence[Sequence[str]],
    *,
    max_terms: int,
) -> list[str]:
    tokens: list[str] = []
    seen: set[str] = set()
    group_index = 0
    while len(tokens) < max_terms:
        added = False
        for group in term_groups:
            if group_index >= len(group):
                continue
            _append_unique_token(
                group[group_index],
                tokens,
                seen,
                max_terms=max_terms,
            )
            added = True
            if len(tokens) >= max_terms:
                return tokens
        if not added:
            return tokens
        group_index += 1
    return tokens


def _sampled_ngram_starts(token_length: int, size: int) -> list[int]:
    max_start = token_length - size
    if max_start < 0:
        return []

    starts: list[int] = []
    starts.extend(range(0, min(max_start, 4) + 1))
    starts.extend(range(max(0, max_start - 6), max_start + 1))
    starts.extend([max_start // 2, max_start // 4, (max_start * 3) // 4])
    return _unique_ints(starts)


def _unique_ints(values: Sequence[int]) -> list[int]:
    seen: set[int] = set()
    unique: list[int] = []
    for value in values:
        if value in seen:
            continue
        seen.add(value)
        unique.append(value)
    return unique


def _append_unique_token(
    token: str,
    tokens: list[str],
    seen: set[str],
    *,
    max_terms: int,
) -> None:
    if token in seen or len(tokens) >= max_terms:
        return
    seen.add(token)
    tokens.append(token)


def _search_tokens(text: str) -> list[str]:
    tokens: list[str] = []
    for token in _iter_search_terms(text):
        if _is_cjk_token(token):
            tokens.extend(_cjk_ngrams(token, min_size=1, max_size=6))
        else:
            tokens.append(token)
    return _unique_terms(tokens)


def _iter_search_terms(text: str) -> list[str]:
    return [match.group(0).lower() for match in _SEARCH_TOKEN_RE.finditer(text)]


def _unique_terms(terms: Sequence[str]) -> list[str]:
    seen: set[str] = set()
    unique: list[str] = []
    for term in terms:
        if term in seen:
            continue
        seen.add(term)
        unique.append(term)
    return unique


def _is_cjk_token(token: str) -> bool:
    return any(
        "\u3040" <= char <= "\u30ff"
        or "\u3400" <= char <= "\u4dbf"
        or "\u4e00" <= char <= "\u9fff"
        or "\uf900" <= char <= "\ufaff"
        or "\uac00" <= char <= "\ud7af"
        for char in token
    )


def _cjk_ngrams(token: str, *, min_size: int, max_size: int) -> list[str]:
    ngrams: list[str] = []
    largest = min(max_size, len(token))
    for size in range(min_size, largest + 1):
        ngrams.extend(
            token[start : start + size] for start in range(len(token) - size + 1)
        )
    return ngrams


def _quote_fts_token(token: str) -> str:
    return '"' + token.replace('"', '""') + '"'


def _local_name(tag: str) -> str:
    return tag.rsplit("}", 1)[-1].lower()


def _has_descendant_block(element: ElementTree.Element) -> bool:
    return any(
        descendant is not element and _local_name(descendant.tag) in _XHTML_BLOCK_TAGS
        for descendant in element.iter()
    )


def _visible_element_text(element: ElementTree.Element) -> str:
    parts = [element.text or ""]
    for child in element:
        if _local_name(child.tag) not in _IGNORED_TEXT_TAGS:
            parts.append(_visible_element_text(child))
        parts.append(child.tail or "")
    return "".join(parts)


def _normalize_text(text: str) -> str:
    return _WHITESPACE_RE.sub(" ", text).strip()

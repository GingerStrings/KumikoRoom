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

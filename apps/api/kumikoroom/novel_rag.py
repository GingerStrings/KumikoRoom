from __future__ import annotations

import html
import posixpath
import re
import sqlite3
import sys
from argparse import ArgumentParser
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


_TEXT_EXTENSIONS = (".xhtml", ".html", ".htm")
_XHTML_BLOCK_TAGS = {"h1", "h2", "h3", "p", "div", "li"}
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
    return sorted(name for name in archive_names if _is_text_path(name))


def _opf_spine_text_paths(archive: ZipFile, archive_names: set[str]) -> list[str]:
    for opf_path in _opf_paths(archive, archive_names):
        try:
            root = ElementTree.fromstring(archive.read(opf_path))
        except (ElementTree.ParseError, KeyError):
            continue

        manifest_paths: dict[str, str] = {}
        spine_idrefs: list[str] = []
        for element in root.iter():
            tag = _local_name(element.tag)
            if tag == "item":
                item_id = element.attrib.get("id")
                href = element.attrib.get("href")
                if item_id and href:
                    manifest_paths[item_id] = _resolve_epub_href(opf_path, href)
            elif tag == "itemref":
                idref = element.attrib.get("idref")
                if idref:
                    spine_idrefs.append(idref)

        spine_paths: list[str] = []
        seen: set[str] = set()
        for idref in spine_idrefs:
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
        if tag not in _XHTML_BLOCK_TAGS or _has_descendant_block(element):
            continue
        if tag in {"h1", "h2", "h3"}:
            text = _normalize_text("".join(element.itertext()))
            if text and not title:
                title = text
            if text:
                paragraphs.append(text)
        else:
            text = _normalize_text("".join(element.itertext()))
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


def _local_name(tag: str) -> str:
    return tag.rsplit("}", 1)[-1].lower()


def _has_descendant_block(element: ElementTree.Element) -> bool:
    return any(
        descendant is not element and _local_name(descendant.tag) in _XHTML_BLOCK_TAGS
        for descendant in element.iter()
    )


def _normalize_text(text: str) -> str:
    return _WHITESPACE_RE.sub(" ", text).strip()

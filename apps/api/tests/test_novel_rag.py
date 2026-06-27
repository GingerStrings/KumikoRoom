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

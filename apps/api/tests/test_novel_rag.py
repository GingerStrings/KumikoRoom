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


def test_extract_epub_chunks_uses_opf_spine_order_and_skips_nav(
    tmp_path: Path,
) -> None:
    epub_path = tmp_path / "spine.epub"
    write_epub(
        epub_path,
        {
            "OEBPS/content.opf": """
                <package xmlns="http://www.idpf.org/2007/opf">
                  <manifest>
                    <item id="nav" href="Text/nav.xhtml" media-type="application/xhtml+xml" />
                    <item id="chapter2" href="Text/chapter2.xhtml" media-type="application/xhtml+xml" />
                    <item id="chapter10" href="Text/chapter10.xhtml" media-type="application/xhtml+xml" />
                  </manifest>
                  <spine>
                    <itemref idref="chapter2" />
                    <itemref idref="chapter10" />
                  </spine>
                </package>
            """,
            "OEBPS/Text/nav.xhtml": """
                <html xmlns="http://www.w3.org/1999/xhtml"><body><nav>目录</nav></body></html>
            """,
            "OEBPS/Text/chapter10.xhtml": """
                <html xmlns="http://www.w3.org/1999/xhtml"><body><h1>第十章</h1><p>第十章正文。</p></body></html>
            """,
            "OEBPS/Text/chapter2.xhtml": """
                <html xmlns="http://www.w3.org/1999/xhtml"><body><h1>第二章</h1><p>第二章正文。</p></body></html>
            """,
        },
    )

    chunks = extract_epub_chunks(
        epub_path,
        source_id="spine",
        source_title="Spine",
        max_chars=80,
    )

    assert [chunk.chapter_title for chunk in chunks] == ["第二章", "第十章"]
    assert all("目录" not in chunk.text for chunk in chunks)


def test_extract_epub_chunks_reads_common_block_tags_without_parent_duplicates(
    tmp_path: Path,
) -> None:
    epub_path = tmp_path / "blocks.epub"
    write_epub(
        epub_path,
        {
            "OEBPS/Text/chapter.xhtml": """
                <html xmlns="http://www.w3.org/1999/xhtml">
                  <body>
                    <h1>块标签章</h1>
                    <section>
                      <div>久美子在 div 里停顿了一下。</div>
                      <ul><li>丽奈在 li 里提到了合奏。</li></ul>
                    </section>
                  </body>
                </html>
            """,
        },
    )

    chunks = extract_epub_chunks(
        epub_path,
        source_id="blocks",
        source_title="Blocks",
        max_chars=120,
    )

    joined = "\n".join(chunk.text for chunk in chunks)
    assert "块标签章" in joined
    assert "久美子在 div 里停顿了一下" in joined
    assert "丽奈在 li 里提到了合奏" in joined
    assert joined.count("久美子在 div 里停顿了一下") == 1


def test_chunk_paragraphs_respects_exact_boundary_and_splits_long_paragraph() -> None:
    from kumikoroom.novel_rag import _chunk_paragraphs

    assert _chunk_paragraphs(["一二", "三四"], max_chars=5) == ["一二\n三四"]

    chunks = _chunk_paragraphs(["一二三四五六七八九十"], max_chars=4)

    assert chunks == ["一二三四", "五六七八", "九十"]

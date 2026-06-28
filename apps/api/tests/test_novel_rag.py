import sqlite3
from pathlib import Path
from zipfile import ZIP_DEFLATED, ZipFile

import pytest

from kumikoroom import novel_rag
from kumikoroom.llm import LLMMessage, LLMResult, ProviderStatus
from kumikoroom.novel_rag import (
    NovelChunk,
    NovelIndexStats,
    NovelRagDecision,
    NovelRagRouter,
    NovelRagRoutingError,
    NovelRagStore,
    NovelSearchResult,
    build_novel_reference_context,
    discover_epubs,
    extract_epub_chunks,
    main,
    parse_novel_rag_decision,
    rebuild_novel_index,
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


def test_extract_epub_chunks_skips_nav_in_spine_and_toc_fallback(
    tmp_path: Path,
) -> None:
    spine_epub = tmp_path / "spine-nav.epub"
    write_epub(
        spine_epub,
        {
            "OEBPS/content.opf": """
                <package xmlns="http://www.idpf.org/2007/opf">
                  <manifest>
                    <item id="nav" href="Text/nav.xhtml" media-type="application/xhtml+xml" properties="nav" />
                    <item id="toc" href="Text/toc.xhtml" media-type="application/xhtml+xml" />
                    <item id="chapter" href="Text/chapter.xhtml" media-type="application/xhtml+xml" />
                  </manifest>
                  <spine>
                    <itemref idref="nav" linear="no" />
                    <itemref idref="toc" linear="no" />
                    <itemref idref="chapter" />
                  </spine>
                </package>
            """,
            "OEBPS/Text/nav.xhtml": """
                <html xmlns="http://www.w3.org/1999/xhtml"><body><p>导航目录不应进入索引。</p></body></html>
            """,
            "OEBPS/Text/toc.xhtml": """
                <html xmlns="http://www.w3.org/1999/xhtml"><body><p>TOC 目录不应进入索引。</p></body></html>
            """,
            "OEBPS/Text/chapter.xhtml": """
                <html xmlns="http://www.w3.org/1999/xhtml"><body><h1>正文章</h1><p>久美子正文。</p></body></html>
            """,
        },
    )

    chunks = extract_epub_chunks(
        spine_epub,
        source_id="spine-nav",
        source_title="Spine Nav",
        max_chars=80,
    )

    joined = "\n".join(chunk.text for chunk in chunks)
    assert [chunk.chapter_title for chunk in chunks] == ["正文章"]
    assert "久美子正文" in joined
    assert "导航目录" not in joined
    assert "TOC 目录" not in joined

    fallback_epub = tmp_path / "fallback-nav.epub"
    write_epub(
        fallback_epub,
        {
            "OEBPS/Text/nav.xhtml": """
                <html xmlns="http://www.w3.org/1999/xhtml"><body><p>fallback 导航目录。</p></body></html>
            """,
            "OEBPS/Text/toc.xhtml": """
                <html xmlns="http://www.w3.org/1999/xhtml"><body><p>fallback TOC。</p></body></html>
            """,
            "OEBPS/Text/chapter.xhtml": """
                <html xmlns="http://www.w3.org/1999/xhtml"><body><h1>Fallback 正文</h1><p>丽奈正文。</p></body></html>
            """,
        },
    )

    fallback_chunks = extract_epub_chunks(
        fallback_epub,
        source_id="fallback-nav",
        source_title="Fallback Nav",
        max_chars=80,
    )
    fallback_text = "\n".join(chunk.text for chunk in fallback_chunks)
    assert "丽奈正文" in fallback_text
    assert "fallback 导航目录" not in fallback_text
    assert "fallback TOC" not in fallback_text


def test_extract_epub_chunks_omits_script_and_style_text(tmp_path: Path) -> None:
    epub_path = tmp_path / "script-style.epub"
    write_epub(
        epub_path,
        {
            "OEBPS/Text/chapter.xhtml": """
                <html xmlns="http://www.w3.org/1999/xhtml">
                  <body>
                    <p>久美子正文<script>secret script text</script><style>secret style text</style></p>
                  </body>
                </html>
            """,
        },
    )

    chunks = extract_epub_chunks(
        epub_path,
        source_id="script-style",
        source_title="Script Style",
        max_chars=80,
    )

    text = "\n".join(chunk.text for chunk in chunks)
    assert "久美子正文" in text
    assert "secret script text" not in text
    assert "secret style text" not in text


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


def test_store_searches_natural_cjk_question_with_extra_words(
    tmp_path: Path,
) -> None:
    store = NovelRagStore(tmp_path / "novels.sqlite3")
    store.clear()
    store.upsert_chunks(
        [
            NovelChunk(
                source_id="01",
                source_title="第一卷",
                source_path="local.epub",
                chapter_path="chapter.xhtml",
                chapter_title="第一章",
                chunk_index=0,
                text="久美子和丽奈站在一起，谁都没有先把话说满。",
            )
        ]
    )

    results = store.search("久美子和丽奈的关系为什么这样", limit=5)

    assert len(results) == 1
    assert "久美子和丽奈站在一起" in results[0].text


def test_store_searches_natural_cjk_question_with_different_connectives(
    tmp_path: Path,
) -> None:
    store = NovelRagStore(tmp_path / "novels.sqlite3")
    store.clear()
    store.upsert_chunks(
        [
            NovelChunk(
                source_id="01",
                source_title="第一卷",
                source_path="local.epub",
                chapter_path="chapter.xhtml",
                chapter_title="第一章",
                chunk_index=0,
                text="久美子与丽奈站在一起，谁都没有先把话说满。",
            )
        ]
    )

    results = store.search("久美子和丽奈的关系为什么这样", limit=5)

    assert len(results) == 1
    assert "久美子与丽奈站在一起" in results[0].text


def test_store_searches_long_natural_cjk_question_with_keywords_near_end(
    tmp_path: Path,
) -> None:
    store = NovelRagStore(tmp_path / "novels.sqlite3")
    store.clear()
    store.upsert_chunks(
        [
            NovelChunk(
                source_id="01",
                source_title="第一卷",
                source_path="local.epub",
                chapter_path="chapter.xhtml",
                chapter_title="第一章",
                chunk_index=0,
                text="久美子与丽奈站在一起，谁都没有先把话说满。",
            )
        ]
    )

    query = (
        "我想知道原作里那种明明很在意却又说得很轻的关系变化到底"
        "为什么会发展成这样尤其是久美子和丽奈"
    )
    results = store.search(query, limit=5)

    assert len(results) == 1
    assert "久美子与丽奈站在一起" in results[0].text


def test_store_searches_long_cjk_question_when_punctuation_separates_keywords(
    tmp_path: Path,
) -> None:
    store = NovelRagStore(tmp_path / "novels.sqlite3")
    store.clear()
    store.upsert_chunks(
        [
            NovelChunk(
                source_id="01",
                source_title="第一卷",
                source_path="local.epub",
                chapter_path="chapter.xhtml",
                chapter_title="第一章",
                chunk_index=0,
                text="久美子与丽奈站在一起，谁都没有先把话说满。",
            )
        ]
    )

    query = (
        "我想知道原作里那种明明很在意却又说得很轻的关系变化到底"
        "为什么会发展成这样，尤其是久美子和丽奈"
    )
    results = store.search(query, limit=5)

    assert len(results) == 1
    assert "久美子与丽奈站在一起" in results[0].text


def test_store_search_empty_query_returns_empty_list(tmp_path: Path) -> None:
    store = NovelRagStore(tmp_path / "novels.sqlite3")

    assert store.search("   ") == []


def test_store_closes_connections_after_operations(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    connections: list[TrackingConnection] = []
    original_connect = novel_rag.sqlite3.connect

    class TrackingConnection(sqlite3.Connection):
        closed = False

        def close(self) -> None:
            self.closed = True
            super().close()

    def tracking_connect(*args: object, **kwargs: object) -> TrackingConnection:
        connect_kwargs = dict(kwargs)
        connect_kwargs["factory"] = TrackingConnection
        connection = original_connect(*args, **connect_kwargs)
        connections.append(connection)
        return connection

    monkeypatch.setattr(novel_rag.sqlite3, "connect", tracking_connect)
    db_path = tmp_path / "novels.sqlite3"

    try:
        store = NovelRagStore(db_path)
        store.clear()
        store.upsert_chunks(
            [
                NovelChunk(
                    source_id="01",
                    source_title="第一卷",
                    source_path="local.epub",
                    chapter_path="chapter.xhtml",
                    chapter_title="第一章",
                    chunk_index=0,
                    text="久美子。",
                )
            ]
        )

        assert store.search("久美子", limit=1)
        assert connections
        assert all(connection.closed for connection in connections)

        db_path.unlink()

        assert not db_path.exists()
    finally:
        for connection in connections:
            if not connection.closed:
                connection.close()


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
    assert (
        NovelRagStore(db_path).search("久美子", limit=1)[0].source_id
        == "01-fixture"
    )


def test_rebuild_novel_index_keeps_colliding_source_ids_distinct(
    tmp_path: Path,
) -> None:
    corpus_dir = tmp_path / "corpus"
    corpus_dir.mkdir()
    write_epub(
        corpus_dir / "a b.epub",
        {
            "OEBPS/Text/chapter.xhtml": (
                "<html xmlns='http://www.w3.org/1999/xhtml'>"
                "<body><p>第一本久美子。</p></body></html>"
            )
        },
    )
    write_epub(
        corpus_dir / "a-b.epub",
        {
            "OEBPS/Text/chapter.xhtml": (
                "<html xmlns='http://www.w3.org/1999/xhtml'>"
                "<body><p>第二本丽奈。</p></body></html>"
            )
        },
    )
    db_path = tmp_path / "rag.sqlite3"

    stats = rebuild_novel_index(corpus_dir, db_path)
    store = NovelRagStore(db_path)
    first_result = store.search("第一本久美子", limit=1)
    second_result = store.search("第二本丽奈", limit=1)

    assert stats.source_count == 2
    assert stats.chunk_count == 2
    assert first_result
    assert second_result
    assert first_result[0].source_id != second_result[0].source_id


def test_rebuild_novel_index_reports_broken_epub_and_continues(
    tmp_path: Path,
) -> None:
    corpus_dir = tmp_path / "corpus"
    corpus_dir.mkdir()
    (corpus_dir / "01.broken.epub").write_bytes(b"not an epub")
    write_epub(
        corpus_dir / "02.valid.epub",
        {
            "OEBPS/Text/chapter.xhtml": """
                <html xmlns="http://www.w3.org/1999/xhtml">
                  <body><p>久美子继续被索引。</p></body>
                </html>
            """,
        },
    )
    db_path = tmp_path / "rag.sqlite3"

    stats = rebuild_novel_index(corpus_dir, db_path)

    assert stats.source_count == 1
    assert stats.chunk_count == 1
    assert stats.errors
    assert "01.broken.epub" in stats.errors[0]
    assert (
        NovelRagStore(db_path).search("久美子", limit=1)[0].source_id == "02-valid"
    )


class FakeRouterProvider:
    def __init__(
        self,
        responses: list[str] | None = None,
        *,
        error: Exception | None = None,
    ) -> None:
        self.responses = responses or []
        self.error = error
        self.calls: list[dict[str, object]] = []

    def generate(
        self,
        messages: list[LLMMessage],
        tools: list[dict[str, object]] | None = None,
        tool_choice: str | None = None,
        timeout: float | None = None,
    ) -> LLMResult:
        self.calls.append(
            {
                "messages": messages,
                "tools": tools,
                "tool_choice": tool_choice,
                "timeout": timeout,
            }
        )
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
        message["content"] or ""
        for message in provider.calls[0]["messages"]  # type: ignore[index]
    )
    assert "JSON only" in prompt_text
    assert "之前聊到丽奈" in prompt_text
    assert "刚才说北宇治" in prompt_text


@pytest.mark.parametrize(
    "message",
    [
        "播放京吹角色歌为什么没声音",
        "久美子你觉得我和朋友的关系怎么样",
    ],
)
def test_router_uses_provider_decision_to_skip_false_positive_like_commands(
    message: str,
) -> None:
    provider = FakeRouterProvider(
        ['{"use_novel_rag": false, "reason": "provider skipped"}']
    )

    decision = NovelRagRouter(provider).route(message)

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


@pytest.mark.parametrize(
    "provider",
    [
        FakeRouterProvider(error=RuntimeError("provider down")),
        FakeRouterProvider(["not json"]),
    ],
)
def test_router_falls_back_to_skip_on_provider_or_parse_failure(
    provider: FakeRouterProvider,
) -> None:
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


def test_build_novel_reference_context_deduplicates_exact_snippet_text() -> None:
    results = [
        NovelSearchResult(
            source_id="01",
            source_title="第一卷",
            chapter_path="a.xhtml",
            chapter_title="第一章",
            chunk_index=0,
            text="久美子重复片段。",
            rank=-1.0,
        ),
        NovelSearchResult(
            source_id="02",
            source_title="第二卷",
            chapter_path="b.xhtml",
            chapter_title="第二章",
            chunk_index=3,
            text="久美子重复片段。",
            rank=-0.5,
        ),
    ]

    context = build_novel_reference_context(results, max_chars=260)

    assert context.count("久美子重复片段") == 1


def test_build_novel_reference_context_respects_whole_context_budget() -> None:
    results = [
        NovelSearchResult(
            source_id=str(index),
            source_title="很长的卷名" * 8,
            chapter_path=f"chapter{index}.xhtml",
            chapter_title="很长的章节名" * 8,
            chunk_index=index,
            text="久美子很长的片段。" * 40,
            rank=-float(index + 1),
        )
        for index in range(5)
    ]

    context = build_novel_reference_context(results, max_chars=360)

    assert len(context) <= 360
    assert "使用规则" in context
    assert "不要长段复述原文" in context


def test_build_novel_reference_context_lists_snippets_before_rules() -> None:
    context = build_novel_reference_context(
        [
            NovelSearchResult(
                source_id="01",
                source_title="第一卷",
                chapter_path="chapter.xhtml",
                chapter_title="第一章",
                chunk_index=0,
                text="久美子先沉默了一下。",
                rank=-1.0,
            )
        ],
        max_chars=360,
    )

    assert context.index("久美子先沉默了一下") < context.index("使用规则")


def test_main_rebuild_prints_index_stats(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
    capsys: pytest.CaptureFixture[str],
) -> None:
    settings = type(
        "Settings",
        (),
        {
            "novel_corpus_dir": tmp_path / "corpus",
            "novel_rag_db_path": tmp_path / "rag.sqlite3",
        },
    )()
    calls: list[tuple[Path, Path]] = []

    def fake_load_settings() -> object:
        return settings

    def fake_rebuild_novel_index(
        corpus_dir: Path | str,
        db_path: Path | str,
    ) -> NovelIndexStats:
        calls.append((Path(corpus_dir), Path(db_path)))
        return NovelIndexStats(
            source_count=2,
            chunk_count=7,
            skipped_files=("notes.txt",),
            errors=(),
        )

    monkeypatch.setattr(novel_rag, "load_settings", fake_load_settings, raising=False)
    monkeypatch.setattr(novel_rag, "rebuild_novel_index", fake_rebuild_novel_index)

    exit_code = main(["rebuild"])

    output = capsys.readouterr().out
    assert exit_code == 0
    assert calls == [(settings.novel_corpus_dir, settings.novel_rag_db_path)]
    assert "Indexed sources: 2" in output
    assert "Indexed chunks: 7" in output
    assert "Skipped files: 1" in output
    assert "  skipped: notes.txt" in output
    assert "Errors: 0" in output


def test_main_rebuild_returns_one_when_index_has_errors(
    monkeypatch: pytest.MonkeyPatch,
    capsys: pytest.CaptureFixture[str],
    tmp_path: Path,
) -> None:
    class FakeSettings:
        novel_corpus_dir = tmp_path / "corpus"
        novel_rag_db_path = tmp_path / "rag.sqlite3"

    def fake_load_settings() -> FakeSettings:
        return FakeSettings()

    def fake_rebuild_novel_index(corpus_dir: Path, db_path: Path) -> NovelIndexStats:
        return NovelIndexStats(
            source_count=0,
            chunk_count=0,
            skipped_files=("ignore.pdf",),
            errors=("broken.epub: bad zip",),
        )

    monkeypatch.setattr(novel_rag, "load_settings", fake_load_settings)
    monkeypatch.setattr(novel_rag, "rebuild_novel_index", fake_rebuild_novel_index)

    assert novel_rag.main(["rebuild"]) == 1
    output = capsys.readouterr().out
    assert "Errors: 1" in output
    assert "error: broken.epub: bad zip" in output

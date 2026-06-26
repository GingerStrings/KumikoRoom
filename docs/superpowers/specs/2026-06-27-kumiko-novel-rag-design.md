# Kumiko Novel RAG and Persona Logic Design

Date: 2026-06-27

## Purpose

KumikoRoom currently uses a compact runtime persona prompt, recent chat context, local user memory, room state, and music state to shape replies. This feature adds a local novel-backed reference layer for Hibike! Euphonium source details, while tightening the speaking logic that makes the Kumiko persona feel recognizable and controlled.

The first slice should improve both:

- source-aware answers about characters, relationships, plot context, and original-novel details;
- everyday replies that follow a stable Kumiko-like conversation rhythm.

The novel files live locally under `D:\555\codex\jc`. The implementation must treat them as private local material. Extracted text, indexes, and generated metadata stay under `user-data/` and are not committed.

## Goals

- Build a local index from the 12 Hibike! Euphonium EPUB files in `D:\555\codex\jc`.
- Use SQLite FTS5 for the first retrieval implementation, avoiding heavy new dependencies.
- Retrieve short novel reference snippets only when the current turn appears to need source context.
- Keep a compact always-on persona logic card in the runtime prompt.
- Keep the existing chat API shape working when no corpus or index exists.
- Prevent long source-text reproduction in model output.
- Make retrieval, prompt assembly, and persona rules testable without live LLM calls.

## Non-Goals

- Adding semantic embedding search in the first implementation.
- Adding a new frontend settings panel for RAG.
- Uploading, syncing, or committing novel text.
- Building a public quote database or export feature.
- Asking the model to imitate exact novel prose or reproduce long passages.
- Changing the music tool loop, Auto DJ planning, or session storage behavior.
- Replacing the existing user memory system.

## Chosen Architecture

Use a backend-only local RAG slice:

```text
EPUB files in D:\555\codex\jc
  -> local indexing command/API helper
  -> user-data/rag/kumiko-novels.sqlite3
  -> per-turn retrieval gate
  -> short novel reference context
  -> ConversationManager system prompt
```

The existing chat request contract remains unchanged. `ConversationManager` gets one new optional collaborator, a novel reference store/retriever. If the retriever is absent, disabled, or has no index, chat continues as it does today.

This fits the current ownership boundary:

- `persona.py` owns compact speaking rules.
- `memory.py` owns user memory.
- the new novel RAG module owns source extraction, indexing, and retrieval.
- `conversation.py` owns prompt assembly and decides which context blocks enter a turn.

## Corpus Selection

The importer reads only EPUB files matching the known novel set. The current local directory includes unrelated PDFs, images, HTML, and videos, so the importer must whitelist `.epub` and ignore every other file.

The first implementation should sort by filename and record:

- `source_id`: stable file-derived id such as `01-welcome-kitauji`;
- `source_title`: filename-derived title;
- `source_path`: local absolute path, stored only in the local SQLite database;
- `chapter_path`: EPUB internal XHTML path;
- `chapter_title`: best-effort title from the XHTML document or generated fallback;
- `chunk_index`: numeric order within the source;
- `text`: normalized text chunk.

The app should not require the corpus path to exist. A missing path should produce no retrieval context and, at most, a log/debug status.

## Indexing

Add a module such as `apps/api/kumikoroom/novel_rag.py` with focused boundaries:

```py
class NovelRagStore:
    def __init__(self, db_path: Path | str) -> None: ...
    def initialize_schema(self) -> None: ...
    def clear(self) -> None: ...
    def upsert_chunks(self, chunks: list[NovelChunk]) -> None: ...
    def search(self, query: str, *, limit: int = 5) -> list[NovelSearchResult]: ...

def discover_epubs(corpus_dir: Path) -> list[Path]: ...
def extract_epub_chunks(epub_path: Path, source_id: str, source_title: str) -> list[NovelChunk]: ...
def rebuild_novel_index(corpus_dir: Path, db_path: Path) -> NovelIndexStats: ...
```

Use Python standard library pieces first:

- `zipfile` for EPUB reading;
- `xml.etree.ElementTree` for XHTML parsing when possible;
- a conservative fallback text stripper only for malformed XHTML;
- `sqlite3` with FTS5 for search.

Chunking should be paragraph-window based:

- normalize whitespace and remove empty boilerplate;
- keep chunks around 400-800 Chinese characters;
- overlap lightly when a paragraph boundary would otherwise lose context;
- store enough metadata to show where a snippet came from.

The index lives at `user-data/rag/kumiko-novels.sqlite3` by default. Add configuration fields alongside the first implementation:

- `KUMIKOROOM_NOVEL_CORPUS_DIR`
- `KUMIKOROOM_NOVEL_RAG_DB_PATH`
- `KUMIKOROOM_NOVEL_RAG_ENABLED`

For this local workspace, `D:\555\codex\jc` is the intended corpus directory. If the environment variable is unset, the app may use that path when it exists and otherwise skip novel retrieval quietly.

The first rebuild entry can be a local developer command:

```powershell
cd apps\api
python -m kumikoroom.novel_rag rebuild
```

The command should print indexed source count, chunk count, skipped files, and EPUB extraction errors.

## Retrieval Gate

Retrieval should be turn-scoped and conservative. The first implementation can use a deterministic heuristic before adding any LLM-based intent classifier.

Run retrieval when the current message or recent context contains signals such as:

- work/title words: `京吹`, `吹响吧`, `上低音号`, `北宇治`;
- character names: `久美子`, `丽奈`, `明日香`, `秀一`, `叶月`, `绿辉`, `奏`;
- source-detail words: `小说`, `原作`, `剧情`, `人物关系`, `设定`, `台词`, `片段`;
- personality-analysis words: `性格`, `说话方式`, `为什么`, `像她`, `人设`, `语气`.

Skip retrieval for ordinary app/tool requests, music playback actions, local file instructions, greetings, and short emotional check-ins unless the message also includes source-context signals.

The retriever should query with a compact string built from:

- the current user message;
- the last few relevant user messages;
- any directly mentioned character/work keywords.

Limit the result set to 3-5 snippets. Deduplicate by source/chapter and collapse near-identical chunks.

## Persona Logic Card

The runtime persona prompt should remain compact. `persona.py` can add a small always-on section that describes conversation logic rather than source facts.

Rules to encode:

- answer the user’s current intent first;
- listen before becoming expressive;
- prefer plain, slightly self-aware phrasing;
- use small dry comments sparingly;
- avoid grand speeches and theatrical declarations;
- avoid repeated identity exposition;
- use music/ensemble analogies only when they fit the current topic;
- treat relationships and club responsibility with nuance;
- keep technical, file, and tool instructions clear and reliable;
- do not claim current actions, practice, playback, or official status without evidence.

The card should guide style. It should not contain long source summaries, broad relationship essays, or novel quotes.

## Prompt Assembly

`ConversationManager._build_messages()` should assemble system context in this order:

1. compact persona prompt plus persona logic card;
2. recent user memory;
3. novel reference context, only when retrieval is enabled and has hits;
4. room state;
5. listening context;
6. music state.

Novel reference context should be clearly labeled, for example:

```text
小说参考片段：
- [01 欢迎加入北宇治高中吹奏乐部 / chapter21] 久美子相关片段摘要或短摘录...
- [11 决意的最终乐章(前篇) / chapter31] ...

使用规则：
- 这些片段只作为事实和性格依据。
- 不要长段复述原文。
- 如果片段不足以支持结论，要说明依据有限。
```

The context block needs a strict budget. First target:

- at most 5 snippets;
- at most about 1,500-2,000 Chinese characters total;
- trim each snippet at sentence or punctuation boundaries where practical.

This keeps the existing prompt small enough and avoids drowning out the user’s actual message.

## Output Boundaries

The assistant may summarize what the local snippets suggest. It should avoid long verbatim source reproduction.

For source-grounded answers, the model should be nudged toward wording such as:

- `从我检索到的小说片段看...`
- `这一点比较像久美子的...`
- `片段能支持到这里，再往后就需要更多上下文。`

When retrieval returns weak or no evidence, the assistant should say so briefly and answer from the stable persona/profile layer.

## API and UI Impact

The first slice should not require frontend changes.

Possible later additions:

- an API endpoint to show index status;
- a manual “rebuild novel index” control in a local settings/debug panel;
- a visible source badge for answers that used novel references.

For the first implementation, the local developer command is enough to rebuild the index. The chat endpoint should auto-use the index when it exists and the retrieval gate triggers.

## Error Handling

- Missing corpus directory: skip indexing and report zero indexed sources.
- Missing RAG database: chat proceeds without novel context.
- Broken EPUB file: skip that file, continue indexing others, and include the error in index stats.
- Malformed XHTML: use fallback extraction for that document.
- SQLite FTS unavailable: raise a clear startup/indexing error in tests or indexing command; chat still works if no retriever is configured.
- Search errors during chat: log and continue without novel context.

No RAG failure should break the chat endpoint.

## Testing

Add focused API tests without live model calls:

- EPUB extraction can parse a tiny fixture EPUB and produce ordered chunks.
- Index rebuild inserts chunks and returns source/chunk counts.
- FTS search returns expected chunks for Chinese terms and character names.
- Retrieval gate triggers for source/persona questions and skips unrelated tool/music messages.
- `ConversationManager` includes novel context only when the retriever returns hits.
- `ConversationManager` omits novel context when retrieval is disabled, the index is empty, or the gate skips.
- Prompt output includes source labels and the no-long-quote instruction.
- Existing persona tests still enforce compact prompt size and core identity facts.

The fixture EPUB should be synthetic and tiny. Do not commit excerpts from the local novels.

## Implementation Order

1. Add the RAG data model, EPUB extraction, SQLite schema, and search tests.
2. Add an index rebuild helper with stats and safe corpus filtering.
3. Add retrieval gating and prompt-context formatting.
4. Wire the retriever into `ConversationManager`.
5. Tighten the persona logic card and update persona tests.
6. Add conversation tests for with/without novel context.
7. Run API tests and then the broader workspace tests if practical.

## Acceptance Criteria

- A local index can be built from the 12 EPUB files under `D:\555\codex\jc`.
- The generated index lives under `user-data/rag/` or another ignored local path.
- Asking about Kumiko, her relationships, or original-novel details adds bounded novel context to the LLM prompt.
- Ordinary chat and music/tool commands do not pay a retrieval cost unless they mention source-context signals.
- The persona becomes more explicit about speaking logic while staying compact.
- Chat remains functional when the corpus or index is missing.
- Tests cover extraction, search, gating, prompt assembly, and failure fallback.

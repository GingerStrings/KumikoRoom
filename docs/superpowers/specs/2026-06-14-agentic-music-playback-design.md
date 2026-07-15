# Agentic Music Playback Design

Date: 2026-06-14

## Purpose

This redesign makes music playback in KumikoRoom agent-led. When the user asks Kumiko to play music, the chat turn should go through the LLM agent loop. The model sees tool schemas, chooses the music tools, receives real tool outputs, and then answers from those outputs. The browser player applies returned client actions.

The goal for this slice is specific: named-song playback should search NetEase and Bilibili candidates, rank them with available evidence, select the most likely playable candidate, and play it in the existing music-player UI. Personalized recommendation can wait.

## Current Problems Found

The existing implementation uses the word "agent" for code that is mostly deterministic routing:

- `apps/web/src/lib/roomAgent.ts` has regex intent patterns such as `PLAY_INTENT_PATTERN`, `MUSIC_SEARCH_COMMAND_PATTERN`, and `VIDEO_INTENT_PATTERN`.
- `apps/web/src/components/RoomShell.tsx` calls `executeRoomAgentIntent()` before `postChat()`, so recognized play requests bypass the LLM.
- `executeMusicSearchAction()` calls `searchMusic(query, 1)` and plays the first result.
- `formatRoomAgentToolReply()` generates fixed UI template replies such as `已切到《...》`.
- `ConversationManager` and `LLMProvider` only support plain text chat completions; no model-visible tools, no `tool_calls`, no tool-result continuation.
- Existing tests lock this behavior by asserting music commands do not call `postChat`.

This slice must remove that shortcut as the main path. Regex parsing can remain only for platform URL normalization or offline mock-provider behavior, never as the production decision maker for natural play requests.

## Codex Source References

The implementation should follow the actual Codex source semantics, adapted to this TypeScript/Python app:

- `codex-rs/core/src/session/turn.rs:123`: `run_turn` loops over model sampling; model output is either function calls or assistant messages.
- `codex-rs/core/src/session/turn.rs:1001`: `build_prompt()` passes `router.model_visible_specs()` to the model.
- `codex-rs/core/src/session/turn.rs:1040`: `run_sampling_request()` builds a `ToolRouter` and a `ToolCallRuntime`.
- `codex-rs/core/src/session/turn.rs:1803`: `try_run_sampling_request()` streams model output and tracks `needs_follow_up`.
- `codex-rs/core/src/stream_events_utils.rs:405`: `handle_output_item_done()` parses completed response items.
- `codex-rs/core/src/stream_events_utils.rs:442`: a model tool call starts a tool future and sets `needs_follow_up = true`.
- `codex-rs/core/src/tools/router.rs:28`: `ToolCall` is a typed call with `tool_name`, `call_id`, and payload.
- `codex-rs/core/src/tools/router.rs:96`: `ToolRouter::build_tool_call()` converts model response items into typed tool calls.
- `codex-rs/core/src/tools/router.rs:193`: dispatch builds a `ToolInvocation` and passes it into the registry.
- `codex-rs/core/src/tools/registry.rs:391`: `ToolRegistry::dispatch_any()` executes a registered tool.
- `codex-rs/core/src/tools/registry.rs:167`: `AnyToolResult::into_response()` converts tool output back into a model input item.
- `codex-rs/core/src/tools/context.rs:184`: `FunctionToolOutput` is the model-facing tool result.
- `codex-rs/core/src/tools/parallel.rs:58`: `ToolCallRuntime::handle_tool_call()` wraps dispatch output and failure output.

The KumikoRoom version should copy the architecture, not the Rust code:

1. Build prompt with model-visible tool specs.
2. Let the model emit tool calls.
3. Dispatch only registered tools.
4. Add tool outputs back into the same agent turn.
5. Continue until the model returns a normal assistant reply.
6. Return client actions separately from the natural reply.

## Target User Flow

User: `播放 晴天 周杰伦`

Expected flow:

1. Browser sends the normal chat message to `/api/room/chat`.
2. Backend builds an agent prompt with tools:
   - `search_music`
   - `play_music_item`
3. Model calls `search_music` with `{"query":"晴天 周杰伦","source":"all","limit":8}`.
4. Backend searches NetEase and Bilibili, enriches candidates, ranks them, and returns structured tool output:
   - ranked candidates
   - score breakdown
   - selected candidate id
   - available evidence: title/artist/duration match, playability, popularity, comment count, hot-comment like count
5. Model calls `play_music_item` with the selected candidate id.
6. Backend records a client action:
   - type: `play_music_item`
   - item metadata: source, title, creator, duration, page URL, platform audio URL, tags
   - evidence and selected reason
7. Tool result is returned to the model.
8. Model writes the final Kumiko reply based on the tool result.
9. Browser appends the normal user message and model reply, then applies the client action to the existing player UI.
10. Player title, creator, source badge, audio URL, and progress reflect the selected real item.

## Agent Boundary

Backend owns agent decisions:

- Natural-language playback requests go to `/api/room/chat`.
- Search query construction belongs to the LLM tool call.
- Candidate selection belongs to backend ranking plus the model's follow-up play call.
- Final wording belongs to the LLM after tool results.

Frontend owns browser-local effects:

- Existing player state.
- Queue insertion.
- Active track selection.
- `<audio>` playback.
- Bilibili mini-window display.

Frontend can keep deterministic shortcuts only for non-natural player controls:

- Player buttons.
- Selecting an existing playlist chip.
- Opening the video mini-window button.
- Normalizing explicit platform URLs if a returned client action includes them.

## Tool Schemas

### `search_music`

Input:

```json
{
  "query": "string",
  "source": "all",
  "limit": 8
}
```

Output:

```json
{
  "ok": true,
  "query": "晴天 周杰伦",
  "source": "all",
  "selected_id": "netease-song-2668397359",
  "candidates": [
    {
      "id": "netease-song-2668397359",
      "song_id": "2668397359",
      "title": "晴天 (原唱 周杰伦)",
      "creator": "RyaVocal",
      "duration_ms": 270738,
      "page_url": "https://music.163.com/#/song?id=2668397359",
      "platform_audio_url": "https://music.163.com/song/media/outer/url?id=2668397359.mp3",
      "playable": true,
      "popularity": 100.0,
      "comment_count": 5918,
      "hot_comment_liked_count": 14314,
      "score": 139.4,
      "evidence": [
        "title contains requested title",
        "candidate is playable through NetEase outer audio URL",
        "comment_count=5918",
        "hot_comment_liked_count=14314"
      ]
    }
  ]
}
```

If engagement endpoints fail, the output must mark fields as `null` and include evidence saying which signals were unavailable.

Bilibili candidates use `source: "bilibili"`, `bvid`, `page_url`, `embed_url`, `view_count`, `comment_count`, `hot_comment_liked_count`, `score`, and `evidence`. Bilibili candidates are playable through the existing video mini-window and should set `can_open_video: true` in the client action.

### `play_music_item`

Input:

```json
{
  "item_id": "netease-song-2668397359"
}
```

Output:

```json
{
  "ok": true,
  "client_action": {
    "type": "play_music_item",
    "item": {
      "id": "netease-song-2668397359",
      "source": "netease",
      "title": "晴天 (原唱 周杰伦)",
      "creator": "RyaVocal",
      "duration_ms": 270738,
      "page_url": "https://music.163.com/#/song?id=2668397359",
      "platform_audio_url": "https://music.163.com/song/media/outer/url?id=2668397359.mp3",
      "tags": ["netease", "search", "agent-selected"],
      "can_open_video": false
    }
  }
}
```

The client action is returned in `ChatOut.client_actions`; the model also sees a text summary so it can reply naturally.

## Candidate Ranking

Ranking is deterministic and testable. The model does not pick from raw platform order alone.

Signals:

- Title match: exact normalized title, title contains requested title, requested title appears in aliases.
- Artist/request match: requested artist appears in artist names, title parentheses, aliases, or album when available.
- Variant penalties: apply negative points for `DJ`, `钢琴版`, `伴奏`, `翻自`, `cover`, `Live`, `片段`, `女声版` unless the query includes that variant.
- Duration plausibility: prefer normal song durations over very short clips.
- Playability: prefer candidates whose NetEase outer URL does not redirect to `/404`.
- Popularity: use `popularity` or `score` from `api/song/detail` when available.
- Comment count: use `api/v1/resource/comments/R_SO_4_{song_id}` total when available.
- Hot-comment likes: use top hot comment `likedCount` when available.
- Bilibili engagement: use view count, reply/comment count, and top comment likes when available.
- Search rank: use as a weak tie-breaker.

Ranking must return a score breakdown and evidence strings so tests and the model can inspect why a candidate won.

Known platform limitation: NetEase public search endpoints may hide some official copyrighted songs. If the exact original is absent or unplayable, the agent should choose the best playable candidate and mention the evidence without pretending it found an unavailable original.

## API Contract Changes

`ChatOut` gains:

```json
{
  "client_actions": [
    {
      "type": "play_music_item",
      "item": {}
    }
  ],
  "agent_trace": {
    "tool_calls": [
      {
        "id": "call_search",
        "name": "search_music",
        "ok": true
      }
    ]
  }
}
```

`agent_trace` is for tests/debugging and should stay compact.

`MusicSearchResultOut` gains:

- `song_id`
- `id`
- `playable`
- `popularity`
- `comment_count`
- `hot_comment_liked_count`
- `score`
- `evidence`

## LLM Provider Changes

`LLMProvider.generate()` should accept optional `tools` and `tool_choice`.

DeepSeek uses its OpenAI-compatible Chat Completion API:

- request includes `tools` and `tool_choice: "auto"` during agent turns.
- response may include `message.tool_calls`.
- tool result continuation appends:
  - assistant message with `tool_calls`
  - tool message with `tool_call_id`, `name`, and JSON/text content

Mock provider may simulate tool calls for development, but tests for the agent loop should use explicit fake providers that return known tool calls. Production correctness should rely on the common provider protocol, not frontend regex.

## Frontend Changes

`RoomShell` should stop calling `executeRoomAgentIntent()` before `postChat()` for natural-language music requests.

After `postChat()` returns:

1. Render the user message and backend reply as normal chat messages.
2. Apply `clientActions`:
   - for `play_music_item`, convert item payload into `MusicItem`, upsert it into `playerQueue`, select it, close video window, set `isPlayerPlaying=true`.
   - for future `open_video_window`, select the item and open the mini-window.
3. Remove template tool acknowledgements from the main chat path.

`routeRoomAgentIntent()` can be retired or reduced to deterministic UI helpers. Old tests expecting `postChat` to be skipped for natural play requests must be rewritten.

## Testing Requirements

Backend:

- DeepSeek provider sends `tools` and parses `tool_calls`.
- Conversation manager runs multi-step tool loop: user -> `search_music` -> `play_music_item` -> final reply.
- Unknown tool returns model-visible failure output and does not create a client action.
- Tool loop stops at a max iteration cap with a calm fallback.
- Search ranking chooses a candidate by score, not by raw first result.
- Ranking uses comment count and hot-comment likes when available.
- Ranking handles unavailable metrics by recording evidence.
- `/api/room/music/search` returns enriched ranked results.

Frontend:

- A natural play request calls `postChat`.
- A `play_music_item` client action updates queue, title, source badge, play state, and either audio URL or video mini-window metadata.
- The chat timeline shows the user request and backend reply, not a template tool reply.
- Existing direct player controls still work.
- Platform URL helper tests remain only for URL parsing and item normalization.

Verification:

- `npm run test --workspace apps/web`
- `python -m pytest apps/api/tests -q`
- `npm run build --workspace apps/web`
- browser test at `http://127.0.0.1:3001/room`

## Acceptance Criteria

- Asking Kumiko to play a named song enters the backend agent loop.
- Model-visible tools are part of the LLM request.
- The model can issue `search_music` and `play_music_item`.
- Search returns multiple enriched candidates.
- Ranking uses available popularity, comment, and like evidence.
- Bilibili candidates can be selected when their evidence wins or NetEase lacks a playable match.
- The chosen track is played through the existing music-player UI.
- The final chat reply is generated after tool results.
- No natural-language playback request is handled only by frontend regex.
- The UI style of the player and chat remains unchanged.

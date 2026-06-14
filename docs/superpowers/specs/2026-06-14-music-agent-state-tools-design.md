# Music Agent State And Management Tools Design

Date: 2026-06-14

## Purpose

Kumiko can currently search for music and emit a `play_music_item` client action, but her view of the player is limited to the active title, creator, source, and play/pause state. Queue, previous/next tracks, recent playback, saved tracks, playback progress, and queue management remain hidden inside the browser.

This slice makes the music player a real agent-controlled subsystem. Kumiko receives an accurate snapshot of the player's state and can explicitly call tools that read or change it. The browser remains the source of truth for playback and persisted queue records.

## Goals

- Give the agent enough state to answer questions about the current track, play/pause state, progress, previous track, next track, upcoming queue, recent playback, and saved tracks.
- Expose queue and saved-track operations as explicit agent tools.
- Keep `search_music` ranking and evidence available for play-now and add-to-queue flows.
- Make every mutation visible as a typed client action that the frontend validates and applies.
- Preserve the current compact player UI and platform playback behavior.
- Clarify the queue panel as `正在播放 + 接下来`, with separate `最近` and `收藏` views.

## Non-Goals

- Personalized recommendation and user modeling.
- Cross-device queue synchronization.
- Local audio or FL project integration.
- Agent-authored recent-history entries.
- A general-purpose Codex runtime reimplementation.

## Codex Source Basis

The agent tool architecture is based on direct reading of `D:\555\codex\codex-main.zip`, especially:

- `codex-main/codex-rs/core/src/tools/spec_plan.rs`
  - `build_tool_specs_and_registry` separates model-visible tool specifications from runtime handlers.
- `codex-main/codex-rs/core/src/tools/router.rs`
  - `ToolRouter::build_tool_call` converts model output into a typed call and routes by tool name.
- `codex-main/codex-rs/core/src/tools/registry.rs`
  - tool execution returns a model-visible result while lifecycle and runtime concerns remain separate.
- `codex-main/codex-rs/core/src/stream_events_utils.rs`
  - `handle_output_item_done` records an explicit model tool call, executes it, and marks the turn for follow-up.
- `codex-main/codex-rs/core/src/session/turn.rs`
  - tool results are fed back into the next sampling request until the model produces a final response.
- `codex-main/codex-rs/core/src/tools/handlers/dynamic.rs`
  - dynamic tool requests and responses are represented as explicit events with stable call IDs and success state.

KumikoRoom will keep its smaller synchronous loop, while following the same boundaries:

1. Model-visible tool specs are explicit.
2. A dispatcher routes calls by tool name.
3. Tool output returns structured success/error content to the model.
4. Browser mutations are typed client actions, never inferred from reply text.
5. Tool calls remain visible in `agent_trace`.

## Architecture

### Browser-Owned State

`RoomShell` remains the source of truth for:

- active track;
- play/pause state;
- playback position and duration;
- upcoming queue order;
- recent playback records;
- saved tracks;
- video mini-window state.

Before each chat request, the browser builds a `MusicAgentState` snapshot and sends it with the request.

### Agent Tool Context

`RoomAgentToolContext` receives the snapshot at the start of a turn. Read tools return facts from the snapshot. Mutation tools append typed `RoomClientActionOut` values. Search candidates remain turn-local and can be referenced by later tool calls.

The backend does not pretend that a client action has already changed browser state. Tool output says the action was requested and includes the emitted action. A later user turn receives the updated browser snapshot.

### Client Action Executor

The frontend uses one typed reducer-like entry point for all agent music actions. It validates each action, applies it to `MusicQueueState`, updates transport state when needed, and persists the queue.

## Music State Contract

Add a request field named `music_state`.

```ts
interface MusicAgentTrack {
  id: string;
  source: "bilibili" | "netease";
  title: string;
  creator: string;
  durationMs: number;
  pageUrl: string | null;
  canOpenVideo: boolean;
  saved: boolean;
}

interface MusicAgentState {
  isPlaying: boolean;
  currentTimeMs: number;
  durationMs: number;
  current: MusicAgentTrack | null;
  previous: MusicAgentTrack | null;
  next: MusicAgentTrack | null;
  upcoming: MusicAgentTrack[];
  recent: MusicAgentTrack[];
  saved: MusicAgentTrack[];
}
```

Rules:

- `previous` is the most recently played record.
- `next` is the first upcoming entry.
- `upcoming` excludes the active track.
- `recent` is newest-first and capped by the existing queue record limit.
- `saved` contains saved entries regardless of queue status.
- `currentTimeMs` and `durationMs` describe only `current`.
- Empty collections are sent as empty arrays, and missing tracks are `null`.

The existing `listening_context` remains temporarily for compatibility and persona prompting. `music_state` becomes the authoritative music tool context.

## Tool Set

### Read And Search

- `get_music_state()`
  - Returns the complete state snapshot.
- `search_music(query, source="all", limit=8)`
  - Keeps the existing ranked candidate behavior and evidence.

### Mutations

- `play_music_item(item_id)`
  - Plays a search candidate or a known item from current/upcoming/recent/saved state.
- `add_music_to_queue(item_id)`
  - Adds a search candidate or known state item to the end of `upcoming` without interrupting playback.
- `remove_music_from_queue(item_id)`
  - Removes one item from upcoming. It rejects current/recent/saved-only targets.
- `save_music_item(item_id)`
  - Saves a search candidate or known state item.
- `unsave_music_item(item_id)`
  - Removes one known item from saved tracks.
- `clear_music_queue()`
  - Clears upcoming tracks and keeps current/recent/saved records.

Recent playback has no mutation tool. It is generated by actual playback transitions.

Queue reordering is deferred until the basic tool set is stable. The current user need is play, add, remove, clear, save, and unsave.

## Client Actions

Extend `RoomClientAction` / `RoomClientActionOut` with:

```ts
type RoomClientAction =
  | { type: "play_music_item"; item: ClientMusicItem }
  | { type: "add_music_to_queue"; item: ClientMusicItem }
  | { type: "remove_music_from_queue"; itemId: string }
  | { type: "save_music_item"; item: ClientMusicItem }
  | { type: "unsave_music_item"; itemId: string }
  | { type: "clear_music_queue" }
  | { type: "open_video_window"; item: ClientMusicItem };
```

Actions carrying an item use the same `ClientMusicItem` contract as search playback. ID-only actions can only target entries already present in the browser state.

## Intent And Tool Guidance

The agent prompt/tool descriptions should establish these semantics:

- “放一下 / 播放 / 来一首” calls `play_music_item`.
- “加到队列 / 接着放” calls `add_music_to_queue`.
- “下一首是什么 / 现在放的什么 / 我收藏了什么” calls `get_music_state`.
- “删掉下一首 / 从队列移除” calls `remove_music_from_queue`.
- “收藏当前这首” calls `save_music_item`.
- “取消收藏” calls `unsave_music_item`.
- “清空接下来” calls `clear_music_queue`.

Search and selection remain agent-led. The browser must not inspect user text to trigger music behavior.

## Queue UI Semantics

The current player card keeps its appearance. The management panel changes its first tab:

- Tab label becomes `接下来`.
- A small `正在播放` section appears above the upcoming list.
- Upcoming rows exclude the current item.
- `最近` and `收藏` retain their current purpose.
- Empty upcoming state says `接下来还没有歌曲`.

This change removes the ambiguous presentation where the current track appears to be part of the queue.

## Error Handling

- Unknown tool names return structured errors to the model.
- Empty or unknown item IDs return `ok: false` with a useful error.
- Candidate-based tools reject unplayable candidates for play/add.
- State-item tools can resolve items from current, upcoming, recent, or saved snapshots.
- Remove rejects items outside upcoming.
- Unsave rejects items absent from saved.
- Client action validation ignores malformed actions without corrupting queue state.
- Existing localStorage validation continues to protect queue hydration.

## Testing

Backend:

- schemas accept and preserve full `music_state`;
- `get_music_state` returns the provided snapshot;
- known state items can be played/saved without a search call;
- search candidates can be added to queue without play;
- remove/unsave/clear emit correct typed actions;
- invalid targets return structured failures;
- agent loop feeds tool outputs back to the provider and returns actions/traces.

Frontend:

- `buildMusicAgentState` produces correct current/previous/next/upcoming/recent/saved and progress fields;
- API client maps `music_state` and all action variants;
- queue helper adds without playing, saves an inserted item, explicitly unsaves, and clears only upcoming;
- `RoomShell` sends full state with chat requests;
- all action variants mutate browser queue state correctly and persist after reload;
- queue panel shows current separately from upcoming.

Browser:

- current/next/recent/saved surfaces remain readable in the right rail;
- an agent play action starts the selected track;
- add-to-queue leaves the current track playing;
- save/remove/clear actions update the panel;
- no console errors or warnings.

## Acceptance Criteria

- Kumiko can truthfully answer what is playing, whether it is paused, and what the previous and next tracks are.
- Kumiko can add, remove, clear, save, unsave, and play through explicit tools.
- Asking to add a track does not interrupt current playback.
- Asking to play a track does not erase unrelated upcoming tracks.
- Recent records reflect real playback transitions only.
- The first queue panel tab clearly separates the active track from upcoming tracks.
- No frontend keyword detector controls music behavior.


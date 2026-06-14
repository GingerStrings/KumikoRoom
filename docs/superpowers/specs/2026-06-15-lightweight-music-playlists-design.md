# Lightweight Music Playlists Design

Date: 2026-06-15

## Purpose

The room player now has real playback state, upcoming queue management, recent records, saved songs, and agent-emitted music actions. The next step is to give those pieces a music-platform shape without turning the right rail into a full standalone music app.

This slice adds a lightweight playlist system. Playlists are long-lived music collections. The current queue remains the short-lived playback order for this listening session. Kumiko can manage both through explicit tools, and the browser remains the source of truth for local playlist and playback state.

## Goals

- Add a compact `我的歌单` experience inside the existing player management panel.
- Keep the current player card visually stable.
- Preserve the current queue semantics while showing it as `已播放 / 正在播放 / 接下来`.
- Let users create, rename, delete, view, play, enqueue, and edit playlists.
- Let Kumiko create and manage playlists through explicit agent tools.
- Support natural requests such as `建一个北宇治歌单`, `把当前这首加进去`, `播放久美子推荐`, and `把最近听过的吹奏部曲子整理成歌单`.
- Store playlist data locally in the first slice while keeping the model shape ready for later API persistence.

## Non-Goals

- Account system, cloud sync, sharing, comments, or public playlist pages.
- Complex cover generation.
- Drag-and-drop ordering in the first implementation.
- Personalized recommendation model training.
- Replacing the compact room player with a full music application route.
- Local audio or FL project management.

## Recommended Approach

Use a two-layer music model:

1. **Playlist layer**: stable collections such as `北宇治吹奏部`, `雨天散步`, `久美子推荐`, or user-created themes.
2. **Playback layer**: the current queue, split into played/current/upcoming states.

The right player `管理` panel becomes a compact music library with these tabs:

- `当前队列`
- `我的歌单`
- `最近`
- `收藏`

This keeps the feature lightweight but gives it the same mental model as a real music platform.

## Existing System Fit

The implementation should build on:

- `MusicItem` as the canonical song payload.
- `MusicQueueState` for current playback order and history.
- `MusicAgentState` for the agent-visible browser snapshot.
- `RoomClientAction` for browser mutations requested by the backend.
- localStorage hydration and validation patterns already used for the queue.

Do not revive the deleted frontend-only `roomAgent` runtime. Agent behavior remains backend tool calls plus typed client actions.

## Codex Source Basis

Agent tool design continues to follow the source-backed pattern already documented from `D:\555\codex\codex-main.zip`:

- model-visible tool specs stay explicit;
- tool calls are routed by name through a dispatcher;
- handlers return structured success/error results to the model;
- browser mutations are represented as typed client actions;
- tool calls and outcomes remain visible through trace data.

The relevant Codex source paths remain:

- `codex-main/codex-rs/core/src/tools/spec_plan.rs`
- `codex-main/codex-rs/core/src/tools/router.rs`
- `codex-main/codex-rs/core/src/tools/registry.rs`
- `codex-main/codex-rs/core/src/session/turn.rs`
- `codex-main/codex-rs/core/src/tools/handlers/dynamic.rs`

This feature should not use reply-text parsing or frontend keyword detection to manage playlists.

## Data Model

Add a browser-side playlist model.

```ts
interface MusicPlaylist {
  id: string;
  name: string;
  description: string | null;
  items: MusicPlaylistItem[];
  createdAt: string;
  updatedAt: string;
  source: "user" | "agent" | "recent" | "saved";
}

interface MusicPlaylistItem {
  item: MusicItem;
  addedAt: string;
  addedBy: "user" | "agent";
  sourceQuery?: string;
  selectedReason?: string;
  selectionEvidence?: string[];
}

interface MusicLibraryState {
  playlists: MusicPlaylist[];
  selectedPlaylistId: string | null;
}
```

Rules:

- Playlist item identity is `item.id`.
- Adding a duplicate item updates metadata and `addedAt`, and does not create duplicate visible rows.
- Deleting a playlist never deletes queue, recent, or saved records.
- Removing a song from a playlist never unsaves it and never removes it from recent.
- Playing a playlist makes the first item current and appends the remaining items to upcoming.
- Enqueueing a playlist appends all playlist items to upcoming without interrupting playback.

## UI Design

### Player Card

The player card keeps the current track, progress, controls, source badge, optional video mini-window button, and compact queue preview. The `管理` button remains the main entry point.

### Management Panel Tabs

`当前队列`:

- Shows three sections: `已播放`, `正在播放`, `接下来`.
- Keeps current playback management close to the existing queue behavior.
- `清空接下来` affects only upcoming entries.

`我的歌单`:

- Shows a compact playlist list first.
- Each playlist row shows name, description, count, and source badge.
- Selecting a playlist opens a detail view in the same panel.
- Detail view shows actions: `播放`, `加到接下来`, `重命名`, `删除`.
- Song rows show title, creator, source badge, and actions: `播放`, `加到接下来`, `收藏/取消收藏`, `小窗` when supported, `移除`.
- A compact `新建` action creates an empty playlist.

`最近`:

- Keeps playback history.
- Adds an action to add a recent item to a playlist.
- Adds an action to create a playlist from selected recent context through Kumiko later.

`收藏`:

- Keeps saved single songs.
- Adds an action to add a saved item to a playlist.

### Empty States

- No playlists: `还没有歌单`.
- Empty playlist: `这个歌单还没有歌曲`.
- No upcoming songs: `接下来还没有歌曲`.

All empty states should stay short and fit the compact panel.

## Manual User Workflows

- Create playlist from `我的歌单`.
- Rename or delete a playlist from playlist detail.
- Add current song to a playlist.
- Add a queue/recent/saved song to a playlist.
- Play a playlist immediately.
- Append a playlist to upcoming.
- Remove a song from a playlist.

The first implementation can use a small menu or inline select for choosing a playlist. It should avoid a large modal.

## Agent Tools

Add playlist tools to the backend tool set.

Read tools:

- `list_music_playlists()`
  - Returns playlist id, name, description, count, and updated time.
- `get_music_playlist(playlist_id_or_name)`
  - Returns playlist details and items.

Mutation tools:

- `create_music_playlist(name, description?)`
- `rename_music_playlist(playlist_id_or_name, name)`
- `delete_music_playlist(playlist_id_or_name)`
- `add_music_to_playlist(playlist_id_or_name, item_id)`
- `remove_music_from_playlist(playlist_id_or_name, item_id)`
- `play_music_playlist(playlist_id_or_name)`
- `add_playlist_to_queue(playlist_id_or_name)`

`item_id` can refer to:

- a search candidate from this turn;
- current track;
- upcoming track;
- recent track;
- saved track;
- an item already in a playlist snapshot.

Agent-created playlists should include a clear description when the user asks for a themed or curated list.

## Agent State Contract

Extend `music_state` with a lightweight library snapshot.

```ts
interface MusicAgentPlaylistSummary {
  id: string;
  name: string;
  description: string | null;
  itemCount: number;
  updatedAt: string;
}

interface MusicAgentState {
  // existing fields...
  playlists: MusicAgentPlaylistSummary[];
}
```

For token control, full playlist item lists are returned by `get_music_playlist`, not sent on every chat request. The currently selected playlist may be included later if needed, but the first slice should keep chat payloads small.

## Client Actions

Extend `RoomClientAction` / `RoomClientActionOut` with:

```ts
type PlaylistClientAction =
  | { type: "create_music_playlist"; playlist: MusicPlaylist }
  | { type: "rename_music_playlist"; playlistId: string; name: string }
  | { type: "delete_music_playlist"; playlistId: string }
  | { type: "add_music_to_playlist"; playlistId: string; item: ClientMusicItem }
  | { type: "remove_music_from_playlist"; playlistId: string; itemId: string }
  | { type: "play_music_playlist"; playlistId: string }
  | { type: "add_playlist_to_queue"; playlistId: string };
```

The frontend validates all playlist actions before applying them. ID-only playlist playback actions use browser-owned playlist state.

## Persistence

First slice persistence:

- localStorage key: `kumikoroom.musicLibrary`.
- Validate shape on hydration.
- Discard malformed playlist records.
- Preserve known `MusicItem` extension fields such as page URLs, audio URLs, embed URLs, and tags.

Later persistence can move `MusicLibraryState` to the API without changing the UI contract.

## Error Handling

- Empty playlist names are rejected.
- Duplicate playlist names are allowed only if ids differ, but agent lookup by name must detect ambiguity and ask the model to disambiguate.
- Playlist deletion rejects unknown ids.
- Playlist playback rejects empty playlists with a structured tool error.
- Add/remove item tools reject unknown item ids.
- Client action validation ignores malformed playlist actions and leaves existing state unchanged.
- localStorage hydration falls back to an empty library if validation fails.

## Testing

Frontend helper tests:

- create, rename, delete playlist;
- add item without duplicate rows;
- remove playlist item without affecting queue/recent/saved;
- play playlist maps first item to current and remaining items to upcoming;
- enqueue playlist appends without interrupting playback;
- localStorage hydration rejects malformed records.

Frontend component tests:

- management panel shows `当前队列 / 我的歌单 / 最近 / 收藏`;
- playlist list empty state renders;
- creating a playlist adds a row;
- playlist detail actions play/enqueue/remove songs;
- current/recent/saved rows can add items to a playlist;
- chat requests send playlist summaries in `musicState`;
- agent playlist client actions update browser state and persist after reload.

Backend tests:

- tool specs include playlist read and mutation tools;
- list/get playlist tools read from `music_state`;
- add-to-playlist resolves search candidates and known state items;
- play/enqueue playlist emit typed client actions;
- empty playlist playback returns structured failure;
- ambiguous name lookup returns structured failure;
- agent trace includes playlist tool calls.

Browser smoke test:

- `http://127.0.0.1:3001/room` loads with API connected;
- right player management panel opens;
- `我的歌单` tab creates and opens a playlist;
- playlist playback updates the player and queue preview;
- no console errors.

## Acceptance Criteria

- The music panel feels like a compact music-platform library.
- Users can manage playlists without leaving the chat room.
- Playlists and the current queue have clearly different roles.
- Kumiko can create, edit, play, and enqueue playlists through explicit tools.
- No playlist behavior is triggered by frontend keyword detection.
- The right rail remains visually compact and does not overflow at desktop or mobile widths.
- Playlist data survives reloads locally.

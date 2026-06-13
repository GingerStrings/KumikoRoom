# Platform Music Player And Video Mini-Window Design

## Purpose

KumikoRoom should support platform music listening inside the companion room while preserving the current chat-first room interface. A Bilibili or NetEase Cloud Music item should feel like a music item in KumikoRoom by default. Video surfaces are available on demand through a compact mini-window.

This slice turns the existing static room player into the first version of a source-aware music player. It does not change the main chat layout, and it does not make platform video the default room surface.

## Product Direction

The room remains a quiet listening and chat space:

- The current right-side player stays visually close to the existing music player.
- Platform entries appear as track-like items with title, source, creator, cover, tags, and notes.
- Bilibili video playback is available through a small in-page window opened from the player.
- Current listening context is sent with chat requests so Kumiko can talk about what the user is hearing.
- The first implementation favors stable embedding and local metadata over fragile platform scraping.

The feature supports the broader product goal: KumikoRoom becomes a place to listen, collect, discuss, and later analyze music and community content.

## MVP Scope

The first version includes:

- A shared `MusicItem` data shape for local audio, Bilibili, and future NetEase entries.
- Bilibili URL parsing for common `BV` links.
- A room player state that tracks the active item and queue.
- A Bilibili embed URL builder for an in-page iframe player.
- A `VideoMiniWindow` opened from the existing room player.
- A player button that appears only when the current item has an embeddable video source.
- Current music context included in chat payloads.
- A lightweight room agent runtime that routes user intent to player, mini-window, and music-item tools.
- UI tests for the unchanged default player surface and mini-window open/close behavior.

The first version excludes:

- Bilibili login or OAuth.
- Automatic comment or danmaku ingestion.
- NetEase login.
- Full progress synchronization for cross-origin platform iframes.
- Drag-resize behavior for the mini-window.
- Platform recommendation ranking.
- Audio stream extraction or direct platform media downloads.

## Source Model

`MusicItem` represents the player-facing item:

```ts
export type MusicSourceKind = "local" | "bilibili" | "netease";

export interface MusicItem {
  id: string;
  source: MusicSourceKind;
  title: string;
  creator: string | null;
  coverUrl: string | null;
  pageUrl: string | null;
  embedUrl: string | null;
  audioUrl: string | null;
  tags: string[];
  notes: string | null;
}
```

Source behavior:

- `local`: plays through a native `<audio>` element. Progress, pause, volume, and duration are controllable.
- `bilibili`: appears in the music player by default. Playback happens in the mini-window iframe when opened.
- `netease`: uses the same shape, but the first implementation can keep it as a future provider unless a stable external player URL is supplied by the user.

## Bilibili Link Handling

The MVP parser should accept common public Bilibili URLs:

- `https://www.bilibili.com/video/BV...`
- `https://b23.tv/...` only after expansion support exists; otherwise show a clear unsupported-link message.
- Optional query parameters should not break parsing.

The parser stores:

- `pageUrl`: the original normalized Bilibili URL.
- `embedUrl`: a `player.bilibili.com/player.html` URL when enough data is available.
- `title` and `creator`: manually entered or later filled by a metadata provider.

If the app cannot infer `cid`, the first version may still save the item and open the original page in a new tab from the mini-window fallback. A later metadata step can resolve `cid` through an approved API or user-provided metadata.

## Room Player UI

The default room UI should remain close to the current player:

- Track title and creator/source.
- Progress bar or source status.
- Previous, play/open, next, volume, and loop controls.
- Queue chips or small playlist buttons.
- A compact video button for video-backed items.

For Bilibili items:

- The player shows music-like metadata, not a video rectangle.
- The video button opens the mini-window.
- The play button can open the mini-window when no native audio controller is available.
- The player should show a calm label such as `B站小窗播放` when platform playback depends on the iframe.

For local items:

- The existing player controls drive native audio playback.
- The mini-window button is hidden.

## Video Mini-Window

`VideoMiniWindow` is an in-page overlay controlled by the room player.

MVP behavior:

- Opens from the player video button.
- Defaults to a compact fixed position near the right side of the room.
- Contains a title bar with item title, source label, close button, and size toggle.
- Shows the Bilibili iframe when `embedUrl` is available.
- Shows a fallback with the original link when embedding data is incomplete.
- Keeps the chat timeline and composer usable while open.
- Closes without clearing the current music item.

MVP layout states:

- `compact`: small floating video window.
- `large`: larger centered overlay within the room stage.

Drag and free resize are left for a later slice.

## Chat Context

The room chat request should include the current listening item in a compact form:

```ts
export interface ListeningContext {
  source: MusicSourceKind;
  title: string;
  creator: string | null;
  pageUrl: string | null;
  tags: string[];
  notes: string | null;
}
```

Kumiko can use this to answer questions such as:

- "这首是什么感觉？"
- "这个视频适合当什么参考？"
- "你觉得我为什么会喜欢它？"
- "帮我记一下这首的灵感点。"

The chat context should stay small. Full comment, danmaku, and recommendation analysis belong to later feature slices.

## Room Agent Runtime

The player and mini-window should be wired through a small agent runtime inspired by Codex-style local agent design: explicit context, bounded tools, observable actions, and project-level instructions.

The MVP runtime has one coordinator, `RoomAgent`, that receives:

- The latest user message.
- Current room state.
- Current `ListeningContext`.
- Available music queue items.
- Persisted user preferences and Kumiko persona rules.

The coordinator classifies the user's intent into one of these actions:

- `chat`: answer normally with listening context.
- `play_item`: switch the active music item.
- `open_video_window`: open the mini-window for the current or referenced Bilibili item.
- `save_music_note`: attach a short note to the current item.
- `explain_item`: summarize why the current item may fit the user's taste or creative mood.
- `unsupported`: explain the missing capability without changing player state.

Tools are narrow functions with typed inputs and outputs:

```ts
export type RoomAgentToolName =
  | "parse_bilibili_url"
  | "set_active_music_item"
  | "open_video_mini_window"
  | "save_music_note"
  | "build_listening_context";
```

The first implementation can keep these tools local to the web app. Later slices may move durable operations to the API.

Agent rules:

- The agent may open the mini-window only from an explicit user request or a player button action.
- The agent may save notes only when the user clearly asks to remember or record something.
- The agent should keep platform limitations visible, especially iframe progress and unsupported links.
- Tool results should update UI state and be reflected in the next chat reply.
- Tool failures should be returned as calm chat-visible status, not thrown into the main room UI.

This gives KumikoRoom a real Agent workflow without forcing the first player slice into a large recommendation platform.

## Studio Relationship

The room player and the studio should share the same item model over time.

MVP room behavior may use a small built-in sample queue so the player can be implemented safely. The next studio slice should add:

- Save a Bilibili or NetEase link as a music item.
- Edit title, creator, tags, and notes.
- Send one saved item to the room player.
- Keep recent listening items available from the room.

This keeps the room and studio connected without forcing a large studio rebuild into the first player slice.

## Error Handling

- Invalid link: show an inline message in the add/link flow.
- Unsupported short link: save nothing and ask for the full Bilibili URL.
- Missing embed URL: keep the item playable as an external link fallback.
- Iframe load failure: show a short fallback message and keep the player state intact.
- Cross-origin control limits: do not pretend progress is synchronized for platform items.

The player should never block chat when a platform embed fails.

## Testing

Frontend tests should cover:

- Bilibili URL parsing for valid and invalid URLs.
- Building a Bilibili embed URL when required fields exist.
- Room player renders the same default music surface for local and platform items.
- Video button appears for Bilibili items and is hidden for local items.
- Mini-window opens, changes size, and closes.
- Mini-window fallback appears when no `embedUrl` exists.
- Chat payload includes the compact listening context for the active item.
- Room agent intent routing opens the video mini-window only for explicit user intent.
- Room agent note-saving writes to the active item only when requested.

If local audio playback logic is added in this slice, tests should mock media methods and assert state changes instead of depending on real playback.

## Acceptance Criteria

- `/room` still looks like the current chat room by default.
- The right-side player can represent a Bilibili music item without showing video by default.
- A video-backed item can open a Bilibili mini-window inside the room.
- Closing the mini-window keeps the current item selected.
- Local audio remains the path for full native playback control.
- Chat requests can include current listening context.
- Agent-routed player actions are typed, testable, and visible in the chat response.
- No platform media is downloaded or committed.

## Later Work

- Studio link intake and item editing.
- Bilibili metadata retrieval through a stable approved path.
- Comment and danmaku sample ingestion for content understanding.
- NetEase external player support with clear unavailable-state handling.
- Real queue persistence in local SQLite.
- Recommendation and "why this track" explanations based on listening history.
- Desktop mini-window handoff in the Electron app.

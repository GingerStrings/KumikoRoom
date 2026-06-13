# Platform Music Player Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a source-aware music player to the existing room shell, with Bilibili music-style playback as the first platform source and an optional video mini-window that leaves the default chat UI unchanged.

**Architecture:** Keep the existing `RoomShell` visual structure and move player data plus platform parsing into focused library files. Add a small room-agent runtime inspired by the local Codex source's typed tool router and registry lifecycle, with deterministic MVP routing and no LLM calls.

**Tech Stack:** Next.js app router, React, TypeScript, Vitest, Testing Library, CSS in `apps/web/app/globals.css`.

---

## Source-Derived Agent Notes

These notes come from the local zip extracted at `.runtime/codex-main/codex-main`; future workers must read these files directly before editing the agent runtime:

- `.runtime/codex-main/codex-main/codex-rs/core/src/tools/registry.rs`
  - `ToolRegistry::from_tools` maps tool names to executors and rejects duplicate tool names.
  - `dispatch_any_with_terminal_outcome` resolves a tool, returns a model-visible unsupported-tool message when missing, emits start and finish lifecycle notifications, runs pre-tool hooks, dispatches the handler, then records the final outcome.
- `.runtime/codex-main/codex-main/codex-rs/core/src/tools/router.rs`
  - `ToolRouter::build_tool_call` translates external response items into internal `ToolCall` values.
  - `dispatch_tool_call_with_code_mode_result_inner` wraps the call as a `ToolInvocation` and delegates to `ToolRegistry`.
- `.runtime/codex-main/codex-main/codex-rs/core/src/tools/lifecycle.rs`
  - `notify_tool_start` and `notify_tool_finish` keep tool lifecycle events separate from handler logic.
- `.runtime/codex-main/codex-main/codex-rs/app-server-protocol/src/protocol/v2/turn.rs`
  - `TurnPlanStep` uses explicit step text plus `Pending`, `InProgress`, and `Completed` states.

The KumikoRoom runtime should copy the architectural shape: typed action construction, typed dispatch, unsupported-action results, and observable lifecycle events. It should stay much smaller than Codex's runtime.

## Design Decisions

- Color palette: reuse current Liz Bluebird room tokens and existing `#2f7eba`, `#83b9d7`, `#d8e2dd`, and soft surface values from `globals.css`.
- Typography: keep the current room shell type sizes, with 12px metadata and 14px track titles in the compact player.
- Spacing system: preserve the existing 6px, 8px, 10px, 12px, and 14px rhythm around `.media-player`.
- Border-radius strategy: keep existing compact controls around 10px to 16px, with the video window using the existing room panel radius.
- Shadow hierarchy: reuse the current soft player shadow; add one fixed mini-window elevation that reads as a utility panel.
- Motion style: reuse existing transitions and equalizer animation, respecting `prefers-reduced-motion` for the mini-window.

## File Structure

- Create `apps/web/src/lib/musicItems.ts`
  - Owns `MusicItem`, source kinds, Bilibili URL parsing, sample queue, and `ListeningContext`.
- Create `apps/web/tests/musicItems.test.ts`
  - Covers Bilibili parsing, embed URL building, sample queue shape, and listening context output.
- Create `apps/web/src/lib/roomAgent.ts`
  - Owns Codex-inspired room-agent action routing and tool dispatch for player actions.
- Create `apps/web/tests/roomAgent.test.ts`
  - Covers route-to-action behavior, lifecycle events, unsupported tools, and note saving.
- Create `apps/web/src/components/VideoMiniWindow.tsx`
  - Owns the optional Bilibili iframe panel and size toggle.
- Create `apps/web/tests/VideoMiniWindow.test.tsx`
  - Covers default rendering, iframe attributes, size toggle, close, and source fallback.
- Modify `apps/web/src/api/types.ts`
  - Adds `ListeningContext` to `ChatRequest`.
- Modify `apps/web/src/api/client.ts`
  - Maps `listeningContext` to `listening_context` in the chat request body.
- Modify `apps/web/tests/client.test.ts`
  - Verifies chat requests include listening context only when supplied.
- Modify `apps/web/src/components/RoomShell.tsx`
  - Replaces the local `PLAYER_TRACKS` constant with imported source-aware items, adds the mini-window state, routes chat context into `postChat`, and keeps the existing default player layout.
- Modify `apps/web/tests/RoomShell.test.tsx`
  - Verifies the player stays music-first, Bilibili opens via mini-window, and chat sends listening context.
- Modify `apps/web/app/globals.css`
  - Adds minimal source badge, video utility button, and fixed mini-window styling.
- Modify `apps/web/tests/design-tokens.test.ts`
  - Locks the new selectors and checks the default player surface stays music-oriented.

---

### Task 1: Music Item Model And Bilibili Parsing

**Files:**
- Create: `apps/web/src/lib/musicItems.ts`
- Create: `apps/web/tests/musicItems.test.ts`

- [ ] **Step 1: Write the failing parser and context tests**

Create `apps/web/tests/musicItems.test.ts` with:

```typescript
import { describe, expect, it } from "vitest";
import {
  PLAYER_TRACKS,
  buildListeningContext,
  makeBilibiliMusicItem,
  parseBilibiliVideoUrl
} from "../src/lib/musicItems";

describe("music item platform helpers", () => {
  it("parses common Bilibili video links into page and embed URLs", () => {
    expect(parseBilibiliVideoUrl("https://www.bilibili.com/video/BV1xx411c7mD/?spm_id_from=333.337.search-card.all.click")).toEqual({
      bvid: "BV1xx411c7mD",
      pageUrl: "https://www.bilibili.com/video/BV1xx411c7mD",
      embedUrl: "https://player.bilibili.com/player.html?bvid=BV1xx411c7mD&page=1&high_quality=1&autoplay=0"
    });
  });

  it("parses short Bilibili links that still contain a BV id", () => {
    expect(parseBilibiliVideoUrl("b23.tv/BV1xx411c7mD")).toMatchObject({
      bvid: "BV1xx411c7mD",
      pageUrl: "https://www.bilibili.com/video/BV1xx411c7mD"
    });
  });

  it("returns null for text without a Bilibili BV id", () => {
    expect(parseBilibiliVideoUrl("https://music.163.com/song?id=123")).toBeNull();
  });

  it("creates a Bilibili music item with an embeddable video surface", () => {
    const item = makeBilibiliMusicItem({
      id: "test-bv",
      title: "Blue Bird rehearsal",
      creator: "demo up",
      url: "https://www.bilibili.com/video/BV1xx411c7mD"
    });

    expect(item).toMatchObject({
      id: "test-bv",
      source: "bilibili",
      title: "Blue Bird rehearsal",
      creator: "demo up",
      pageUrl: "https://www.bilibili.com/video/BV1xx411c7mD",
      embedUrl: "https://player.bilibili.com/player.html?bvid=BV1xx411c7mD&page=1&high_quality=1&autoplay=0",
      canOpenVideo: true
    });
  });

  it("keeps the default queue source-aware while preserving the current first track label", () => {
    expect(PLAYER_TRACKS[0]).toMatchObject({
      source: "local",
      title: "雨后的走廊",
      creator: "练习室 · 傍晚",
      canOpenVideo: false
    });
    expect(PLAYER_TRACKS.some((track) => track.source === "bilibili" && track.canOpenVideo)).toBe(true);
  });

  it("builds compact listening context for chat requests", () => {
    expect(buildListeningContext(PLAYER_TRACKS[1], true)).toEqual({
      source: PLAYER_TRACKS[1].source,
      title: PLAYER_TRACKS[1].title,
      creator: PLAYER_TRACKS[1].creator,
      isPlaying: true,
      pageUrl: PLAYER_TRACKS[1].pageUrl ?? null,
      tags: PLAYER_TRACKS[1].tags
    });
  });
});
```

- [ ] **Step 2: Run the focused test to verify RED**

Run:

```bash
npm run test --workspace apps/web -- tests/musicItems.test.ts
```

Expected: fail because `../src/lib/musicItems` does not exist.

- [ ] **Step 3: Implement music item helpers**

Create `apps/web/src/lib/musicItems.ts` with:

```typescript
export type MusicSourceKind = "local" | "bilibili" | "netease";

export interface MusicItem {
  id: string;
  source: MusicSourceKind;
  title: string;
  creator: string;
  coverUrl?: string;
  pageUrl?: string;
  embedUrl?: string;
  audioUrl?: string;
  tags: string[];
  notes?: string;
  canOpenVideo: boolean;
}

export interface ListeningContext {
  source: MusicSourceKind;
  title: string;
  creator: string;
  isPlaying: boolean;
  pageUrl: string | null;
  tags: string[];
}

export interface ParsedBilibiliVideo {
  bvid: string;
  pageUrl: string;
  embedUrl: string;
}

const BVID_PATTERN = /(BV[0-9A-Za-z]{10,})/;

export function buildBilibiliEmbedUrl(bvid: string): string {
  return `https://player.bilibili.com/player.html?bvid=${encodeURIComponent(bvid)}&page=1&high_quality=1&autoplay=0`;
}

export function parseBilibiliVideoUrl(input: string): ParsedBilibiliVideo | null {
  const trimmed = input.trim();
  if (!trimmed) return null;

  const match = trimmed.match(BVID_PATTERN);
  const bvid = match?.[1];
  if (!bvid) return null;

  return {
    bvid,
    pageUrl: `https://www.bilibili.com/video/${bvid}`,
    embedUrl: buildBilibiliEmbedUrl(bvid)
  };
}

export function makeBilibiliMusicItem(input: {
  id: string;
  title: string;
  creator: string;
  url: string;
  coverUrl?: string;
  tags?: string[];
  notes?: string;
}): MusicItem {
  const parsed = parseBilibiliVideoUrl(input.url);
  if (!parsed) {
    throw new Error(`Invalid Bilibili video URL: ${input.url}`);
  }

  return {
    id: input.id,
    source: "bilibili",
    title: input.title,
    creator: input.creator,
    coverUrl: input.coverUrl,
    pageUrl: parsed.pageUrl,
    embedUrl: parsed.embedUrl,
    tags: input.tags ?? ["bilibili"],
    notes: input.notes,
    canOpenVideo: true
  };
}

export const PLAYER_TRACKS: MusicItem[] = [
  {
    id: "local-rain-corridor",
    source: "local",
    title: "雨后的走廊",
    creator: "练习室 · 傍晚",
    tags: ["ambient", "room"],
    notes: "Default room ambience.",
    canOpenVideo: false
  },
  makeBilibiliMusicItem({
    id: "bilibili-blue-bird-rehearsal",
    title: "合奏前调音",
    creator: "B站 · 木管声部",
    url: "https://www.bilibili.com/video/BV1xx411c7mD",
    tags: ["bilibili", "rehearsal", "ensemble"],
    notes: "Bilibili source used to prove the music player can open a video mini-window on demand."
  }),
  {
    id: "local-bluebird-bridge",
    source: "local",
    title: "青鸟的间奏",
    creator: "长笛 · 双簧管",
    tags: ["ambient", "bluebird"],
    notes: "Local placeholder for future NetEase or uploaded audio.",
    canOpenVideo: false
  }
];

export function buildListeningContext(item: MusicItem, isPlaying: boolean): ListeningContext {
  return {
    source: item.source,
    title: item.title,
    creator: item.creator,
    isPlaying,
    pageUrl: item.pageUrl ?? null,
    tags: item.tags
  };
}
```

- [ ] **Step 4: Run the focused test to verify GREEN**

Run:

```bash
npm run test --workspace apps/web -- tests/musicItems.test.ts
```

Expected: 6 tests pass.

- [ ] **Step 5: Commit Task 1**

Run:

```bash
git add apps/web/src/lib/musicItems.ts apps/web/tests/musicItems.test.ts
git commit -m "feat: add platform music item model"
```

---

### Task 2: Codex-Inspired Room Agent Runtime

**Files:**
- Create: `apps/web/src/lib/roomAgent.ts`
- Create: `apps/web/tests/roomAgent.test.ts`

- [ ] **Step 1: Read the required local Codex source**

Run these commands and keep the architectural points in mind while coding:

```bash
Select-String -Path .runtime\codex-main\codex-main\codex-rs\core\src\tools\registry.rs -Pattern "pub struct ToolRegistry|from_tools|dispatch_any_with_terminal_outcome|unsupported_tool_call_message|notify_tool_start|notify_tool_finish" -Context 3,8
Select-String -Path .runtime\codex-main\codex-main\codex-rs\core\src\tools\router.rs -Pattern "pub struct ToolRouter|build_tool_call|dispatch_tool_call|ToolInvocation" -Context 3,8
Select-String -Path .runtime\codex-main\codex-main\codex-rs\core\src\tools\lifecycle.rs -Pattern "notify_tool_start|notify_tool_finish" -Context 2,8
```

Expected: output includes the registry, router, and lifecycle functions listed in the source-derived notes.

- [ ] **Step 2: Write the failing agent runtime tests**

Create `apps/web/tests/roomAgent.test.ts` with:

```typescript
import { describe, expect, it } from "vitest";
import { PLAYER_TRACKS } from "../src/lib/musicItems";
import {
  createRoomAgentRuntime,
  dispatchRoomAgentAction,
  routeRoomAgentIntent
} from "../src/lib/roomAgent";

describe("room agent runtime", () => {
  it("routes play intent to a typed player action", () => {
    expect(routeRoomAgentIntent("播放 合奏前调音", PLAYER_TRACKS)).toEqual({
      id: "agent-action-play-bilibili-blue-bird-rehearsal",
      toolName: "play_item",
      input: { itemId: "bilibili-blue-bird-rehearsal" }
    });
  });

  it("routes video intent to the Bilibili mini-window action", () => {
    expect(routeRoomAgentIntent("打开这个 B站 视频小窗", [PLAYER_TRACKS[1]])).toEqual({
      id: "agent-action-open-video-bilibili-blue-bird-rehearsal",
      toolName: "open_video_window",
      input: { itemId: "bilibili-blue-bird-rehearsal" }
    });
  });

  it("routes note intent to a note-saving action", () => {
    expect(routeRoomAgentIntent("记一下这首适合写副歌", [PLAYER_TRACKS[0]])).toEqual({
      id: "agent-action-save-note",
      toolName: "save_music_note",
      input: { note: "记一下这首适合写副歌" }
    });
  });

  it("dispatches through a registry and records lifecycle events", () => {
    const runtime = createRoomAgentRuntime({
      activeItemId: PLAYER_TRACKS[0].id,
      notes: []
    });

    const result = dispatchRoomAgentAction(
      runtime,
      { id: "manual-note", toolName: "save_music_note", input: { note: "适合写主旋律" } },
      PLAYER_TRACKS
    );

    expect(result).toEqual({
      ok: true,
      toolName: "save_music_note",
      message: "saved music note",
      state: {
        activeItemId: "local-rain-corridor",
        videoWindowOpen: false,
        notes: ["适合写主旋律"]
      }
    });
    expect(runtime.events).toEqual([
      { type: "tool_start", actionId: "manual-note", toolName: "save_music_note" },
      { type: "tool_finish", actionId: "manual-note", toolName: "save_music_note", ok: true }
    ]);
  });

  it("returns a typed unsupported-tool result", () => {
    const runtime = createRoomAgentRuntime();

    const result = dispatchRoomAgentAction(
      runtime,
      { id: "bad-action", toolName: "missing_tool", input: {} },
      PLAYER_TRACKS
    );

    expect(result).toEqual({
      ok: false,
      toolName: "missing_tool",
      message: "unsupported room agent tool: missing_tool",
      state: {
        activeItemId: null,
        videoWindowOpen: false,
        notes: []
      }
    });
    expect(runtime.events).toEqual([
      { type: "tool_start", actionId: "bad-action", toolName: "missing_tool" },
      { type: "tool_finish", actionId: "bad-action", toolName: "missing_tool", ok: false }
    ]);
  });
});
```

- [ ] **Step 3: Run the focused test to verify RED**

Run:

```bash
npm run test --workspace apps/web -- tests/roomAgent.test.ts
```

Expected: fail because `../src/lib/roomAgent` does not exist.

- [ ] **Step 4: Implement the small registry, router, and dispatcher**

Create `apps/web/src/lib/roomAgent.ts` with:

```typescript
import type { MusicItem } from "./musicItems";

export type RoomAgentToolName =
  | "play_item"
  | "open_video_window"
  | "save_music_note"
  | "recommend_next"
  | string;

export interface RoomAgentAction {
  id: string;
  toolName: RoomAgentToolName;
  input: Record<string, unknown>;
}

export interface RoomAgentState {
  activeItemId: string | null;
  videoWindowOpen: boolean;
  notes: string[];
}

export interface RoomAgentEvent {
  type: "tool_start" | "tool_finish";
  actionId: string;
  toolName: RoomAgentToolName;
  ok?: boolean;
}

export interface RoomAgentToolResult {
  ok: boolean;
  toolName: RoomAgentToolName;
  message: string;
  state: RoomAgentState;
}

type RoomAgentToolHandler = (
  state: RoomAgentState,
  action: RoomAgentAction,
  queue: MusicItem[]
) => RoomAgentToolResult;

export interface RoomAgentRuntime {
  state: RoomAgentState;
  events: RoomAgentEvent[];
  tools: Map<RoomAgentToolName, RoomAgentToolHandler>;
}

export function createRoomAgentRuntime(initialState: Partial<RoomAgentState> = {}): RoomAgentRuntime {
  const state: RoomAgentState = {
    activeItemId: initialState.activeItemId ?? null,
    videoWindowOpen: initialState.videoWindowOpen ?? false,
    notes: initialState.notes ?? []
  };

  return {
    state,
    events: [],
    tools: createRoomAgentToolRegistry([
      ["play_item", playItem],
      ["open_video_window", openVideoWindow],
      ["save_music_note", saveMusicNote],
      ["recommend_next", recommendNext]
    ])
  };
}

export function createRoomAgentToolRegistry(
  entries: Array<[RoomAgentToolName, RoomAgentToolHandler]>
): Map<RoomAgentToolName, RoomAgentToolHandler> {
  const registry = new Map<RoomAgentToolName, RoomAgentToolHandler>();
  for (const [name, handler] of entries) {
    if (registry.has(name)) {
      throw new Error(`room agent tool already registered: ${name}`);
    }
    registry.set(name, handler);
  }
  return registry;
}

export function routeRoomAgentIntent(message: string, queue: MusicItem[]): RoomAgentAction | null {
  const normalized = message.trim();
  if (!normalized) return null;

  if (/视频|小窗|b站|B站|Bilibili/i.test(normalized)) {
    const videoItem = queue.find((item) => item.canOpenVideo);
    if (videoItem) {
      return {
        id: `agent-action-open-video-${videoItem.id}`,
        toolName: "open_video_window",
        input: { itemId: videoItem.id }
      };
    }
  }

  if (/记一下|记录|note/i.test(normalized)) {
    return {
      id: "agent-action-save-note",
      toolName: "save_music_note",
      input: { note: normalized }
    };
  }

  if (/播放|听|放一下/.test(normalized)) {
    const requestedItem =
      queue.find((item) => normalized.includes(item.title)) ?? queue.find((item) => item.title.length > 0);
    if (requestedItem) {
      return {
        id: `agent-action-play-${requestedItem.id}`,
        toolName: "play_item",
        input: { itemId: requestedItem.id }
      };
    }
  }

  if (/推荐|下一首/.test(normalized)) {
    return {
      id: "agent-action-recommend-next",
      toolName: "recommend_next",
      input: {}
    };
  }

  return null;
}

export function dispatchRoomAgentAction(
  runtime: RoomAgentRuntime,
  action: RoomAgentAction,
  queue: MusicItem[]
): RoomAgentToolResult {
  notifyToolStart(runtime, action);
  const handler = runtime.tools.get(action.toolName);
  const result = handler
    ? handler(runtime.state, action, queue)
    : {
        ok: false,
        toolName: action.toolName,
        message: `unsupported room agent tool: ${action.toolName}`,
        state: runtime.state
      };
  runtime.state = result.state;
  notifyToolFinish(runtime, action, result.ok);
  return result;
}

function notifyToolStart(runtime: RoomAgentRuntime, action: RoomAgentAction) {
  runtime.events.push({ type: "tool_start", actionId: action.id, toolName: action.toolName });
}

function notifyToolFinish(runtime: RoomAgentRuntime, action: RoomAgentAction, ok: boolean) {
  runtime.events.push({ type: "tool_finish", actionId: action.id, toolName: action.toolName, ok });
}

function playItem(state: RoomAgentState, action: RoomAgentAction, queue: MusicItem[]): RoomAgentToolResult {
  const item = queue.find((candidate) => candidate.id === action.input.itemId);
  if (!item) {
    return { ok: false, toolName: action.toolName, message: "music item not found", state };
  }

  return {
    ok: true,
    toolName: action.toolName,
    message: "playing music item",
    state: { ...state, activeItemId: item.id }
  };
}

function openVideoWindow(state: RoomAgentState, action: RoomAgentAction, queue: MusicItem[]): RoomAgentToolResult {
  const item = queue.find((candidate) => candidate.id === action.input.itemId);
  if (!item?.canOpenVideo) {
    return { ok: false, toolName: action.toolName, message: "music item has no video window", state };
  }

  return {
    ok: true,
    toolName: action.toolName,
    message: "opened video mini-window",
    state: { ...state, activeItemId: item.id, videoWindowOpen: true }
  };
}

function saveMusicNote(state: RoomAgentState, action: RoomAgentAction): RoomAgentToolResult {
  const note = typeof action.input.note === "string" ? action.input.note.trim() : "";
  if (!note) {
    return { ok: false, toolName: action.toolName, message: "empty music note", state };
  }

  return {
    ok: true,
    toolName: action.toolName,
    message: "saved music note",
    state: { ...state, notes: [...state.notes, note] }
  };
}

function recommendNext(state: RoomAgentState, action: RoomAgentAction, queue: MusicItem[]): RoomAgentToolResult {
  if (queue.length === 0) {
    return { ok: false, toolName: action.toolName, message: "music queue is empty", state };
  }

  const currentIndex = queue.findIndex((item) => item.id === state.activeItemId);
  const nextItem = queue[(currentIndex + 1 + queue.length) % queue.length];

  return {
    ok: true,
    toolName: action.toolName,
    message: "recommended next music item",
    state: { ...state, activeItemId: nextItem.id }
  };
}
```

- [ ] **Step 5: Run the focused test to verify GREEN**

Run:

```bash
npm run test --workspace apps/web -- tests/roomAgent.test.ts
```

Expected: 5 tests pass.

- [ ] **Step 6: Commit Task 2**

Run:

```bash
git add apps/web/src/lib/roomAgent.ts apps/web/tests/roomAgent.test.ts
git commit -m "feat: add room agent player runtime"
```

---

### Task 3: Video Mini-Window Component

**Files:**
- Create: `apps/web/src/components/VideoMiniWindow.tsx`
- Create: `apps/web/tests/VideoMiniWindow.test.tsx`

- [ ] **Step 1: Write the failing component tests**

Create `apps/web/tests/VideoMiniWindow.test.tsx` with:

```typescript
import { fireEvent, render, screen } from "@testing-library/react";
import React from "react";
import { describe, expect, it, vi } from "vitest";
import { PLAYER_TRACKS } from "../src/lib/musicItems";
import { VideoMiniWindow } from "../src/components/VideoMiniWindow";

const bilibiliItem = PLAYER_TRACKS.find((item) => item.source === "bilibili")!;

describe("VideoMiniWindow", () => {
  it("renders a Bilibili item as an optional mini player surface", () => {
    render(
      <VideoMiniWindow
        item={bilibiliItem}
        size="compact"
        onClose={vi.fn()}
        onToggleSize={vi.fn()}
      />
    );

    expect(screen.getByRole("dialog", { name: "B站视频小窗" })).toBeTruthy();
    expect(screen.getByText(bilibiliItem.title)).toBeTruthy();
    const frame = screen.getByTitle(`${bilibiliItem.title} 视频播放`);
    expect(frame.getAttribute("src")).toBe(bilibiliItem.embedUrl);
    expect(frame.getAttribute("allow")).toContain("autoplay");
    expect(screen.getByRole("link", { name: "在 B站 打开" }).getAttribute("href")).toBe(bilibiliItem.pageUrl);
  });

  it("exposes close and size controls", () => {
    const onClose = vi.fn();
    const onToggleSize = vi.fn();

    render(
      <VideoMiniWindow
        item={bilibiliItem}
        size="large"
        onClose={onClose}
        onToggleSize={onToggleSize}
      />
    );

    fireEvent.click(screen.getByRole("button", { name: "缩小视频小窗" }));
    fireEvent.click(screen.getByRole("button", { name: "关闭视频小窗" }));

    expect(onToggleSize).toHaveBeenCalledTimes(1);
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("renders nothing when the item has no embed URL", () => {
    const { container } = render(
      <VideoMiniWindow
        item={{ ...PLAYER_TRACKS[0], embedUrl: undefined }}
        size="compact"
        onClose={vi.fn()}
        onToggleSize={vi.fn()}
      />
    );

    expect(container.firstChild).toBeNull();
  });
});
```

- [ ] **Step 2: Run the focused test to verify RED**

Run:

```bash
npm run test --workspace apps/web -- tests/VideoMiniWindow.test.tsx
```

Expected: fail because `VideoMiniWindow` does not exist.

- [ ] **Step 3: Implement the component**

Create `apps/web/src/components/VideoMiniWindow.tsx` with:

```typescript
import type { MusicItem } from "../lib/musicItems";

interface VideoMiniWindowProps {
  item: MusicItem;
  size: "compact" | "large";
  onClose: () => void;
  onToggleSize: () => void;
}

export function VideoMiniWindow({ item, size, onClose, onToggleSize }: VideoMiniWindowProps) {
  if (!item.embedUrl) return null;

  const isLarge = size === "large";

  return (
    <aside className={`video-mini-window video-mini-window--${size}`} role="dialog" aria-label="B站视频小窗">
      <header className="video-mini-window__header">
        <div className="video-mini-window__title">
          <span>Bilibili</span>
          <strong>{item.title}</strong>
        </div>
        <div className="video-mini-window__actions">
          <button type="button" className="video-mini-window__button" onClick={onToggleSize} aria-label={isLarge ? "缩小视频小窗" : "放大视频小窗"}>
            {isLarge ? "↙" : "↗"}
          </button>
          <button type="button" className="video-mini-window__button" onClick={onClose} aria-label="关闭视频小窗">
            ×
          </button>
        </div>
      </header>
      <iframe
        className="video-mini-window__frame"
        title={`${item.title} 视频播放`}
        src={item.embedUrl}
        allow="autoplay; fullscreen; picture-in-picture"
        allowFullScreen
      />
      {item.pageUrl ? (
        <a className="video-mini-window__link" href={item.pageUrl} target="_blank" rel="noreferrer">
          在 B站 打开
        </a>
      ) : null}
    </aside>
  );
}
```

- [ ] **Step 4: Run the focused test to verify GREEN**

Run:

```bash
npm run test --workspace apps/web -- tests/VideoMiniWindow.test.tsx
```

Expected: 3 tests pass.

- [ ] **Step 5: Commit Task 3**

Run:

```bash
git add apps/web/src/components/VideoMiniWindow.tsx apps/web/tests/VideoMiniWindow.test.tsx
git commit -m "feat: add bilibili video mini window"
```

---

### Task 4: Listening Context In Chat API Requests

**Files:**
- Modify: `apps/web/src/api/types.ts`
- Modify: `apps/web/src/api/client.ts`
- Modify: `apps/web/tests/client.test.ts`

- [ ] **Step 1: Write the failing client test**

Add this test case inside `describe("room API client", () => { ... })` in `apps/web/tests/client.test.ts` after the existing explicit chat request test:

```typescript
  it("posts chat messages with optional listening context", async () => {
    const fetchMock = vi.fn(async () => ({
      ok: true,
      status: 200,
      statusText: "OK",
      text: async () =>
        JSON.stringify({
          reply: { id: "3", role: "kumiko", content: "This track feels focused." },
          expression: "listening",
          suggested_actions: [],
          provider_status: {
            provider: "mock",
            model: null,
            configured: true,
            label: "Local Mock API"
          },
          memory_events: [],
          session: null
        })
    }));
    vi.stubGlobal("fetch", fetchMock);

    await roomApi.postChat({
      message: "这首适合写什么？",
      roomState: DEFAULT_ROOM_STATE,
      listeningContext: {
        source: "bilibili",
        title: "合奏前调音",
        creator: "B站 · 木管声部",
        isPlaying: true,
        pageUrl: "https://www.bilibili.com/video/BV1xx411c7mD",
        tags: ["bilibili", "rehearsal"]
      }
    });

    expect(requestBody(fetchMock)).toMatchObject({
      listening_context: {
        source: "bilibili",
        title: "合奏前调音",
        creator: "B站 · 木管声部",
        is_playing: true,
        page_url: "https://www.bilibili.com/video/BV1xx411c7mD",
        tags: ["bilibili", "rehearsal"]
      }
    });
  });
```

- [ ] **Step 2: Run the focused test to verify RED**

Run:

```bash
npm run test --workspace apps/web -- tests/client.test.ts
```

Expected: fail because `ChatRequest` lacks `listeningContext` and the body lacks `listening_context`.

- [ ] **Step 3: Add request types and mapping**

In `apps/web/src/api/types.ts`, import or duplicate the web-facing `ListeningContext` shape from `musicItems.ts`. Use an `import type` to keep one source of truth:

```typescript
import type { ListeningContext } from "../lib/musicItems";
```

Then add this field to `ChatRequest`:

```typescript
  listeningContext?: ListeningContext;
```

In `apps/web/src/api/client.ts`, add this helper near `mapRoomStateRequest`:

```typescript
function mapListeningContextRequest(value: ChatRequest["listeningContext"]) {
  if (!value) return null;

  return {
    source: value.source,
    title: value.title,
    creator: value.creator,
    is_playing: value.isPlaying,
    page_url: value.pageUrl,
    tags: value.tags
  };
}
```

Update `postChat` request body:

```typescript
      listening_context: mapListeningContextRequest(payload.listeningContext),
```

- [ ] **Step 4: Run the focused test to verify GREEN**

Run:

```bash
npm run test --workspace apps/web -- tests/client.test.ts
```

Expected: all client tests pass.

- [ ] **Step 5: Commit Task 4**

Run:

```bash
git add apps/web/src/api/types.ts apps/web/src/api/client.ts apps/web/tests/client.test.ts
git commit -m "feat: send listening context with chat"
```

---

### Task 5: RoomShell Player Integration

**Files:**
- Modify: `apps/web/src/components/RoomShell.tsx`
- Modify: `apps/web/tests/RoomShell.test.tsx`

- [ ] **Step 1: Write the failing RoomShell tests**

Add these tests inside `describe("RoomShell", () => { ... })` in `apps/web/tests/RoomShell.test.tsx` near the current player-related shell tests:

```typescript
  it("keeps the default player music-first with no video surface open", async () => {
    render(<RoomShell initialState={DEFAULT_ROOM_STATE} connectionStatus={connectionStatus} />);

    expect(await screen.findByRole("button", { name: "默认会话" })).toBeTruthy();
    expect(screen.getByLabelText("氛围播放器")).toBeTruthy();
    expect(screen.queryByRole("dialog", { name: "B站视频小窗" })).toBeNull();
    expect(screen.queryByTitle(/视频播放/)).toBeNull();
  });

  it("opens and closes the Bilibili mini-window from the music player", async () => {
    render(<RoomShell initialState={DEFAULT_ROOM_STATE} connectionStatus={connectionStatus} />);

    expect(await screen.findByRole("button", { name: "默认会话" })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "合奏前调音" }));
    fireEvent.click(screen.getByRole("button", { name: "打开视频小窗" }));

    expect(screen.getByRole("dialog", { name: "B站视频小窗" })).toBeTruthy();
    expect(screen.getByTitle("合奏前调音 视频播放")).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "关闭视频小窗" }));
    expect(screen.queryByRole("dialog", { name: "B站视频小窗" })).toBeNull();
  });

  it("sends the active listening context with chat messages", async () => {
    apiMocks.postChat.mockResolvedValueOnce(makeChatResponse({ session: null }));

    render(<RoomShell initialState={DEFAULT_ROOM_STATE} connectionStatus={connectionStatus} />);

    expect(await screen.findByRole("button", { name: "默认会话" })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "合奏前调音" }));
    fireEvent.change(screen.getByRole("textbox", { name: "写一条消息" }), {
      target: { value: "这首适合写什么？" }
    });
    fireEvent.click(screen.getByRole("button", { name: "发送" }));

    await waitFor(() =>
      expect(apiMocks.postChat).toHaveBeenCalledWith(
        expect.objectContaining({
          listeningContext: expect.objectContaining({
            source: "bilibili",
            title: "合奏前调音",
            isPlaying: true
          })
        })
      )
    );
  });
```

If the existing test file displays Chinese text correctly in the editor, use the same visible labels. If the file stores mojibake literals, copy the nearby existing role labels from the file so tests match the current DOM.

- [ ] **Step 2: Run the focused tests to verify RED**

Run:

```bash
npm run test --workspace apps/web -- tests/RoomShell.test.tsx
```

Expected: fail because the imported player model, mini-window, and chat context integration are missing.

- [ ] **Step 3: Integrate source-aware music items**

In `apps/web/src/components/RoomShell.tsx`, add imports:

```typescript
import { PLAYER_TRACKS, buildListeningContext } from "../lib/musicItems";
import { VideoMiniWindow } from "./VideoMiniWindow";
```

Remove the local `PLAYER_TRACKS` constant near the top of the file.

Change the player state near the existing player state:

```typescript
  const [playerTrackIndex, setPlayerTrackIndex] = useState(0);
  const [isPlayerPlaying, setIsPlayerPlaying] = useState(true);
  const [videoWindowOpen, setVideoWindowOpen] = useState(false);
  const [videoWindowSize, setVideoWindowSize] = useState<"compact" | "large">("compact");
```

Change `activeTrack` and create context:

```typescript
  const activeTrack = PLAYER_TRACKS[playerTrackIndex] ?? PLAYER_TRACKS[0];
  const activeListeningContext = buildListeningContext(activeTrack, isPlayerPlaying);
```

Update the `postChat` payload:

```typescript
        memoryEnabled,
        listeningContext: activeListeningContext
```

- [ ] **Step 4: Keep player UI music-first and add the video action**

In the `.track-title` block, keep the existing title and subtitle layout while changing `subtitle` to `creator`:

```tsx
              <div className="track-title">
                <strong>{activeTrack.title}</strong>
                <span>{activeTrack.creator}</span>
              </div>
```

Near the equalizer in `.track-head`, add a compact source badge:

```tsx
              <div className="track-actions">
                <span className="source-badge" data-source={activeTrack.source}>
                  {activeTrack.source === "bilibili" ? "B站" : activeTrack.source === "netease" ? "网易云" : "本地"}
                </span>
                <div className="equalizer" aria-hidden="true">
                  <i />
                  <i />
                  <i />
                </div>
              </div>
```

Inside `.player-controls`, add a video button after the play button:

```tsx
              {activeTrack.canOpenVideo ? (
                <button
                  className="control video"
                  type="button"
                  aria-label="打开视频小窗"
                  onClick={() => setVideoWindowOpen(true)}
                >
                  ▣
                </button>
              ) : null}
```

When rendering playlist buttons, use the full title for stable accessible names:

```tsx
                  {track.title}
```

Add the mini-window just before `</main>` or as the last child in `<main className="room-stage">`:

```tsx
      {videoWindowOpen && activeTrack.canOpenVideo ? (
        <VideoMiniWindow
          item={activeTrack}
          size={videoWindowSize}
          onClose={() => setVideoWindowOpen(false)}
          onToggleSize={() => setVideoWindowSize((current) => (current === "compact" ? "large" : "compact"))}
        />
      ) : null}
```

- [ ] **Step 5: Run the focused tests to verify GREEN**

Run:

```bash
npm run test --workspace apps/web -- tests/RoomShell.test.tsx
```

Expected: all RoomShell tests pass.

- [ ] **Step 6: Commit Task 5**

Run:

```bash
git add apps/web/src/components/RoomShell.tsx apps/web/tests/RoomShell.test.tsx
git commit -m "feat: integrate platform player in room shell"
```

---

### Task 6: Player And Mini-Window Styling

**Files:**
- Modify: `apps/web/app/globals.css`
- Modify: `apps/web/tests/design-tokens.test.ts`

- [ ] **Step 1: Write the failing design token tests**

Add this test inside `describe("Liz Bluebird room visual tokens", () => { ... })` in `apps/web/tests/design-tokens.test.ts`:

```typescript
  it("defines platform player and optional video mini-window selectors", () => {
    const css = fs.readFileSync(cssPath, "utf8");

    [
      ".track-actions",
      ".source-badge",
      ".source-badge[data-source=\"bilibili\"]",
      ".control.video",
      ".video-mini-window",
      ".video-mini-window--compact",
      ".video-mini-window--large",
      ".video-mini-window__frame",
      ".video-mini-window__button",
      ".video-mini-window__link",
    ].forEach((selector) => {
      expect(css).toContain(selector);
    });
  });
```

Add this assertion to the existing test named `defines the v6 room shell and settings popover selectors`:

```typescript
      ".media-player",
      ".track-actions",
      ".source-badge",
```

- [ ] **Step 2: Run the focused test to verify RED**

Run:

```bash
npm run test --workspace apps/web -- tests/design-tokens.test.ts
```

Expected: fail because the new CSS selectors do not exist.

- [ ] **Step 3: Add compact player source and mini-window styles**

Append these styles near the current `.media-player`, `.track-head`, `.control`, and `.playlist` styles in `apps/web/app/globals.css`:

```css
.track-actions {
  display: flex;
  align-items: center;
  gap: 8px;
}

.source-badge {
  display: inline-flex;
  align-items: center;
  min-height: 22px;
  padding: 0 8px;
  border: 1px solid rgba(195, 213, 211, 0.72);
  border-radius: 999px;
  background: rgba(247, 251, 247, 0.72);
  color: #687a7b;
  font-size: 11px;
  font-weight: 800;
  white-space: nowrap;
}

.source-badge[data-source="bilibili"] {
  border-color: rgba(47, 126, 186, 0.26);
  background: rgba(219, 239, 248, 0.82);
  color: #2f7eba;
}

.source-badge[data-source="netease"] {
  border-color: rgba(184, 123, 104, 0.28);
  background: rgba(255, 235, 249, 0.58);
  color: #b87b68;
}

.control.video {
  border-color: rgba(47, 126, 186, 0.28);
  color: #2f7eba;
}

.video-mini-window {
  position: fixed;
  right: 28px;
  bottom: 28px;
  z-index: 40;
  display: grid;
  grid-template-rows: auto minmax(0, 1fr) auto;
  overflow: hidden;
  border: 1px solid rgba(195, 213, 211, 0.92);
  border-radius: 16px;
  background: rgba(255, 253, 247, 0.97);
  box-shadow: 0 24px 54px rgba(61, 82, 83, 0.22);
  backdrop-filter: blur(18px);
}

.video-mini-window--compact {
  width: min(360px, calc(100vw - 32px));
  aspect-ratio: 16 / 11;
}

.video-mini-window--large {
  width: min(680px, calc(100vw - 32px));
  aspect-ratio: 16 / 10;
}

.video-mini-window__header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  padding: 10px 12px;
  border-bottom: 1px solid rgba(216, 226, 221, 0.9);
}

.video-mini-window__title {
  min-width: 0;
  display: grid;
  gap: 2px;
}

.video-mini-window__title span {
  color: #2f7eba;
  font-size: 11px;
  font-weight: 800;
  text-transform: uppercase;
}

.video-mini-window__title strong {
  overflow: hidden;
  color: #27383a;
  font-size: 13px;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.video-mini-window__actions {
  display: flex;
  gap: 6px;
}

.video-mini-window__button {
  width: 30px;
  height: 30px;
  border: 1px solid rgba(195, 213, 211, 0.86);
  border-radius: 10px;
  background: rgba(247, 251, 247, 0.84);
  color: #27383a;
  font-weight: 900;
}

.video-mini-window__button:hover {
  border-color: rgba(47, 126, 186, 0.32);
  color: #2f7eba;
}

.video-mini-window__frame {
  width: 100%;
  height: 100%;
  border: 0;
  background: #101719;
}

.video-mini-window__link {
  padding: 8px 12px 10px;
  color: #2f7eba;
  font-size: 12px;
  font-weight: 800;
  text-decoration: none;
}

@media (max-width: 760px) {
  .video-mini-window {
    right: 12px;
    bottom: 12px;
  }

  .video-mini-window--large {
    width: calc(100vw - 24px);
  }
}
```

Adjust `.player-controls` grid so the optional video button fits without shifting controls badly:

```css
.player-controls {
  display: grid;
  grid-template-columns: 34px 42px 34px minmax(0, 1fr) 34px;
  align-items: center;
  gap: 8px;
  margin-top: 13px;
}
```

If the new video button makes six children, change the template to:

```css
  grid-template-columns: 34px 42px 34px 34px minmax(0, 1fr) 34px;
```

- [ ] **Step 4: Run the focused test to verify GREEN**

Run:

```bash
npm run test --workspace apps/web -- tests/design-tokens.test.ts
```

Expected: all design token tests pass.

- [ ] **Step 5: Commit Task 6**

Run:

```bash
git add apps/web/app/globals.css apps/web/tests/design-tokens.test.ts
git commit -m "style: add platform player mini window chrome"
```

---

### Task 7: Full Web Verification

**Files:**
- No production files.

- [ ] **Step 1: Run all web tests**

Run:

```bash
npm run test --workspace apps/web
```

Expected: all web test files pass.

- [ ] **Step 2: Inspect final diff**

Run:

```bash
git status --short
git log --oneline -8
git diff --stat HEAD~6..HEAD
```

Expected: the branch contains the plan commit plus focused commits for Tasks 1 through 6. If Task 7 finds a fix is needed, make the smallest change with a failing test first, rerun the targeted test, rerun all web tests, and commit the fix with a focused message.

- [ ] **Step 3: Final review**

Dispatch a final reviewer with:

```text
Review the branch from the parent of the plan commit through HEAD. Check that:
1. The default room chat UI stays music-first and has no video iframe until requested.
2. Bilibili items can open an iframe mini-window from the player.
3. Chat requests carry listeningContext.
4. The room-agent runtime is traceable to the local Codex source files named in the plan and uses typed routing plus typed dispatch.
5. No unrelated UI or API behavior changed.
```

Expected: no Critical or Important findings remain.

---

## Spec Coverage Checklist

- The player remains a music player by default: Task 5 and Task 6.
- Bilibili playback can happen inside the page through a mini-window: Task 3, Task 5, and Task 6.
- The mini-window is optional and closed by default: Task 3 and Task 5.
- Other platforms have a typed path through `MusicSourceKind`: Task 1.
- Chat can receive listening context: Task 4 and Task 5.
- Agent logic references local Codex source directly: Source-Derived Agent Notes and Task 2.
- The first MVP avoids login, OAuth, danmaku, comments, ranking, and audio extraction: no task adds these features.

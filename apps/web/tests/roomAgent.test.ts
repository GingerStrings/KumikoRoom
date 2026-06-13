import { describe, expect, it } from "vitest";
import { PLAYER_TRACKS } from "../src/lib/musicItems";
import {
  createRoomAgentRuntime,
  createRoomAgentToolRegistry,
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

  it("rejects duplicate tool registrations like the Codex tool registry", () => {
    const handler = () => ({
      ok: true,
      toolName: "play_item" as const,
      message: "ok",
      state: { activeItemId: null, videoWindowOpen: false, notes: [] }
    });

    expect(() =>
      createRoomAgentToolRegistry([
        ["play_item", handler],
        ["play_item", handler]
      ])
    ).toThrow("room agent tool already registered: play_item");
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

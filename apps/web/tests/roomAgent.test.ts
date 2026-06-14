import { describe, expect, it } from "vitest";
import { PLAYER_TRACKS } from "../src/lib/musicItems";
import {
  createRoomAgentRuntime,
  createRoomAgentToolRegistry,
  dispatchRoomAgentAction
} from "../src/lib/roomAgent";

describe("room agent runtime", () => {
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
        activeItemId: "netease-red-horse-instrumental",
        videoWindowOpen: false,
        notes: ["适合写主旋律"]
      }
    });
    expect(runtime.events).toEqual([
      { type: "tool_start", actionId: "manual-note", toolName: "save_music_note" },
      { type: "tool_finish", actionId: "manual-note", toolName: "save_music_note", ok: true }
    ]);
  });

  it("dispatches play_item state transitions", () => {
    const runtime = createRoomAgentRuntime({
      activeItemId: PLAYER_TRACKS[0].id,
      videoWindowOpen: true
    });

    const result = dispatchRoomAgentAction(
      runtime,
      { id: "manual-play", toolName: "play_item", input: { itemId: PLAYER_TRACKS[1].id } },
      PLAYER_TRACKS
    );

    expect(result).toMatchObject({
      ok: true,
      toolName: "play_item",
      message: "playing music item",
      state: {
        activeItemId: "bilibili-blue-bird-rehearsal",
        videoWindowOpen: false,
        notes: []
      }
    });
    expect(runtime.state).toEqual(result.state);
  });

  it("dispatches open_video_window state transitions", () => {
    const runtime = createRoomAgentRuntime();
    const action = { id: "manual-video", toolName: "open_video_window" as const, input: { itemId: PLAYER_TRACKS[1].id } };

    const result = dispatchRoomAgentAction(runtime, action, PLAYER_TRACKS);

    expect(result).toMatchObject({
      ok: true,
      toolName: "open_video_window",
      message: "opened video window",
      state: {
        activeItemId: "bilibili-blue-bird-rehearsal",
        videoWindowOpen: true,
        notes: []
      }
    });
    expect(runtime.state).toEqual(result.state);
  });

  it("dispatches recommend_next state transitions", () => {
    const runtime = createRoomAgentRuntime({
      activeItemId: PLAYER_TRACKS[0].id,
      videoWindowOpen: true
    });

    const result = dispatchRoomAgentAction(
      runtime,
      { id: "manual-recommend", toolName: "recommend_next", input: {} },
      PLAYER_TRACKS
    );

    expect(result).toMatchObject({
      ok: true,
      toolName: "recommend_next",
      message: "recommended next music item",
      state: {
        activeItemId: "bilibili-blue-bird-rehearsal",
        videoWindowOpen: false,
        notes: []
      }
    });
    expect(runtime.state).toEqual(result.state);
  });

  it("records tool_finish and returns failure when a handler throws", () => {
    const runtime = createRoomAgentRuntime({
      activeItemId: PLAYER_TRACKS[0].id,
      videoWindowOpen: true,
      notes: ["before"]
    });
    runtime.registry.set("explode", () => {
      throw new Error("boom");
    });

    const result = dispatchRoomAgentAction(
      runtime,
      { id: "throw-action", toolName: "explode", input: {} },
      PLAYER_TRACKS
    );

    expect(result).toEqual({
      ok: false,
      toolName: "explode",
      message: "room agent tool failed: boom",
      state: {
        activeItemId: "netease-red-horse-instrumental",
        videoWindowOpen: true,
        notes: ["before"]
      }
    });
    expect(runtime.events).toEqual([
      { type: "tool_start", actionId: "throw-action", toolName: "explode" },
      { type: "tool_finish", actionId: "throw-action", toolName: "explode", ok: false }
    ]);
  });

  it("keeps returned result state snapshots isolated from runtime state", () => {
    const runtime = createRoomAgentRuntime({ notes: [] });

    const result = dispatchRoomAgentAction(
      runtime,
      { id: "snapshot-note", toolName: "save_music_note", input: { note: "keep this" } },
      PLAYER_TRACKS
    );

    result.state.notes.push("changed");

    expect(runtime.state.notes).toEqual(["keep this"]);
    expect(result.state.notes).toEqual(["keep this", "changed"]);
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

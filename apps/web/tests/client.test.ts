import { afterEach, describe, expect, it, vi } from "vitest";
import { getRoomState, postChat } from "../src/api/client";
import { DEFAULT_ROOM_STATE } from "../src/lib/roomState";

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("room API client", () => {
  it("loads room state", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({
        ok: true,
        status: 200,
        statusText: "OK",
        text: async () =>
          JSON.stringify({
            app_name: "KumikoRoom",
            room_name: "陪伴房间",
            character: {
              display_name: "黄前久美子",
              romanized_name: "Oumae Kumiko",
              expression: "listening",
              status_text: "正在听你今天想说的音乐"
            },
            music: {
              current_track_title: null,
              current_artist: null,
              listening_mood: "还没记录"
            },
            diary_summary: "今天还没有写听歌日记。",
            inspiration_count: 0,
            studio: {
              label: "创作资料室",
              route: "/studio",
              unfinished_count: 0
            }
          })
      }))
    );

    await expect(getRoomState()).resolves.toEqual(DEFAULT_ROOM_STATE);
  });

  it("posts chat messages", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({
        ok: true,
        status: 200,
        statusText: "OK",
        text: async () =>
          JSON.stringify({
            reply: { id: "1", role: "kumiko", content: "嗯，我在听。" },
            expression: "listening",
            suggested_actions: ["save_diary"]
          })
      }))
    );

    await expect(postChat({ message: "晚上好", roomState: DEFAULT_ROOM_STATE })).resolves.toMatchObject({
      reply: { role: "kumiko" },
      expression: "listening",
      suggestedActions: ["save_diary"]
    });
  });
});

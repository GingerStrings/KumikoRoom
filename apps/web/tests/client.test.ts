import { afterEach, describe, expect, it, vi } from "vitest";
import * as roomApi from "../src/api/client";
import { DEFAULT_ROOM_STATE } from "../src/lib/roomState";

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

function roomStateApi() {
  return {
    app_name: DEFAULT_ROOM_STATE.appName,
    room_name: DEFAULT_ROOM_STATE.roomName,
    character: {
      display_name: DEFAULT_ROOM_STATE.character.displayName,
      romanized_name: DEFAULT_ROOM_STATE.character.romanizedName,
      expression: DEFAULT_ROOM_STATE.character.expression,
      status_text: DEFAULT_ROOM_STATE.character.statusText
    },
    music: {
      current_track_title: DEFAULT_ROOM_STATE.music.currentTrackTitle,
      current_artist: DEFAULT_ROOM_STATE.music.currentArtist,
      listening_mood: DEFAULT_ROOM_STATE.music.listeningMood
    },
    diary_summary: DEFAULT_ROOM_STATE.diarySummary,
    inspiration_count: DEFAULT_ROOM_STATE.inspirationCount,
    studio: {
      label: DEFAULT_ROOM_STATE.studio.label,
      route: DEFAULT_ROOM_STATE.studio.route,
      unfinished_count: DEFAULT_ROOM_STATE.studio.unfinishedCount
    }
  };
}

function requestBody(fetchMock: ReturnType<typeof vi.fn>) {
  const init = fetchMock.mock.calls[0][1] as RequestInit;
  return JSON.parse(String(init.body));
}

describe("room API client", () => {
  it("loads room state", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({
        ok: true,
        status: 200,
        statusText: "OK",
        text: async () => JSON.stringify(roomStateApi())
      }))
    );

    await expect(roomApi.getRoomState()).resolves.toEqual(DEFAULT_ROOM_STATE);
  });

  it("loads sessions and messages", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        statusText: "OK",
        text: async () =>
          JSON.stringify([
            {
              id: "session-1",
              title: "Quiet evening",
              latest_message_preview: "Something quiet.",
              created_at: "2026-06-10T10:00:00Z",
              updated_at: "2026-06-10T10:05:00Z"
            }
          ])
      })
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        statusText: "OK",
        text: async () =>
          JSON.stringify([
            {
              id: "message-1",
              session_id: "session-1",
              role: "user",
              content: "Something quiet.",
              created_at: "2026-06-10T10:04:00Z",
              provider: null,
              provider_model: null,
              provider_configured: null,
              provider_label: null
            },
            {
              id: "message-2",
              session_id: "session-1",
              role: "kumiko",
              content: "Let's listen.",
              created_at: "2026-06-10T10:05:00Z",
              provider: "deepseek",
              provider_model: "deepseek-chat",
              provider_configured: true,
              provider_label: "DeepSeek"
            }
          ])
      });
    vi.stubGlobal("fetch", fetchMock);

    await expect(roomApi.getSessions()).resolves.toEqual([
      {
        id: "session-1",
        title: "Quiet evening",
        latestMessagePreview: "Something quiet.",
        createdAt: "2026-06-10T10:00:00Z",
        updatedAt: "2026-06-10T10:05:00Z"
      }
    ]);
    await expect(roomApi.getSessionMessages("session-1")).resolves.toEqual([
      {
        id: "message-1",
        sessionId: "session-1",
        role: "user",
        content: "Something quiet.",
        createdAt: "2026-06-10T10:04:00Z",
        provider: null,
        providerModel: null,
        providerConfigured: null,
        providerLabel: null
      },
      {
        id: "message-2",
        sessionId: "session-1",
        role: "kumiko",
        content: "Let's listen.",
        createdAt: "2026-06-10T10:05:00Z",
        provider: "deepseek",
        providerModel: "deepseek-chat",
        providerConfigured: true,
        providerLabel: "DeepSeek"
      }
    ]);
    expect(fetchMock).toHaveBeenNthCalledWith(1, "/api/room/sessions", expect.any(Object));
    expect(fetchMock).toHaveBeenNthCalledWith(
      2,
      "/api/room/sessions/session-1/messages",
      expect.any(Object)
    );
  });

  it("creates renames and deletes sessions", async () => {
    const sessionApi = {
      id: "session/1",
      title: "Renamed",
      latest_message_preview: null,
      created_at: "2026-06-10T10:00:00Z",
      updated_at: "2026-06-10T10:05:00Z"
    };
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        statusText: "OK",
        text: async () => JSON.stringify(sessionApi)
      })
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        statusText: "OK",
        text: async () => JSON.stringify(sessionApi)
      })
      .mockResolvedValueOnce({
        ok: true,
        status: 204,
        statusText: "No Content",
        text: async () => ""
      });
    vi.stubGlobal("fetch", fetchMock);

    await roomApi.createSession();
    await roomApi.renameSession("session/1", "Renamed");
    await expect(roomApi.deleteSession("session/1")).resolves.toBeUndefined();

    expect(fetchMock).toHaveBeenNthCalledWith(
      1,
      "/api/room/sessions",
      expect.objectContaining({ method: "POST" })
    );
    expect(fetchMock).toHaveBeenNthCalledWith(
      2,
      "/api/room/sessions/session%2F1",
      expect.objectContaining({ method: "PATCH" })
    );
    expect(JSON.parse(String((fetchMock.mock.calls[1][1] as RequestInit).body))).toEqual({
      title: "Renamed"
    });
    expect(fetchMock).toHaveBeenNthCalledWith(
      3,
      "/api/room/sessions/session%2F1",
      expect.objectContaining({ method: "DELETE" })
    );
  });

  it("posts chat messages with default room context and maps provider memory response fields", async () => {
    const fetchMock = vi.fn(async () => ({
      ok: true,
      status: 200,
      statusText: "OK",
      text: async () =>
        JSON.stringify({
          reply: { id: "1", role: "kumiko", content: "I'm listening." },
          expression: "listening",
          suggested_actions: ["save_diary"],
          provider_status: {
            provider: "mock",
            model: null,
            configured: true,
            label: "Local Mock API"
          },
          memory_events: [
            {
              id: "memory-1",
              category: "preference",
              text: "likes quiet piano",
              confidence: 0.82,
              created_at: "2026-06-06T23:00:00Z"
            }
          ],
          session: null
        })
    }));
    vi.stubGlobal("fetch", fetchMock);

    await expect(roomApi.postChat({ message: "Evening", roomState: DEFAULT_ROOM_STATE })).resolves.toEqual({
      reply: { id: "1", role: "kumiko", content: "I'm listening." },
      expression: "listening",
      suggestedActions: ["save_diary"],
      providerStatus: {
        provider: "mock",
        model: null,
        configured: true,
        label: "Local Mock API"
      },
      memoryEvents: [
        {
          id: "memory-1",
          category: "preference",
          text: "likes quiet piano",
          confidence: 0.82,
          createdAt: "2026-06-06T23:00:00Z"
        }
      ],
      session: null
    });

    expect(fetchMock).toHaveBeenCalledWith(
      "/api/room/chat",
      expect.objectContaining({
        method: "POST"
      })
    );
    expect(requestBody(fetchMock)).toEqual({
      message: "Evening",
      room_state: roomStateApi(),
      listening_context: null,
      recent_messages: [],
      persona_strength: "medium",
      memory_enabled: true,
      session_id: null
    });
  });

  it("posts chat messages with explicit session, persona strength, memory toggle, and recent messages", async () => {
    const recentMessages = [
      { id: "recent-1", role: "kumiko" as const, content: "What should we listen to?" },
      { id: "recent-2", role: "user" as const, content: "Something quiet." }
    ];
    const fetchMock = vi.fn(async () => ({
      ok: true,
      status: 200,
      statusText: "OK",
      text: async () =>
        JSON.stringify({
          reply: { id: "2", role: "kumiko", content: "Let's keep it quiet." },
          expression: "encouraging",
          suggested_actions: [],
          provider_status: {
            provider: "deepseek",
            model: "deepseek-v4-flash",
            configured: true,
            label: "DeepSeek"
          },
          memory_events: [],
          session: {
            id: "session-1",
            title: "Continue",
            latest_message_preview: "Let's keep it quiet.",
            created_at: "2026-06-10T10:00:00Z",
            updated_at: "2026-06-10T10:05:00Z"
          }
        })
    }));
    vi.stubGlobal("fetch", fetchMock);

    await expect(
      roomApi.postChat({
        message: "Continue",
        roomState: DEFAULT_ROOM_STATE,
        recentMessages,
        personaStrength: "strong",
        memoryEnabled: false,
        sessionId: "session-1"
      })
    ).resolves.toMatchObject({
      session: {
        id: "session-1",
        title: "Continue",
        latestMessagePreview: "Let's keep it quiet.",
        createdAt: "2026-06-10T10:00:00Z",
        updatedAt: "2026-06-10T10:05:00Z"
      }
    });

    expect(requestBody(fetchMock)).toEqual({
      message: "Continue",
      room_state: roomStateApi(),
      listening_context: null,
      recent_messages: recentMessages,
      persona_strength: "strong",
      memory_enabled: false,
      session_id: "session-1"
    });
  });

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
        creator: "部室 · 木管声部",
        isPlaying: true,
        pageUrl: "https://www.bilibili.com/video/BV1xx411c7mD",
        tags: ["bilibili", "rehearsal"]
      }
    });

    expect(requestBody(fetchMock)).toMatchObject({
      listening_context: {
        source: "bilibili",
        title: "合奏前调音",
        creator: "部室 · 木管声部",
        is_playing: true,
        page_url: "https://www.bilibili.com/video/BV1xx411c7mD",
        tags: ["bilibili", "rehearsal"]
      }
    });
  });

  it("loads memories and maps created timestamps", async () => {
    const fetchMock = vi.fn(async () => ({
      ok: true,
      status: 200,
      statusText: "OK",
      text: async () =>
        JSON.stringify([
          {
            id: "memory-1",
            category: "creative_note",
            text: "finish the demo tomorrow",
            confidence: 0.9,
            created_at: "2026-06-07T10:30:00Z"
          }
        ])
    }));
    vi.stubGlobal("fetch", fetchMock);

    await expect(roomApi.getMemories()).resolves.toEqual([
      {
        id: "memory-1",
        category: "creative_note",
        text: "finish the demo tomorrow",
        confidence: 0.9,
        createdAt: "2026-06-07T10:30:00Z"
      }
    ]);
    expect(fetchMock).toHaveBeenCalledWith("/api/room/memory", expect.any(Object));
  });

  it("deletes one memory and clears all memories", async () => {
    const fetchMock = vi.fn(async () => ({
      ok: true,
      status: 204,
      statusText: "No Content",
      text: async () => ""
    }));
    vi.stubGlobal("fetch", fetchMock);

    await roomApi.deleteMemory("memory-1");
    await roomApi.clearMemories();

    expect(fetchMock).toHaveBeenNthCalledWith(
      1,
      "/api/room/memory/memory-1",
      expect.objectContaining({ method: "DELETE" })
    );
    expect(fetchMock).toHaveBeenNthCalledWith(
      2,
      "/api/room/memory",
      expect.objectContaining({ method: "DELETE" })
    );
  });
});

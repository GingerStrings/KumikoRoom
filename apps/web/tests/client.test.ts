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

function musicAgentTrack(overrides: Record<string, unknown> = {}) {
  return {
    id: "current",
    source: "netease",
    title: "Current Song",
    creator: "Current Artist",
    durationMs: 180000,
    pageUrl: "https://music.example/current",
    platformAudioUrl: "https://audio.example/current.mp3",
    tags: ["current", "liked"],
    canOpenVideo: false,
    saved: true,
    ...overrides
  };
}

function musicAgentTrackApi(overrides: Record<string, unknown> = {}) {
  return {
    id: "current",
    source: "netease",
    title: "Current Song",
    creator: "Current Artist",
    duration_ms: 180000,
    page_url: "https://music.example/current",
    platform_audio_url: "https://audio.example/current.mp3",
    tags: ["current", "liked"],
    can_open_video: false,
    saved: true,
    ...overrides
  };
}

function clientMusicItem(overrides: Record<string, unknown> = {}) {
  return {
    id: "client-item",
    source: "netease",
    title: "Client Song",
    creator: "Client Artist",
    durationMs: 210000,
    pageUrl: "https://music.example/client-item",
    platformAudioUrl: "https://audio.example/client-item.mp3",
    tags: ["agent-selected"],
    canOpenVideo: false,
    sourceQuery: null,
    selectedReason: null,
    selectionEvidence: [],
    selectionScore: null,
    ...overrides
  };
}

function clientMusicItemApi(overrides: Record<string, unknown> = {}) {
  return {
    id: "client-item",
    source: "netease",
    title: "Client Song",
    creator: "Client Artist",
    duration_ms: 210000,
    page_url: "https://music.example/client-item",
    platform_audio_url: "https://audio.example/client-item.mp3",
    tags: ["agent-selected"],
    can_open_video: false,
    source_query: null,
    selected_reason: null,
    selection_evidence: [],
    selection_score: null,
    ...overrides
  };
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
      session: null,
      clientActions: [],
      agentTrace: { toolCalls: [] }
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

  it("posts chat messages with music state snapshot fields", async () => {
    const fetchMock = vi.fn(async () => ({
      ok: true,
      status: 200,
      statusText: "OK",
      text: async () =>
        JSON.stringify({
          reply: { id: "music-state", role: "kumiko", content: "I can see the queue." },
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
      message: "What is next?",
      roomState: DEFAULT_ROOM_STATE,
      musicState: {
        isPlaying: false,
        currentTimeMs: 42000,
        durationMs: 180000,
        current: musicAgentTrack(),
        previous: musicAgentTrack({
          id: "previous",
          title: "Previous Song",
          platformAudioUrl: null,
          tags: ["recent"],
          saved: false
        }),
        next: musicAgentTrack({
          id: "next",
          title: "Next Song",
          tags: ["upcoming"],
          saved: false
        }),
        upcoming: [
          musicAgentTrack({ id: "next", title: "Next Song", tags: ["upcoming"], saved: false }),
          musicAgentTrack({
            id: "later",
            title: "Later Song",
            source: "bilibili",
            platformAudioUrl: null,
            canOpenVideo: true,
            tags: ["video"],
            saved: false
          })
        ],
        recent: [musicAgentTrack({ id: "recent", title: "Recent Song", saved: false })],
        saved: [musicAgentTrack({ id: "saved", title: "Saved Song", saved: true })],
        playlists: [
          {
            id: "playlist-night-writing",
            name: "Night Writing",
            description: "quiet songs",
            itemCount: 1,
            updatedAt: "2026-06-15T00:01:00.000Z",
            items: [
              musicAgentTrack({
                id: "playlist-song",
                title: "Playlist Song",
                tags: ["playlist"],
                saved: false
              })
            ]
          }
        ]
      }
    });

    expect(requestBody(fetchMock).music_state).toEqual({
      is_playing: false,
      current_time_ms: 42000,
      duration_ms: 180000,
      current: musicAgentTrackApi(),
      previous: musicAgentTrackApi({
        id: "previous",
        title: "Previous Song",
        platform_audio_url: null,
        tags: ["recent"],
        saved: false
      }),
      next: musicAgentTrackApi({
        id: "next",
        title: "Next Song",
        tags: ["upcoming"],
        saved: false
      }),
      upcoming: [
        musicAgentTrackApi({ id: "next", title: "Next Song", tags: ["upcoming"], saved: false }),
        musicAgentTrackApi({
          id: "later",
          title: "Later Song",
          source: "bilibili",
          platform_audio_url: null,
          can_open_video: true,
          tags: ["video"],
          saved: false
        })
      ],
      recent: [musicAgentTrackApi({ id: "recent", title: "Recent Song", saved: false })],
      saved: [musicAgentTrackApi({ id: "saved", title: "Saved Song", saved: true })],
      playlists: [
        {
          id: "playlist-night-writing",
          name: "Night Writing",
          description: "quiet songs",
          item_count: 1,
          updated_at: "2026-06-15T00:01:00.000Z",
          items: [
            musicAgentTrackApi({
              id: "playlist-song",
              title: "Playlist Song",
              tags: ["playlist"],
              saved: false
            })
          ]
        }
      ]
    });
  });

  it("maps chat client actions and agent trace fields", async () => {
    const fetchMock = vi.fn(async () => ({
      ok: true,
      status: 200,
      statusText: "OK",
      text: async () =>
        JSON.stringify({
          reply: { id: "4", role: "kumiko", content: "我找了一下，选了《晴天》。" },
          expression: "listening",
          suggested_actions: [],
          provider_status: {
            provider: "deepseek",
            model: "deepseek-v4-flash",
            configured: true,
            label: "DeepSeek"
          },
          memory_events: [],
          session: null,
          client_actions: [
            {
              type: "play_music_item",
              item: {
                id: "netease-song-2",
                source: "netease",
                title: "晴天 (原唱 周杰伦)",
                creator: "RyaVocal",
                duration_ms: 270738,
                page_url: "https://music.163.com/#/song?id=2",
                platform_audio_url: "https://music.163.com/song/media/outer/url?id=2.mp3",
                tags: ["netease", "agent-selected"],
                can_open_video: false,
                source_query: "play Sunny",
                selected_reason: "ranked score 120",
                selection_evidence: ["title exact match", "comment_count=10"],
                selection_score: 120
              }
            }
          ],
          agent_trace: {
            tool_calls: [{ id: "call-play", name: "play_music_item", ok: true }]
          }
        })
    }));
    vi.stubGlobal("fetch", fetchMock);

    await expect(
      roomApi.postChat({ message: "播放 晴天", roomState: DEFAULT_ROOM_STATE })
    ).resolves.toMatchObject({
      clientActions: [
        {
          type: "play_music_item",
          item: {
            id: "netease-song-2",
            source: "netease",
            title: "晴天 (原唱 周杰伦)",
            creator: "RyaVocal",
            durationMs: 270738,
            pageUrl: "https://music.163.com/#/song?id=2",
            platformAudioUrl: "https://music.163.com/song/media/outer/url?id=2.mp3",
            tags: ["netease", "agent-selected"],
            canOpenVideo: false,
            sourceQuery: "play Sunny",
            selectedReason: "ranked score 120",
            selectionEvidence: ["title exact match", "comment_count=10"],
            selectionScore: 120
          }
        }
      ],
      agentTrace: {
        toolCalls: [{ id: "call-play", name: "play_music_item", ok: true }]
      }
    });
  });

  it("maps typed music client actions and ignores malformed actions", async () => {
    const fetchMock = vi.fn(async () => ({
      ok: true,
      status: 200,
      statusText: "OK",
      text: async () =>
        JSON.stringify({
          reply: { id: "actions", role: "kumiko", content: "Updated the music state." },
          expression: "listening",
          suggested_actions: [],
          provider_status: {
            provider: "deepseek",
            model: "deepseek-v4-flash",
            configured: true,
            label: "DeepSeek"
          },
          memory_events: [],
          session: null,
          client_actions: [
            {
              type: "play_music_item",
              item: clientMusicItemApi({ id: "play", title: "Play Song" })
            },
            {
              type: "add_music_to_queue",
              item: clientMusicItemApi({ id: "add", title: "Add Song" })
            },
            {
              type: "save_music_item",
              item: clientMusicItemApi({ id: "save", title: "Save Song" })
            },
            {
              type: "open_video_window",
              item: clientMusicItemApi({
                id: "video",
                source: "bilibili",
                title: "Video Song",
                platform_audio_url: null,
                can_open_video: true
              })
            },
            { type: "remove_music_from_queue", item_id: "next" },
            { type: "unsave_music_item", item_id: "saved" },
            { type: "clear_music_queue", item: null, item_id: null },
            {
              type: "create_music_playlist",
              playlist_id: "playlist-night-writing",
              playlist_name: "Night Writing",
              description: "quiet"
            },
            { type: "rename_music_playlist", playlist_id: "playlist-night-writing", playlist_name: "Late Night" },
            { type: "delete_music_playlist", playlist_id: "playlist-old" },
            {
              type: "add_music_to_playlist",
              playlist_id: "playlist-night-writing",
              item: clientMusicItemApi({ id: "playlist-song", title: "Playlist Song" })
            },
            { type: "remove_music_from_playlist", playlist_id: "playlist-night-writing", item_id: "playlist-song" },
            { type: "play_music_playlist", playlist_id: "playlist-night-writing" },
            { type: "add_playlist_to_queue", playlist_id: "playlist-night-writing" },
            { type: "play_music_item" },
            { type: "remove_music_from_queue", item_id: "" },
            { type: "clear_music_queue", item: clientMusicItemApi({ id: "extra" }) },
            { type: "create_music_playlist", playlist_name: "" },
            { type: "create_music_playlist", playlist_name: "Missing id" },
            { type: "rename_music_playlist", playlist_id: "", playlist_name: "Bad" },
            { type: "add_music_to_playlist", playlist_id: "playlist-night-writing" },
            { type: "remove_music_from_playlist", playlist_id: "playlist-night-writing", item_id: "" },
            { type: "play_music_playlist", playlist_id: "" },
            { type: "unknown_action", item: clientMusicItemApi({ id: "unknown" }) }
          ]
        })
    }));
    vi.stubGlobal("fetch", fetchMock);

    await expect(
      roomApi.postChat({ message: "Update queue", roomState: DEFAULT_ROOM_STATE })
    ).resolves.toMatchObject({
      clientActions: [
        {
          type: "play_music_item",
          item: clientMusicItem({ id: "play", title: "Play Song" })
        },
        {
          type: "add_music_to_queue",
          item: clientMusicItem({ id: "add", title: "Add Song" })
        },
        {
          type: "save_music_item",
          item: clientMusicItem({ id: "save", title: "Save Song" })
        },
        {
          type: "open_video_window",
          item: clientMusicItem({
            id: "video",
            source: "bilibili",
            title: "Video Song",
            platformAudioUrl: null,
            canOpenVideo: true
          })
        },
        { type: "remove_music_from_queue", itemId: "next" },
        { type: "unsave_music_item", itemId: "saved" },
        { type: "clear_music_queue" },
        {
          type: "create_music_playlist",
          playlistId: "playlist-night-writing",
          playlistName: "Night Writing",
          description: "quiet"
        },
        { type: "rename_music_playlist", playlistId: "playlist-night-writing", playlistName: "Late Night" },
        { type: "delete_music_playlist", playlistId: "playlist-old" },
        {
          type: "add_music_to_playlist",
          playlistId: "playlist-night-writing",
          item: clientMusicItem({ id: "playlist-song", title: "Playlist Song" })
        },
        { type: "remove_music_from_playlist", playlistId: "playlist-night-writing", itemId: "playlist-song" },
        { type: "play_music_playlist", playlistId: "playlist-night-writing" },
        { type: "add_playlist_to_queue", playlistId: "playlist-night-writing" }
      ]
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

  it("searches music by query and maps platform fields", async () => {
    const fetchMock = vi.fn(async () => ({
      ok: true,
      status: 200,
      statusText: "OK",
      text: async () =>
        JSON.stringify([
          {
            source: "netease",
            id: "netease-song-186016",
            song_id: "186016",
            title: "晴天",
            creator: "周杰伦",
            duration_ms: 269000,
            page_url: "https://music.163.com/#/song?id=186016",
            platform_audio_url: "https://music.163.com/song/media/outer/url?id=186016.mp3",
            tags: ["netease", "search"],
            playable: true,
            popularity: 100,
            comment_count: 1970484,
            hot_comment_liked_count: 823181,
            score: 180.5,
            evidence: ["title exact match", "comment_count=1970484"]
          }
        ])
    }));
    vi.stubGlobal("fetch", fetchMock);

    await expect(roomApi.searchMusic("晴天", 1)).resolves.toEqual([
      {
        source: "netease",
        id: "netease-song-186016",
        songId: "186016",
        title: "晴天",
        creator: "周杰伦",
        durationMs: 269000,
        pageUrl: "https://music.163.com/#/song?id=186016",
        platformAudioUrl: "https://music.163.com/song/media/outer/url?id=186016.mp3",
        tags: ["netease", "search"],
        playable: true,
        popularity: 100,
        commentCount: 1970484,
        hotCommentLikedCount: 823181,
        score: 180.5,
        evidence: ["title exact match", "comment_count=1970484"]
      }
    ]);
    expect(fetchMock).toHaveBeenCalledWith(
      "/api/room/music/search?q=%E6%99%B4%E5%A4%A9&limit=1",
      expect.any(Object)
    );
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

  it("includes llm_config in postChat body when provided", async () => {
    const fetchMock = vi.fn(async () => ({
      ok: true,
      status: 200,
      statusText: "OK",
      text: async () => JSON.stringify({
        reply: { id: "1", role: "kumiko", content: "ok" },
        expression: "listening",
        suggested_actions: [],
        provider_status: {
          provider: "openai_compatible",
          model: "gpt-4o-mini",
          configured: true,
          label: "OpenAI 兼容 gpt-4o-mini"
        },
        memory_events: [],
        session: null
      })
    }));
    vi.stubGlobal("fetch", fetchMock);

    await roomApi.postChat({
      message: "hi",
      roomState: DEFAULT_ROOM_STATE,
      llmConfig: {
        provider: "openai_compatible",
        baseUrl: "https://api.openai.com/v1",
        apiKey: "sk-test",
        model: "gpt-4o-mini"
      }
    });

    const body = requestBody(fetchMock);
    expect(body.llm_config).toEqual({
      provider: "openai_compatible",
      base_url: "https://api.openai.com/v1",
      api_key: "sk-test",
      model: "gpt-4o-mini"
    });
  });

  it("omits llm_config from postChat body when not provided", async () => {
    const fetchMock = vi.fn(async () => ({
      ok: true,
      status: 200,
      statusText: "OK",
      text: async () => JSON.stringify({
        reply: { id: "1", role: "kumiko", content: "ok" },
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

    await roomApi.postChat({ message: "hi", roomState: DEFAULT_ROOM_STATE });

    const body = requestBody(fetchMock);
    expect(body).not.toHaveProperty("llm_config");
  });

  it("testLLMConnection posts to /api/room/llm/test and maps response", async () => {
    const fetchMock = vi.fn(async () => ({
      ok: true,
      status: 200,
      statusText: "OK",
      text: async () => JSON.stringify({
        ok: true,
        error: null,
        model: "gpt-4o-mini",
        latency_ms: 312
      })
    }));
    vi.stubGlobal("fetch", fetchMock);

    const result = await roomApi.testLLMConnection({
      provider: "openai_compatible",
      baseUrl: "https://api.openai.com/v1",
      apiKey: "sk-test",
      model: "gpt-4o-mini"
    });

    expect(fetchMock).toHaveBeenCalledWith(
      "/api/room/llm/test",
      expect.objectContaining({ method: "POST" })
    );
    const body = requestBody(fetchMock);
    expect(body).toEqual({
      provider: "openai_compatible",
      base_url: "https://api.openai.com/v1",
      api_key: "sk-test",
      model: "gpt-4o-mini"
    });
    expect(result).toEqual({
      ok: true,
      error: null,
      model: "gpt-4o-mini",
      latencyMs: 312
    });
  });

  it("testLLMConnection maps failure response", async () => {
    const fetchMock = vi.fn(async () => ({
      ok: true,
      status: 200,
      statusText: "OK",
      text: async () => JSON.stringify({
        ok: false,
        error: "HTTP 401",
        model: "gpt-4o-mini",
        latency_ms: 42
      })
    }));
    vi.stubGlobal("fetch", fetchMock);

    const result = await roomApi.testLLMConnection({
      provider: "openai_compatible",
      baseUrl: "https://api.openai.com/v1",
      apiKey: "bad",
      model: "gpt-4o-mini"
    });

    expect(result.ok).toBe(false);
    expect(result.error).toBe("HTTP 401");
    expect(result.latencyMs).toBe(42);
  });
});

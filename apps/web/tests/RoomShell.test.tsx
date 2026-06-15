import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import React from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ChatSession, StoredChatMessage } from "../src/api/types";
import { RoomShell } from "../src/components/RoomShell";
import { getConnectionStatus } from "../src/lib/connectionStatus";
import { PLAYER_TRACKS, buildListeningContext } from "../src/lib/musicItems";
import { DEFAULT_ROOM_STATE, getIdleLine } from "../src/lib/roomState";

const apiMocks = vi.hoisted(() => ({
  createSession: vi.fn(),
  deleteSession: vi.fn(),
  getSessionMessages: vi.fn(),
  getSessions: vi.fn(),
  renameSession: vi.fn(),
  postChat: vi.fn(),
  searchMusic: vi.fn()
}));

vi.mock("../src/api/client", () => ({
  createSession: apiMocks.createSession,
  deleteSession: apiMocks.deleteSession,
  getSessionMessages: apiMocks.getSessionMessages,
  getSessions: apiMocks.getSessions,
  renameSession: apiMocks.renameSession,
  postChat: apiMocks.postChat,
  searchMusic: apiMocks.searchMusic
}));

const connectionStatus = getConnectionStatus("http://127.0.0.1:8000");
const defaultSession = makeSession({
  id: "session-default",
  title: "默认会话",
  latestMessagePreview: null
});
const defaultCreatedSession = makeSession({
  id: "session-new",
  title: "新会话",
  latestMessagePreview: null
});

const mediaPlayMock = vi.fn(() => Promise.resolve());
const mediaPauseMock = vi.fn();

describe("RoomShell", () => {
  beforeEach(() => {
    for (const mock of Object.values(apiMocks)) {
      mock.mockReset();
    }
    mediaPlayMock.mockClear();
    mediaPauseMock.mockClear();
    Object.defineProperty(HTMLMediaElement.prototype, "play", {
      configurable: true,
      value: mediaPlayMock
    });
    Object.defineProperty(HTMLMediaElement.prototype, "pause", {
      configurable: true,
      value: mediaPauseMock
    });
    localStorage.clear();
    apiMocks.getSessions.mockResolvedValue([defaultSession]);
    apiMocks.getSessionMessages.mockResolvedValue([]);
    apiMocks.createSession.mockResolvedValue(defaultCreatedSession);
    apiMocks.deleteSession.mockResolvedValue(undefined);
    apiMocks.renameSession.mockImplementation((sessionId: string, title: string) =>
      Promise.resolve(
        makeSession({
          id: sessionId,
          title,
          latestMessagePreview: null
        })
      )
    );
    apiMocks.postChat.mockResolvedValue(makeChatResponse({ session: null }));
    apiMocks.searchMusic.mockResolvedValue([]);
  });

  it("renders a chat-first workspace without the character placeholder", async () => {
    render(<RoomShell initialState={DEFAULT_ROOM_STATE} connectionStatus={connectionStatus} />);

    expect(await screen.findByRole("button", { name: "默认会话" })).toBeTruthy();
    expect(screen.queryByRole("heading", { name: "和久美子说会儿话" })).toBeNull();
    const timeline = screen.getByLabelText("聊天时间线");
    expect(timeline.textContent).toContain("还没有消息");
    expect(timeline.textContent).not.toContain(getIdleLine(DEFAULT_ROOM_STATE));
    expect(screen.getByRole("textbox", { name: "写一条消息" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "模型与偏好" })).toBeTruthy();
    expect(screen.getByRole("link", { name: "首页" }).getAttribute("href")).toBe("/");
    expect(screen.getByRole("link", { name: "资料室" }).getAttribute("href")).toBe("/studio");
    expect(screen.queryByRole("link", { name: "打开创作资料" })).toBeNull();
    expect(screen.queryByLabelText("久美子立绘占位")).toBeNull();
    expect(screen.queryByText("陪伴房间")).toBeNull();
    expect(screen.queryByText("房间")).toBeNull();
    expect(screen.queryByLabelText("今日摘要")).toBeNull();
    expect(screen.queryByLabelText("本地音乐状态")).toBeNull();
    expect(screen.queryByLabelText("AI 设置")).toBeNull();
    expect(screen.queryByText("今日心情")).toBeNull();
    expect(screen.queryByText("听歌日记")).toBeNull();
  });

  it("uses the v6 room shell with a compact sidebar create tool", async () => {
    render(<RoomShell initialState={DEFAULT_ROOM_STATE} connectionStatus={connectionStatus} />);

    expect(await screen.findByRole("button", { name: "默认会话" })).toBeTruthy();
    expect(document.querySelector(".room-stage")).toBeTruthy();
    expect(document.querySelector(".room-workspace")).toBeTruthy();
    expect(document.querySelector(".chat")).toBeTruthy();
    expect(document.querySelector(".profile")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "收起会话列表" })).toBeNull();

    const brandMark = document.querySelector(".brand .brand-mark");
    expect(brandMark?.tagName).toBe("SPAN");
    expect(brandMark?.textContent).toBe("KR");

    const createButton = screen.getByRole("button", { name: "新建会话" });
    expect(createButton.classList.contains("tool")).toBe(true);
    expect(createButton.textContent).toBe("+");
  });

  it("renders the default Netease platform track before video is opened", async () => {
    render(<RoomShell initialState={DEFAULT_ROOM_STATE} connectionStatus={connectionStatus} />);

    expect(await screen.findByRole("button", { name: defaultSession.title })).toBeTruthy();
    expect(screen.getByLabelText("氛围播放器")).toBeTruthy();
    expect(screen.getByText(PLAYER_TRACKS[0].title)).toBeTruthy();
    expect(screen.getByText(PLAYER_TRACKS[0].creator)).toBeTruthy();
    const playerControls = getPlayerControls();
    const sourceBadge = document.querySelector<HTMLElement>(".source-badge");
    const audio = getPlatformAudio();

    expect(playerControls.getAttribute("data-has-video")).not.toBe("true");
    expect(sourceBadge?.getAttribute("data-source")).toBe("netease");
    expect(audio.getAttribute("src")).toBe(PLAYER_TRACKS[0].platformAudioUrl);
    expect(audio.getAttribute("src")).not.toContain("/assets/");
    expect(screen.queryByRole("button", { name: "打开视频小窗" })).toBeNull();
    expect(screen.queryByRole("dialog", { name: "B站视频小窗" })).toBeNull();
    expect(screen.queryByTitle(/视频播放/)).toBeNull();
  });

  it("updates Netease progress from media events and controls the platform audio element", async () => {
    render(<RoomShell initialState={DEFAULT_ROOM_STATE} connectionStatus={connectionStatus} />);

    expect(await screen.findByRole("button", { name: defaultSession.title })).toBeTruthy();
    const audio = getPlatformAudio();
    Object.defineProperty(audio, "duration", {
      configurable: true,
      value: PLAYER_TRACKS[0].durationMs / 1000
    });
    audio.currentTime = 42;
    fireEvent.loadedMetadata(audio);
    fireEvent.timeUpdate(audio);

    const progress = document.querySelector<HTMLElement>(".progress");
    const fill = document.querySelector<HTMLElement>(".bar span");
    expect(progress?.textContent).toContain("00:42");
    expect(progress?.textContent).toContain("03:35");
    expect(fill?.style.width).toBe("19.5%");

    fireEvent.click(screen.getByRole("button", { name: "暂停" }));
    expect(mediaPauseMock).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByRole("button", { name: "播放" }));
    expect(mediaPlayMock).toHaveBeenCalled();
  });

  it("advances to the next queued audio track on ended without removing played tracks", async () => {
    const firstTrack = {
      id: "netease-ended-first",
      source: "netease" as const,
      title: "自动播放第一首",
      creator: "Queue Test",
      durationMs: 180000,
      pageUrl: "https://music.163.com/#/song?id=180",
      platformAudioUrl: "https://music.163.com/song/media/outer/url?id=180.mp3",
      tags: ["netease", "queue-test"],
      canOpenVideo: false
    };
    const secondTrack = {
      id: "netease-ended-second",
      source: "netease" as const,
      title: "自动播放第二首",
      creator: "Queue Test",
      durationMs: 181000,
      pageUrl: "https://music.163.com/#/song?id=181",
      platformAudioUrl: "https://music.163.com/song/media/outer/url?id=181.mp3",
      tags: ["netease", "queue-test"],
      canOpenVideo: false
    };
    apiMocks.postChat.mockResolvedValueOnce(
      makeChatResponse({
        reply: { id: "reply-auto-next", role: "kumiko", content: "我排好队列并开始播放了。" },
        clientActions: [
          { type: "play_music_item", item: firstTrack },
          { type: "add_music_to_queue", item: secondTrack }
        ]
      })
    );
    render(<RoomShell initialState={DEFAULT_ROOM_STATE} connectionStatus={connectionStatus} />);

    expect(await screen.findByRole("button", { name: defaultSession.title })).toBeTruthy();
    fireEvent.change(getComposerInput(), { target: { value: "播放并排下一首" } });
    fireEvent.click(getComposerSubmit());

    expect(await within(getTimeline()).findByText("我排好队列并开始播放了。")).toBeTruthy();
    expect(document.querySelector<HTMLElement>(".track-title strong")?.textContent).toBe(firstTrack.title);
    const audio = getPlatformAudio();
    audio.currentTime = firstTrack.durationMs / 1000;
    fireEvent.ended(audio);

    await waitFor(() =>
      expect(document.querySelector<HTMLElement>(".track-title strong")?.textContent).toBe(secondTrack.title)
    );
    fireEvent.click(getQueueManageButton());
    const panel = getMusicQueuePanel();
    const firstRow = within(panel).getByText(firstTrack.title).closest(".music-queue-row");
    const secondRow = within(panel).getByText(secondTrack.title).closest(".music-queue-row");
    expect(firstRow).toBeTruthy();
    expect(secondRow?.getAttribute("data-active")).toBe("true");
  });

  it("cycles playback modes from the player controls", async () => {
    render(<RoomShell initialState={DEFAULT_ROOM_STATE} connectionStatus={connectionStatus} />);

    expect(await screen.findByRole("button", { name: defaultSession.title })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "播放模式：顺序播放" }));
    expect(screen.getByRole("button", { name: "播放模式：随机播放" })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "播放模式：随机播放" }));
    expect(screen.getByRole("button", { name: "播放模式：单曲循环" })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "播放模式：单曲循环" }));
    expect(screen.getByRole("button", { name: "播放模式：顺序播放" })).toBeTruthy();
  });

  it("wraps from the last track to the first track when pressing next in sequence mode", async () => {
    render(<RoomShell initialState={DEFAULT_ROOM_STATE} connectionStatus={connectionStatus} />);

    expect(await screen.findByRole("button", { name: defaultSession.title })).toBeTruthy();
    fireEvent.click(getQueuePreviewMain());
    expect(document.querySelector<HTMLElement>(".track-title strong")?.textContent).toBe(PLAYER_TRACKS[1].title);

    fireEvent.click(screen.getByRole("button", { name: "下一首" }));

    expect(document.querySelector<HTMLElement>(".track-title strong")?.textContent).toBe(PLAYER_TRACKS[0].title);
  });

  it("opens and closes the Bilibili mini-window from the music player", async () => {
    render(<RoomShell initialState={DEFAULT_ROOM_STATE} connectionStatus={connectionStatus} />);

    expect(await screen.findByRole("button", { name: defaultSession.title })).toBeTruthy();
    fireEvent.click(getQueuePreviewMain());
    const sourceBadge = document.querySelector<HTMLElement>(".source-badge");

    expect(sourceBadge?.getAttribute("data-source")).toBe("bilibili");
    expect(getPlayerControls().getAttribute("data-has-video")).toBe("true");
    expect(screen.getByRole("button", { name: "打开视频小窗" })).toBeTruthy();
    expect(document.querySelector("audio.platform-audio-host")).toBeNull();
    expect(document.querySelector(".progress")?.textContent).not.toContain("00:42");
    expect(document.querySelector(".progress")?.textContent).not.toContain("02:18");
    fireEvent.click(screen.getByRole("button", { name: "打开视频小窗" }));

    expect(screen.getByRole("dialog", { name: "B站视频小窗" })).toBeTruthy();
    expect(screen.getByTitle(new RegExp(PLAYER_TRACKS[1].title))).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "关闭视频小窗" }));
    expect(screen.queryByRole("dialog", { name: "B站视频小窗" })).toBeNull();
  });

  it("sends active listening context with chat messages", async () => {
    const bilibiliTrack = PLAYER_TRACKS.find((track) => track.id === "bilibili-blue-bird-rehearsal");
    if (!bilibiliTrack) {
      throw new Error("Bilibili player track not found");
    }
    render(<RoomShell initialState={DEFAULT_ROOM_STATE} connectionStatus={connectionStatus} />);

    expect(await screen.findByRole("button", { name: defaultSession.title })).toBeTruthy();
    fireEvent.click(getQueuePreviewMain());
    fireEvent.change(getComposerInput(), {
      target: { value: "这首现在是什么感觉？" }
    });
    fireEvent.click(getComposerSubmit());

    await waitFor(() => expect(apiMocks.postChat).toHaveBeenCalledTimes(1));
    expect(apiMocks.postChat).toHaveBeenCalledWith(
      expect.objectContaining({
        listeningContext: buildListeningContext(bilibiliTrack, true),
        musicState: expect.objectContaining({
          isPlaying: true,
          current: expect.objectContaining({
            id: bilibiliTrack.id,
            title: bilibiliTrack.title,
            creator: bilibiliTrack.creator,
            saved: false
          }),
          previous: expect.objectContaining({
            id: PLAYER_TRACKS[0].id
          }),
          next: expect.any(Object),
          upcoming: expect.any(Array),
          recent: expect.arrayContaining([
            expect.objectContaining({
              id: PLAYER_TRACKS[0].id
            })
          ]),
          saved: []
        })
      })
    );
  });

  it("sends stored music library playlists with chat messages", async () => {
    localStorage.setItem(
      "kumikoroom.musicLibrary",
      JSON.stringify({
        playlists: [
          {
            id: "playlist-night-writing",
            name: "Night Writing",
            description: "quiet songs",
            createdAt: "2026-06-15T00:00:00.000Z",
            updatedAt: "2026-06-15T00:01:00.000Z",
            items: [
              {
                id: PLAYER_TRACKS[0].id,
                item: PLAYER_TRACKS[0],
                addedAt: "2026-06-15T00:01:00.000Z",
                addedBy: "user"
              }
            ]
          }
        ]
      })
    );
    render(<RoomShell initialState={DEFAULT_ROOM_STATE} connectionStatus={connectionStatus} />);

    expect(await screen.findByRole("button", { name: defaultSession.title })).toBeTruthy();
    fireEvent.change(getComposerInput(), { target: { value: "What is in my playlists?" } });
    fireEvent.click(getComposerSubmit());

    await waitFor(() => expect(apiMocks.postChat).toHaveBeenCalledTimes(1));
    expect(apiMocks.postChat).toHaveBeenCalledWith(
      expect.objectContaining({
        musicState: expect.objectContaining({
          playlists: [
            expect.objectContaining({
              id: "playlist-night-writing",
              name: "Night Writing",
              description: "quiet songs",
              itemCount: 1,
              updatedAt: "2026-06-15T00:01:00.000Z",
              items: [
                expect.objectContaining({
                  id: PLAYER_TRACKS[0].id,
                  title: PLAYER_TRACKS[0].title,
                  tags: PLAYER_TRACKS[0].tags
                })
              ]
            })
          ]
        })
      })
    );
  });

  it("creates and persists a manual playlist from the management panel", async () => {
    const firstRender = render(<RoomShell initialState={DEFAULT_ROOM_STATE} connectionStatus={connectionStatus} />);

    expect(await screen.findByRole("button", { name: defaultSession.title })).toBeTruthy();
    fireEvent.click(getQueueManageButton());
    let panel = getMusicQueuePanel();
    fireEvent.click(within(panel).getByRole("tab", { name: "我的歌单" }));
    fireEvent.change(within(panel).getByLabelText("歌单名称"), { target: { value: "夜晚写作" } });
    fireEvent.click(within(panel).getByRole("button", { name: "新建歌单" }));

    expect(within(panel).getByText("夜晚写作")).toBeTruthy();
    expect(localStorage.getItem("kumikoroom.musicLibrary")).toContain("夜晚写作");

    firstRender.unmount();
    render(<RoomShell initialState={DEFAULT_ROOM_STATE} connectionStatus={connectionStatus} />);

    expect(await screen.findByRole("button", { name: defaultSession.title })).toBeTruthy();
    fireEvent.click(getQueueManageButton());
    panel = getMusicQueuePanel();
    fireEvent.click(within(panel).getByRole("tab", { name: "我的歌单" }));
    expect(within(panel).getByText("夜晚写作")).toBeTruthy();
  });

  it("applies agent playlist client actions and plays the playlist", async () => {
    apiMocks.postChat.mockResolvedValueOnce(
      makeChatResponse({
        reply: { id: "reply-playlist", role: "kumiko", content: "我建好歌单并开始播放了。" },
        clientActions: [
          {
            type: "create_music_playlist",
            playlistId: "playlist-agent-list",
            playlistName: "Agent List",
            description: "from agent"
          },
          {
            type: "add_music_to_playlist",
            playlistId: "playlist-agent-list",
            item: {
              id: "netease-agent-playlist-song",
              source: "netease",
              title: "Agent Playlist Song",
              creator: "Agent Curator",
              durationMs: 201000,
              pageUrl: "https://music.163.com/#/song?id=201",
              platformAudioUrl: "https://music.163.com/song/media/outer/url?id=201.mp3",
              tags: ["netease", "agent-selected"],
              canOpenVideo: false
            }
          },
          { type: "play_music_playlist", playlistId: "playlist-agent-list" }
        ]
      })
    );
    render(<RoomShell initialState={DEFAULT_ROOM_STATE} connectionStatus={connectionStatus} />);

    expect(await screen.findByRole("button", { name: defaultSession.title })).toBeTruthy();
    fireEvent.change(getComposerInput(), { target: { value: "建一个歌单然后播放" } });
    fireEvent.click(getComposerSubmit());

    expect(await within(getTimeline()).findByText("我建好歌单并开始播放了。")).toBeTruthy();
    expect(document.querySelector<HTMLElement>(".track-title strong")?.textContent).toBe("Agent Playlist Song");
    fireEvent.click(getQueueManageButton());
    const panel = getMusicQueuePanel();
    fireEvent.click(within(panel).getByRole("tab", { name: "我的歌单" }));
    expect(within(panel).getByText("Agent List")).toBeTruthy();
    expect(within(panel).getByText("Agent Playlist Song")).toBeTruthy();
  });

  it("uses the backend playlist id when delayed agent playlist actions race with a same-name manual playlist", async () => {
    const pendingChat = deferred<Awaited<ReturnType<typeof apiMocks.postChat>>>();
    const agentPlaylistTrack = {
      id: "netease-agent-race-song",
      source: "netease" as const,
      title: "Agent Race Song",
      creator: "Agent Curator",
      durationMs: 201000,
      pageUrl: "https://music.163.com/#/song?id=301",
      platformAudioUrl: "https://music.163.com/song/media/outer/url?id=301.mp3",
      tags: ["netease", "agent-selected"],
      canOpenVideo: false
    };
    apiMocks.postChat.mockReturnValueOnce(pendingChat.promise);
    render(<RoomShell initialState={DEFAULT_ROOM_STATE} connectionStatus={connectionStatus} />);

    expect(await screen.findByRole("button", { name: defaultSession.title })).toBeTruthy();
    fireEvent.change(getComposerInput(), { target: { value: "Build the focus playlist" } });
    fireEvent.click(getComposerSubmit());

    await waitFor(() => expect(apiMocks.postChat).toHaveBeenCalledTimes(1));
    fireEvent.click(getQueueManageButton());
    let panel = getMusicQueuePanel();
    fireEvent.click(within(panel).getByRole("tab", { name: "我的歌单" }));
    fireEvent.change(within(panel).getByLabelText("歌单名称"), { target: { value: "Agent Focus" } });
    fireEvent.click(within(panel).getByRole("button", { name: "新建歌单" }));
    expect(within(panel).getByText("Agent Focus")).toBeTruthy();

    pendingChat.resolve(
      makeChatResponse({
        reply: { id: "reply-race-playlist", role: "kumiko", content: "I used the playlist I created." },
        clientActions: [
          {
            type: "create_music_playlist",
            playlistId: "playlist-agent-focus",
            playlistName: "Agent Focus",
            description: "from agent"
          },
          {
            type: "add_music_to_playlist",
            playlistId: "playlist-agent-focus",
            item: agentPlaylistTrack
          },
          { type: "play_music_playlist", playlistId: "playlist-agent-focus" }
        ]
      })
    );

    expect(await within(getTimeline()).findByText("I used the playlist I created.")).toBeTruthy();
    expect(document.querySelector<HTMLElement>(".track-title strong")?.textContent).toBe("Agent Race Song");

    panel = getMusicQueuePanel();
    expect(within(panel).getAllByText("Agent Focus")).toHaveLength(2);
    const storedLibrary = JSON.parse(localStorage.getItem("kumikoroom.musicLibrary") ?? "{\"playlists\":[]}") as {
      playlists: Array<{
        id: string;
        name: string;
        items: Array<{ item: { title: string } }>;
      }>;
    };
    const matchingPlaylists = storedLibrary.playlists.filter((playlist) => playlist.name === "Agent Focus");
    expect(matchingPlaylists.map((playlist) => playlist.id).sort()).toEqual([
      "playlist-agent-focus",
      "playlist-agent-focus-2"
    ]);
    expect(matchingPlaylists.find((playlist) => playlist.id === "playlist-agent-focus")?.items).toEqual([]);
    expect(
      matchingPlaylists
        .find((playlist) => playlist.id === "playlist-agent-focus-2")
        ?.items.map((entry) => entry.item.title)
    ).toEqual(["Agent Race Song"]);
  });

  it("appends a stored playlist to the queue without interrupting playback", async () => {
    const queuedPlaylistTrack = {
      id: "netease-night-queue-song",
      source: "netease" as const,
      title: "Night Queue Song",
      creator: "Queue Curator",
      durationMs: 203000,
      pageUrl: "https://music.163.com/#/song?id=203",
      platformAudioUrl: "https://music.163.com/song/media/outer/url?id=203.mp3",
      tags: ["netease"],
      canOpenVideo: false
    };
    localStorage.setItem(
      "kumikoroom.musicLibrary",
      JSON.stringify({
        playlists: [
          {
            id: "playlist-night-queue",
            name: "Night Queue",
            description: "queued by agent",
            createdAt: "2026-06-15T00:00:00.000Z",
            updatedAt: "2026-06-15T00:01:00.000Z",
            items: [
              {
                id: queuedPlaylistTrack.id,
                item: queuedPlaylistTrack,
                addedAt: "2026-06-15T00:01:00.000Z",
                addedBy: "user"
              }
            ]
          }
        ]
      })
    );
    apiMocks.postChat.mockResolvedValueOnce(
      makeChatResponse({
        reply: { id: "reply-enqueue-playlist", role: "kumiko", content: "我把这张歌单排到后面了。" },
        clientActions: [{ type: "add_playlist_to_queue", playlistId: "playlist-night-queue" }]
      })
    );
    render(<RoomShell initialState={DEFAULT_ROOM_STATE} connectionStatus={connectionStatus} />);

    expect(await screen.findByRole("button", { name: defaultSession.title })).toBeTruthy();
    fireEvent.change(getComposerInput(), { target: { value: "把 Night Queue 加到接下来" } });
    fireEvent.click(getComposerSubmit());

    expect(await within(getTimeline()).findByText("我把这张歌单排到后面了。")).toBeTruthy();
    expect(document.querySelector<HTMLElement>(".track-title strong")?.textContent).toBe(PLAYER_TRACKS[0].title);
    fireEvent.click(getQueueManageButton());
    const panel = getMusicQueuePanel();
    expect(within(panel).getByText(queuedPlaylistTrack.title)).toBeTruthy();
  });

  it("adds an agent-selected track to upcoming without interrupting the current track", async () => {
    apiMocks.postChat.mockResolvedValueOnce(
      makeChatResponse({
        reply: { id: "reply-add", role: "kumiko", content: "我先放进接下来。" },
        clientActions: [
          {
            type: "add_music_to_queue",
            item: {
              id: "netease-agent-upcoming",
              source: "netease",
              title: "接下来测试曲",
              creator: "Agent Queue",
              durationMs: 188000,
              pageUrl: "https://music.163.com/#/song?id=188",
              platformAudioUrl: "https://music.163.com/song/media/outer/url?id=188.mp3",
              tags: ["netease", "agent-selected"],
              canOpenVideo: false,
              sourceQuery: "加到队列",
              selectedReason: "综合热度和评论更稳"
            }
          }
        ]
      })
    );
    render(<RoomShell initialState={DEFAULT_ROOM_STATE} connectionStatus={connectionStatus} />);

    expect(await screen.findByRole("button", { name: defaultSession.title })).toBeTruthy();
    fireEvent.change(getComposerInput(), { target: { value: "先把这首放后面" } });
    fireEvent.click(getComposerSubmit());

    expect(await within(getTimeline()).findByText("我先放进接下来。")).toBeTruthy();
    expect(document.querySelector<HTMLElement>(".track-title strong")?.textContent).toBe(PLAYER_TRACKS[0].title);
    fireEvent.click(getQueueManageButton());

    const panel = getMusicQueuePanel();
    expect(within(panel).getByRole("tab", { name: "接下来" }).getAttribute("aria-selected")).toBe("true");
    expect(within(panel).getByText("播放队列")).toBeTruthy();
    const currentRow = within(panel).getByText(PLAYER_TRACKS[0].title).closest(".music-queue-row");
    expect(currentRow?.getAttribute("data-active")).toBe("true");
    expect(within(panel).getByText("接下来测试曲")).toBeTruthy();
    expect(within(panel).getByText("来自: 加到队列")).toBeTruthy();
    expect(within(panel).getByText("综合热度和评论更稳")).toBeTruthy();
  });

  it("folds agent queue management actions into one persisted queue state", async () => {
    apiMocks.postChat.mockResolvedValueOnce(
      makeChatResponse({
        reply: { id: "reply-manage", role: "kumiko", content: "我整理好了。" },
        clientActions: [
          {
            type: "add_music_to_queue",
            item: {
              id: "netease-agent-saved",
              source: "netease",
              title: "收藏测试曲",
              creator: "Agent Save",
              durationMs: 199000,
              pageUrl: "https://music.163.com/#/song?id=199",
              platformAudioUrl: "https://music.163.com/song/media/outer/url?id=199.mp3",
              tags: ["netease", "agent-selected"],
              canOpenVideo: false
            }
          },
          {
            type: "save_music_item",
            item: {
              id: "netease-agent-saved",
              source: "netease",
              title: "收藏测试曲",
              creator: "Agent Save",
              durationMs: 199000,
              pageUrl: "https://music.163.com/#/song?id=199",
              platformAudioUrl: "https://music.163.com/song/media/outer/url?id=199.mp3",
              tags: ["netease", "agent-selected"],
              canOpenVideo: false
            }
          },
          {
            type: "remove_music_from_queue",
            itemId: PLAYER_TRACKS[1].id
          }
        ]
      })
    );
    const firstRender = render(<RoomShell initialState={DEFAULT_ROOM_STATE} connectionStatus={connectionStatus} />);

    expect(await screen.findByRole("button", { name: defaultSession.title })).toBeTruthy();
    fireEvent.change(getComposerInput(), { target: { value: "整理一下队列" } });
    fireEvent.click(getComposerSubmit());

    expect(await within(getTimeline()).findByText("我整理好了。")).toBeTruthy();
    fireEvent.click(getQueueManageButton());
    let panel = getMusicQueuePanel();
    expect(within(panel).queryByText(PLAYER_TRACKS[1].title)).toBeNull();
    expect(within(panel).getByText("收藏测试曲")).toBeTruthy();
    fireEvent.click(within(panel).getByRole("tab", { name: "收藏" }));
    expect(within(panel).getByText("收藏测试曲")).toBeTruthy();

    firstRender.unmount();
    render(<RoomShell initialState={DEFAULT_ROOM_STATE} connectionStatus={connectionStatus} />);

    expect(await screen.findByRole("button", { name: defaultSession.title })).toBeTruthy();
    fireEvent.click(getQueueManageButton());
    panel = getMusicQueuePanel();
    expect(within(panel).queryByText(PLAYER_TRACKS[1].title)).toBeNull();
    fireEvent.click(within(panel).getByRole("tab", { name: "收藏" }));
    expect(within(panel).getByText("收藏测试曲")).toBeTruthy();
  });

  it("lets agent unsave an item and clear only upcoming queue entries", async () => {
    apiMocks.postChat.mockResolvedValueOnce(
      makeChatResponse({
        reply: { id: "reply-save", role: "kumiko", content: "先收藏。" },
        clientActions: [
          {
            type: "save_music_item",
            item: {
              id: "netease-agent-cleared",
              source: "netease",
              title: "待清空测试曲",
              creator: "Agent Clear",
              durationMs: 177000,
              pageUrl: "https://music.163.com/#/song?id=177",
              platformAudioUrl: "https://music.163.com/song/media/outer/url?id=177.mp3",
              tags: ["netease", "agent-selected"],
              canOpenVideo: false
            }
          }
        ]
      })
    );
    apiMocks.postChat.mockResolvedValueOnce(
      makeChatResponse({
        reply: { id: "reply-clear", role: "kumiko", content: "接下来清空了。" },
        clientActions: [
          { type: "unsave_music_item", itemId: "netease-agent-cleared" },
          { type: "clear_music_queue" }
        ]
      })
    );
    render(<RoomShell initialState={DEFAULT_ROOM_STATE} connectionStatus={connectionStatus} />);

    expect(await screen.findByRole("button", { name: defaultSession.title })).toBeTruthy();
    fireEvent.change(getComposerInput(), { target: { value: "收藏这首" } });
    fireEvent.click(getComposerSubmit());
    expect(await within(getTimeline()).findByText("先收藏。")).toBeTruthy();

    fireEvent.change(getComposerInput(), { target: { value: "取消收藏并清空接下来" } });
    fireEvent.click(getComposerSubmit());
    expect(await within(getTimeline()).findByText("接下来清空了。")).toBeTruthy();

    fireEvent.click(getQueueManageButton());
    const panel = getMusicQueuePanel();
    expect(within(panel).getByText("播放队列")).toBeTruthy();
    const currentRow = within(panel).getByText(PLAYER_TRACKS[0].title).closest(".music-queue-row");
    expect(currentRow?.getAttribute("data-active")).toBe("true");
    expect(within(panel).queryByText("待清空测试曲")).toBeNull();
    fireEvent.click(within(panel).getByRole("tab", { name: "收藏" }));
    expect(within(panel).queryByText("待清空测试曲")).toBeNull();
  });

  it("applies delayed agent queue actions on top of the latest local player state", async () => {
    const pendingChat = deferred<Awaited<ReturnType<typeof apiMocks.postChat>>>();
    apiMocks.postChat.mockReturnValueOnce(pendingChat.promise);
    render(<RoomShell initialState={DEFAULT_ROOM_STATE} connectionStatus={connectionStatus} />);

    expect(await screen.findByRole("button", { name: defaultSession.title })).toBeTruthy();
    fireEvent.change(getComposerInput(), { target: { value: "先帮我找一首放后面" } });
    fireEvent.click(getComposerSubmit());

    await waitFor(() => expect(apiMocks.postChat).toHaveBeenCalledTimes(1));
    fireEvent.click(getQueuePreviewMain());
    expect(document.querySelector<HTMLElement>(".track-title strong")?.textContent).toBe(PLAYER_TRACKS[1].title);

    pendingChat.resolve(
      makeChatResponse({
        reply: { id: "reply-late-add", role: "kumiko", content: "我把它排到后面了。" },
        clientActions: [
          {
            type: "add_music_to_queue",
            item: {
              id: "netease-agent-late",
              source: "netease",
              title: "延迟加入测试曲",
              creator: "Agent Late",
              durationMs: 190000,
              pageUrl: "https://music.163.com/#/song?id=190",
              platformAudioUrl: "https://music.163.com/song/media/outer/url?id=190.mp3",
              tags: ["netease", "agent-selected"],
              canOpenVideo: false
            }
          }
        ]
      })
    );

    expect(await within(getTimeline()).findByText("我把它排到后面了。")).toBeTruthy();
    expect(document.querySelector<HTMLElement>(".track-title strong")?.textContent).toBe(PLAYER_TRACKS[1].title);
    fireEvent.click(getQueueManageButton());

    const panel = getMusicQueuePanel();
    expect(within(panel).getByText("延迟加入测试曲")).toBeTruthy();
  });

  it("sends named play requests through chat and applies the returned music action", async () => {
    const command = "播放 晴天";
    apiMocks.postChat.mockResolvedValueOnce(
      makeChatResponse({
        reply: { id: "reply-agent", role: "kumiko", content: "我找了一下，选了证据最稳的《晴天》。" },
        clientActions: [
          {
            type: "play_music_item",
            item: {
              id: "netease-song-186016",
              source: "netease",
              title: "晴天",
              creator: "周杰伦",
              durationMs: 269000,
              pageUrl: "https://music.163.com/#/song?id=186016",
              platformAudioUrl: "https://music.163.com/song/media/outer/url?id=186016.mp3",
              tags: ["netease", "search", "agent-selected"],
              canOpenVideo: false
            }
          }
        ],
        agentTrace: {
          toolCalls: [
            { id: "call-search", name: "search_music", ok: true },
            { id: "call-play", name: "play_music_item", ok: true }
          ]
        }
      })
    );
    render(<RoomShell initialState={DEFAULT_ROOM_STATE} connectionStatus={connectionStatus} />);

    expect(await screen.findByRole("button", { name: defaultSession.title })).toBeTruthy();
    fireEvent.change(getComposerInput(), {
      target: { value: command }
    });
    fireEvent.click(getComposerSubmit());

    await waitFor(() => expect(apiMocks.postChat).toHaveBeenCalledTimes(1));
    expect(apiMocks.searchMusic).not.toHaveBeenCalled();
    expect(document.querySelector<HTMLElement>(".source-badge")?.getAttribute("data-source")).toBe("netease");
    expect(getPlatformAudio().getAttribute("src")).toBe("https://music.163.com/song/media/outer/url?id=186016.mp3");
    expect(document.querySelector(".queue-preview")).toBeTruthy();
    expect(screen.getByRole("button", { name: /管理播放队列/ })).toBeTruthy();
    fireEvent.click(getQueueManageButton());
    expect(within(getMusicQueuePanel()).getByText(PLAYER_TRACKS[1].title)).toBeTruthy();
    expect(within(getTimeline()).getByText(command)).toBeTruthy();
    expect(await within(getTimeline()).findByText("我找了一下，选了证据最稳的《晴天》。")).toBeTruthy();
    expect(within(getTimeline()).queryByText("已切到《晴天》。")).toBeNull();
  });

  it("records agent-selected tracks in the queue panel", async () => {
    apiMocks.postChat.mockResolvedValueOnce(
      makeChatResponse({
        reply: { id: "reply-agent", role: "kumiko", content: "我选了这版。" },
        clientActions: [
          {
            type: "play_music_item",
            item: {
              id: "netease-song-2",
              source: "netease",
              title: "Sunny",
              creator: "Composer",
              durationMs: 200000,
              pageUrl: "https://music.163.com/#/song?id=2",
              platformAudioUrl: "https://music.163.com/song/media/outer/url?id=2.mp3",
              tags: ["netease", "search", "agent-selected"],
              canOpenVideo: false,
              sourceQuery: "play Sunny",
              selectedReason: "ranked score 120",
              selectionEvidence: ["title exact match", "comment_count=10"],
              selectionScore: 120
            }
          }
        ]
      })
    );
    render(<RoomShell initialState={DEFAULT_ROOM_STATE} connectionStatus={connectionStatus} />);

    expect(await screen.findByRole("button", { name: defaultSession.title })).toBeTruthy();
    fireEvent.change(getComposerInput(), { target: { value: "play Sunny" } });
    fireEvent.click(getComposerSubmit());

    await waitFor(() => expect(apiMocks.postChat).toHaveBeenCalledTimes(1));
    fireEvent.click(screen.getByRole("button", { name: /管理播放队列/ }));

    const panel = screen.getByRole("dialog", { name: /音乐记录/ });
    expect(within(panel).getByText("Sunny")).toBeTruthy();
    expect(within(panel).getByText("来自: play Sunny")).toBeTruthy();
    expect(within(panel).getByText("ranked score 120")).toBeTruthy();
  });

  it("saves the current track from the queue panel", async () => {
    render(<RoomShell initialState={DEFAULT_ROOM_STATE} connectionStatus={connectionStatus} />);

    expect(await screen.findByRole("button", { name: defaultSession.title })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: /管理播放队列/ }));
    const panel = screen.getByRole("dialog", { name: /音乐记录/ });
    fireEvent.click(within(panel).getByRole("button", { name: `收藏 ${PLAYER_TRACKS[0].title}` }));
    fireEvent.click(within(panel).getByRole("tab", { name: "收藏" }));

    expect(within(panel).getByText(PLAYER_TRACKS[0].title)).toBeTruthy();
  });

  it("keeps removed queue entries removed after the room reloads", async () => {
    const removedTrack = PLAYER_TRACKS[1];
    const firstRender = render(<RoomShell initialState={DEFAULT_ROOM_STATE} connectionStatus={connectionStatus} />);

    expect(await screen.findByRole("button", { name: defaultSession.title })).toBeTruthy();
    fireEvent.click(getQueueManageButton());
    let panel = getMusicQueuePanel();
    const rowToRemove = within(panel).getByText(removedTrack.title).closest(".music-queue-row");
    if (!rowToRemove) {
      throw new Error("Queue row to remove not found");
    }
    const removeButton = Array.from(rowToRemove.querySelectorAll("button")).at(-1);
    if (!removeButton) {
      throw new Error("Queue remove button not found");
    }
    fireEvent.click(removeButton);

    expect(within(panel).queryByText(removedTrack.title)).toBeNull();
    firstRender.unmount();

    render(<RoomShell initialState={DEFAULT_ROOM_STATE} connectionStatus={connectionStatus} />);

    expect(await screen.findByRole("button", { name: defaultSession.title })).toBeTruthy();
    fireEvent.click(getQueueManageButton());
    panel = getMusicQueuePanel();
    expect(within(panel).queryByText(removedTrack.title)).toBeNull();
  });

  it("opens the video mini-window from a backend client action after chat", async () => {
    const command = "打开这个 B站 视频小窗";
    apiMocks.postChat.mockResolvedValueOnce(
      makeChatResponse({
        reply: { id: "reply-video", role: "kumiko", content: "我把视频小窗打开了。" },
        clientActions: [
          {
            type: "open_video_window",
            item: {
              id: "bilibili-video-BV1xx411c7mD",
              source: "bilibili",
              title: "B站视频 BV1xx411c7mD",
              creator: "Bilibili",
              durationMs: 0,
              pageUrl: "https://www.bilibili.com/video/BV1xx411c7mD",
              platformAudioUrl: null,
              tags: ["bilibili", "agent-selected"],
              canOpenVideo: true
            }
          }
        ]
      })
    );
    render(<RoomShell initialState={DEFAULT_ROOM_STATE} connectionStatus={connectionStatus} />);

    expect(await screen.findByRole("button", { name: defaultSession.title })).toBeTruthy();
    fireEvent.change(getComposerInput(), {
      target: { value: command }
    });
    fireEvent.click(getComposerSubmit());

    expect(await screen.findByRole("dialog", { name: "B站视频小窗" })).toBeTruthy();
    expect(document.querySelector<HTMLElement>(".source-badge")?.getAttribute("data-source")).toBe("bilibili");
    expect(document.querySelector<HTMLElement>(".track-title strong")?.textContent).toBe("B站视频 BV1xx411c7mD");
    expect(within(getTimeline()).getByText(command)).toBeTruthy();
    expect(await within(getTimeline()).findByText("我把视频小窗打开了。")).toBeTruthy();
    expect(apiMocks.postChat).toHaveBeenCalledTimes(1);
  });

  it("sends confirmation text through chat and applies the returned play action", async () => {
    apiMocks.postChat
      .mockResolvedValueOnce(
        makeChatResponse({
          reply: { id: "reply-recommend", role: "kumiko", content: "那我会选《红马 (伴奏)》。" },
          session: null
        })
      )
      .mockResolvedValueOnce(
        makeChatResponse({
          reply: { id: "reply-confirm", role: "kumiko", content: "好，我现在放这首。" },
          clientActions: [
            {
              type: "play_music_item",
              item: {
                id: "netease-red-horse-instrumental",
                source: "netease",
                title: "红马 (伴奏)",
                creator: "闫杰晨",
                durationMs: 215866,
                pageUrl: "https://music.163.com/#/song?id=1822942870",
                platformAudioUrl: "https://music.163.com/song/media/outer/url?id=1822942870.mp3",
                tags: ["netease", "instrumental", "agent-selected"],
                canOpenVideo: false
              }
            }
          ],
          session: null
        })
      );
    render(<RoomShell initialState={DEFAULT_ROOM_STATE} connectionStatus={connectionStatus} />);

    expect(await screen.findByRole("button", { name: defaultSession.title })).toBeTruthy();
    fireEvent.click(getQueuePreviewMain());
    fireEvent.change(getComposerInput(), {
      target: { value: "你今天想听什么" }
    });
    fireEvent.click(getComposerSubmit());

    expect(await within(getTimeline()).findByText("那我会选《红马 (伴奏)》。")).toBeTruthy();

    fireEvent.change(getComposerInput(), {
      target: { value: "可以" }
    });
    fireEvent.click(getComposerSubmit());

    expect(await within(getTimeline()).findByText("好，我现在放这首。")).toBeTruthy();
    expect(document.querySelector<HTMLElement>(".source-badge")?.getAttribute("data-source")).toBe("netease");
    expect(getPlatformAudio().getAttribute("src")).toBe("https://music.163.com/song/media/outer/url?id=1822942870.mp3");
    expect(within(getTimeline()).getByText("可以")).toBeTruthy();
    expect(within(getTimeline()).queryByText("已切到《红马 (伴奏)》。")).toBeNull();
    expect(apiMocks.postChat).toHaveBeenCalledTimes(2);
  });

  it("exposes compact session controls from the chat header", async () => {
    render(<RoomShell initialState={DEFAULT_ROOM_STATE} connectionStatus={connectionStatus} />);

    expect(await screen.findByRole("button", { name: defaultSession.title })).toBeTruthy();
    const panelTrigger = document.querySelector<HTMLButtonElement>(".mobile-session-trigger");
    const createButton = document.querySelector<HTMLButtonElement>(".mobile-session-create");

    expect(panelTrigger).toBeTruthy();
    expect(createButton).toBeTruthy();

    fireEvent.click(panelTrigger!);
    const mobilePanel = document.querySelector<HTMLElement>(".mobile-session-panel");

    expect(mobilePanel).toBeTruthy();
    expect(within(mobilePanel!).getByRole("button", { name: defaultSession.title })).toBeTruthy();

    fireEvent.click(createButton!);

    await waitFor(() => expect(apiMocks.createSession).toHaveBeenCalledTimes(1));
  });

  it("renames and deletes sessions from the compact session panel", async () => {
    const sessionOne = makeSession({ id: "session-1", title: "Session One", latestMessagePreview: null });
    const sessionTwo = makeSession({ id: "session-2", title: "Session Two", latestMessagePreview: null });
    apiMocks.getSessions.mockResolvedValueOnce([sessionOne, sessionTwo]);
    apiMocks.getSessionMessages.mockResolvedValue([]);

    render(<RoomShell initialState={DEFAULT_ROOM_STATE} connectionStatus={connectionStatus} />);

    expect(await screen.findByRole("button", { name: "Session One" })).toBeTruthy();
    fireEvent.click(document.querySelector<HTMLButtonElement>(".mobile-session-trigger")!);

    const panel = document.querySelector<HTMLElement>(".mobile-session-panel");
    expect(panel).toBeTruthy();

    fireEvent.click(within(panel!).getByRole("button", { name: "更多 Session Two" }));
    fireEvent.click(within(panel!).getByRole("menuitem", { name: "重命名 Session Two" }));
    const input = within(panel!).getByLabelText("会话名称");
    fireEvent.change(input, { target: { value: "Renamed Two" } });
    fireEvent.submit(input.closest("form")!);

    await waitFor(() => expect(apiMocks.renameSession).toHaveBeenCalledWith("session-2", "Renamed Two"));
    expect(within(panel!).getByRole("button", { name: "Renamed Two" })).toBeTruthy();

    fireEvent.click(within(panel!).getByRole("button", { name: "更多 Renamed Two" }));
    fireEvent.click(within(panel!).getByRole("menuitem", { name: "删除 Renamed Two" }));

    expect(within(panel!).getByText("删除这个会话？")).toBeTruthy();
    fireEvent.click(within(panel!).getByRole("button", { name: "确认删除 Renamed Two" }));

    await waitFor(() => expect(apiMocks.deleteSession).toHaveBeenCalledWith("session-2"));
  });

  it("opens model and preference controls from the top-right popover", async () => {
    render(<RoomShell initialState={DEFAULT_ROOM_STATE} connectionStatus={connectionStatus} />);

    expect(await screen.findByRole("button", { name: "默认会话" })).toBeTruthy();
    const settings = openModelPreferences();

    expect(within(settings).getByText("当前连接")).toBeTruthy();
    expect(within(settings).getByText("本地 API")).toBeTruthy();
    expect(within(settings).getByRole("group", { name: "人设强度" })).toBeTruthy();
    expect(within(settings).getByRole("button", { name: "中" })).toBeTruthy();
    expect(within(settings).getByRole("button", { name: "强" })).toBeTruthy();
    expect(within(settings).getByRole("checkbox", { name: "自动记忆" })).toBeTruthy();
    expect(within(settings).queryByLabelText("最近记住的内容")).toBeNull();
    expect(screen.getAllByText("当前连接")).toHaveLength(1);
    expect(screen.queryByText(/127\.0\.0\.1/)).toBeNull();
    expect(screen.queryByText(/聊天请求会转发到/)).toBeNull();
    expect(screen.queryByRole("button", { name: "TTS" })).toBeNull();
    expect(screen.queryByRole("button", { name: "存到日记" })).toBeNull();
    expect(screen.queryByRole("button", { name: "存为灵感" })).toBeNull();

    fireEvent.click(within(settings).getByRole("button", { name: "关闭模型设置" }));
    expect(screen.queryByRole("dialog", { name: "模型与偏好设置" })).toBeNull();
  });

  it("loads sessions and messages into the room", async () => {
    const session = makeSession({
      id: "session-1",
      title: "雨夜练习",
      latestMessagePreview: "保存过的消息"
    });
    apiMocks.getSessions.mockResolvedValueOnce([session]);
    apiMocks.getSessionMessages.mockResolvedValueOnce([
      makeStoredMessage({
        id: "message-1",
        sessionId: "session-1",
        role: "user",
        content: "保存过的消息"
      })
    ]);

    render(<RoomShell initialState={DEFAULT_ROOM_STATE} connectionStatus={connectionStatus} />);

    expect(await screen.findByRole("button", { name: "雨夜练习" })).toBeTruthy();
    const timeline = within(screen.getByLabelText("聊天时间线"));
    expect(await timeline.findByText("保存过的消息")).toBeTruthy();
    expect(apiMocks.getSessionMessages).toHaveBeenCalledWith("session-1");
    expect(apiMocks.createSession).not.toHaveBeenCalled();
  });

  it("creates a session and switches to its empty timeline", async () => {
    const createdSession = makeSession({
      id: "session-created",
      title: "新的练习",
      latestMessagePreview: null
    });
    apiMocks.getSessions.mockResolvedValueOnce([]);
    apiMocks.createSession.mockResolvedValueOnce(createdSession);
    apiMocks.getSessionMessages.mockResolvedValueOnce([]);

    render(<RoomShell initialState={DEFAULT_ROOM_STATE} connectionStatus={connectionStatus} />);

    expect(await screen.findByRole("button", { name: "新的练习" })).toBeTruthy();
    expect(apiMocks.createSession).toHaveBeenCalledTimes(1);
    expect(apiMocks.getSessionMessages).toHaveBeenCalledWith("session-created");
    const timeline = screen.getByLabelText("聊天时间线");
    expect(timeline.textContent).toContain("还没有消息");
    expect(timeline.textContent).not.toContain(getIdleLine(DEFAULT_ROOM_STATE));
  });

  it("sends chat with the active session and updates the sidebar", async () => {
    const session = makeSession({
      id: "session-1",
      title: "Session One",
      latestMessagePreview: null
    });
    const updatedSession = makeSession({
      id: "session-1",
      title: "Quiet piano",
      latestMessagePreview: "I hear it"
    });
    apiMocks.getSessions.mockResolvedValueOnce([session]);
    apiMocks.getSessionMessages.mockResolvedValueOnce([]);
    apiMocks.postChat.mockResolvedValueOnce(
      makeChatResponse({
        reply: { id: "reply-1", role: "kumiko", content: "I hear it" },
        session: updatedSession
      })
    );

    render(<RoomShell initialState={DEFAULT_ROOM_STATE} connectionStatus={connectionStatus} />);

    expect(await screen.findByRole("button", { name: "Session One" })).toBeTruthy();
    fireEvent.change(screen.getByRole("textbox", { name: "写一条消息" }), {
      target: { value: "Quiet piano" }
    });
    fireEvent.click(screen.getByRole("button", { name: "发送" }));

    const timeline = within(screen.getByLabelText("聊天时间线"));
    expect(await timeline.findByText("I hear it")).toBeTruthy();
    expect(apiMocks.postChat).toHaveBeenCalledWith(
      expect.objectContaining({
        message: "Quiet piano",
        sessionId: "session-1"
      })
    );
    const updatedSessionButton = await screen.findByRole("button", { name: "Quiet piano" });
    expect(within(updatedSessionButton).getByText("I hear it")).toBeTruthy();
  });

  it("shows a natural typing state while the reply is pending", async () => {
    const session = makeSession({
      id: "session-1",
      title: "Session One",
      latestMessagePreview: null
    });
    const pendingChat = deferred<Awaited<ReturnType<typeof apiMocks.postChat>>>();
    apiMocks.getSessions.mockResolvedValueOnce([session]);
    apiMocks.getSessionMessages.mockResolvedValueOnce([]);
    apiMocks.postChat.mockReturnValueOnce(pendingChat.promise);

    render(<RoomShell initialState={DEFAULT_ROOM_STATE} connectionStatus={connectionStatus} />);

    expect(await screen.findByRole("button", { name: "Session One" })).toBeTruthy();
    fireEvent.change(getComposerInput(), {
      target: { value: "Are you there?" }
    });
    fireEvent.click(getComposerSubmit());

    expect(await screen.findByLabelText("久美子正在输入")).toBeTruthy();
    expect(screen.getByText("正在回复")).toBeTruthy();
    expect(getComposerSubmit().textContent).toBe("发送中");

    pendingChat.resolve(
      makeChatResponse({
        reply: { id: "reply-typing", role: "kumiko", content: "嗯，我在。" },
        session
      })
    );

    expect(await within(getTimeline()).findByText("嗯，我在。")).toBeTruthy();
    expect(screen.queryByLabelText("久美子正在输入")).toBeNull();
  });

  it("scrolls the timeline to the latest optimistic message", async () => {
    const session = makeSession({
      id: "session-1",
      title: "Session One",
      latestMessagePreview: null
    });
    const pendingChat = deferred<Awaited<ReturnType<typeof apiMocks.postChat>>>();
    apiMocks.getSessions.mockResolvedValueOnce([session]);
    apiMocks.getSessionMessages.mockResolvedValueOnce([]);
    apiMocks.postChat.mockReturnValueOnce(pendingChat.promise);

    render(<RoomShell initialState={DEFAULT_ROOM_STATE} connectionStatus={connectionStatus} />);

    expect(await screen.findByRole("button", { name: "Session One" })).toBeTruthy();
    const timeline = getTimeline();
    Object.defineProperty(timeline, "scrollHeight", { configurable: true, value: 1200 });
    fireEvent.change(getComposerInput(), {
      target: { value: "Please scroll down" }
    });
    fireEvent.click(getComposerSubmit());

    await waitFor(() => expect(timeline.scrollTop).toBe(1200));
    await act(async () => {
      pendingChat.resolve(makeChatResponse({ session }));
      await pendingChat.promise;
    });
  });

  it("keeps a failed user message in place and retries it without duplication", async () => {
    const session = makeSession({
      id: "session-1",
      title: "Session One",
      latestMessagePreview: null
    });
    apiMocks.getSessions.mockResolvedValueOnce([session]);
    apiMocks.getSessionMessages.mockResolvedValueOnce([]);
    apiMocks.postChat
      .mockRejectedValueOnce(new Error("network down"))
      .mockResolvedValueOnce(
        makeChatResponse({
          reply: { id: "reply-retry", role: "kumiko", content: "这次收到了。" },
          session
        })
      );

    render(<RoomShell initialState={DEFAULT_ROOM_STATE} connectionStatus={connectionStatus} />);

    expect(await screen.findByRole("button", { name: "Session One" })).toBeTruthy();
    fireEvent.change(getComposerInput(), {
      target: { value: "Can you hear me?" }
    });
    fireEvent.click(getComposerSubmit());

    expect((await screen.findByRole("alert")).textContent).toContain("消息没送出去");
    const timeline = within(getTimeline());
    expect(timeline.getAllByText("Can you hear me?")).toHaveLength(1);
    const failedMessage = timeline.getByText("Can you hear me?").closest("article");
    expect(failedMessage?.classList.contains("message--failed")).toBe(true);

    fireEvent.click(screen.getByRole("button", { name: "重试发送" }));

    expect(await timeline.findByText("这次收到了。")).toBeTruthy();
    expect(timeline.getAllByText("Can you hear me?")).toHaveLength(1);
    expect(apiMocks.postChat).toHaveBeenCalledTimes(2);
  });

  it("keeps the composer disabled and active session unchanged while selected session messages load", async () => {
    const sessionOne = makeSession({
      id: "session-1",
      title: "Session One",
      latestMessagePreview: "Session one message"
    });
    const sessionTwo = makeSession({
      id: "session-2",
      title: "Session Two",
      latestMessagePreview: "Session two message"
    });
    const sessionTwoMessages = deferred<StoredChatMessage[]>();
    apiMocks.getSessions.mockResolvedValueOnce([sessionOne, sessionTwo]);
    apiMocks.getSessionMessages
      .mockResolvedValueOnce([
        makeStoredMessage({
          id: "message-session-1",
          sessionId: "session-1",
          role: "user",
          content: "Session one message"
        })
      ])
      .mockReturnValueOnce(sessionTwoMessages.promise);

    render(<RoomShell initialState={DEFAULT_ROOM_STATE} connectionStatus={connectionStatus} />);

    expect(await within(getTimeline()).findByText("Session one message")).toBeTruthy();
    fireEvent.change(getComposerInput(), {
      target: { value: "Do not send this stale draft" }
    });
    fireEvent.click(screen.getByRole("button", { name: "Session Two" }));

    await waitFor(() => expect(apiMocks.getSessionMessages).toHaveBeenCalledWith("session-2"));
    expect(screen.queryByText("正在加载会话...")).toBeNull();
    expect(screen.getByRole("button", { name: "Session One" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Session Two" })).toBeTruthy();
    expect(localStorage.getItem("kumikoroom.lastSessionId")).toBe("session-1");
    expect(within(getTimeline()).getByText("Session one message")).toBeTruthy();
    expect(within(getTimeline()).queryByText("Session two message")).toBeNull();
    expect(getComposerInput().disabled).toBe(true);
    expect(getComposerSubmit().disabled).toBe(true);

    fireEvent.click(getComposerSubmit());

    expect(apiMocks.postChat).not.toHaveBeenCalled();

    sessionTwoMessages.resolve([
      makeStoredMessage({
        id: "message-session-2",
        sessionId: "session-2",
        role: "kumiko",
        content: "Session two message"
      })
    ]);

    expect(await within(getTimeline()).findByText("Session two message")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Session Two" }).getAttribute("aria-current")).toBe(
      "true"
    );
  });

  it("blocks sidebar session actions while a chat response is pending", async () => {
    const sessionOne = makeSession({
      id: "session-1",
      title: "Session One",
      latestMessagePreview: null
    });
    const sessionTwo = makeSession({
      id: "session-2",
      title: "Session Two",
      latestMessagePreview: null
    });
    const pendingChat = deferred<Awaited<ReturnType<typeof apiMocks.postChat>>>();
    apiMocks.getSessions.mockResolvedValueOnce([sessionOne, sessionTwo]);
    apiMocks.getSessionMessages.mockResolvedValueOnce([]);
    apiMocks.postChat.mockReturnValueOnce(pendingChat.promise);

    render(<RoomShell initialState={DEFAULT_ROOM_STATE} connectionStatus={connectionStatus} />);

    expect(await screen.findByRole("button", { name: "Session One" })).toBeTruthy();
    fireEvent.change(getComposerInput(), {
      target: { value: "Please stay in this session" }
    });
    fireEvent.click(getComposerSubmit());

    await waitFor(() => expect(apiMocks.postChat).toHaveBeenCalledTimes(1));
    expect(screen.queryByText("正在加载会话...")).toBeNull();
    expect(screen.getByRole("button", { name: "Session One" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Session Two" })).toBeTruthy();
    fireEvent.click(getCreateSessionButton());
    screen.queryByRole("button", { name: "Session Two" })?.click();
    queryDeleteButtonFor("Session One")?.click();

    expect(apiMocks.createSession).not.toHaveBeenCalled();
    expect(apiMocks.deleteSession).not.toHaveBeenCalled();
    expect(apiMocks.getSessionMessages).toHaveBeenCalledTimes(1);

    pendingChat.resolve(
      makeChatResponse({
        reply: { id: "reply-session-1", role: "kumiko", content: "Still here" },
        session: makeSession({
          id: "session-1",
          title: "Session One",
          latestMessagePreview: "Still here"
        })
      })
    );

    expect(await within(getTimeline()).findByText("Still here")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Session One" }).getAttribute("aria-current")).toBe(
      "true"
    );
  });

  it("uses sparse timeline alignment for one-speaker short messages", async () => {
    const session = makeSession({
      id: "session-1",
      title: "Short note",
      latestMessagePreview: "你好"
    });
    apiMocks.getSessions.mockResolvedValueOnce([session]);
    apiMocks.getSessionMessages.mockResolvedValueOnce([
      makeStoredMessage({
        id: "message-short",
        sessionId: "session-1",
        role: "user",
        content: "你好"
      })
    ]);

    render(<RoomShell initialState={DEFAULT_ROOM_STATE} connectionStatus={connectionStatus} />);

    expect(await screen.findByRole("button", { name: "Short note" })).toBeTruthy();
    const timeline = getTimeline();
    expect(timeline.classList.contains("chat-timeline--sparse")).toBe(true);
    const shortMessage = within(timeline).getByText("你好").closest("article");
    expect(shortMessage?.classList.contains("message--short")).toBe(true);
    expect(shortMessage?.classList.contains("me")).toBe(true);
    expect(shortMessage?.querySelector(".avatar.small.user-avatar")).toBeTruthy();
  });

  it("restores the last session while keeping the v6 sidebar expanded", async () => {
    localStorage.setItem("kumikoroom.lastSessionId", "session-2");
    localStorage.setItem("kumikoroom.sessionsCollapsed", "true");
    apiMocks.getSessions.mockResolvedValueOnce([
      makeSession({ id: "session-1", title: "Session One", latestMessagePreview: null }),
      makeSession({ id: "session-2", title: "Session Two", latestMessagePreview: "Saved two" })
    ]);
    apiMocks.getSessionMessages.mockResolvedValueOnce([
      makeStoredMessage({
        id: "message-2",
        sessionId: "session-2",
        role: "kumiko",
        content: "Saved two"
      })
    ]);

    render(<RoomShell initialState={DEFAULT_ROOM_STATE} connectionStatus={connectionStatus} />);

    expect(await within(getTimeline()).findByText("Saved two")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Session Two" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "展开会话列表" })).toBeNull();
    expect(apiMocks.getSessionMessages).toHaveBeenCalledWith("session-2");
    expect(localStorage.getItem("kumikoroom.lastSessionId")).toBe("session-2");
    expect(localStorage.getItem("kumikoroom.sessionsCollapsed")).toBe("true");
  });

  it("creates a new session from the compact sidebar tool", async () => {
    const sessionOne = makeSession({ id: "session-1", title: "Session One", latestMessagePreview: null });
    const sessionTwo = makeSession({ id: "session-2", title: "Session Two", latestMessagePreview: null });
    const createdSession = makeSession({ id: "session-3", title: "New Session", latestMessagePreview: null });
    apiMocks.getSessions.mockResolvedValueOnce([sessionOne, sessionTwo]);
    apiMocks.createSession.mockResolvedValueOnce(createdSession);
    apiMocks.getSessionMessages.mockResolvedValue([]);

    render(<RoomShell initialState={DEFAULT_ROOM_STATE} connectionStatus={connectionStatus} />);

    expect(await screen.findByRole("button", { name: "Session One" })).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "新建会话" }));
    await waitFor(() => expect(apiMocks.createSession).toHaveBeenCalledTimes(1));
    expect(await screen.findByRole("button", { name: "New Session" })).toBeTruthy();
    expect(apiMocks.getSessionMessages).toHaveBeenCalledWith("session-3");
    expect(screen.queryByRole("button", { name: "重命名 New Session" })).toBeNull();
    expect(screen.queryByRole("button", { name: "删除 New Session" })).toBeNull();
  });

  it("sends exact visible conversation history through the room API", async () => {
    apiMocks.postChat.mockResolvedValueOnce({
      reply: { id: "api-reply-1", role: "kumiko", content: "嗯，我在听。" },
      expression: "thinking",
      suggestedActions: ["save_diary"],
      providerStatus: {
        provider: "deepseek",
        model: "deepseek-v4-flash",
        configured: true,
        label: "DeepSeek deepseek-v4-flash"
      },
      memoryEvents: [
        {
          id: "memory-1",
          category: "preference",
          text: "用户喜欢安静的钢琴。",
          confidence: 0.92,
          createdAt: "2026-06-08T08:00:00.000Z"
        }
      ],
      session: null
    });
    apiMocks.postChat.mockResolvedValueOnce({
      reply: { id: "api-reply-2", role: "kumiko", content: "我们继续慢慢听。" },
      expression: "listening",
      suggestedActions: [],
      providerStatus: {
        provider: "deepseek",
        model: "deepseek-v4-flash",
        configured: true,
        label: "DeepSeek deepseek-v4-flash"
      },
      memoryEvents: [],
      session: null
    });

    render(<RoomShell initialState={DEFAULT_ROOM_STATE} connectionStatus={connectionStatus} />);

    expect(await screen.findByRole("button", { name: "默认会话" })).toBeTruthy();
    const settings = openModelPreferences();
    fireEvent.click(within(settings).getByRole("button", { name: "强" }));
    fireEvent.click(within(settings).getByRole("checkbox", { name: "自动记忆" }));
    fireEvent.change(screen.getByRole("textbox", { name: "写一条消息" }), {
      target: { value: "晚上好" }
    });
    fireEvent.click(screen.getByRole("button", { name: "发送" }));

    expect(await screen.findByText("嗯，我在听。")).toBeTruthy();
    expect(screen.getByRole("status", { name: "DeepSeek deepseek-v4-flash" })).toBeTruthy();
    expect(screen.queryByLabelText("最近记住的内容")).toBeNull();
    expect(screen.queryByText("用户喜欢安静的钢琴。")).toBeNull();
    expect(screen.queryByText("思考")).toBeNull();
    const currentRoomState = {
      ...DEFAULT_ROOM_STATE,
      music: {
        currentTrackTitle: PLAYER_TRACKS[0].title,
        currentArtist: PLAYER_TRACKS[0].creator,
        listeningMood: "playing"
      }
    };

    expect(apiMocks.postChat).toHaveBeenNthCalledWith(1, {
      message: "晚上好",
      roomState: currentRoomState,
      listeningContext: buildListeningContext(PLAYER_TRACKS[0], true),
      musicState: expect.objectContaining({
        isPlaying: true,
        currentTimeMs: 0,
        durationMs: PLAYER_TRACKS[0].durationMs,
        current: expect.objectContaining({
          id: PLAYER_TRACKS[0].id,
          title: PLAYER_TRACKS[0].title,
          saved: false
        }),
        next: expect.objectContaining({
          id: PLAYER_TRACKS[1].id
        }),
        upcoming: [
          expect.objectContaining({
            id: PLAYER_TRACKS[1].id
          })
        ],
        recent: [],
        saved: []
      }),
      recentMessages: [],
      personaStrength: "strong",
      memoryEnabled: false,
      sessionId: "session-default"
    });

    fireEvent.change(screen.getByRole("textbox", { name: "写一条消息" }), {
      target: { value: "想继续聊这首" }
    });
    fireEvent.click(screen.getByRole("button", { name: "发送" }));

    expect(await screen.findByText("我们继续慢慢听。")).toBeTruthy();
    expect(apiMocks.postChat).toHaveBeenNthCalledWith(2, {
      message: "想继续聊这首",
      roomState: currentRoomState,
      listeningContext: buildListeningContext(PLAYER_TRACKS[0], true),
      musicState: expect.objectContaining({
        isPlaying: true,
        current: expect.objectContaining({
          id: PLAYER_TRACKS[0].id
        }),
        next: expect.objectContaining({
          id: PLAYER_TRACKS[1].id
        }),
        upcoming: [
          expect.objectContaining({
            id: PLAYER_TRACKS[1].id
          })
        ]
      }),
      recentMessages: [
        {
          id: expect.stringMatching(/^user-\d+$/),
          role: "user",
          content: "晚上好"
        },
        {
          id: "api-reply-1",
          role: "kumiko",
          content: "嗯，我在听。"
        }
      ],
      personaStrength: "strong",
      memoryEnabled: false,
      sessionId: "session-default"
    });
  });

  it("sends a non-empty draft when Enter is pressed in the composer", async () => {
    render(<RoomShell initialState={DEFAULT_ROOM_STATE} connectionStatus={connectionStatus} />);

    expect(await screen.findByRole("button", { name: "默认会话" })).toBeTruthy();
    const input = getComposerInput();
    fireEvent.change(input, { target: { value: "晚上好" } });
    fireEvent.keyDown(input, { key: "Enter", code: "Enter" });

    expect(await screen.findByText("收到。")).toBeTruthy();
    expect(apiMocks.postChat).toHaveBeenCalledWith(
      expect.objectContaining({
        message: "晚上好",
        sessionId: "session-default"
      })
    );
  });

  it("keeps Shift+Enter available for multiline drafts", async () => {
    render(<RoomShell initialState={DEFAULT_ROOM_STATE} connectionStatus={connectionStatus} />);

    expect(await screen.findByRole("button", { name: "默认会话" })).toBeTruthy();
    const input = getComposerInput();
    fireEvent.change(input, { target: { value: "第一行" } });
    fireEvent.keyDown(input, { key: "Enter", code: "Enter", shiftKey: true });
    fireEvent.change(input, { target: { value: "第一行\n第二行" } });

    expect(apiMocks.postChat).not.toHaveBeenCalled();
    expect(input.value).toBe("第一行\n第二行");
  });

  it("does not send while the IME composition Enter key is active", async () => {
    render(<RoomShell initialState={DEFAULT_ROOM_STATE} connectionStatus={connectionStatus} />);

    expect(await screen.findByRole("button", { name: "默认会话" })).toBeTruthy();
    const input = getComposerInput();
    fireEvent.change(input, { target: { value: "kumiko" } });
    fireEvent.keyDown(input, { key: "Enter", code: "Enter", isComposing: true });

    expect(apiMocks.postChat).not.toHaveBeenCalled();
    expect(input.value).toBe("kumiko");
  });

  it("does not send when IME Enter reports keyCode 229", async () => {
    render(<RoomShell initialState={DEFAULT_ROOM_STATE} connectionStatus={connectionStatus} />);

    expect(await screen.findByRole("button", { name: defaultSession.title })).toBeTruthy();
    const input = getComposerInput();
    fireEvent.change(input, { target: { value: "kumiko" } });
    fireEvent.keyDown(input, { key: "Enter", code: "Enter", keyCode: 229 });

    expect(apiMocks.postChat).not.toHaveBeenCalled();
    expect(input.value).toBe("kumiko");
  });

  it("does not send from the keyboard while the composer is disabled", async () => {
    const pendingSession = deferred<ChatSession>();
    apiMocks.getSessions.mockResolvedValueOnce([]);
    apiMocks.createSession.mockReturnValueOnce(pendingSession.promise);

    render(<RoomShell initialState={DEFAULT_ROOM_STATE} connectionStatus={connectionStatus} />);

    const input = getComposerInput();
    expect(input.disabled).toBe(true);
    fireEvent.keyDown(input, { key: "Enter", code: "Enter" });

    expect(apiMocks.postChat).not.toHaveBeenCalled();
    pendingSession.resolve(defaultCreatedSession);
    expect(await screen.findByRole("button", { name: "新会话" })).toBeTruthy();
  });

  it("restores and persists AI control choices", async () => {
    localStorage.setItem("kumikoroom.personaStrength", "strong");
    localStorage.setItem("kumikoroom.memoryEnabled", "false");

    render(
      <React.StrictMode>
        <RoomShell initialState={DEFAULT_ROOM_STATE} connectionStatus={connectionStatus} />
      </React.StrictMode>
    );

    expect(await screen.findByRole("button", { name: "默认会话" })).toBeTruthy();
    await waitFor(() => expect(apiMocks.getSessions).toHaveBeenCalledTimes(1));
    expect(apiMocks.getSessionMessages).toHaveBeenCalledTimes(1);
    expect(apiMocks.createSession).not.toHaveBeenCalled();
    const settings = openModelPreferences();
    const mediumButton = within(settings).getByRole("button", { name: "中" });
    const strongButton = within(settings).getByRole("button", { name: "强" });
    const memoryCheckbox = within(settings).getByRole("checkbox", {
      name: "自动记忆"
    }) as HTMLInputElement;

    expect(localStorage.getItem("kumikoroom.personaStrength")).toBe("strong");
    expect(localStorage.getItem("kumikoroom.memoryEnabled")).toBe("false");
    expect(mediumButton.getAttribute("aria-pressed")).toBe("false");
    expect(strongButton.getAttribute("aria-pressed")).toBe("true");
    expect(memoryCheckbox.checked).toBe(false);

    fireEvent.click(mediumButton);
    fireEvent.click(memoryCheckbox);

    expect(localStorage.getItem("kumikoroom.personaStrength")).toBe("medium");
    expect(localStorage.getItem("kumikoroom.memoryEnabled")).toBe("true");
  });

  it("ignores unsupported stored persona strengths", async () => {
    localStorage.setItem("kumikoroom.personaStrength", "weak");

    render(<RoomShell initialState={DEFAULT_ROOM_STATE} connectionStatus={connectionStatus} />);

    expect(await screen.findByRole("button", { name: "默认会话" })).toBeTruthy();
    const settings = openModelPreferences();
    expect(within(settings).getByRole("button", { name: "中" }).getAttribute("aria-pressed")).toBe("true");
    expect(within(settings).getByRole("button", { name: "强" }).getAttribute("aria-pressed")).toBe("false");
  });
});

function makeSession(overrides: Partial<ChatSession> = {}): ChatSession {
  return {
    id: "session-1",
    title: "Session",
    latestMessagePreview: null,
    createdAt: "2026-06-10T08:00:00.000Z",
    updatedAt: "2026-06-10T08:00:00.000Z",
    ...overrides
  };
}

function makeStoredMessage(overrides: Partial<StoredChatMessage> = {}): StoredChatMessage {
  return {
    id: "message-1",
    sessionId: "session-1",
    role: "user",
    content: "Stored message",
    createdAt: "2026-06-10T08:00:00.000Z",
    provider: null,
    providerModel: null,
    providerConfigured: null,
    providerLabel: null,
    ...overrides
  };
}

function makeChatResponse(overrides: Partial<Awaited<ReturnType<typeof apiMocks.postChat>>> = {}) {
  return {
    reply: { id: "reply-default", role: "kumiko" as const, content: "收到。" },
    expression: "listening" as const,
    suggestedActions: [],
    providerStatus: {
      provider: "mock" as const,
      model: null,
      configured: true,
      label: "Mock"
    },
    memoryEvents: [],
    session: null,
    clientActions: [],
    agentTrace: { toolCalls: [] },
    ...overrides
  };
}

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((promiseResolve, promiseReject) => {
    resolve = promiseResolve;
    reject = promiseReject;
  });

  return { promise, resolve, reject };
}

function openModelPreferences(): HTMLElement {
  fireEvent.click(screen.getByRole("button", { name: "模型与偏好" }));
  return screen.getByRole("dialog", { name: "模型与偏好设置" });
}

function getComposerInput(): HTMLTextAreaElement {
  const input = document.querySelector<HTMLTextAreaElement>("#workspace-message");
  if (!input) {
    throw new Error("Composer input not found");
  }

  return input;
}

function getComposerSubmit(): HTMLButtonElement {
  const button = document.querySelector<HTMLButtonElement>(
    ".composer-actions button[type='submit']"
  );
  if (!button) {
    throw new Error("Composer submit button not found");
  }

  return button;
}

function getCreateSessionButton(): HTMLButtonElement {
  const button = document.querySelector<HTMLButtonElement>(".session-sidebar__create");
  if (!button) {
    throw new Error("Create session button not found");
  }

  return button;
}

function getTimeline(): HTMLElement {
  const timeline = document.querySelector<HTMLElement>(".chat-timeline");
  if (!timeline) {
    throw new Error("Chat timeline not found");
  }

  return timeline;
}

function getPlayerControls(): HTMLElement {
  const controls = document.querySelector<HTMLElement>(".player-controls");
  if (!controls) {
    throw new Error("Player controls not found");
  }

  return controls;
}

function getQueuePreviewMain(): HTMLButtonElement {
  const button = document.querySelector<HTMLButtonElement>(".queue-preview-main");
  if (!button) {
    throw new Error("Queue preview button not found");
  }

  return button;
}

function getQueueManageButton(): HTMLButtonElement {
  const button = document.querySelector<HTMLButtonElement>(".queue-manage");
  if (!button) {
    throw new Error("Queue manage button not found");
  }

  return button;
}

function getMusicQueuePanel(): HTMLElement {
  const panel = document.querySelector<HTMLElement>(".music-queue-panel");
  if (!panel) {
    throw new Error("Music queue panel not found");
  }

  return panel;
}

function getPlatformAudio(): HTMLAudioElement {
  const audio = document.querySelector<HTMLAudioElement>("audio.platform-audio-host");
  if (!audio) {
    throw new Error("Platform audio host not found");
  }

  return audio;
}

function queryDeleteButtonFor(title: string): HTMLButtonElement | null {
  return (
    Array.from(document.querySelectorAll<HTMLButtonElement>(".session-sidebar__actions button")).find(
      (button) => button.getAttribute("aria-label")?.endsWith(title) && button.textContent === "×"
    ) ?? null
  );
}

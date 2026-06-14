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
  postChat: vi.fn()
}));

vi.mock("../src/api/client", () => ({
  createSession: apiMocks.createSession,
  deleteSession: apiMocks.deleteSession,
  getSessionMessages: apiMocks.getSessionMessages,
  getSessions: apiMocks.getSessions,
  renameSession: apiMocks.renameSession,
  postChat: apiMocks.postChat
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
    expect(screen.getByRole("button", { name: PLAYER_TRACKS[0].title })).toBeTruthy();
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

    audio.currentTime = PLAYER_TRACKS[0].durationMs / 1000;
    fireEvent.ended(audio);
    expect(screen.getByRole("button", { name: "播放" })).toBeTruthy();
  });

  it("opens and closes the Bilibili mini-window from the music player", async () => {
    render(<RoomShell initialState={DEFAULT_ROOM_STATE} connectionStatus={connectionStatus} />);

    expect(await screen.findByRole("button", { name: defaultSession.title })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: PLAYER_TRACKS[1].title }));
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
    fireEvent.click(screen.getByRole("button", { name: bilibiliTrack.title }));
    fireEvent.change(getComposerInput(), {
      target: { value: "这首现在是什么感觉？" }
    });
    fireEvent.click(getComposerSubmit());

    await waitFor(() => expect(apiMocks.postChat).toHaveBeenCalledTimes(1));
    expect(apiMocks.postChat).toHaveBeenCalledWith(
      expect.objectContaining({
        listeningContext: buildListeningContext(bilibiliTrack, true)
      })
    );
  });

  it("uses room agent intent to open the Bilibili mini-window from chat", async () => {
    const bilibiliTrack = PLAYER_TRACKS.find((track) => track.id === "bilibili-blue-bird-rehearsal");
    if (!bilibiliTrack) {
      throw new Error("Bilibili player track not found");
    }
    render(<RoomShell initialState={DEFAULT_ROOM_STATE} connectionStatus={connectionStatus} />);

    expect(await screen.findByRole("button", { name: defaultSession.title })).toBeTruthy();
    fireEvent.change(getComposerInput(), {
      target: { value: "打开 B站 视频小窗" }
    });
    fireEvent.click(getComposerSubmit());

    expect(await screen.findByRole("dialog", { name: "B站视频小窗" })).toBeTruthy();
    expect(document.querySelector<HTMLElement>(".source-badge")?.getAttribute("data-source")).toBe("bilibili");
    await waitFor(() => expect(apiMocks.postChat).toHaveBeenCalledTimes(1));
    expect(apiMocks.postChat).toHaveBeenCalledWith(
      expect.objectContaining({
        listeningContext: buildListeningContext(bilibiliTrack, true)
      })
    );
  });

  it("uses room agent intent to play the Netease platform track from chat", async () => {
    const neteaseTrack = PLAYER_TRACKS.find((track) => track.id === "netease-red-horse-instrumental");
    if (!neteaseTrack) {
      throw new Error("Netease player track not found");
    }
    render(<RoomShell initialState={DEFAULT_ROOM_STATE} connectionStatus={connectionStatus} />);

    expect(await screen.findByRole("button", { name: defaultSession.title })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: PLAYER_TRACKS[1].title }));
    fireEvent.change(getComposerInput(), {
      target: { value: "播放 红马 (伴奏)" }
    });
    fireEvent.click(getComposerSubmit());

    expect(document.querySelector<HTMLElement>(".source-badge")?.getAttribute("data-source")).toBe("netease");
    expect(getPlatformAudio().getAttribute("src")).toBe(neteaseTrack.platformAudioUrl);
    await waitFor(() => expect(apiMocks.postChat).toHaveBeenCalledTimes(1));
    expect(apiMocks.postChat).toHaveBeenCalledWith(
      expect.objectContaining({
        listeningContext: buildListeningContext(neteaseTrack, true)
      })
    );
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
    expect(apiMocks.postChat).toHaveBeenNthCalledWith(1, {
      message: "晚上好",
      roomState: DEFAULT_ROOM_STATE,
      listeningContext: buildListeningContext(PLAYER_TRACKS[0], true),
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
      roomState: DEFAULT_ROOM_STATE,
      listeningContext: buildListeningContext(PLAYER_TRACKS[0], true),
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

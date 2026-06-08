import { fireEvent, render, screen, within } from "@testing-library/react";
import React from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { RoomShell } from "../src/components/RoomShell";
import { getConnectionStatus } from "../src/lib/connectionStatus";
import { DEFAULT_ROOM_STATE, getIdleLine } from "../src/lib/roomState";

const apiMocks = vi.hoisted(() => ({
  postChat: vi.fn()
}));

vi.mock("../src/api/client", () => ({
  postChat: apiMocks.postChat
}));

const connectionStatus = getConnectionStatus("http://127.0.0.1:8000");

describe("RoomShell", () => {
  beforeEach(() => {
    apiMocks.postChat.mockReset();
    localStorage.clear();
  });

  it("renders a chat-first workspace without the character placeholder", () => {
    render(<RoomShell initialState={DEFAULT_ROOM_STATE} connectionStatus={connectionStatus} />);

    expect(screen.getByRole("heading", { name: "和久美子说会儿话" })).toBeTruthy();
    expect(screen.getByLabelText("聊天时间线").textContent).toContain("今天想从哪首歌开始聊");
    expect(screen.getByRole("textbox", { name: "写一条消息" })).toBeTruthy();
    expect(screen.getByRole("link", { name: "打开创作资料" }).getAttribute("href")).toBe("/studio");
    expect(screen.queryByLabelText("久美子立绘占位")).toBeNull();
    expect(screen.queryByText("陪伴房间")).toBeNull();
  });

  it("shows local music and connection status as calm utility panels", () => {
    render(<RoomShell initialState={DEFAULT_ROOM_STATE} connectionStatus={connectionStatus} />);

    const localMusicCard = screen.getByLabelText("本地音乐状态");
    const aiCard = screen.getByLabelText("AI 设置");

    expect(screen.getByLabelText("今日摘要")).toBeTruthy();
    expect(localMusicCard).toBeTruthy();
    expect(aiCard).toBeTruthy();
    expect(screen.getByRole("button", { name: "中" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "强" })).toBeTruthy();
    expect(screen.getByRole("checkbox", { name: "自动记忆" })).toBeTruthy();
    expect(within(localMusicCard).queryByText("模型连接")).toBeNull();
    expect(within(localMusicCard).queryByText("本地 API")).toBeNull();
    expect(within(aiCard).getByText("本地 API")).toBeTruthy();
    expect(screen.getAllByText("当前连接")).toHaveLength(1);
    expect(screen.queryByText(/127\.0\.0\.1/)).toBeNull();
    expect(screen.queryByText(/聊天请求会转发到/)).toBeNull();
    expect(screen.queryByRole("button", { name: "TTS" })).toBeNull();
    expect(screen.queryByRole("button", { name: "存到日记" })).toBeNull();
    expect(screen.queryByRole("button", { name: "存为灵感" })).toBeNull();
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
      ]
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
      memoryEvents: []
    });

    render(<RoomShell initialState={DEFAULT_ROOM_STATE} connectionStatus={connectionStatus} />);

    fireEvent.click(screen.getByRole("button", { name: "强" }));
    fireEvent.click(screen.getByRole("checkbox", { name: "自动记忆" }));
    fireEvent.change(screen.getByRole("textbox", { name: "写一条消息" }), {
      target: { value: "晚上好" }
    });
    fireEvent.click(screen.getByRole("button", { name: "发送" }));

    expect(await screen.findByText("嗯，我在听。")).toBeTruthy();
    expect(screen.getByRole("status", { name: "DeepSeek deepseek-v4-flash" })).toBeTruthy();
    expect(screen.getAllByText("DeepSeek deepseek-v4-flash")).toHaveLength(2);
    expect(screen.getByText("用户喜欢安静的钢琴。")).toBeTruthy();
    expect(screen.getByText("思考")).toBeTruthy();
    expect(apiMocks.postChat).toHaveBeenNthCalledWith(1, {
      message: "晚上好",
      roomState: DEFAULT_ROOM_STATE,
      recentMessages: [
        {
          id: "idle-line",
          role: "kumiko",
          content: getIdleLine(DEFAULT_ROOM_STATE)
        }
      ],
      personaStrength: "strong",
      memoryEnabled: false
    });

    fireEvent.change(screen.getByRole("textbox", { name: "写一条消息" }), {
      target: { value: "想继续聊这首" }
    });
    fireEvent.click(screen.getByRole("button", { name: "发送" }));

    expect(await screen.findByText("我们继续慢慢听。")).toBeTruthy();
    expect(apiMocks.postChat).toHaveBeenNthCalledWith(2, {
      message: "想继续聊这首",
      roomState: DEFAULT_ROOM_STATE,
      recentMessages: [
        {
          id: "idle-line",
          role: "kumiko",
          content: getIdleLine(DEFAULT_ROOM_STATE)
        },
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
      memoryEnabled: false
    });
  });

  it("restores and persists AI control choices", () => {
    localStorage.setItem("kumikoroom.personaStrength", "strong");
    localStorage.setItem("kumikoroom.memoryEnabled", "false");

    render(
      <React.StrictMode>
        <RoomShell initialState={DEFAULT_ROOM_STATE} connectionStatus={connectionStatus} />
      </React.StrictMode>
    );

    const mediumButton = screen.getByRole("button", { name: "中" });
    const strongButton = screen.getByRole("button", { name: "强" });
    const memoryCheckbox = screen.getByRole("checkbox", { name: "自动记忆" }) as HTMLInputElement;

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

  it("ignores unsupported stored persona strengths", () => {
    localStorage.setItem("kumikoroom.personaStrength", "weak");

    render(<RoomShell initialState={DEFAULT_ROOM_STATE} connectionStatus={connectionStatus} />);

    expect(screen.getByRole("button", { name: "中" }).getAttribute("aria-pressed")).toBe("true");
    expect(screen.getByRole("button", { name: "强" }).getAttribute("aria-pressed")).toBe("false");
  });
});

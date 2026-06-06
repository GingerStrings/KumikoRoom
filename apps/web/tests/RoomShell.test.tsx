import { fireEvent, render, screen } from "@testing-library/react";
import React from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { RoomShell } from "../src/components/RoomShell";
import { getConnectionStatus } from "../src/lib/connectionStatus";
import { DEFAULT_ROOM_STATE } from "../src/lib/roomState";

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
  });

  it("renders a chat-first workspace without the character placeholder", () => {
    render(<RoomShell initialState={DEFAULT_ROOM_STATE} connectionStatus={connectionStatus} />);

    expect(screen.getByRole("heading", { name: "对话工作区" })).toBeTruthy();
    expect(screen.getByLabelText("聊天时间线").textContent).toContain("今天想从哪首歌开始聊");
    expect(screen.getByRole("textbox", { name: "写一条消息" })).toBeTruthy();
    expect(screen.getByRole("link", { name: "打开创作资料" }).getAttribute("href")).toBe("/studio");
    expect(screen.queryByLabelText("久美子立绘占位")).toBeNull();
    expect(screen.queryByText("陪伴房间")).toBeNull();
  });

  it("shows local music and connection status as calm utility panels", () => {
    render(<RoomShell initialState={DEFAULT_ROOM_STATE} connectionStatus={connectionStatus} />);

    expect(screen.getByLabelText("今日摘要")).toBeTruthy();
    expect(screen.getByLabelText("本地音乐状态")).toBeTruthy();
    expect(screen.getByText("本地 Mock API")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "TTS" })).toBeNull();
    expect(screen.queryByRole("button", { name: "存到日记" })).toBeNull();
    expect(screen.queryByRole("button", { name: "存为灵感" })).toBeNull();
  });

  it("sends a message through the room API", async () => {
    apiMocks.postChat.mockResolvedValue({
      reply: { id: "api-reply", role: "kumiko", content: "嗯，我在听。" },
      expression: "thinking",
      suggestedActions: ["save_diary"]
    });

    render(<RoomShell initialState={DEFAULT_ROOM_STATE} connectionStatus={connectionStatus} />);

    fireEvent.change(screen.getByRole("textbox", { name: "写一条消息" }), {
      target: { value: "晚上好" }
    });
    fireEvent.click(screen.getByRole("button", { name: "发送" }));

    expect(await screen.findByText("嗯，我在听。")).toBeTruthy();
    expect(screen.getByText("思考")).toBeTruthy();
    expect(apiMocks.postChat).toHaveBeenCalledWith({
      message: "晚上好",
      roomState: DEFAULT_ROOM_STATE
    });
  });
});

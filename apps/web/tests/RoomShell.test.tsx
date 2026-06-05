import { fireEvent, render, screen } from "@testing-library/react";
import React from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { RoomShell } from "../src/components/RoomShell";
import { DEFAULT_ROOM_STATE } from "../src/lib/roomState";

const apiMocks = vi.hoisted(() => ({
  postChat: vi.fn()
}));

vi.mock("../src/api/client", () => ({
  postChat: apiMocks.postChat
}));

describe("RoomShell", () => {
  beforeEach(() => {
    apiMocks.postChat.mockReset();
  });

  it("renders KumikoRoom as a chat-first companion room", () => {
    render(<RoomShell initialState={DEFAULT_ROOM_STATE} />);

    expect(screen.getByRole("heading", { name: "KumikoRoom" })).toBeTruthy();
    expect(screen.getByLabelText("久美子状态").textContent).toContain("黄前久美子");
    expect(screen.getByLabelText("聊天时间线").textContent).toContain("今天想从哪首歌开始聊");
    expect(screen.getByRole("textbox", { name: "给久美子发消息" })).toBeTruthy();
    expect(screen.getByRole("link", { name: "打开创作资料室" }).getAttribute("href")).toBe("/studio");
  });

  it("sends a message through the room API", async () => {
    apiMocks.postChat.mockResolvedValue({
      reply: { id: "api-reply", role: "kumiko", content: "嗯，我在听。" },
      expression: "listening",
      suggestedActions: ["save_diary"]
    });

    render(<RoomShell initialState={DEFAULT_ROOM_STATE} />);

    fireEvent.change(screen.getByRole("textbox", { name: "给久美子发消息" }), {
      target: { value: "晚上好" }
    });
    fireEvent.click(screen.getByRole("button", { name: "发送" }));

    expect(await screen.findByText("嗯，我在听。")).toBeTruthy();
    expect(apiMocks.postChat).toHaveBeenCalledWith({
      message: "晚上好",
      roomState: DEFAULT_ROOM_STATE
    });
  });
});

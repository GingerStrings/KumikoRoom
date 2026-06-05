import { render, screen } from "@testing-library/react";
import React from "react";
import { describe, expect, it } from "vitest";
import { RoomShell } from "../src/components/RoomShell";
import { DEFAULT_ROOM_STATE } from "../src/lib/roomState";

describe("RoomShell", () => {
  it("renders KumikoRoom as a chat-first companion room", () => {
    render(<RoomShell initialState={DEFAULT_ROOM_STATE} />);

    expect(screen.getByRole("heading", { name: "KumikoRoom" })).toBeTruthy();
    expect(screen.getByLabelText("久美子状态").textContent).toContain("黄前久美子");
    expect(screen.getByLabelText("聊天时间线").textContent).toContain("今天想从哪首歌开始聊");
    expect(screen.getByRole("textbox", { name: "给久美子发消息" })).toBeTruthy();
    expect(screen.getByRole("link", { name: "打开创作资料室" }).getAttribute("href")).toBe("/studio");
  });
});

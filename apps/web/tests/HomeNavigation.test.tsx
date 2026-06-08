import { render, screen } from "@testing-library/react";
import React from "react";
import { describe, expect, it } from "vitest";
import { HomeNavigation } from "../src/components/HomeNavigation";
import { getConnectionStatus } from "../src/lib/connectionStatus";

describe("HomeNavigation", () => {
  it("renders KumikoRoom as a navigation entry page", () => {
    render(<HomeNavigation connectionStatus={getConnectionStatus("http://127.0.0.1:8000")} />);

    expect(screen.getByRole("heading", { name: "KumikoRoom" })).toBeTruthy();
    expect(screen.getByText("今天从哪里开始？")).toBeTruthy();
    expect(screen.getByRole("link", { name: "对话 打开对话工作区" }).getAttribute("href")).toBe("/room");
    expect(screen.getByRole("link", { name: "音乐日记 记录今天听到的东西" }).getAttribute("href")).toBe("/room");
    expect(screen.getByRole("link", { name: "创作资料 打开工程和灵感" }).getAttribute("href")).toBe("/studio");
    expect(screen.getByRole("link", { name: "本地工程 查看待接入状态" }).getAttribute("href")).toBe("/studio");
    expect(screen.getByText("本地 API")).toBeTruthy();
    expect(screen.getByText("本地服务已连接。")).toBeTruthy();
    expect(screen.queryByText(/127\.0\.0\.1/)).toBeNull();
  });

  it("keeps the first screen free of character placeholders", () => {
    render(<HomeNavigation connectionStatus={getConnectionStatus("http://127.0.0.1:8000")} />);

    expect(screen.queryByText("立绘")).toBeNull();
    expect(screen.queryByText("陪伴房间")).toBeNull();
  });
});

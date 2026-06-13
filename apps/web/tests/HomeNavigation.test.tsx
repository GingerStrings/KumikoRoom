import { render, screen } from "@testing-library/react";
import React from "react";
import { describe, expect, it } from "vitest";
import { HomeNavigation } from "../src/components/HomeNavigation";
import { getConnectionStatus } from "../src/lib/connectionStatus";

describe("HomeNavigation", () => {
  it("renders KumikoRoom as an illustrated chat lobby", () => {
    render(<HomeNavigation connectionStatus={getConnectionStatus("http://127.0.0.1:8000")} />);

    expect(screen.getByRole("heading", { name: "KumikoRoom" })).toBeTruthy();
    expect(screen.getByText("窗外还在下小雨，谱架留在原来的位置。")).toBeTruthy();
    expect(screen.getByRole("link", { name: "开始聊天" }).getAttribute("href")).toBe("/room");
    expect(screen.getByRole("link", { name: "资料室" }).getAttribute("href")).toBe("/studio");
    expect(screen.getByText("本地 API")).toBeTruthy();
    expect(screen.getByText("本地服务已连接。")).toBeTruthy();
    expect(screen.queryByText("音乐日记")).toBeNull();
    expect(screen.queryByText("本地工程")).toBeNull();
    expect(document.querySelector(".home-lobby")).toBeTruthy();
    expect(document.querySelector(".home-entry-window")).toBeTruthy();
    expect(document.querySelector(".home-entry-visual")).toBeTruthy();
    expect(document.querySelector(".route-card")).toBeNull();
  });

  it("keeps the home page free of explanatory feature cards", () => {
    render(<HomeNavigation connectionStatus={getConnectionStatus("http://127.0.0.1:8000")} />);

    expect(screen.queryByText("今天从哪里开始？")).toBeNull();
    expect(screen.queryByText("今日入口")).toBeNull();
    expect(screen.queryByText("创作资料")).toBeNull();
    expect(screen.queryByText(/功能说明/)).toBeNull();
    expect(screen.queryByText(/不用先读/)).toBeNull();
  });
});

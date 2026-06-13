import { render, screen } from "@testing-library/react";
import React from "react";
import { describe, expect, it } from "vitest";
import { StudioEntry } from "../src/components/StudioEntry";

describe("StudioEntry", () => {
  it("renders Studio as a quiet materials workbench", () => {
    render(<StudioEntry />);

    expect(screen.getByRole("heading", { name: "资料室" })).toBeTruthy();
    expect(screen.getByRole("link", { name: "回到房间" }).getAttribute("href")).toBe("/room");
    expect(screen.getByRole("link", { name: "回到入口" }).getAttribute("href")).toBe("/");
    expect(screen.getByRole("button", { name: "工程" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "素材" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "笔记" })).toBeTruthy();
    expect(screen.getByText("本地资料为空。")).toBeTruthy();
    expect(screen.getByText("未连接本地目录")).toBeTruthy();
    expect(document.querySelector(".studio-workbench")).toBeTruthy();
    expect(document.querySelector(".studio-shelf")).toBeTruthy();
    expect(document.querySelector(".studio-module")).toBeNull();
  });

  it("does not render the old module-card grid", () => {
    render(<StudioEntry />);

    expect(screen.queryByText("创作资料")).toBeNull();
    expect(screen.queryByText("工程概览")).toBeNull();
    expect(screen.queryByText("Demo 音频")).toBeNull();
    expect(screen.queryByText(/之后这里可以放/)).toBeNull();
    expect(screen.queryByText(/不用假内容/)).toBeNull();
    expect(screen.queryByText(/这里更像一个轻资料柜/)).toBeNull();
  });
});

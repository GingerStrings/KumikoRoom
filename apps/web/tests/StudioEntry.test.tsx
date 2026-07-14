import { render, screen } from "@testing-library/react";
import React from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import * as studioApi from "../src/api/studioClient";
import { StudioEntry } from "../src/components/StudioEntry";

vi.mock("../src/api/studioClient", () => ({
  getStudioRoots: vi.fn(),
  getStudioProjects: vi.fn(),
  getStudioAnalysis: vi.fn(),
  getStudioProject: vi.fn(),
  addStudioRoot: vi.fn(),
  removeStudioRoot: vi.fn(),
  startStudioScan: vi.fn(),
  getStudioScan: vi.fn()
}));

beforeEach(() => {
  vi.mocked(studioApi.getStudioRoots).mockResolvedValue([]);
  vi.mocked(studioApi.getStudioProjects).mockResolvedValue([]);
});

describe("StudioEntry", () => {
  it("keeps the Studio shell and loads the live project library", async () => {
    render(<StudioEntry />);

    expect(screen.getByRole("heading", { name: "资料室" })).toBeTruthy();
    expect(screen.getByRole("link", { name: "回到聊天" }).getAttribute("href")).toBe("/room");
    expect(screen.getByRole("link", { name: "回到入口" }).getAttribute("href")).toBe("/");
    expect(screen.getByRole("status").textContent).toContain("正在整理工程档案");
    expect(await screen.findByRole("heading", { name: "添加第一个工程目录" })).toBeTruthy();
    expect(studioApi.getStudioRoots).toHaveBeenCalledOnce();
    expect(studioApi.getStudioProjects).toHaveBeenCalledOnce();
  });

  it("shows a recoverable load error", async () => {
    vi.mocked(studioApi.getStudioProjects).mockRejectedValueOnce(new Error("library offline"));
    render(<StudioEntry />);

    expect((await screen.findByRole("alert")).textContent).toContain("library offline");
    expect(screen.getByRole("button", { name: "重试" })).toBeTruthy();
  });
});

import { render, screen } from "@testing-library/react";
import React from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import * as studioApi from "../src/api/studioClient";
import type { StudioProjectSummary } from "../src/api/studioTypes";
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

  it("renders project summaries without waiting for project metadata", async () => {
    const project: StudioProjectSummary = {
      id: "p-progressive",
      canonicalPath: "D:/Music/Progressive.flp",
      displayName: "Progressive",
      status: "ready",
      modifiedAt: "2026-07-14T08:00:00Z",
      latestSnapshotId: "snapshot-progressive",
      createdAt: "2026-07-14T08:00:00Z",
      updatedAt: "2026-07-14T08:00:00Z",
      tempo: 120,
      patternCount: 8,
      warningCount: 0,
      errorCount: 0,
      diagnosticCount: 0,
      inferredKey: "D minor"
    };
    vi.mocked(studioApi.getStudioProjects).mockResolvedValueOnce([project]);
    vi.mocked(studioApi.getStudioAnalysis).mockImplementationOnce(() => new Promise(() => {}));
    vi.mocked(studioApi.getStudioProject).mockImplementationOnce(() => new Promise(() => {}));

    render(<StudioEntry />);

    expect(await screen.findByRole("link", { name: /Progressive/ })).toBeTruthy();
    expect(screen.queryByRole("status")).toBeNull();
    expect(studioApi.getStudioAnalysis).toHaveBeenCalledWith("p-progressive");
    expect(studioApi.getStudioProject).toHaveBeenCalledWith("p-progressive");
  });
});

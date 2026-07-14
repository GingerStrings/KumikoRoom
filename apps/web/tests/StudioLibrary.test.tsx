import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import React from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as studioApi from "../src/api/studioClient";
import type { StudioAnalysis, StudioProjectDetail, StudioProjectSummary, StudioRoot, StudioScanJob } from "../src/api/studioTypes";
import { StudioLibrary } from "../src/components/studio/StudioLibrary";

vi.mock("../src/api/studioClient", async () => {
  const actual = await vi.importActual<typeof import("../src/api/studioClient")>("../src/api/studioClient");
  return {
    ...actual,
    addStudioRoot: vi.fn(),
    removeStudioRoot: vi.fn(),
    startStudioScan: vi.fn(),
    getStudioScan: vi.fn(),
    getStudioProjects: vi.fn(),
    getStudioAnalysis: vi.fn(),
    getStudioProject: vi.fn()
  };
});

const root: StudioRoot = { id: "r1", path: "D:/Music", createdAt: "2026-07-13T08:00:00Z" };
const blueHour: StudioProjectSummary = {
  id: "p1",
  canonicalPath: "D:/Music/Blue Hour.flp",
  displayName: "Blue Hour",
  status: "ready",
  modifiedAt: "2026-07-13T10:00:00Z",
  latestSnapshotId: "s1",
  createdAt: "2026-07-13T10:00:01Z",
  updatedAt: "2026-07-13T10:00:02Z",
  tempo: 128,
  patternCount: 42,
  warningCount: 1,
  errorCount: 0,
  diagnosticCount: 1,
  inferredKey: "A minor"
};
const amberLine: StudioProjectSummary = {
  ...blueHour,
  id: "p2",
  canonicalPath: "D:/Music/Amber Line.flp",
  displayName: "Amber Line",
  status: "partial",
  modifiedAt: "2026-07-12T10:00:00Z",
  tempo: 94,
  inferredKey: "C major",
  warningCount: 0
};

function analysis(plugin: string, dependencyExists = true): StudioAnalysis {
  return {
    sourcePath: "D:/Music/Blue Hour.flp",
    sourceHash: "hash",
    status: "ready",
    project: { title: null, author: null, flVersion: null, tempo: 128, ppq: 96, timeSignatureNumerator: 4, timeSignatureDenominator: 4, createdAt: null, timeSpentSeconds: null },
    patterns: [],
    channels: [],
    playlistClips: [],
    plugins: [{ id: "plugin", name: plugin, kind: "generator", location: "channel", stateSupported: true }],
    mixerInserts: [],
    automations: [],
    relatedAssets: [],
    dependencies: [{ path: "D:/Samples/kick.wav", kind: "sample", exists: dependencyExists }],
    fingerprint: { noteMin: null, noteMax: null, noteDensity: 0, velocityMean: null, patternReuse: 0, inferredKey: null, inferredKeyConfidence: 0, inferredKeyEvidence: [] },
    diagnostics: [],
    unknownEventCount: 0
  };
}

function detail(project: StudioProjectSummary): StudioProjectDetail {
  return {
    ...project,
    latestSnapshotSourceHash: "hash",
    latestSnapshotAnalyzedAt: "2026-07-13T10:02:00Z"
  };
}

beforeEach(() => {
  vi.mocked(studioApi.addStudioRoot).mockResolvedValue(root);
  vi.mocked(studioApi.removeStudioRoot).mockResolvedValue(undefined);
  vi.mocked(studioApi.startStudioScan).mockResolvedValue({
    id: "scan-1",
    status: "queued",
    discoveredCount: 0,
    parsedCount: 0,
    cachedCount: 0,
    failedCount: 0,
    error: null,
    createdAt: "2026-07-13T10:00:00Z",
    updatedAt: "2026-07-13T10:00:00Z"
  });
  vi.mocked(studioApi.getStudioProjects).mockResolvedValue([blueHour, amberLine]);
  vi.mocked(studioApi.getStudioAnalysis).mockImplementation(async (id) => id === "p1" ? analysis("FLEX", false) : analysis("Serum"));
  vi.mocked(studioApi.getStudioProject).mockImplementation(async (id) => detail(id === "p1" ? blueHour : amberLine));
});

afterEach(() => {
  vi.clearAllMocks();
  vi.useRealTimers();
});

describe("StudioLibrary", () => {
  it("shows projects, scan information, and attention signals", () => {
    render(
      <StudioLibrary
        initialProjects={[blueHour, amberLine]}
        initialRoots={[root]}
        initialAnalyses={{ p1: analysis("FLEX", false), p2: analysis("Serum") }}
        initialDetails={{ p1: detail(blueHour), p2: detail(amberLine) }}
      />
    );

    expect(screen.getByRole("link", { name: /Blue Hour/ }).getAttribute("href")).toBe("/studio/projects/p1");
    expect(screen.getByText("128 BPM")).toBeTruthy();
    expect(screen.getAllByText("A minor").length).toBeGreaterThan(0);
    expect(screen.getByText("1 个提醒")).toBeTruthy();
    expect(screen.getByText("缺少 1 项依赖")).toBeTruthy();
    expect(screen.getAllByText(/上次分析/).length).toBeGreaterThan(0);
  });

  it("filters by text, status, BPM, key, plugin, and dependency state", () => {
    render(
      <StudioLibrary
        initialProjects={[blueHour, amberLine]}
        initialRoots={[root]}
        initialAnalyses={{ p1: analysis("FLEX", false), p2: analysis("Serum") }}
        initialDetails={{ p1: detail(blueHour), p2: detail(amberLine) }}
      />
    );

    fireEvent.change(screen.getByRole("searchbox", { name: "搜索工程" }), { target: { value: "blue" } });
    expect(screen.getByRole("link", { name: /Blue Hour/ })).toBeTruthy();
    expect(screen.queryByRole("link", { name: /Amber Line/ })).toBeNull();

    fireEvent.change(screen.getByRole("searchbox", { name: "搜索工程" }), { target: { value: "" } });
    fireEvent.change(screen.getByLabelText("解析状态"), { target: { value: "partial" } });
    expect(screen.getByRole("link", { name: /Amber Line/ })).toBeTruthy();
    expect(screen.queryByRole("link", { name: /Blue Hour/ })).toBeNull();

    fireEvent.change(screen.getByLabelText("解析状态"), { target: { value: "all" } });
    fireEvent.change(screen.getByLabelText("BPM 范围"), { target: { value: "fast" } });
    expect(screen.getByRole("link", { name: /Blue Hour/ })).toBeTruthy();
    expect(screen.queryByRole("link", { name: /Amber Line/ })).toBeNull();

    fireEvent.change(screen.getByLabelText("BPM 范围"), { target: { value: "all" } });
    fireEvent.change(screen.getByLabelText("推测调式"), { target: { value: "C major" } });
    expect(screen.getByRole("link", { name: /Amber Line/ })).toBeTruthy();

    fireEvent.change(screen.getByLabelText("推测调式"), { target: { value: "all" } });
    fireEvent.change(screen.getByLabelText("插件"), { target: { value: "FLEX" } });
    expect(screen.getByRole("link", { name: /Blue Hour/ })).toBeTruthy();

    fireEvent.change(screen.getByLabelText("插件"), { target: { value: "all" } });
    fireEvent.change(screen.getByLabelText("依赖状态"), { target: { value: "missing" } });
    expect(screen.getByRole("link", { name: /Blue Hour/ })).toBeTruthy();
    expect(screen.queryByRole("link", { name: /Amber Line/ })).toBeNull();
  });

  it("offers every project analysis status as a filter", () => {
    render(<StudioLibrary initialProjects={[blueHour]} initialRoots={[root]} />);

    const values = within(screen.getByLabelText("解析状态")).getAllByRole("option").map(
      (option) => (option as HTMLOptionElement).value
    );
    expect(values).toEqual([
      "all",
      "discovered",
      "queued",
      "parsing",
      "ready",
      "partial",
      "failed",
      "stale"
    ]);
  });

  it("keeps unavailable dependency analysis truthful and filterable", () => {
    render(
      <StudioLibrary
        initialProjects={[blueHour, amberLine]}
        initialRoots={[root]}
        initialAnalyses={{ p2: analysis("Serum") }}
      />
    );

    const blueCard = screen.getByRole("link", { name: /Blue Hour/ });
    expect(blueCard.textContent).toContain("依赖尚未分析");
    expect(blueCard.textContent).not.toContain("依赖完整");

    fireEvent.change(screen.getByLabelText("依赖状态"), { target: { value: "complete" } });
    expect(screen.queryByRole("link", { name: /Blue Hour/ })).toBeNull();
    expect(screen.getByRole("link", { name: /Amber Line/ })).toBeTruthy();

    fireEvent.change(screen.getByLabelText("依赖状态"), { target: { value: "unknown" } });
    expect(screen.getByRole("link", { name: /Blue Hour/ })).toBeTruthy();
    expect(screen.queryByRole("link", { name: /Amber Line/ })).toBeNull();
  });

  it("sorts projects by recent edit or name", () => {
    render(<StudioLibrary initialProjects={[blueHour, amberLine]} initialRoots={[root]} />);
    const projectList = screen.getByLabelText("工程列表");
    expect(within(projectList).getAllByRole("link")[0].textContent).toContain("Blue Hour");

    fireEvent.change(screen.getByLabelText("排序"), { target: { value: "name" } });
    expect(within(projectList).getAllByRole("link")[0].textContent).toContain("Amber Line");
  });

  it("adds and removes folders, then starts a scan", async () => {
    vi.mocked(studioApi.addStudioRoot).mockResolvedValue({
      id: "r2",
      path: "E:/Archive",
      createdAt: "2026-07-13T09:00:00Z"
    });
    vi.mocked(studioApi.startStudioScan).mockResolvedValue({
      id: "scan-complete",
      status: "completed",
      discoveredCount: 1,
      parsedCount: 1,
      cachedCount: 0,
      failedCount: 0,
      error: null,
      createdAt: "2026-07-13T10:00:00Z",
      updatedAt: "2026-07-13T10:00:01Z"
    });
    render(<StudioLibrary initialProjects={[blueHour]} initialRoots={[root]} />);

    fireEvent.change(screen.getByLabelText("工程目录"), { target: { value: "E:/Archive" } });
    fireEvent.submit(screen.getByRole("form", { name: "添加工程目录" }));
    await waitFor(() => expect(studioApi.addStudioRoot).toHaveBeenCalledWith("E:/Archive"));
    expect(studioApi.startStudioScan).toHaveBeenCalledTimes(1);

    fireEvent.click(screen.getByRole("button", { name: "移除 D:/Music" }));
    await waitFor(() => expect(studioApi.removeStudioRoot).toHaveBeenCalledWith("r1"));

    await waitFor(() => expect((screen.getByRole("button", { name: "重新扫描" }) as HTMLButtonElement).disabled).toBe(false));
    fireEvent.click(screen.getByRole("button", { name: "重新扫描" }));
    await waitFor(() => expect(studioApi.startStudioScan).toHaveBeenCalledTimes(2));
  });

  it("polls queued and running jobs, then refreshes projects after completion", async () => {
    vi.useFakeTimers();
    const running: StudioScanJob = {
      id: "scan-1",
      status: "running",
      discoveredCount: 2,
      parsedCount: 1,
      cachedCount: 0,
      failedCount: 0,
      error: null,
      createdAt: "2026-07-13T10:00:00Z",
      updatedAt: "2026-07-13T10:00:01Z"
    };
    vi.mocked(studioApi.getStudioScan)
      .mockResolvedValueOnce(running)
      .mockResolvedValueOnce({ ...running, status: "completed", parsedCount: 2 });
    render(<StudioLibrary initialProjects={[blueHour]} initialRoots={[root]} />);

    fireEvent.click(screen.getByRole("button", { name: "重新扫描" }));
    await act(async () => {});
    await act(async () => { vi.advanceTimersByTime(1000); });
    expect(studioApi.getStudioScan).toHaveBeenCalledTimes(1);
    await act(async () => { vi.advanceTimersByTime(1000); });
    expect(studioApi.getStudioScan).toHaveBeenCalledTimes(2);
    await act(async () => {});
    expect(studioApi.getStudioProjects).toHaveBeenCalledTimes(1);

    await act(async () => { vi.advanceTimersByTime(5000); });
    expect(studioApi.getStudioScan).toHaveBeenCalledTimes(2);
  });

  it("renders empty and request error states", async () => {
    const first = render(<StudioLibrary initialProjects={[]} initialRoots={[]} />);
    expect(screen.getByRole("heading", { name: "添加第一个工程目录" })).toBeTruthy();
    first.unmount();

    vi.mocked(studioApi.startStudioScan).mockRejectedValueOnce(new Error("scan unavailable"));
    render(<StudioLibrary initialProjects={[]} initialRoots={[root]} />);
    fireEvent.click(screen.getByRole("button", { name: "重新扫描" }));
    expect((await screen.findByRole("alert")).textContent).toContain("scan unavailable");
  });
});

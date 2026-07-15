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
    render(
      <StudioLibrary
        initialProjects={[blueHour]}
        initialRoots={[root]}
        initialAnalyses={{ p1: analysis("FLEX") }}
        initialDetails={{ p1: detail(blueHour) }}
      />
    );

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
    vi.mocked(studioApi.getStudioAnalysis).mockImplementation((id) =>
      id === "p1" ? new Promise(() => {}) : Promise.resolve(analysis("Serum"))
    );
    render(
      <StudioLibrary
        initialProjects={[blueHour, amberLine]}
        initialRoots={[root]}
        initialAnalyses={{ p2: analysis("Serum") }}
        initialDetails={{ p1: detail(blueHour), p2: detail(amberLine) }}
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
    render(
      <StudioLibrary
        initialProjects={[blueHour, amberLine]}
        initialRoots={[root]}
        initialAnalyses={{ p1: analysis("FLEX"), p2: analysis("Serum") }}
        initialDetails={{ p1: detail(blueHour), p2: detail(amberLine) }}
      />
    );
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

  it("retries a transient scan polling error and still reaches completion", async () => {
    vi.useFakeTimers();
    const queued: StudioScanJob = {
      id: "scan-retry",
      status: "queued",
      discoveredCount: 0,
      parsedCount: 0,
      cachedCount: 0,
      failedCount: 0,
      error: null,
      createdAt: "2026-07-14T08:00:00Z",
      updatedAt: "2026-07-14T08:00:00Z"
    };
    vi.mocked(studioApi.startStudioScan).mockResolvedValueOnce(queued);
    vi.mocked(studioApi.getStudioScan)
      .mockRejectedValueOnce(new Error("temporary transport error"))
      .mockResolvedValueOnce({ ...queued, status: "completed", discoveredCount: 1, parsedCount: 1 });
    render(<StudioLibrary initialProjects={[blueHour]} initialRoots={[root]} />);

    fireEvent.click(screen.getByRole("button", { name: "重新扫描" }));
    await act(async () => {});
    await act(async () => { vi.advanceTimersByTime(1000); });
    expect(studioApi.getStudioScan).toHaveBeenCalledTimes(1);
    expect(screen.getByRole("alert").textContent).toContain("temporary transport error");

    await act(async () => { vi.advanceTimersByTime(2000); });
    expect(studioApi.getStudioScan).toHaveBeenCalledTimes(2);
    await act(async () => {});
    expect(screen.getByText("扫描完成")).toBeTruthy();
    expect(studioApi.getStudioProjects).toHaveBeenCalledTimes(1);
  });

  it("reports a completed scan refresh failure after completion is rendered", async () => {
    vi.useFakeTimers();
    const queued: StudioScanJob = {
      id: "scan-refresh-error",
      status: "queued",
      discoveredCount: 0,
      parsedCount: 0,
      cachedCount: 0,
      failedCount: 0,
      error: null,
      createdAt: "2026-07-14T08:00:00Z",
      updatedAt: "2026-07-14T08:00:00Z"
    };
    let rejectRefresh: ((reason: unknown) => void) | undefined;
    vi.mocked(studioApi.startStudioScan).mockResolvedValueOnce(queued);
    vi.mocked(studioApi.getStudioScan).mockResolvedValueOnce({
      ...queued,
      status: "completed",
      discoveredCount: 1,
      parsedCount: 1
    });
    vi.mocked(studioApi.getStudioProjects).mockImplementationOnce(
      () => new Promise((_resolve, reject) => { rejectRefresh = reject; })
    );
    render(
      <StudioLibrary
        initialProjects={[blueHour]}
        initialRoots={[root]}
        initialAnalyses={{ p1: analysis("FLEX") }}
        initialDetails={{ p1: detail(blueHour) }}
      />
    );

    fireEvent.click(screen.getByRole("button", { name: "重新扫描" }));
    await act(async () => {});
    await act(async () => { vi.advanceTimersByTime(1000); });
    expect(screen.getByText("扫描完成")).toBeTruthy();

    await act(async () => { rejectRefresh?.(new Error("project refresh unavailable")); });
    expect(screen.getByRole("alert").textContent).toContain("project refresh unavailable");
  });

  it("ignores an old completed refresh error after a newer scan starts", async () => {
    vi.useFakeTimers();
    const queued = (id: string): StudioScanJob => ({
      id,
      status: "queued",
      discoveredCount: 0,
      parsedCount: 0,
      cachedCount: 0,
      failedCount: 0,
      error: null,
      createdAt: "2026-07-14T08:00:00Z",
      updatedAt: "2026-07-14T08:00:00Z"
    });
    let rejectOldRefresh: ((reason: unknown) => void) | undefined;
    vi.mocked(studioApi.startStudioScan)
      .mockResolvedValueOnce(queued("scan-refresh-old"))
      .mockResolvedValueOnce(queued("scan-refresh-new"));
    vi.mocked(studioApi.getStudioScan).mockResolvedValueOnce({
      ...queued("scan-refresh-old"),
      status: "completed",
      discoveredCount: 1,
      parsedCount: 1
    });
    vi.mocked(studioApi.getStudioProjects).mockImplementationOnce(
      () => new Promise((_resolve, reject) => { rejectOldRefresh = reject; })
    );
    render(
      <StudioLibrary
        initialProjects={[blueHour]}
        initialRoots={[root]}
        initialAnalyses={{ p1: analysis("FLEX") }}
        initialDetails={{ p1: detail(blueHour) }}
      />
    );

    fireEvent.click(screen.getByRole("button", { name: "重新扫描" }));
    await act(async () => {});
    await act(async () => { vi.advanceTimersByTime(1000); });
    expect(screen.getByText("扫描完成")).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "重新扫描" }));
    await act(async () => {});
    expect(screen.getByText("等待扫描")).toBeTruthy();
    await act(async () => { rejectOldRefresh?.(new Error("obsolete refresh error")); });

    expect(screen.queryByRole("alert")).toBeNull();
    expect(screen.getByText("等待扫描")).toBeTruthy();
  });

  it("ignores an old polling response after a newer scan starts", async () => {
    vi.useFakeTimers();
    const queued = (id: string): StudioScanJob => ({
      id,
      status: "queued",
      discoveredCount: 0,
      parsedCount: 0,
      cachedCount: 0,
      failedCount: 0,
      error: null,
      createdAt: "2026-07-14T08:00:00Z",
      updatedAt: "2026-07-14T08:00:00Z"
    });
    let resolveOld: ((job: StudioScanJob) => void) | undefined;
    vi.mocked(studioApi.startStudioScan)
      .mockResolvedValueOnce(queued("scan-old"))
      .mockResolvedValueOnce(queued("scan-new"));
    vi.mocked(studioApi.getStudioScan).mockImplementationOnce(
      () => new Promise((resolve) => { resolveOld = resolve; })
    );
    render(
      <StudioLibrary
        initialProjects={[blueHour]}
        initialRoots={[root]}
        initialAnalyses={{ p1: analysis("FLEX") }}
        initialDetails={{ p1: detail(blueHour) }}
      />
    );

    fireEvent.click(screen.getByRole("button", { name: "重新扫描" }));
    await act(async () => {});
    await act(async () => { vi.advanceTimersByTime(1000); });
    expect(studioApi.getStudioScan).toHaveBeenCalledWith("scan-old");

    fireEvent.change(screen.getByLabelText("工程目录"), { target: { value: "E:/Archive" } });
    fireEvent.submit(screen.getByRole("form", { name: "添加工程目录" }));
    await act(async () => {});
    expect(studioApi.startStudioScan).toHaveBeenCalledTimes(2);

    await act(async () => {
      resolveOld?.({ ...queued("scan-old"), status: "completed", discoveredCount: 1, parsedCount: 1 });
    });
    expect(screen.queryByText("扫描完成")).toBeNull();
    expect(screen.getByText("等待扫描")).toBeTruthy();
    expect(studioApi.getStudioProjects).not.toHaveBeenCalled();
  });

  it("loads project metadata progressively with bounded request concurrency", async () => {
    const projects = Array.from({ length: 5 }, (_, index): StudioProjectSummary => ({
      ...blueHour,
      id: `bounded-${index + 1}`,
      displayName: `Bounded ${index + 1}`,
      latestSnapshotId: `snapshot-${index + 1}`
    }));
    let active = 0;
    let maxActive = 0;
    const pending = new Map<string, { resolve: (value: unknown) => void; reject: (reason: unknown) => void }>();
    const hold = (key: string) => new Promise<unknown>((resolve, reject) => {
      active += 1;
      maxActive = Math.max(maxActive, active);
      pending.set(key, {
        resolve: (value) => { active -= 1; resolve(value); },
        reject: (reason) => { active -= 1; reject(reason); }
      });
    });
    vi.mocked(studioApi.getStudioAnalysis).mockImplementation((id) => hold(`analysis:${id}`) as Promise<StudioAnalysis>);
    vi.mocked(studioApi.getStudioProject).mockImplementation((id) => hold(`detail:${id}`) as Promise<StudioProjectDetail>);

    const view = render(<StudioLibrary initialProjects={projects} initialRoots={[root]} />);

    expect(screen.getAllByRole("link", { name: /Bounded/ })).toHaveLength(5);
    await waitFor(() => expect(active).toBe(4));
    expect(maxActive).toBe(4);
    pending.get("detail:bounded-1")?.reject(new Error("detail unavailable"));
    pending.get("analysis:bounded-1")?.resolve(analysis("FLEX"));
    await waitFor(() => expect(screen.getByRole("link", { name: /Bounded 1/ }).textContent).toContain("依赖完整"));
    expect(screen.getByRole("link", { name: /Bounded 1/ }).textContent).toContain("上次分析 不可用");
    expect(maxActive).toBe(4);
    expect(active).toBe(4);
    view.unmount();
  });

  it("stops an old metadata queue from expanding after unmount", async () => {
    const projects = Array.from({ length: 5 }, (_, index): StudioProjectSummary => ({
      ...blueHour,
      id: `unmount-${index + 1}`,
      displayName: `Unmount ${index + 1}`,
      latestSnapshotId: `snapshot-unmount-${index + 1}`
    }));
    const releases: Array<() => void> = [];
    const hold = () => new Promise<never>((resolve) => {
      releases.push(() => resolve(undefined as never));
    });
    vi.mocked(studioApi.getStudioAnalysis).mockImplementation(hold);
    vi.mocked(studioApi.getStudioProject).mockImplementation(hold);
    const view = render(<StudioLibrary initialProjects={projects} initialRoots={[root]} />);
    await waitFor(() => expect(studioApi.getStudioAnalysis.mock.calls.length + studioApi.getStudioProject.mock.calls.length).toBe(4));

    view.unmount();
    await act(async () => { releases.splice(0).forEach((release) => release()); });

    expect(studioApi.getStudioAnalysis.mock.calls.length + studioApi.getStudioProject.mock.calls.length).toBe(4);
  });

  it("times out hung metadata requests and advances the bounded queue", async () => {
    vi.useFakeTimers();
    const projects = Array.from({ length: 5 }, (_, index): StudioProjectSummary => ({
      ...blueHour,
      id: `timeout-${index + 1}`,
      displayName: `Timeout ${index + 1}`,
      latestSnapshotId: `snapshot-timeout-${index + 1}`
    }));
    let active = 0;
    let maxActive = 0;
    const signals: AbortSignal[] = [];
    const holdUntilAbort = (_id: string, options?: { signal?: AbortSignal }) => new Promise<never>((_resolve, reject) => {
      active += 1;
      maxActive = Math.max(maxActive, active);
      if (!options?.signal) return;
      signals.push(options.signal);
      options.signal.addEventListener("abort", () => {
        active -= 1;
        reject(new DOMException("Aborted", "AbortError"));
      }, { once: true });
    });
    vi.mocked(studioApi.getStudioAnalysis).mockImplementation(holdUntilAbort);
    vi.mocked(studioApi.getStudioProject).mockImplementation(holdUntilAbort);
    const view = render(<StudioLibrary initialProjects={projects} initialRoots={[root]} />);
    await act(async () => {});
    expect(active).toBe(4);

    await act(async () => { vi.advanceTimersByTime(10000); });
    const calls = studioApi.getStudioAnalysis.mock.calls.length + studioApi.getStudioProject.mock.calls.length;
    expect(calls).toBeGreaterThan(4);
    expect(maxActive).toBe(4);
    expect(signals.slice(0, 4).every((signal) => signal.aborted)).toBe(true);
    view.unmount();
  });

  it("aborts old metadata before a refreshed project generation starts", async () => {
    vi.useFakeTimers();
    const oldProjects = Array.from({ length: 3 }, (_, index): StudioProjectSummary => ({
      ...blueHour,
      id: `old-${index + 1}`,
      displayName: `Old ${index + 1}`,
      latestSnapshotId: `snapshot-old-${index + 1}`
    }));
    const newProjects = Array.from({ length: 3 }, (_, index): StudioProjectSummary => ({
      ...blueHour,
      id: `new-${index + 1}`,
      displayName: `New ${index + 1}`,
      latestSnapshotId: `snapshot-new-${index + 1}`
    }));
    let active = 0;
    let maxActive = 0;
    const holdUntilAbort = (_id: string, options?: { signal?: AbortSignal }) => new Promise<never>((_resolve, reject) => {
      active += 1;
      maxActive = Math.max(maxActive, active);
      options?.signal?.addEventListener("abort", () => {
        active -= 1;
        reject(new DOMException("Aborted", "AbortError"));
      }, { once: true });
    });
    vi.mocked(studioApi.getStudioAnalysis).mockImplementation(holdUntilAbort);
    vi.mocked(studioApi.getStudioProject).mockImplementation(holdUntilAbort);
    vi.mocked(studioApi.getStudioProjects).mockResolvedValueOnce(newProjects);
    vi.mocked(studioApi.getStudioScan).mockResolvedValueOnce({
      id: "scan-generation",
      status: "completed",
      discoveredCount: 3,
      parsedCount: 3,
      cachedCount: 0,
      failedCount: 0,
      error: null,
      createdAt: "2026-07-14T08:00:00Z",
      updatedAt: "2026-07-14T08:00:01Z"
    });
    render(<StudioLibrary initialProjects={oldProjects} initialRoots={[root]} />);
    await act(async () => {});
    expect(active).toBe(4);

    fireEvent.click(screen.getByRole("button", { name: "重新扫描" }));
    await act(async () => {});
    await act(async () => { vi.advanceTimersByTime(1000); });
    await act(async () => {});

    expect(screen.getAllByRole("link", { name: /New/ })).toHaveLength(3);
    expect(maxActive).toBe(4);
    expect(active).toBe(4);
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

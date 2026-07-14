import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import StudioProjectPage from "../app/studio/projects/[id]/page";
import { ApiError } from "../src/api/client";
import * as studioApi from "../src/api/studioClient";
import type {
  StudioAnalysis,
  StudioProjectDetail,
  StudioProjectSummary
} from "../src/api/studioTypes";
import { ProjectDashboard } from "../src/components/studio/ProjectDashboard";
import { ProjectWorkspace } from "../src/components/studio/ProjectWorkspace";

vi.mock("../src/api/studioClient", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/api/studioClient")>();
  return {
    ...actual,
    getStudioAnalysis: vi.fn(),
    getStudioProject: vi.fn()
  };
});

const project: StudioProjectDetail = {
  id: "p1",
  canonicalPath: "D:/Music/Blue Hour.flp",
  displayName: "Blue Hour",
  status: "ready",
  modifiedAt: "2026-07-13T10:00:00Z",
  latestSnapshotId: "s1",
  createdAt: "2026-07-13T09:00:00Z",
  updatedAt: "2026-07-13T10:02:00Z",
  tempo: 128,
  patternCount: 2,
  warningCount: 2,
  errorCount: 0,
  diagnosticCount: 3,
  inferredKey: "D minor",
  latestSnapshotSourceHash: "hash-1",
  latestSnapshotAnalyzedAt: "2026-07-13T10:02:00Z"
};

const analysis: StudioAnalysis = {
  sourcePath: project.canonicalPath,
  sourceHash: "hash-1",
  status: "ready",
  project: {
    title: "Blue Hour",
    author: "Kumiko",
    flVersion: "21.2",
    tempo: 128,
    ppq: 96,
    timeSignatureNumerator: 4,
    timeSignatureDenominator: 4,
    createdAt: "2026-07-12T18:30:00Z",
    timeSpentSeconds: 7320
  },
  patterns: [
    {
      id: "pat-1",
      name: "Verse",
      usedInPlaylist: true,
      notes: [
        { key: 50, position: 0, length: 96, velocity: 92, channelId: "ch-1" },
        { key: 62, position: 96, length: 96, velocity: 108, channelId: "ch-1" }
      ]
    },
    { id: "pat-2", name: "Lift", usedInPlaylist: false, notes: [] }
  ],
  channels: [{ id: "ch-1", name: "Keys", pluginName: "FLEX", channelType: "instrument" }],
  playlistClips: [
    { id: "clip-1", trackIndex: 1, start: 0, length: 384, clipType: "pattern", sourceId: "pat-1" }
  ],
  plugins: [{ id: "plug-1", name: "FLEX", kind: "generator", location: "channel:ch-1", stateSupported: true }],
  mixerInserts: [{ id: "mix-1", name: "Master", slotPluginIds: [], routeTargetIds: [] }],
  automations: [],
  relatedAssets: [],
  dependencies: [
    { path: "D:/Samples/vocal.wav", kind: "sample", exists: false },
    { path: "D:/Samples/texture.wav", kind: "sample", exists: false },
    { path: "D:/Samples/kick.wav", kind: "sample", exists: true }
  ],
  fingerprint: {
    noteMin: 50,
    noteMax: 86,
    noteDensity: 0.34,
    velocityMean: 101.4,
    patternReuse: 0.58,
    inferredKey: "D minor",
    inferredKeyConfidence: 0.82,
    inferredKeyEvidence: ["D 音级重心", "A–D 终止倾向"]
  },
  diagnostics: [
    { code: "missing_dependency", severity: "warning", message: "找不到 vocal.wav", targetType: "dependency", targetId: "vocal" },
    { code: "unknown_event", severity: "notice", message: "有 2 个事件尚未识别", targetType: "project", targetId: "p1" }
  ],
  unknownEventCount: 2
};

beforeEach(() => {
  vi.mocked(studioApi.getStudioProject).mockResolvedValue(project);
  vi.mocked(studioApi.getStudioAnalysis).mockResolvedValue(analysis);
});

afterEach(() => {
  vi.clearAllMocks();
});

describe("Project dashboard", () => {
  it("renders truthful metrics, diagnostics, dependency reminders, and fingerprint evidence", () => {
    render(<ProjectDashboard analysis={analysis} project={project} />);

    expect(screen.getByRole("heading", { name: "Blue Hour" })).toBeTruthy();
    expect(screen.getByText("128 BPM")).toBeTruthy();
    expect(screen.getByText("2 Patterns")).toBeTruthy();
    expect(screen.getByText("2 条依赖提醒")).toBeTruthy();
    expect(screen.getByText("找不到 vocal.wav")).toBeTruthy();

    const fingerprint = screen.getByLabelText("音乐指纹");
    expect(within(fingerprint).getByText("D minor · 82% 可信度")).toBeTruthy();
    expect(within(fingerprint).getByText("D 音级重心")).toBeTruthy();
    expect(within(fingerprint).getByText("A–D 终止倾向")).toBeTruthy();
    expect(within(fingerprint).getByText(/音域 50–86/)).toBeTruthy();
    expect(within(fingerprint).getByTitle("音乐指纹：音域 50 到 86，音符密度 0.34 个/拍，平均力度 101，Pattern 复用 58%，推断调性 D minor，可信度 82%")).toBeTruthy();
  });

  it("keeps unavailable fingerprint values explicit and finite", () => {
    const unavailable: StudioAnalysis = {
      ...analysis,
      project: { ...analysis.project, tempo: null },
      fingerprint: {
        noteMin: null,
        noteMax: null,
        noteDensity: 0,
        velocityMean: null,
        patternReuse: 0,
        inferredKey: null,
        inferredKeyConfidence: 0,
        inferredKeyEvidence: []
      }
    };
    render(<ProjectDashboard analysis={unavailable} project={{ ...project, tempo: null, inferredKey: null }} />);

    expect(screen.getByText("BPM 未读取")).toBeTruthy();
    expect(screen.getByText("调性未推断")).toBeTruthy();
    expect(screen.getByText("没有足够的 MIDI 音符来估算音域与平均力度。")).toBeTruthy();
    expect(document.body.textContent).not.toMatch(/NaN|Infinity/);
  });
});

describe("Project workspace", () => {
  it("loads the route project id and exposes only the implemented overview tab", async () => {
    render(<ProjectWorkspace projectId="p/1" />);

    expect(screen.getByRole("status").textContent).toContain("正在读取工程分析");
    expect(await screen.findByRole("heading", { name: "Blue Hour" })).toBeTruthy();
    expect(studioApi.getStudioProject).toHaveBeenCalledWith("p/1", expect.objectContaining({ signal: expect.any(AbortSignal) }));
    expect(studioApi.getStudioAnalysis).toHaveBeenCalledWith("p/1", expect.objectContaining({ signal: expect.any(AbortSignal) }));

    const tabs = screen.getByRole("tablist", { name: "工程分析视图" });
    expect(within(tabs).getByRole("tab", { name: "总览" }).getAttribute("aria-selected")).toBe("true");
    for (const name of ["编曲", "Pattern", "插件与 Mixer", "依赖", "版本"]) {
      expect((within(tabs).getByRole("tab", { name }) as HTMLButtonElement).disabled).toBe(true);
    }
  });

  it("marks partial analysis while keeping available analysis visible", async () => {
    vi.mocked(studioApi.getStudioProject).mockResolvedValueOnce({ ...project, status: "partial" });
    vi.mocked(studioApi.getStudioAnalysis).mockResolvedValueOnce({ ...analysis, status: "partial" });
    render(<ProjectWorkspace projectId="partial" />);

    expect(await screen.findByRole("heading", { name: "Blue Hour" })).toBeTruthy();
    expect(screen.getByRole("status", { name: "部分解析" }).textContent).toContain("已展示可确认的数据");
  });

  it("renders a project-specific failed state", async () => {
    vi.mocked(studioApi.getStudioProject).mockResolvedValueOnce({ ...project, status: "failed" });
    vi.mocked(studioApi.getStudioAnalysis).mockRejectedValueOnce(new ApiError("analysis failed", 409, {}));
    render(<ProjectWorkspace projectId="failed" />);

    expect(await screen.findByRole("heading", { name: "Blue Hour 解析失败" })).toBeTruthy();
    expect(screen.getByText("analysis failed")).toBeTruthy();
    expect(screen.getByRole("link", { name: "返回工程库" }).getAttribute("href")).toBe("/studio");
  });

  it("renders an in-product 404 for an unknown id", async () => {
    vi.mocked(studioApi.getStudioProject).mockRejectedValueOnce(new ApiError("missing", 404, {}));
    render(<ProjectWorkspace projectId="missing" />);

    expect(await screen.findByRole("heading", { name: "没有找到这个工程" })).toBeTruthy();
    expect(screen.getByRole("link", { name: "返回工程库" }).getAttribute("href")).toBe("/studio");
    expect(studioApi.getStudioAnalysis).not.toHaveBeenCalled();
  });

  it("can retry a transient request error", async () => {
    vi.mocked(studioApi.getStudioProject)
      .mockRejectedValueOnce(new Error("temporary unavailable"))
      .mockResolvedValueOnce(project);
    render(<ProjectWorkspace projectId="retry" />);

    expect((await screen.findByRole("alert")).textContent).toContain("temporary unavailable");
    fireEvent.click(screen.getByRole("button", { name: "重试" }));
    expect(await screen.findByRole("heading", { name: "Blue Hour" })).toBeTruthy();
  });

  it("aborts in-flight requests when leaving the workspace", async () => {
    let signal: AbortSignal | undefined;
    vi.mocked(studioApi.getStudioProject).mockImplementationOnce((_id, options) => {
      signal = options.signal;
      return new Promise(() => {});
    });
    const view = render(<ProjectWorkspace projectId="slow" />);
    await waitFor(() => expect(signal).toBeDefined());

    view.unmount();
    expect(signal?.aborted).toBe(true);
  });

  it("passes the dynamic route id to the workspace", async () => {
    render(<StudioProjectPage params={{ id: "route-id" }} />);

    expect(await screen.findByRole("heading", { name: "Blue Hour" })).toBeTruthy();
    expect(studioApi.getStudioProject).toHaveBeenCalledWith("route-id", expect.any(Object));
  });
});

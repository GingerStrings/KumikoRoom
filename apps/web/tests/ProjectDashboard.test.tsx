import fs from "node:fs";
import path from "node:path";
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
import { MusicalFingerprint } from "../src/components/studio/MusicalFingerprint";
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

const studioCssPath = path.resolve(__dirname, "../src/components/studio/Studio.module.css");

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
    expect(within(fingerprint).getByText("DENSITY · 0–8+ / BEAT")).toBeTruthy();
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

  it("keeps gradient definitions and references isolated across fingerprint instances", () => {
    render(
      <>
        <MusicalFingerprint fingerprint={analysis.fingerprint} />
        <MusicalFingerprint fingerprint={analysis.fingerprint} />
      </>
    );

    const svgs = screen.getAllByRole("img");
    const allGradientIds = svgs.flatMap((svg) =>
      Array.from(svg.querySelectorAll("linearGradient"), (gradient) => gradient.id)
    );
    expect(new Set(allGradientIds).size).toBe(allGradientIds.length);

    for (const svg of svgs) {
      const ownIds = new Set(Array.from(svg.querySelectorAll("linearGradient"), (gradient) => gradient.id));
      expect(ownIds.size).toBe(2);
      for (const id of ownIds) expect(id).toMatch(/^[A-Za-z_][A-Za-z0-9_.-]*$/);

      const referencedIds = new Set<string>();
      for (const element of Array.from(svg.querySelectorAll("*"))) {
        for (const attribute of ["fill", "stroke"] as const) {
          const match = element.getAttribute(attribute)?.match(/^url\(#(.+)\)$/);
          if (match) referencedIds.add(match[1]);
        }
      }
      expect(referencedIds).toEqual(ownIds);
    }
  });

  it("keeps every Task 9 small-text color at WCAG AA contrast", () => {
    const css = fs.readFileSync(studioCssPath, "utf8").replace(/\r\n/g, "\n");
    const background = "#fffefa";
    const selectors = [
      ".panelKicker",
      ".heroMetadata dt",
      ".metricLedger span",
      ".keyInference span",
      ".paperPanelHeader > span",
      ".diagnosticList small"
    ];

    for (const selector of selectors) {
      const color = cssRule(css, selector).match(/(?:^|[;\s])color:\s*(#[0-9a-f]{6})/i)?.[1];
      expect(color, `Expected ${selector} to declare a six-digit text color`).toBeDefined();
      expect(contrastRatio(color as string, background), `${selector} contrast`).toBeGreaterThanOrEqual(4.5);
    }
  });

  it("keeps fingerprint small text AA-readable on every composited gradient and texture endpoint", () => {
    const css = fs.readFileSync(studioCssPath, "utf8").replace(/\r\n/g, "\n");
    const fingerprintRule = cssRule(css, ".fingerprint");
    expect(fingerprintRule).toContain("rgba(233, 242, 240, .96)");
    expect(fingerprintRule).toContain("rgba(250, 246, 238, .93)");
    expect(fingerprintRule).toContain("rgba(232, 225, 235, .8)");
    expect(fingerprintRule).toContain("#f6f5ef");
    const textureRule = cssRule(css, ".fingerprint::after");
    expect(textureRule).toContain("opacity: .35;");
    expect(textureRule).toContain("rgba(75, 108, 112, .07)");

    const base = hexRgb("#f6f5ef");
    const texture = hexRgb("#4b6c70");
    const endpoints: Array<[string, number]> = [
      ["#e9f2f0", 0.96],
      ["#faf6ee", 0.93],
      ["#e8e1eb", 0.8]
    ];
    const backgrounds = endpoints.flatMap(([color, alpha]) => {
      const endpoint = alphaComposite(hexRgb(color), alpha, base);
      return [endpoint, alphaComposite(texture, 0.07 * 0.35, endpoint)];
    });

    for (const selector of [".fingerprint .panelKicker", ".keyInference span"]) {
      const color = cssRule(css, selector).match(/(?:^|[;\s])color:\s*(#[0-9a-f]{6})/i)?.[1];
      expect(color, `Expected ${selector} to declare a six-digit text color`).toBeDefined();
      const ratios = backgrounds.map((background) => contrastRatioRgb(hexRgb(color as string), background));
      expect(Math.min(...ratios), `${selector} worst composited contrast`).toBeGreaterThanOrEqual(4.5);
    }
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

  it.each([
    ["discovered", "工程已发现", "等待开始解析"],
    ["queued", "等待解析", "解析队列"],
    ["parsing", "正在解析工程", "解析正在进行"],
    ["failed", "Blue Hour 解析失败", "没有可浏览的成功快照"],
    ["stale", "工程待更新", "等待生成新快照"]
  ] as const)("shows the truthful %s state when the project has no snapshot", async (status, heading, copy) => {
    vi.mocked(studioApi.getStudioProject).mockResolvedValueOnce({
      ...project,
      status,
      latestSnapshotId: null,
      latestSnapshotSourceHash: null,
      latestSnapshotAnalyzedAt: null
    });
    render(<ProjectWorkspace projectId={`no-snapshot-${status}`} />);

    expect(await screen.findByRole("heading", { name: heading })).toBeTruthy();
    expect(screen.getByText(new RegExp(copy))).toBeTruthy();
    expect(studioApi.getStudioAnalysis).not.toHaveBeenCalled();
    expect(screen.queryByRole("heading", { name: "没有找到这个工程" })).toBeNull();
  });

  it.each([
    ["queued", "等待解析", "新一轮解析正在等待；展示上次成功快照。"],
    ["parsing", "解析中", "新一轮解析正在进行；展示上次成功快照。"],
    ["failed", "解析失败", "当前解析失败；展示上次成功快照。"],
    ["stale", "需要更新", "源工程已变化；展示上次成功快照，等待更新。"]
  ] as const)("keeps old analysis browsable while the current project is %s", async (status, statusLabel, banner) => {
    vi.mocked(studioApi.getStudioProject).mockResolvedValueOnce({ ...project, status });
    vi.mocked(studioApi.getStudioAnalysis).mockResolvedValueOnce(analysis);
    render(<ProjectWorkspace projectId={`old-snapshot-${status}`} />);

    expect(await screen.findByRole("heading", { name: "Blue Hour" })).toBeTruthy();
    expect(screen.getByText(statusLabel)).toBeTruthy();
    expect(screen.getByRole("status", { name: "快照状态" }).textContent).toContain(banner);
  });

  it("keeps the displayed snapshot's partial warning alongside the current scan status", async () => {
    vi.mocked(studioApi.getStudioProject).mockResolvedValueOnce({ ...project, status: "queued" });
    vi.mocked(studioApi.getStudioAnalysis).mockResolvedValueOnce({ ...analysis, status: "partial" });
    render(<ProjectWorkspace projectId="queued-with-partial-snapshot" />);

    expect(await screen.findByRole("heading", { name: "Blue Hour" })).toBeTruthy();
    expect(screen.getByText("等待解析")).toBeTruthy();
    expect(screen.getByRole("status", { name: "快照状态" })).toBeTruthy();
    expect(screen.getByRole("status", { name: "部分解析" })).toBeTruthy();
  });

  it.each([
    ["ready", "ready", 0],
    ["queued", "ready", 1],
    ["queued", "partial", 2]
  ] as const)("keeps the scroll viewport in one content row with %s/%s and %i notices", async (projectStatus, analysisStatus, noticeCount) => {
    vi.mocked(studioApi.getStudioProject).mockResolvedValueOnce({ ...project, status: projectStatus });
    vi.mocked(studioApi.getStudioAnalysis).mockResolvedValueOnce({ ...analysis, status: analysisStatus });
    render(<ProjectWorkspace projectId={`layout-${projectStatus}-${analysisStatus}`} />);

    expect(await screen.findByRole("heading", { name: "Blue Hour" })).toBeTruthy();
    const content = screen.getByRole("tablist", { name: "工程分析视图" }).parentElement;
    expect(content).not.toBeNull();
    expect(content?.className).toContain("workspaceContent");
    expect(screen.getByRole("tabpanel", { name: "总览" }).parentElement).toBe(content);
    const notices = screen.queryAllByRole("status");
    expect(notices).toHaveLength(noticeCount);
    for (const notice of notices) expect(notice.parentElement).toBe(content);
  });

  it("reserves one bounded flex row for tabs, notices, and the scroll viewport", () => {
    const css = fs.readFileSync(studioCssPath, "utf8").replace(/\r\n/g, "\n");

    expect(cssRule(css, ".workspaceDesk")).toContain("grid-template-rows: 62px minmax(0, 1fr);");
    expect(cssRule(css, ".workspaceContent")).toContain("display: flex;");
    expect(cssRule(css, ".workspaceContent")).toContain("flex-direction: column;");
    expect(cssRule(css, ".workspaceContent")).toContain("min-height: 0;");
    expect(cssRule(css, ".workspaceContent")).toContain("overflow: hidden;");
    expect(cssRule(css, ".workspaceTabs")).toContain("flex: none;");
    expect(cssRule(css, ".partialNotice")).toContain("flex: none;");
    expect(cssRule(css, ".snapshotNotice")).toContain("flex: none;");
    expect(cssRule(css, ".workspaceScroll")).toContain("flex: 1;");
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

  it("does not turn a missing analysis snapshot into a project 404", async () => {
    vi.mocked(studioApi.getStudioAnalysis).mockRejectedValueOnce(new ApiError("analysis snapshot missing", 404, {}));
    render(<ProjectWorkspace projectId="ready-with-missing-snapshot" />);

    expect(await screen.findByRole("heading", { name: "暂时无法读取工程" })).toBeTruthy();
    expect(screen.getByRole("alert").textContent).toContain("analysis snapshot missing");
    expect(screen.queryByRole("heading", { name: "没有找到这个工程" })).toBeNull();
  });

  it("falls back to the current queued state when its recorded snapshot is missing", async () => {
    vi.mocked(studioApi.getStudioProject).mockResolvedValueOnce({ ...project, status: "queued" });
    vi.mocked(studioApi.getStudioAnalysis).mockRejectedValueOnce(new ApiError("analysis snapshot missing", 404, {}));
    render(<ProjectWorkspace projectId="queued-with-missing-snapshot" />);

    expect(await screen.findByRole("heading", { name: "等待解析" })).toBeTruthy();
    expect(screen.getByText(/解析队列/)).toBeTruthy();
    expect(screen.queryByRole("heading", { name: "没有找到这个工程" })).toBeNull();
  });

  it("keeps a corrupt ready analysis response in the error boundary", async () => {
    vi.mocked(studioApi.getStudioAnalysis).mockRejectedValueOnce(new ApiError("analysis snapshot corrupt", 409, {}));
    render(<ProjectWorkspace projectId="ready-with-corrupt-snapshot" />);

    expect(await screen.findByRole("heading", { name: "暂时无法读取工程" })).toBeTruthy();
    expect(screen.getByRole("alert").textContent).toContain("analysis snapshot corrupt");
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

function cssRule(css: string, selector: string): string {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = css.match(new RegExp(`${escaped}\\s*\\{(?<body>[^}]*)\\}`));
  expect(match, `Expected ${selector} rule to exist`).not.toBeNull();
  return match?.groups?.body ?? "";
}

function contrastRatio(foreground: string, background: string): number {
  const lighter = Math.max(relativeLuminance(foreground), relativeLuminance(background));
  const darker = Math.min(relativeLuminance(foreground), relativeLuminance(background));
  return (lighter + 0.05) / (darker + 0.05);
}

function relativeLuminance(hex: string): number {
  return relativeLuminanceRgb(hexRgb(hex));
}

type Rgb = [number, number, number];

function hexRgb(hex: string): Rgb {
  return [1, 3, 5].map((offset) => Number.parseInt(hex.slice(offset, offset + 2), 16)) as Rgb;
}

function alphaComposite(foreground: Rgb, alpha: number, background: Rgb): Rgb {
  return foreground.map((channel, index) => channel * alpha + background[index] * (1 - alpha)) as Rgb;
}

function contrastRatioRgb(foreground: Rgb, background: Rgb): number {
  const lighter = Math.max(relativeLuminanceRgb(foreground), relativeLuminanceRgb(background));
  const darker = Math.min(relativeLuminanceRgb(foreground), relativeLuminanceRgb(background));
  return (lighter + 0.05) / (darker + 0.05);
}

function relativeLuminanceRgb(rgb: Rgb): number {
  const linear = rgb.map((value) => value / 255).map((channel) => channel <= 0.04045
    ? channel / 12.92
    : ((channel + 0.055) / 1.055) ** 2.4);
  return 0.2126 * linear[0] + 0.7152 * linear[1] + 0.0722 * linear[2];
}

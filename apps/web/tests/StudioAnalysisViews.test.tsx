import fs from "node:fs";
import path from "node:path";
import { useState } from "react";
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as studioApi from "../src/api/studioClient";
import type { StudioAnalysis, StudioProjectDetail } from "../src/api/studioTypes";
import { ArrangementAnalysis } from "../src/components/studio/ArrangementAnalysis";
import { DependencyReport } from "../src/components/studio/DependencyReport";
import { PatternExplorer } from "../src/components/studio/PatternExplorer";
import { PluginMixerView } from "../src/components/studio/PluginMixerView";
import { buildReportArrangement, ProjectReport } from "../src/components/studio/ProjectReport";
import { ProjectWorkspace } from "../src/components/studio/ProjectWorkspace";

vi.mock("../src/api/studioClient", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/api/studioClient")>();
  return {
    ...actual,
    getStudioAnalysis: vi.fn(),
    getStudioProject: vi.fn(),
    openStudioAsset: vi.fn()
  };
});

const project: StudioProjectDetail = {
  id: "p-arrangement",
  canonicalPath: "D:/Music/Rain Memory.flp",
  displayName: "Rain Memory",
  status: "ready",
  modifiedAt: "2026-07-14T10:00:00Z",
  latestSnapshotId: "snapshot-1",
  createdAt: "2026-07-14T09:00:00Z",
  updatedAt: "2026-07-14T10:01:00Z",
  tempo: 124,
  patternCount: 3,
  warningCount: 0,
  errorCount: 0,
  diagnosticCount: 0,
  inferredKey: "D minor",
  latestSnapshotSourceHash: "hash-1",
  latestSnapshotAnalyzedAt: "2026-07-14T10:01:00Z"
};

const analysis: StudioAnalysis = {
  sourcePath: project.canonicalPath,
  sourceHash: "hash-1",
  status: "ready",
  project: {
    title: "Rain Memory",
    author: null,
    flVersion: "21.2",
    tempo: 124,
    ppq: 96,
    timeSignatureNumerator: 4,
    timeSignatureDenominator: 4,
    createdAt: null,
    timeSpentSeconds: null
  },
  patterns: [
    {
      id: "pat-verse",
      name: "Verse",
      usedInPlaylist: true,
      notes: [
        { key: 50, position: 0, length: 96, velocity: 82, channelId: "ch-keys" },
        { key: 62, position: 96, length: 96, velocity: 108, channelId: "ch-keys" },
        { key: 65, position: 192, length: 48, velocity: 94, channelId: null }
      ]
    },
    {
      id: "pat-verse-alt",
      name: "Verse Alt",
      usedInPlaylist: true,
      notes: [
        { key: 53, position: 0, length: 96, velocity: 88, channelId: "ch-keys" },
        { key: 65, position: 96, length: 96, velocity: 104, channelId: "ch-keys" },
        { key: 68, position: 192, length: 48, velocity: 92, channelId: "ch-keys" }
      ]
    },
    { id: "pat-empty", name: "Empty Idea", usedInPlaylist: false, notes: [] }
  ],
  channels: [{ id: "ch-keys", name: "Keys", pluginName: "FLEX", channelType: "instrument" }],
  playlistClips: [
    { id: "clip-verse", trackIndex: 1, start: 0, length: 384, clipType: "pattern", sourceId: "pat-verse" },
    { id: "clip-verse-alt", trackIndex: 2, start: 384, length: 384, clipType: "pattern", sourceId: "pat-verse-alt" },
    { id: "clip-late", trackIndex: 1, start: 3072, length: 384, clipType: "automation", sourceId: null }
  ],
  plugins: [],
  mixerInserts: [],
  automations: [],
  relatedAssets: [],
  dependencies: [],
  fingerprint: {
    noteMin: 50,
    noteMax: 68,
    noteDensity: 0.75,
    velocityMean: 94.7,
    patternReuse: 0.67,
    inferredKey: "D minor",
    inferredKeyConfidence: 0.82,
    inferredKeyEvidence: ["D 音级重心", "A–D 终止倾向"]
  },
  diagnostics: [],
  unknownEventCount: 0
};

beforeEach(() => {
  vi.mocked(studioApi.getStudioProject).mockResolvedValue(project);
  vi.mocked(studioApi.getStudioAnalysis).mockResolvedValue(analysis);
  vi.mocked(studioApi.openStudioAsset).mockReset();
  vi.mocked(studioApi.openStudioAsset).mockResolvedValue(undefined);
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("arrangement and Pattern workspace", () => {
  it("links a Playlist Pattern clip to the selected Pattern tab", async () => {
    render(<ProjectWorkspace projectId="p-arrangement" />);

    await screen.findByRole("heading", { name: "Rain Memory" });
    fireEvent.click(screen.getByRole("tab", { name: "编曲" }));
    fireEvent.click(screen.getByRole("button", { name: "Verse clip at bar 1" }));

    expect(screen.getByRole("tab", { name: "Pattern" }).getAttribute("aria-selected")).toBe("true");
    expect(screen.getByRole("heading", { name: "Verse" })).toBeTruthy();
    expect(screen.getByLabelText("Verse Piano Roll")).toBeTruthy();
  });

  it("zooms the complete arrangement and scrolls the timeline from the keyboard", () => {
    render(<ArrangementAnalysis analysis={analysis} onSelectPattern={() => undefined} />);

    const timeline = screen.getByLabelText("Playlist 编曲时间线") as HTMLElement;
    Object.defineProperties(timeline, {
      clientWidth: { configurable: true, value: 600 },
      scrollWidth: { configurable: true, value: 2400 }
    });

    fireEvent.click(screen.getByRole("button", { name: "4×" }));
    expect(screen.getByRole("button", { name: "4×" }).getAttribute("aria-pressed")).toBe("true");
    expect(screen.getByTestId("arrangement-canvas").getAttribute("data-zoom")).toBe("4");

    timeline.scrollLeft = 0;
    fireEvent.keyDown(timeline, { key: "ArrowRight" });
    expect(timeline.scrollLeft).toBeGreaterThan(0);
    expect(screen.getByLabelText("编曲密度覆盖层")).toBeTruthy();
    expect(screen.getAllByTitle(/长空白/).length).toBeGreaterThan(0);
    expect(timeline.querySelectorAll("[data-grid-cell]")).toHaveLength(0);
  });

  it("aligns ruler, density, gaps, and clips to one gutter-free time field", () => {
    render(<ArrangementAnalysis analysis={analysis} onSelectPattern={() => undefined} />);

    const timeField = screen.getByTestId("arrangement-time-field");
    const clip = screen.getByRole("button", { name: "Verse clip at bar 1" });
    expect(timeField.getAttribute("data-time-origin")).toBe("track-gutter");
    expect(within(timeField).getByLabelText("编曲密度覆盖层")).toBeTruthy();
    expect(within(timeField).getAllByTitle(/长空白/).length).toBeGreaterThan(0);
    expect(clip.parentElement?.getAttribute("data-time-origin")).toBe("track-gutter");
    expect(timeField.querySelector('[data-ruler-tick="0"]')?.getAttribute("style")).toContain("left: 0%");
    expect(clip.getAttribute("style")).toContain("left: 0%");

    const css = fs.readFileSync(path.resolve(__dirname, "../src/components/studio/Studio.module.css"), "utf8");
    expect(css).toContain("--track-gutter: 72px;");
    expect(css).toMatch(/\.arrangementTimeField\s*\{[^}]*left:\s*var\(--track-gutter\)[^}]*right:\s*var\(--time-field-end\)/s);
    expect(css).toMatch(/\.trackLane\s*\{[^}]*grid-template-columns:\s*var\(--track-gutter\) minmax\(0, 1fr\)/s);
  });

  it("labels half-open long gaps without including the ending bar", () => {
    const gapBoundary: StudioAnalysis = {
      ...analysis,
      playlistClips: [
        { id: "before-gap", trackIndex: 1, start: 0, length: 768, clipType: "pattern", sourceId: "pat-verse" },
        { id: "after-gap", trackIndex: 1, start: 3072, length: 384, clipType: "pattern", sourceId: "pat-verse" }
      ]
    };

    render(<ArrangementAnalysis analysis={gapBoundary} onSelectPattern={() => undefined} />);

    expect(screen.getByTitle("长空白：第 3–8 小节")).toBeTruthy();
    expect(screen.queryByTitle("长空白：第 3–9 小节")).toBeNull();
  });
});

describe("plugin, Mixer, and dependency workspace", () => {
  it("opens the plugin and dependency analysis tabs", async () => {
    vi.mocked(studioApi.getStudioAnalysis).mockResolvedValue({
      ...analysis,
      channels: [{ id: "ch-flex", name: "Keys", pluginName: "FLEX", channelType: "instrument" }],
      plugins: [{ id: "plugin-flex", name: "FLEX", kind: "generator", location: "channel:ch-flex", stateSupported: true }],
      mixerInserts: [{ id: "insert-4", name: "Insert 4", slotPluginIds: ["plugin-flex"], routeTargetIds: [] }],
      dependencies: [{ path: "D:/Music/Audio/vocal_take_03.wav", kind: "audio", exists: false }]
    });
    render(<ProjectWorkspace projectId="p-arrangement" />);

    await screen.findByRole("heading", { name: "Rain Memory" });
    fireEvent.click(screen.getByRole("tab", { name: "插件与 Mixer" }));
    expect(screen.getByRole("heading", { name: "Plugin & Mixer" })).toBeTruthy();
    expect(screen.getByLabelText("Mixer 路由图")).toBeTruthy();

    fireEvent.click(screen.getByRole("tab", { name: "依赖" }));
    expect(screen.getByText("vocal_take_03.wav")).toBeTruthy();
    expect(screen.getByRole("button", { name: "查看 vocal_take_03.wav 所在位置" }).hasAttribute("disabled")).toBe(true);
  });

  it("filters plugin sources and keeps effect-chain and automation resolution truthful", () => {
    const detailed = signalAnalysis();
    render(<PluginMixerView analysis={detailed} />);

    expect(screen.getByText("状态不支持")).toBeTruthy();
    expect(screen.getByText("Missing FX ID")).toBeTruthy();
    expect(screen.getByText("插件 ID 未解析")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Insert 4 · 已解析" })).toBeTruthy();
    expect(screen.getByText("Mystery target · 未解析")).toBeTruthy();
    expect(screen.getByText("快照未提供原生/第三方来源，只报告生成器、效果器等功能类别。")).toBeTruthy();
    const initialChains = screen.getByLabelText("Mixer 效果链");
    fireEvent.click(within(screen.getByRole("table")).getByRole("button", { name: "mixer:insert-4:slot:0" }));
    expect(within(initialChains).getByRole("button", { name: "Insert 4" }).closest("section")?.getAttribute("data-selected")).toBe("true");

    fireEvent.click(screen.getByRole("button", { name: "效果器" }));
    const table = screen.getByRole("table");
    expect(within(table).getByText("Serum")).toBeTruthy();
    expect(within(table).getByText("effect")).toBeTruthy();
    expect(within(table).queryByText("FLEX")).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "生成器" }));
    expect(within(table).getByText("FLEX")).toBeTruthy();
    expect(within(table).getByText("Audio Clip")).toBeTruthy();
    expect(within(table).getAllByText("generator")).toHaveLength(2);
    expect(within(table).queryByText("Serum")).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "未分类" }));
    expect(within(table).getByText("Mystery")).toBeTruthy();
    expect(within(table).getByText("wrapper")).toBeTruthy();
    expect(within(table).queryByText("FLEX")).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "全部" }));
    fireEvent.click(within(screen.getByRole("table")).getByRole("button", { name: "channel:ch-flex" }));
    expect(within(screen.getByLabelText("Channel Rack")).getByRole("button", { name: /Keys/ }).closest("li")?.getAttribute("data-selected")).toBe("true");
    fireEvent.click(within(screen.getByRole("table")).getByRole("button", { name: "mixer:insert-4:slot:x" }));
    expect(within(screen.getByRole("table")).getByRole("row", { name: /Audio Clip/ }).getAttribute("data-selected")).toBe("true");
    const chains = screen.getByLabelText("Mixer 效果链");
    fireEvent.click(within(chains).getByRole("button", { name: "Insert 4", exact: true }));
    expect(within(chains).getByRole("button", { name: "Insert 4", exact: true }).closest("section")?.getAttribute("data-selected")).toBe("true");
  });

  it("links same-name Channel plugins by exact parser location or instance id", () => {
    const sameName: StudioAnalysis = {
      ...analysis,
      channels: [
        { id: "1", name: "FLEX one", pluginName: "FLEX", channelType: "instrument" },
        { id: "2", name: "FLEX two", pluginName: "FLEX", channelType: "instrument" }
      ],
      plugins: [
        { id: "plugin-flex-one", name: "FLEX", kind: "generator", location: "channel:1", stateSupported: true },
        { id: "channel:2", name: "FLEX", kind: "generator", location: "", stateSupported: true }
      ],
      mixerInserts: []
    };
    render(<PluginMixerView analysis={sameName} />);
    const rack = screen.getByLabelText("Channel Rack");
    const first = within(rack).getByRole("button", { name: /FLEX one/ }).closest("li")!;
    const second = within(rack).getByRole("button", { name: /FLEX two/ }).closest("li")!;

    expect(within(first).getByText("已关联").getAttribute("title")).toContain("plugin-flex-one");
    expect(within(second).getByText("已关联").getAttribute("title")).toContain("channel:2");
  });

  it("rejects conflicting, duplicate, and malformed exact Channel plugin metadata", () => {
    const boundaries: StudioAnalysis = {
      ...analysis,
      channels: [
        { id: "3", name: "Consistent", pluginName: "Exact", channelType: "instrument" },
        { id: "4", name: "Conflict source", pluginName: "Conflict", channelType: "instrument" },
        { id: "5", name: "Conflict target", pluginName: "Conflict", channelType: "instrument" },
        { id: "6", name: "Duplicate", pluginName: "Duplicate", channelType: "instrument" },
        { id: "7", name: "Malformed", pluginName: "Malformed", channelType: "instrument" },
        { id: "8", name: "Legacy", pluginName: "Legacy", channelType: "instrument" }
      ],
      plugins: [
        { id: "channel:3", name: "Exact", kind: "generator", location: "channel:3", stateSupported: true },
        { id: "channel:4", name: "Conflict", kind: "generator", location: "channel:5", stateSupported: true },
        { id: "duplicate-a", name: "Duplicate", kind: "generator", location: "channel:6", stateSupported: true },
        { id: "duplicate-b", name: "Duplicate", kind: "generator", location: "channel:6", stateSupported: true },
        { id: "malformed", name: "Malformed", kind: "generator", location: "channel:", stateSupported: true },
        { id: "legacy", name: "Legacy", kind: "generator", location: "unknown", stateSupported: true }
      ],
      mixerInserts: []
    };
    render(<PluginMixerView analysis={boundaries} />);
    const rack = screen.getByLabelText("Channel Rack");
    const row = (name: string) => within(rack).getByRole("button", { name: new RegExp(name) }).closest("li")!;

    expect(within(row("Consistent")).getByText("已关联").getAttribute("title")).toContain("channel:3");
    expect(within(row("Legacy")).getByText("已关联").getAttribute("title")).toContain("legacy");
    for (const name of ["Conflict source", "Conflict target", "Duplicate", "Malformed"]) {
      expect(within(row(name)).getByText("未解析")).toBeTruthy();
    }
  });

  it("treats selectedTarget null as a controlled clear and undefined as uncontrolled", () => {
    const detailed = signalAnalysis();
    const flexTarget = { type: "plugin", id: "plugin-flex" } as const;
    const { rerender } = render(<PluginMixerView analysis={detailed} selectedTarget={flexTarget} />);
    const row = (name: string) => within(screen.getByRole("table")).getByRole("row", { name: new RegExp(name) });
    expect(row("FLEX").getAttribute("data-selected")).toBe("true");

    fireEvent.click(within(row("Audio Clip")).getByRole("button", { name: "mixer:insert-4:slot:x" }));
    expect(row("FLEX").getAttribute("data-selected")).toBe("true");
    expect(row("Audio Clip").getAttribute("data-selected")).toBe("false");

    rerender(<PluginMixerView analysis={detailed} selectedTarget={null} />);
    expect(row("FLEX").getAttribute("data-selected")).toBe("false");
    expect(row("Audio Clip").getAttribute("data-selected")).toBe("false");

    rerender(<PluginMixerView analysis={detailed} selectedTarget={undefined} />);
    expect(row("Audio Clip").getAttribute("data-selected")).toBe("true");
  });

  it("disables diagnostic navigation for duplicate Pattern, Channel, plugin, and Mixer ids", () => {
    const duplicateTargets: StudioAnalysis = {
      ...analysis,
      patterns: [analysis.patterns[0], { ...analysis.patterns[0], name: "Verse duplicate" }],
      channels: [analysis.channels[0], { ...analysis.channels[0], name: "Keys duplicate" }],
      plugins: [
        { id: "plugin-dup", name: "One", kind: "generator", location: "", stateSupported: true },
        { id: "plugin-dup", name: "Two", kind: "generator", location: "", stateSupported: true }
      ],
      mixerInserts: [
        { id: "insert-dup", name: "One", slotPluginIds: [], routeTargetIds: [] },
        { id: "insert-dup", name: "Two", slotPluginIds: [], routeTargetIds: [] }
      ],
      diagnostics: [
        { code: "dup-pattern", severity: "warning", message: "duplicate", targetType: "pattern", targetId: analysis.patterns[0].id },
        { code: "dup-channel", severity: "warning", message: "duplicate", targetType: "channel", targetId: analysis.channels[0].id },
        { code: "dup-plugin", severity: "warning", message: "duplicate", targetType: "plugin", targetId: "plugin-dup" },
        { code: "dup-mixer", severity: "warning", message: "duplicate", targetType: "mixer_insert", targetId: "insert-dup" }
      ]
    };
    render(<DependencyReport analysis={duplicateTargets} />);
    const disabled = screen.getAllByRole("button", { name: "无法定位" });
    expect(disabled).toHaveLength(4);
    expect(disabled.every((button) => button.hasAttribute("disabled"))).toBe(true);
  });

  it("keeps ARIA ids unique and references inside each Task11 view instance", () => {
    const detailed = signalAnalysis();
    const { container } = render(<>
      <PluginMixerView analysis={detailed} />
      <PluginMixerView analysis={detailed} />
      <DependencyReport analysis={detailed} />
      <DependencyReport analysis={detailed} />
    </>);
    const ids = [...container.querySelectorAll<HTMLElement>("[id]")].map((element) => element.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const article of container.querySelectorAll("article")) {
      for (const element of article.querySelectorAll<HTMLElement>("[aria-labelledby]")) {
        for (const id of (element.getAttribute("aria-labelledby") || "").split(/\s+/).filter(Boolean)) {
          const target = document.getElementById(id);
          expect(target, `missing ${id}`).toBeTruthy();
          expect(article.contains(target), `${id} escaped its instance`).toBe(true);
        }
      }
    }
  });

  it("prevents Space on Mixer SVG nodes from scrolling while activating selection", () => {
    const onSelect = vi.fn();
    render(<PluginMixerView analysis={signalAnalysis()} onSelectTarget={onSelect} />);
    const graph = screen.getByLabelText("Mixer 路由图");
    const node = graph.querySelector<SVGGElement>('[data-route-node="true"]')!;
    const scrollHost = graph.closest("figure") as HTMLElement;
    scrollHost.scrollTop = 17;
    const event = new KeyboardEvent("keydown", { key: " ", bubbles: true, cancelable: true });
    act(() => node.dispatchEvent(event));

    expect(event.defaultPrevented).toBe(true);
    expect(scrollHost.scrollTop).toBe(17);
    expect(onSelect).toHaveBeenCalledWith({ type: "mixer_insert", id: "insert-4" });
  });

  it("keeps Task11 metadata at readable sizes and WCAG contrast", () => {
    const css = fs.readFileSync(path.resolve(__dirname, "../src/components/studio/Studio.module.css"), "utf8");
    const cases = [
      [".sourceBadge, .stateBadge", "#fffefa", "color"],
      [".effectChains li > small", "#fffefa", "color"],
      [".dependencyGroup li small", "#fffefa", "color"],
      [".diagnosticTargetGroup > h4", "#fffefa", "color"],
      [".routeGraph text + text", "#f7faf6", "fill"]
    ] as const;
    for (const [selector, background, colorProperty] of cases) {
      const rule = cssRule(css, selector);
      const size = Number.parseFloat(cssDeclaration(rule, "font-size"));
      const color = cssDeclaration(rule, colorProperty);
      expect(size, `${selector} font-size`).toBeGreaterThanOrEqual(10);
      expect(contrastRatio(color, background), `${selector} contrast`).toBeGreaterThanOrEqual(4.5);
    }
  });

  it("bounds large cyclic Mixer graphs and reports hidden and unresolved routes in text", () => {
    const total = 110;
    const inserts = Array.from({ length: total }, (_, index) => ({
      id: `insert-${index}`,
      name: `Insert ${index}`,
      slotPluginIds: index === total - 1 ? ["missing-plugin"] : [],
      routeTargetIds: index === total - 1
        ? ["missing-target", "insert-0"]
        : index === 0 ? ["insert-1", "empty"] : [`insert-${(index + 1) % total}`]
    }));
    const large: StudioAnalysis = { ...signalAnalysis(), plugins: [], mixerInserts: [{ id: "empty", name: "Empty", slotPluginIds: [], routeTargetIds: [] }, ...inserts] };
    render(<PluginMixerView analysis={large} />);

    const graph = screen.getByLabelText("Mixer 路由图");
    expect(graph.querySelectorAll('[data-route-node="true"]')).toHaveLength(64);
    expect(graph.querySelectorAll('[data-route-edge="true"]').length).toBeLessThanOrEqual(128);
    expect(screen.getAllByText(/110 个有效 Insert，112 条路由；绘制 64 个节点/).length).toBeGreaterThan(0);
    expect(screen.getByText(/1 条路由目标未解析/)).toBeTruthy();
    expect(screen.getByText("大型路由图已限量绘制；完整数量保留在文字摘要中。")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Empty" })).toBeNull();
  });

  it("separates missing and available dependencies while explaining the unknowable group", () => {
    const detailed = signalAnalysis();
    render(<DependencyReport analysis={detailed} />);

    const missing = screen.getByRole("region", { name: "缺失" });
    const available = screen.getByRole("region", { name: "可用" });
    const unknown = screen.getByRole("region", { name: "未知" });
    expect(within(missing).getByText("vocal_take_03.wav")).toBeTruthy();
    expect(within(available).getByText("kick.wav")).toBeTruthy();
    expect(within(unknown).getByText("FactoryData")).toBeTruthy();
    expect(within(unknown).getByText(/解析器明确标记为未解析/)).toBeTruthy();
    expect(within(unknown).queryByText("vocal_take_03.wav")).toBeNull();
    const locate = within(missing).getByRole("button", { name: "查看 vocal_take_03.wav 所在位置" });
    expect(locate.hasAttribute("disabled")).toBe(true);
    expect(screen.getAllByText("请从工程详情页使用本地定位").length).toBeGreaterThan(0);
  });

  it("classifies only exact unresolved dependency targets as unknown across duplicate paths", () => {
    const factoryPath = "C:/FL/FactoryData";
    const boundary: StudioAnalysis = {
      ...analysis,
      dependencies: [
        { path: factoryPath, kind: "factory_data", exists: false },
        { path: factoryPath, kind: "factory_data", exists: false },
        { path: factoryPath, kind: "factory_data", exists: true },
        { path: "C:/Samples/plain-missing.wav", kind: "audio", exists: false },
        { path: "C:/Samples/no-target.wav", kind: "audio", exists: false },
        { path: "C:/Samples/mismatch.wav", kind: "audio", exists: false },
        { path: "C:/Samples/wrong-type.wav", kind: "audio", exists: false }
      ],
      diagnostics: [
        { code: "unresolved_dependency", severity: "warning", message: "Factory lookup unavailable", targetType: "dependency", targetId: factoryPath },
        { code: "unresolved_dependency", severity: "warning", message: "No target", targetType: "dependency", targetId: null },
        { code: "unresolved_dependency", severity: "warning", message: "Different path", targetType: "dependency", targetId: "C:/Samples/other.wav" },
        { code: "unresolved_dependency", severity: "warning", message: "Wrong target type", targetType: "channel", targetId: "C:/Samples/wrong-type.wav" }
      ]
    };
    render(<DependencyReport analysis={boundary} />);

    const missing = screen.getByRole("region", { name: "缺失" });
    const available = screen.getByRole("region", { name: "可用" });
    const unknown = screen.getByRole("region", { name: "未知" });
    expect(within(unknown).getAllByText("FactoryData")).toHaveLength(2);
    expect(within(available).getByText("FactoryData")).toBeTruthy();
    expect(within(missing).getByText("plain-missing.wav")).toBeTruthy();
    expect(within(missing).getByText("no-target.wav")).toBeTruthy();
    expect(within(missing).getByText("mismatch.wav")).toBeTruthy();
    expect(within(missing).getByText("wrong-type.wav")).toBeTruthy();
    expect(within(unknown).getAllByRole("button", { name: "查看 FactoryData 所在位置" })).toHaveLength(2);
  });

  it("does not navigate malformed or ambiguous parser locations", () => {
    const ambiguous: StudioAnalysis = {
      ...analysis,
      channels: [
        { id: "dup", name: "First", pluginName: null, channelType: "instrument" },
        { id: "dup", name: "Second", pluginName: null, channelType: "instrument" }
      ],
      plugins: [
        { id: "ambiguous", name: "Ambiguous", kind: "generator", location: "channel:dup", stateSupported: true },
        { id: "malformed", name: "Malformed", kind: "effect", location: "mixer:insert-4:slot:x", stateSupported: true },
        { id: "unknown-location", name: "Unknown location", kind: "effect", location: "track:12", stateSupported: true }
      ],
      mixerInserts: [{ id: "insert-4", name: "Insert 4", slotPluginIds: ["malformed"], routeTargetIds: [] }]
    };
    render(<PluginMixerView analysis={ambiguous} />);
    const table = screen.getByRole("table");

    for (const location of ["channel:dup", "mixer:insert-4:slot:x", "track:12"]) {
      fireEvent.click(within(table).getByRole("button", { name: location }));
      expect(within(table).getByRole("button", { name: location }).closest("tr")?.getAttribute("data-selected")).toBe("true");
    }
    expect(within(screen.getByLabelText("Mixer 效果链")).getByRole("button", { name: "Insert 4" }).closest("section")?.getAttribute("data-selected")).toBe("false");
  });

  it("explains empty signal and dependency snapshots without inventing records", () => {
    const empty: StudioAnalysis = { ...analysis, channels: [], plugins: [], mixerInserts: [], automations: [], dependencies: [], diagnostics: [] };
    const { rerender } = render(<PluginMixerView analysis={empty} />);
    expect(screen.getByText("快照没有报告 Channel。")).toBeTruthy();
    expect(screen.getByText("快照没有报告插件实例。")).toBeTruthy();
    expect(screen.getByText("没有带插件或路由的 Mixer Insert；空 Insert 已折叠。")).toBeTruthy();
    expect(screen.getByText("快照没有报告自动化。")).toBeTruthy();

    rerender(<DependencyReport analysis={empty} />);
    expect(screen.getByRole("region", { name: "未知" }).textContent).toContain("这个快照没有依赖数据");
    expect(screen.getByText("快照没有报告解析诊断。")).toBeTruthy();
  });

  it("navigates only diagnostics with targets present in the snapshot", () => {
    const onNavigate = vi.fn();
    render(<DependencyReport analysis={signalAnalysis()} onNavigate={onNavigate} />);

    const patternGroup = screen.getByRole("heading", { name: "pattern · pat-verse" }).closest("section")!;
    fireEvent.click(within(patternGroup).getByRole("button", { name: "查看目标" }));
    expect(onNavigate).toHaveBeenLastCalledWith({ tab: "pattern", patternId: "pat-verse" });

    const mixerGroup = screen.getByRole("heading", { name: "mixer_insert · insert-4" }).closest("section")!;
    fireEvent.click(within(mixerGroup).getByRole("button", { name: "查看目标" }));
    expect(onNavigate).toHaveBeenLastCalledWith({ tab: "plugins", target: { type: "mixer_insert", id: "insert-4" } });

    const missingGroup = screen.getByRole("heading", { name: "plugin · absent-plugin" }).closest("section")!;
    const disabled = within(missingGroup).getByRole("button", { name: "无法定位" });
    expect(disabled.hasAttribute("disabled")).toBe(true);
    expect(disabled.getAttribute("title")).toContain("无法识别");
  });

  it("switches from diagnostics to a selected Pattern and Mixer insert", async () => {
    vi.mocked(studioApi.getStudioAnalysis).mockResolvedValue(signalAnalysis());
    render(<ProjectWorkspace projectId="p-arrangement" />);
    await screen.findByRole("heading", { name: "Rain Memory" });

    fireEvent.click(screen.getByRole("tab", { name: "依赖" }));
    const patternGroup = screen.getByRole("heading", { name: "pattern · pat-verse" }).closest("section")!;
    fireEvent.click(within(patternGroup).getByRole("button", { name: "查看目标" }));
    expect(screen.getByRole("tab", { name: "Pattern" }).getAttribute("aria-selected")).toBe("true");
    expect(screen.getByRole("heading", { name: "Verse" })).toBeTruthy();

    fireEvent.click(screen.getByRole("tab", { name: "依赖" }));
    const mixerGroup = screen.getByRole("heading", { name: "mixer_insert · insert-4" }).closest("section")!;
    fireEvent.click(within(mixerGroup).getByRole("button", { name: "查看目标" }));
    expect(screen.getByRole("tab", { name: "插件与 Mixer" }).getAttribute("aria-selected")).toBe("true");
    expect(within(screen.getByLabelText("Mixer 效果链")).getByRole("button", { name: "Insert 4", exact: true }).closest("section")?.getAttribute("data-selected")).toBe("true");
  });

  it("covers responsive and reduced-motion behavior without unbounded SVG styling", () => {
    const css = fs.readFileSync(path.resolve(__dirname, "../src/components/studio/Studio.module.css"), "utf8");
    expect(css).toMatch(/@media \(max-width: 660px\)[\s\S]*\.dependencyColumns\s*\{\s*grid-template-columns:\s*1fr/);
    expect(css).toMatch(/@media \(prefers-reduced-motion: reduce\)[\s\S]*\.pluginKindFilters button/);
    expect(css).toMatch(/\.routeGraph\s*\{[^}]*max-height:\s*440px/s);
  });
});

describe("safe local actions and editorial report", () => {
  it("opens only registered project actions and reports asynchronous errors", async () => {
    vi.mocked(studioApi.openStudioAsset)
      .mockResolvedValueOnce(undefined)
      .mockRejectedValueOnce(new Error("本地目标已不存在"));
    render(<ProjectWorkspace projectId="p-arrangement" />);
    await screen.findByRole("heading", { name: "Rain Memory" });

    fireEvent.click(screen.getByRole("button", { name: "打开 FLP" }));
    await waitFor(() => expect(studioApi.openStudioAsset).toHaveBeenCalledWith(
      "p-arrangement",
      { kind: "project" },
      expect.objectContaining({ signal: expect.any(AbortSignal) })
    ));

    fireEvent.click(screen.getByRole("button", { name: "打开所在文件夹" }));
    expect((await screen.findByRole("alert")).textContent).toContain("本地目标已不存在");
    expect(studioApi.openStudioAsset).toHaveBeenLastCalledWith(
      "p-arrangement",
      { kind: "folder" },
      expect.objectContaining({ signal: expect.any(AbortSignal) })
    );
  });

  it("opens a dependency by opaque entity id and keeps missing ids disabled", async () => {
    vi.mocked(studioApi.openStudioAsset).mockResolvedValue(undefined);
    const withEntityIds: StudioAnalysis = {
      ...signalAnalysis(),
      dependencies: [
        { path: "D:/Music/Audio/kick.wav", kind: "audio", exists: true, entityId: "dependency_safe" },
        { path: "D:/Music/Audio/legacy.wav", kind: "audio", exists: true }
      ],
      diagnostics: []
    };
    render(<DependencyReport analysis={withEntityIds} projectId="p-arrangement" />);

    fireEvent.click(screen.getByRole("button", { name: "查看 kick.wav 所在位置" }));
    await waitFor(() => expect(studioApi.openStudioAsset).toHaveBeenCalledWith(
      "p-arrangement",
      { kind: "dependency", entityId: "dependency_safe" },
      expect.objectContaining({ signal: expect.any(AbortSignal) })
    ));
    expect(screen.getByRole("button", { name: "查看 legacy.wav 所在位置" }).hasAttribute("disabled")).toBe(true);
  });

  it("clears dependency open state and ignores stale settlement when project changes", async () => {
    let rejectOpen!: (cause: unknown) => void;
    let signal: AbortSignal | undefined;
    vi.mocked(studioApi.openStudioAsset).mockImplementation((_projectId, _action, options) => new Promise((_resolve, reject) => {
      signal = options.signal;
      rejectOpen = reject;
    }));
    const withEntityIds: StudioAnalysis = {
      ...signalAnalysis(),
      dependencies: [{ path: "D:/Music/Audio/kick.wav", kind: "audio", exists: true, entityId: "dependency_safe" }],
      diagnostics: []
    };
    const view = render(<DependencyReport analysis={withEntityIds} projectId="project-a" />);
    const button = screen.getByRole("button", { name: "查看 kick.wav 所在位置" });
    fireEvent.click(button);
    expect(button.hasAttribute("disabled")).toBe(true);

    view.rerender(<DependencyReport analysis={withEntityIds} projectId="project-b" />);

    await waitFor(() => expect(signal?.aborted).toBe(true));
    expect(screen.getByRole("button", { name: "查看 kick.wav 所在位置" }).hasAttribute("disabled")).toBe(false);
    await act(async () => rejectOpen(new Error("stale dependency failure")));
    expect(screen.queryByText("stale dependency failure")).toBeNull();
  });

  it("clears a dependency open error immediately when project changes", async () => {
    vi.mocked(studioApi.openStudioAsset).mockRejectedValue(new Error("旧工程定位失败"));
    const withEntityIds: StudioAnalysis = {
      ...signalAnalysis(),
      dependencies: [{ path: "D:/Music/Audio/kick.wav", kind: "audio", exists: true, entityId: "dependency_safe" }],
      diagnostics: []
    };
    const view = render(<DependencyReport analysis={withEntityIds} projectId="project-a" />);
    fireEvent.click(screen.getByRole("button", { name: "查看 kick.wav 所在位置" }));
    expect((await screen.findByRole("alert")).textContent).toContain("旧工程定位失败");

    view.rerender(<DependencyReport analysis={withEntityIds} projectId="project-b" />);

    await waitFor(() => expect(screen.queryByText("旧工程定位失败")).toBeNull());
  });

  it("renders a truthful print dossier and calls the browser print action", () => {
    const print = vi.fn();
    vi.stubGlobal("print", print);
    render(<ProjectReport project={project} analysis={signalAnalysis()} />);

    expect(screen.getByRole("heading", { name: "Rain Memory" })).toBeTruthy();
    expect(screen.getByRole("region", { name: "音乐指纹摘要" }).textContent).toContain("D minor");
    expect(screen.getByRole("img", { name: "编曲结构缩略图" })).toBeTruthy();
    expect(screen.getByRole("region", { name: "插件与依赖统计" }).textContent).toContain("4");
    expect(screen.getByRole("region", { name: "解析覆盖" }).textContent).toContain("未知事件");
    expect(screen.getByRole("region", { name: "诊断摘录" }).textContent).toContain("pattern_note_gap");

    fireEvent.click(screen.getByRole("button", { name: "打印报告" }));
    expect(print).toHaveBeenCalledTimes(1);
  });

  it("precomputes the report track map once for a 50k clip arrangement", () => {
    let trackIndexReads = 0;
    const clips: StudioAnalysis["playlistClips"] = Array.from({ length: 50_000 }, (_, index) => ({
      id: `clip-${index}`,
      get trackIndex() {
        trackIndexReads += 1;
        return index % 64;
      },
      start: index * 24,
      length: 24,
      clipType: "pattern",
      sourceId: null
    }));

    const arrangement = buildReportArrangement(clips);

    expect(arrangement.validClipCount).toBe(50_000);
    expect(arrangement.trackCount).toBe(64);
    expect(arrangement.displayed).toHaveLength(120);
    expect(trackIndexReads).toBe(50_000 + 120);
  });

  it("uses the dependency view classification for available, missing, and unknown report counts", () => {
    render(<ProjectReport project={project} analysis={signalAnalysis()} />);

    const inventory = screen.getByRole("region", { name: "插件与依赖统计" });
    expect(inventory.textContent).toMatch(/可用依赖1/);
    expect(inventory.textContent).toMatch(/缺失依赖1/);
    expect(inventory.textContent).toMatch(/未知依赖1/);
  });

  it.each([
    ["ready", "当前工程状态：解析完成"],
    ["partial", "当前可用快照仅部分解析"],
    ["queued", "工程等待重新解析；本报告展示上次成功快照"],
    ["failed", "最近解析失败；本报告展示上次成功快照"],
    ["stale", "工程文件已变化；本报告展示上次成功快照"]
  ] as const)("keeps the %s report state explicit on screen and print", (status, copy) => {
    render(<ProjectReport project={{ ...project, status }} analysis={{ ...signalAnalysis(), status: status === "partial" ? "partial" : "ready" }} />);

    const reportStatus = screen.getByRole("status", { name: "报告状态" });
    expect(reportStatus.textContent).toContain(copy);
    expect(reportStatus.textContent).toContain(`快照状态：${status === "partial" ? "PARTIAL" : "READY"}`);

    const css = fs.readFileSync(path.resolve(__dirname, "../src/components/studio/Studio.module.css"), "utf8");
    expect(css).toMatch(/@media print[\s\S]*\.reportStatus[\s\S]*font-size:\s*12pt/);
  });

  it("keeps every non-disabled report small-text style at WCAG AA on screen and print backgrounds", () => {
    const css = fs.readFileSync(path.resolve(__dirname, "../src/components/studio/Studio.module.css"), "utf8");
    const selectors = [
      ".reportEdition", ".reportSectionLabel", ".reportActions small", ".reportMetadata dt",
      ".reportKeyMark span", ".reportFingerprint dt", ".reportCounts dt", ".reportCoverage dt",
      ".reportEvidence", ".reportCounts > p", ".reportCoverage > p", ".reportSectionHeading span",
      ".reportSectionHeading p", ".reportArrangement > small", ".reportDiagnostics > small",
      ".reportDiagnostics li > span", ".reportDiagnostics strong", ".reportDiagnostics p",
      ".reportCoverage code", ".reportEmpty", ".reportStatus"
    ];
    for (const selector of selectors) {
      const rule = styleRule(css, selector);
      const color = rule.match(/(?:^|[;\s])color:\s*(#[0-9a-f]{6})/i)?.[1];
      const size = Number(rule.match(/font-size:\s*([0-9.]+)px/i)?.[1]);
      expect(color, `${selector} explicit color`).toBeDefined();
      expect(size, `${selector} readable size`).toBeGreaterThanOrEqual(11);
      expect(wcagContrast(color as string, "#f7f0df"), `${selector} screen contrast`).toBeGreaterThanOrEqual(4.5);
      expect(wcagContrast(color as string, "#ffffff"), `${selector} print contrast`).toBeGreaterThanOrEqual(4.5);
    }
  });

  it("opens the report tab and provides print-only navigation hiding rules", async () => {
    render(<ProjectWorkspace projectId="p-arrangement" />);
    await screen.findByRole("heading", { name: "Rain Memory" });
    fireEvent.click(screen.getByRole("tab", { name: "报告" }));

    expect(screen.getByRole("button", { name: "打印报告" })).toBeTruthy();
    const css = fs.readFileSync(path.resolve(__dirname, "../src/components/studio/Studio.module.css"), "utf8");
    expect(css).toMatch(/@media print[\s\S]*\.workspaceShelf[\s\S]*display:\s*none/);
    expect(css).toMatch(/@media print[\s\S]*\.workspaceTabs[\s\S]*display:\s*none/);
    expect(css).toMatch(/@media print[\s\S]*\.reportActions[\s\S]*display:\s*none/);
  });
});

function styleRule(css: string, selector: string): string {
  for (const match of css.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    const selectors = match[1].split(",").map((value) => value.trim());
    if (selectors.includes(selector)) return match[2];
  }
  throw new Error(`Missing CSS rule for ${selector}`);
}

function wcagContrast(foreground: string, background: string): number {
  const luminance = (hex: string) => {
    const channels = [1, 3, 5].map((offset) => Number.parseInt(hex.slice(offset, offset + 2), 16) / 255);
    const linear = channels.map((channel) => channel <= 0.04045
      ? channel / 12.92
      : ((channel + 0.055) / 1.055) ** 2.4);
    return 0.2126 * linear[0] + 0.7152 * linear[1] + 0.0722 * linear[2];
  };
  const first = luminance(foreground);
  const second = luminance(background);
  return (Math.max(first, second) + 0.05) / (Math.min(first, second) + 0.05);
}

function signalAnalysis(): StudioAnalysis {
  return {
    ...analysis,
    channels: [
      { id: "ch-flex", name: "Keys", pluginName: "FLEX", channelType: "instrument" },
      { id: "ch-unresolved", name: "Ghost", pluginName: "Missing Synth", channelType: "instrument" }
    ],
    plugins: [
      { id: "plugin-flex", name: "FLEX", kind: "generator", location: "channel:ch-flex", stateSupported: true },
      { id: "plugin-serum", name: "Serum", kind: "effect", location: "mixer:insert-4:slot:0", stateSupported: false },
      { id: "plugin-sample", name: "Audio Clip", kind: "generator", location: "mixer:insert-4:slot:x", stateSupported: true },
      { id: "plugin-odd", name: "Mystery", kind: "wrapper", location: "nowhere", stateSupported: true }
    ],
    mixerInserts: [
      { id: "insert-4", name: "Insert 4", slotPluginIds: ["plugin-serum", "Missing FX ID"], routeTargetIds: ["master"] },
      { id: "master", name: "Master", slotPluginIds: ["plugin-flex"], routeTargetIds: [] },
      { id: "empty-insert", name: "Empty insert", slotPluginIds: [], routeTargetIds: [] }
    ],
    automations: [
      { id: "auto-1", name: "Wet control", targetName: "Insert 4", pointCount: 12 },
      { id: "auto-2", name: "Unknown control", targetName: "Mystery target", pointCount: 2 }
    ],
    dependencies: [
      { path: "D:/Music/Audio/vocal_take_03.wav", kind: "audio", exists: false },
      { path: "D:/Music/Audio/kick.wav", kind: "audio", exists: true },
      { path: "C:/FL/FactoryData", kind: "factory_data", exists: false }
    ],
    diagnostics: [
      { code: "pattern_note_gap", severity: "notice", message: "Pattern includes a long rest.", targetType: "pattern", targetId: "pat-verse" },
      { code: "mixer_route", severity: "warning", message: "Inspect this route.", targetType: "mixer_insert", targetId: "insert-4" },
      { code: "plugin_unknown", severity: "error", message: "Plugin target is absent.", targetType: "plugin", targetId: "absent-plugin" },
      { code: "unresolved_dependency", severity: "warning", message: "Factory data cannot be verified.", targetType: "dependency", targetId: "C:/FL/FactoryData" }
    ]
  };
}

describe("Pattern Explorer", () => {
  it("searches Patterns and explains notes, channels, similarity, and inferred confidence", () => {
    render(<PatternExplorer analysis={analysis} selectedPatternId="pat-verse" onSelectPattern={() => undefined} />);

    expect(screen.getByRole("heading", { name: "Verse" })).toBeTruthy();
    expect(screen.getByLabelText("Verse Piano Roll")).toBeTruthy();
    expect(screen.getByLabelText("Verse 音符与力度条")).toBeTruthy();
    expect(screen.getByText(/3 个音符 · 长度 240 ticks · 2.5 beats · 音域 50–65/)).toBeTruthy();
    expect(within(screen.getByLabelText("Channel 图例")).getByText("Keys")).toBeTruthy();
    expect(within(screen.getByLabelText("Channel 图例")).getByText("未知 Channel")).toBeTruthy();
    expect(screen.getByRole("button", { name: /Verse Alt · 相似度/ })).toBeTruthy();
    expect(screen.getByText("D minor · 82% 可信度")).toBeTruthy();
    expect(screen.getByText("D 音级重心")).toBeTruthy();

    fireEvent.change(screen.getByRole("searchbox", { name: "搜索 Pattern" }), { target: { value: "Empty" } });
    const list = screen.getByRole("listbox", { name: "Pattern 列表" });
    expect(within(list).getByText("Empty Idea")).toBeTruthy();
    expect(within(list).queryByText("Verse Alt")).toBeNull();
  });

  it("uses a real scroll window for more than 100 Pattern rows", async () => {
    const manyPatterns: StudioAnalysis = {
      ...analysis,
      patterns: Array.from({ length: 150 }, (_, index) => ({
        id: `pat-${index}`,
        name: `Pattern ${String(index).padStart(3, "0")}`,
        usedInPlaylist: index % 3 === 0,
        notes: []
      }))
    };
    render(<PatternExplorer analysis={manyPatterns} selectedPatternId="pat-0" onSelectPattern={() => undefined} />);

    const list = screen.getByRole("listbox", { name: "Pattern 列表" });
    expect(list.getAttribute("data-virtualized")).toBe("true");
    expect(list.querySelectorAll('[role="option"]').length).toBeLessThan(30);
    expect(list.querySelector('[role="option"]')?.getAttribute("aria-setsize")).toBe("150");

    fireEvent.scroll(list, { target: { scrollTop: 149 * 52 } });
    await waitFor(() => expect(within(list).getByText("Pattern 149")).toBeTruthy());

    fireEvent.change(screen.getByRole("searchbox", { name: "搜索 Pattern" }), { target: { value: "Pattern 120" } });
    expect(within(list).getByText("Pattern 120")).toBeTruthy();
  });

  it("supports listbox keyboard selection with truthful active options", async () => {
    const onSelectPattern = vi.fn();
    const { rerender } = render(
      <PatternExplorer analysis={analysis} selectedPatternId="pat-verse" onSelectPattern={onSelectPattern} />
    );
    const list = screen.getByRole("listbox", { name: "Pattern 列表" });

    expect(list.getAttribute("tabindex")).toBe("0");
    const initialActiveId = list.getAttribute("aria-activedescendant");
    expect(initialActiveId).toBeTruthy();
    expect(document.getElementById(initialActiveId as string)?.textContent).toContain("Verse");

    fireEvent.keyDown(list, { key: "ArrowDown" });
    expect(onSelectPattern).toHaveBeenLastCalledWith("pat-verse-alt");
    rerender(<PatternExplorer analysis={analysis} selectedPatternId="pat-verse-alt" onSelectPattern={onSelectPattern} />);
    await waitFor(() => {
      const active = document.getElementById(list.getAttribute("aria-activedescendant") as string);
      expect(active?.textContent).toContain("Verse Alt");
      expect(active?.getAttribute("aria-selected")).toBe("true");
    });

    fireEvent.keyDown(list, { key: "End" });
    expect(onSelectPattern).toHaveBeenLastCalledWith("pat-empty");
    fireEvent.keyDown(list, { key: "Home" });
    expect(onSelectPattern).toHaveBeenLastCalledWith("pat-verse");
  });

  it("scrolls an externally selected virtual Pattern into the rendered window", async () => {
    const manyPatterns: StudioAnalysis = {
      ...analysis,
      patterns: Array.from({ length: 150 }, (_, index) => ({
        id: `pat-${index}`,
        name: `Pattern ${String(index).padStart(3, "0")}`,
        usedInPlaylist: false,
        notes: []
      }))
    };
    const { rerender } = render(
      <PatternExplorer analysis={manyPatterns} selectedPatternId="pat-0" onSelectPattern={() => undefined} />
    );
    const list = screen.getByRole("listbox", { name: "Pattern 列表" }) as HTMLElement;

    rerender(<PatternExplorer analysis={manyPatterns} selectedPatternId="pat-149" onSelectPattern={() => undefined} />);

    await waitFor(() => {
      const selected = within(list).getByRole("option", { name: /Pattern 149/ });
      expect(selected.getAttribute("aria-selected")).toBe("true");
      expect(list.getAttribute("aria-activedescendant")).toBe(selected.id);
      expect(list.scrollTop).toBeGreaterThan(0);
    });

    fireEvent.change(screen.getByRole("searchbox", { name: "搜索 Pattern" }), { target: { value: "Pattern 120" } });
    await waitFor(() => {
      const activeId = list.getAttribute("aria-activedescendant");
      expect(activeId).toBeTruthy();
      expect(document.getElementById(activeId as string)?.textContent).toContain("Pattern 120");
    });
  });

  it("uses the measured mobile viewport for external selection and PageDown", async () => {
    const manyPatterns: StudioAnalysis = {
      ...analysis,
      patterns: Array.from({ length: 150 }, (_, index) => ({
        id: `pat-${index}`,
        name: `Pattern ${String(index).padStart(3, "0")}`,
        usedInPlaylist: false,
        notes: []
      }))
    };
    function Harness() {
      const [selected, setSelected] = useState("pat-0");
      return <>
        <button type="button" onClick={() => setSelected("pat-149")}>Select last Pattern</button>
        <PatternExplorer analysis={manyPatterns} selectedPatternId={selected} onSelectPattern={setSelected} />
      </>;
    }
    render(<Harness />);
    const list = screen.getByRole("listbox", { name: "Pattern 列表" }) as HTMLElement;
    Object.defineProperty(list, "clientHeight", { configurable: true, value: 260 });
    fireEvent(window, new Event("resize"));

    fireEvent.keyDown(list, { key: "PageDown" });
    await waitFor(() => {
      const active = document.getElementById(list.getAttribute("aria-activedescendant") as string) as HTMLElement;
      expect(active.textContent).toContain("Pattern 005");
      expect(active.getAttribute("aria-selected")).toBe("true");
      expect(Number.parseInt(active.style.top, 10)).toBeGreaterThanOrEqual(list.scrollTop);
      expect(Number.parseInt(active.style.top, 10) + 52).toBeLessThanOrEqual(list.scrollTop + 260);
    });

    fireEvent.click(screen.getByRole("button", { name: "Select last Pattern" }));
    await waitFor(() => {
      const selected = within(list).getByRole("option", { name: /Pattern 149/ }) as HTMLElement;
      expect(Number.parseInt(selected.style.top, 10)).toBeGreaterThanOrEqual(list.scrollTop);
      expect(Number.parseInt(selected.style.top, 10) + 52).toBeLessThanOrEqual(list.scrollTop + 260);
    });
  });

  it("recomputes the virtual window when ResizeObserver reports a shorter viewport", async () => {
    let resizeCallback: ResizeObserverCallback | null = null;
    class ResizeObserverMock {
      constructor(callback: ResizeObserverCallback) { resizeCallback = callback; }
      observe() {}
      unobserve() {}
      disconnect() {}
    }
    vi.stubGlobal("ResizeObserver", ResizeObserverMock);
    const manyPatterns: StudioAnalysis = {
      ...analysis,
      patterns: Array.from({ length: 150 }, (_, index) => ({
        id: `pat-${index}`,
        name: `Pattern ${String(index).padStart(3, "0")}`,
        usedInPlaylist: false,
        notes: []
      }))
    };
    render(<PatternExplorer analysis={manyPatterns} selectedPatternId="pat-149" onSelectPattern={() => undefined} />);
    const list = screen.getByRole("listbox", { name: "Pattern 列表" }) as HTMLElement;
    let height = 364;
    Object.defineProperty(list, "clientHeight", { configurable: true, get: () => height });

    height = 260;
    act(() => resizeCallback?.([], {} as ResizeObserver));

    await waitFor(() => {
      const selected = within(list).getByRole("option", { name: /Pattern 149/ }) as HTMLElement;
      expect(Number.parseInt(selected.style.top, 10) + 52).toBeLessThanOrEqual(list.scrollTop + 260);
      expect(list.scrollTop).toBe(149 * 52 + 52 - 260);
    });
  });

  it("rebinds measurement when filtering unmounts and remounts the listbox", async () => {
    const observers: Array<{ element: Element | null; disconnected: boolean }> = [];
    class ResizeObserverMock {
      private record = { element: null as Element | null, disconnected: false };
      constructor() { observers.push(this.record); }
      observe(element: Element) { this.record.element = element; }
      unobserve() {}
      disconnect() { this.record.disconnected = true; }
    }
    vi.stubGlobal("ResizeObserver", ResizeObserverMock);
    let measuredHeight = 364;
    vi.spyOn(HTMLElement.prototype, "clientHeight", "get").mockImplementation(() => measuredHeight);
    const manyPatterns: StudioAnalysis = {
      ...analysis,
      patterns: Array.from({ length: 150 }, (_, index) => ({
        id: `pat-${index}`,
        name: `Pattern ${String(index).padStart(3, "0")}`,
        usedInPlaylist: false,
        notes: []
      }))
    };
    function Harness() {
      const [selected, setSelected] = useState("pat-0");
      return <>
        <button type="button" onClick={() => setSelected("pat-149")}>Select remounted last Pattern</button>
        <PatternExplorer analysis={manyPatterns} selectedPatternId={selected} onSelectPattern={setSelected} />
      </>;
    }
    render(<Harness />);
    const search = screen.getByRole("searchbox", { name: "搜索 Pattern" });
    const firstList = screen.getByRole("listbox", { name: "Pattern 列表" }) as HTMLElement;
    expect(observers[0]?.element).toBe(firstList);

    fireEvent.change(search, { target: { value: "no matches here" } });
    expect(screen.queryByRole("listbox", { name: "Pattern 列表" })).toBeNull();
    measuredHeight = 260;
    fireEvent.change(search, { target: { value: "" } });
    const remountedList = await screen.findByRole("listbox", { name: "Pattern 列表" }) as HTMLElement;

    expect(remountedList).not.toBe(firstList);
    expect(observers[0]?.disconnected).toBe(true);
    expect(observers).toHaveLength(2);
    expect(observers[1]?.element).toBe(remountedList);

    fireEvent.keyDown(remountedList, { key: "PageDown" });
    await waitFor(() => {
      const active = document.getElementById(remountedList.getAttribute("aria-activedescendant") as string) as HTMLElement;
      expect(active.textContent).toContain("Pattern 005");
      expect(active.getAttribute("aria-selected")).toBe("true");
      expect(Number.parseInt(active.style.top, 10) + 52).toBeLessThanOrEqual(remountedList.scrollTop + 260);
    });

    fireEvent.click(screen.getByRole("button", { name: "Select remounted last Pattern" }));
    await waitFor(() => {
      const selected = within(remountedList).getByRole("option", { name: /Pattern 149/ }) as HTMLElement;
      expect(Number.parseInt(selected.style.top, 10)).toBeGreaterThanOrEqual(remountedList.scrollTop);
      expect(Number.parseInt(selected.style.top, 10) + 52).toBeLessThanOrEqual(remountedList.scrollTop + 260);
    });
  });

  it("keeps full MIDI metrics while bounding Piano Roll note nodes", () => {
    const total = 20_000;
    const large: StudioAnalysis = {
      ...analysis,
      patterns: [{
        id: "pat-large",
        name: "Large MIDI",
        usedInPlaylist: true,
        notes: Array.from({ length: total }, (_, index) => ({
          key: index === 0 ? 0 : index === total - 1 ? 127 : 36 + (index % 48),
          position: index * 12,
          length: 12,
          velocity: 64 + (index % 32),
          channelId: "ch-keys"
        }))
      }]
    };

    render(<PatternExplorer analysis={large} selectedPatternId="pat-large" onSelectPattern={() => undefined} />);

    expect(screen.getByLabelText("Large MIDI 音符摘要").textContent).toContain("20000 个音符");
    expect(screen.getByLabelText("Large MIDI 音符摘要").textContent).toContain("音域 0–127");
    expect(screen.getByLabelText("Piano Roll 绘制范围").textContent).toMatch(/绘制 \d+ \/ 总 20000 个音符/);
    const pianoRoll = screen.getByLabelText("Large MIDI Piano Roll");
    expect(pianoRoll.querySelectorAll('[data-drawn-note="true"]')).toHaveLength(1000);
    expect(pianoRoll.textContent).toContain("音高 0");
    expect(pianoRoll.textContent).toContain("音高 127");
  });

  it("keeps unavailable timing, empty notes, unknown channels, and invalid coordinates truthful", () => {
    const uncertain: StudioAnalysis = {
      ...analysis,
      project: { ...analysis.project, ppq: null },
      patterns: [
        { id: "empty", name: "No Notes", usedInPlaylist: false, notes: [] },
        {
          id: "odd",
          name: "Odd Notes",
          usedInPlaylist: true,
          notes: [
            { key: 60, position: -20, length: 12, velocity: 90, channelId: "missing-channel" },
            { key: 61, position: 0, length: 12, velocity: 130, channelId: "missing-channel" },
            { key: 62, position: 0, length: 0, velocity: 90, channelId: "missing-channel" },
            { key: Number.NaN, position: Number.POSITIVE_INFINITY, length: 4, velocity: 20, channelId: null },
            { key: 64, position: 0, length: 96, velocity: 90, channelId: "missing-channel" }
          ]
        }
      ],
      playlistClips: [
        { id: "bad", trackIndex: -1, start: Number.NaN, length: Number.POSITIVE_INFINITY, clipType: "pattern", sourceId: "odd" }
      ]
    };
    const { rerender } = render(<PatternExplorer analysis={uncertain} selectedPatternId="empty" onSelectPattern={() => undefined} />);

    expect(screen.getByText("这个 Pattern 没有可绘制的 MIDI 音符。")).toBeTruthy();
    expect(screen.getAllByText(/PPQ 未读取/).length).toBeGreaterThan(0);
    expect(document.body.textContent).not.toMatch(/NaN|Infinity/);

    rerender(<PatternExplorer analysis={uncertain} selectedPatternId="odd" onSelectPattern={() => undefined} />);
    expect(within(screen.getByLabelText("Channel 图例")).getByText("未知 Channel")).toBeTruthy();
    expect(screen.getByText("已忽略 4 条无效音符记录。")).toBeTruthy();
    expect(document.body.textContent).not.toMatch(/NaN|Infinity/);

    rerender(<ArrangementAnalysis analysis={uncertain} onSelectPattern={() => undefined} />);
    expect(screen.getByText("没有可绘制的 Playlist Clip。")).toBeTruthy();
    expect(screen.getAllByText(/PPQ 未读取/).length).toBeGreaterThan(0);
    expect(document.body.textContent).not.toMatch(/NaN|Infinity/);
  });

  it("clips negative-start intervals, rejects invalid tracks, and reports every correction", () => {
    const corrected: StudioAnalysis = {
      ...analysis,
      patterns: [{ id: "pat-corrected", name: "Corrected", usedInPlaylist: true, notes: [] }],
      playlistClips: [
        { id: "crosses-zero", trackIndex: 4, start: -96, length: 192, clipType: "pattern", sourceId: "pat-corrected" },
        { id: "negative-track", trackIndex: -1, start: 0, length: 96, clipType: "pattern", sourceId: "pat-corrected" },
        { id: "before-zero", trackIndex: 5, start: -192, length: 96, clipType: "audio", sourceId: null }
      ]
    };
    render(<ArrangementAnalysis analysis={corrected} onSelectPattern={() => undefined} />);

    const clip = screen.getByRole("button", { name: "Corrected clip at bar 1" });
    expect(clip.getAttribute("style")).toContain("left: 0%");
    expect(clip.getAttribute("style")).toContain("width: 100%");
    expect(clip.getAttribute("title")).toContain("1 beats");
    expect(screen.getByRole("status", { name: "编曲数据修正" }).textContent).toContain("1 个片段裁剪到工程起点");
    expect(screen.getByRole("status", { name: "编曲数据修正" }).textContent).toContain("2 个片段因无效轨道或时间区间被忽略");
    expect(screen.queryByLabelText("Playlist track 0")).toBeNull();
    expect(screen.getByText("1 clips · 1 tracks")).toBeTruthy();
  });

  it("uses tick labels and avoids bar or gap claims when the time signature is unknown", () => {
    const unknownSignature: StudioAnalysis = {
      ...analysis,
      project: {
        ...analysis.project,
        ppq: 96,
        timeSignatureNumerator: null,
        timeSignatureDenominator: null
      }
    };
    render(<ArrangementAnalysis analysis={unknownSignature} onSelectPattern={() => undefined} />);

    expect(screen.getByText(/96 PPQ · 拍号未读取/)).toBeTruthy();
    expect(screen.getByRole("button", { name: "Verse clip at tick 0" })).toBeTruthy();
    expect(screen.queryByTitle(/长空白/)).toBeNull();
    expect(screen.queryByRole("button", { name: /bar/ })).toBeNull();
  });

  it("keeps very long finite coordinates without creating empty lanes", () => {
    const extreme: StudioAnalysis = {
      ...analysis,
      patterns: [{
        id: "pat-extreme",
        name: "Long Form",
        usedInPlaylist: true,
        notes: [{ key: 72, position: Number.MAX_SAFE_INTEGER - 1000, length: 120, velocity: 96, channelId: "ch-keys" }]
      }],
      playlistClips: [
        { id: "negative", trackIndex: 4000, start: -96, length: 192, clipType: "pattern", sourceId: "pat-extreme" },
        { id: "distant", trackIndex: 9000, start: Number.MAX_SAFE_INTEGER - 1000, length: 120, clipType: "audio", sourceId: null }
      ]
    };
    const { rerender } = render(<ArrangementAnalysis analysis={extreme} onSelectPattern={() => undefined} />);

    expect(screen.getByRole("button", { name: "Long Form clip at bar 1" }).getAttribute("style")).toContain("left: 0%");
    expect(screen.getByLabelText("Playlist track 4000")).toBeTruthy();
    expect(screen.getByLabelText("Playlist track 9000")).toBeTruthy();
    expect(screen.queryByLabelText("Playlist track 4001")).toBeNull();
    expect(document.body.innerHTML).not.toMatch(/NaN|Infinity/);

    rerender(<PatternExplorer analysis={extreme} selectedPatternId="pat-extreme" onSelectPattern={() => undefined} />);
    expect(screen.getByLabelText("Long Form Piano Roll")).toBeTruthy();
    expect(document.body.innerHTML).not.toMatch(/NaN|Infinity/);
  });

  it("shows Pattern length, note-duration bins, onset rhythm, and usage from valid MIDI notes", () => {
    const rhythmic: StudioAnalysis = {
      ...analysis,
      patterns: [{
        id: "pat-rhythm",
        name: "Rhythm Study",
        usedInPlaylist: false,
        notes: [
          { key: 60, position: 0, length: 24, velocity: 80, channelId: "ch-keys" },
          { key: 62, position: 48, length: 72, velocity: 90, channelId: "ch-keys" },
          { key: 64, position: 120, length: 144, velocity: 100, channelId: "ch-keys" }
        ]
      }]
    };
    render(<PatternExplorer analysis={rhythmic} selectedPatternId="pat-rhythm" onSelectPattern={() => undefined} />);

    const row = screen.getByRole("option");
    expect(row.textContent).toContain("Rhythm Study");
    expect(row.textContent).toContain("264 ticks · 2.75 beats");
    expect(row.textContent).toContain("未使用");
    expect(screen.getByText("264 ticks · 2.75 beats")).toBeTruthy();
    expect(screen.getByLabelText("音符时值分布").textContent).toContain("短 1 · 中 1 · 长 1");
    expect(screen.getByLabelText("起音节奏分布").textContent).toContain("正拍 1 · 反拍 1 · 其他 1");
  });

  it("uses exact tick distributions when PPQ is unavailable and explains empty Pattern statistics", () => {
    const tickOnly: StudioAnalysis = {
      ...analysis,
      project: { ...analysis.project, ppq: null },
      patterns: [
        {
          id: "tick-only",
          name: "Tick Only",
          usedInPlaylist: true,
          notes: [
            { key: 60, position: 0, length: 24, velocity: 80, channelId: "ch-keys" },
            { key: 62, position: 36, length: 48, velocity: 90, channelId: "ch-keys" }
          ]
        },
        { id: "empty-stats", name: "Empty Stats", usedInPlaylist: false, notes: [] }
      ]
    };
    const { rerender } = render(<PatternExplorer analysis={tickOnly} selectedPatternId="tick-only" onSelectPattern={() => undefined} />);

    expect(screen.getByLabelText("音符时值分布").textContent).toContain("24 ticks × 1");
    expect(screen.getByLabelText("音符时值分布").textContent).toContain("48 ticks × 1");
    expect(screen.getByLabelText("起音节奏分布").textContent).toContain("tick 0 × 1");
    expect(screen.getByLabelText("起音节奏分布").textContent).toContain("无法推断正拍/反拍");

    rerender(<PatternExplorer analysis={tickOnly} selectedPatternId="empty-stats" onSelectPattern={() => undefined} />);
    expect(screen.getByLabelText("音符时值分布").textContent).toContain("没有有效音符可统计时值");
    expect(screen.getByLabelText("起音节奏分布").textContent).toContain("没有有效音符可统计起音位置");
  });
});

function cssRule(css: string, selector: string): string {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = css.match(new RegExp(`${escaped}\\s*\\{(?<body>[^}]*)\\}`));
  expect(match, `Expected ${selector} rule to exist`).not.toBeNull();
  return match?.groups?.body ?? "";
}

function cssDeclaration(rule: string, property: string): string {
  const match = rule.match(new RegExp(`(?:^|[;\\s])${property}:\\s*([^;]+)`));
  expect(match, `Expected ${property} declaration`).not.toBeNull();
  return match?.[1].trim() ?? "";
}

function contrastRatio(foreground: string, background: string): number {
  const lighter = Math.max(relativeLuminance(foreground), relativeLuminance(background));
  const darker = Math.min(relativeLuminance(foreground), relativeLuminance(background));
  return (lighter + 0.05) / (darker + 0.05);
}

function relativeLuminance(hex: string): number {
  const rgb = [1, 3, 5].map((offset) => Number.parseInt(hex.slice(offset, offset + 2), 16) / 255);
  const linear = rgb.map((channel) => channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4);
  return 0.2126 * linear[0] + 0.7152 * linear[1] + 0.0722 * linear[2];
}

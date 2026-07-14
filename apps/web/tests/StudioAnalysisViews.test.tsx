import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import * as studioApi from "../src/api/studioClient";
import type { StudioAnalysis, StudioProjectDetail } from "../src/api/studioTypes";
import { ArrangementAnalysis } from "../src/components/studio/ArrangementAnalysis";
import { PatternExplorer } from "../src/components/studio/PatternExplorer";
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
});

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

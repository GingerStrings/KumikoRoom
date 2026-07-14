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
    expect(screen.getByText(/3 个音符 · 音域 50–65/)).toBeTruthy();
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
            { key: 60, position: -20, length: 0, velocity: 130, channelId: "missing-channel" },
            { key: Number.NaN, position: Number.POSITIVE_INFINITY, length: 4, velocity: 20, channelId: null }
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
    expect(document.body.textContent).not.toMatch(/NaN|Infinity/);

    rerender(<ArrangementAnalysis analysis={uncertain} onSelectPattern={() => undefined} />);
    expect(screen.getByText("没有可绘制的 Playlist Clip。")).toBeTruthy();
    expect(screen.getAllByText(/PPQ 未读取/).length).toBeGreaterThan(0);
    expect(document.body.textContent).not.toMatch(/NaN|Infinity/);
  });

  it("normalizes finite negative positions and very long project coordinates without creating empty lanes", () => {
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
});

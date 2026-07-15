import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import * as studioApi from "../src/api/studioClient";
import { VersionTimeline } from "../src/components/studio/VersionTimeline";

vi.mock("../src/api/studioClient", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/api/studioClient")>();
  return {
    ...actual,
    getStudioVersions: vi.fn(),
    confirmStudioVersion: vi.fn(),
    getStudioDiff: vi.fn()
  };
});

const versions = [
  {
    snapshotId: "current", sourcePath: "D:/Music/Blue Hour.flp", sourceHash: "hash-current",
    analyzedAt: "2026-07-14T10:00:00Z", kind: "current" as const, associationId: null,
    score: null, confirmed: true, title: "Blue Hour", tempo: 128, patternCount: 12
  },
  {
    snapshotId: "backup", sourcePath: "D:/Music/Backups/Blue Hour backup.flp", sourceHash: "hash-backup",
    analyzedAt: "2026-07-14T09:40:00Z", kind: "backup" as const, associationId: "association-1",
    score: 0.92, confirmed: true, title: "Blue Hour", tempo: 126, patternCount: 11
  },
  {
    snapshotId: "candidate", sourcePath: "D:/Music/Backups/Untitled.flp", sourceHash: "hash-candidate",
    analyzedAt: "2026-07-13T09:40:00Z", kind: "candidate" as const, associationId: "association-2",
    score: 0.63, confirmed: false, title: null, tempo: 124, patternCount: 8
  }
];

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(studioApi.getStudioVersions).mockResolvedValue(versions);
  vi.mocked(studioApi.confirmStudioVersion).mockResolvedValue({
    id: "association-2", projectId: "project-1", candidateProjectId: "candidate-project",
    snapshotId: "candidate", score: 0.63, confirmed: true,
    createdAt: "2026-07-13T09:40:00Z", updatedAt: "2026-07-14T10:00:00Z"
  });
  vi.mocked(studioApi.getStudioDiff).mockResolvedValue({
    fromSnapshotId: "backup",
    toSnapshotId: "current",
    summary: { changeCount: 3 },
    projectMetrics: { added: [], removed: [], changed: [{ field: "tempo", before: 126, after: 128 }] },
    patterns: { added: [{ id: "p12", name: "Bridge" }], removed: [], changed: [] },
    notes: { added: [], removed: [], changed: [] },
    channels: { added: [], removed: [], changed: [] },
    plugins: { added: [{ id: "serum", name: "Serum" }], removed: [], changed: [] },
    playlistClips: { added: [], removed: [], changed: [] },
    mixerInserts: { added: [], removed: [], changed: [] },
    dependencies: { added: [], removed: [], changed: [] }
  });
});

describe("VersionTimeline", () => {
  it("shows current, confirmed backups, candidates, and a structured read-only diff", async () => {
    render(<VersionTimeline projectId="project-1" />);

    expect(await screen.findByText("当前工程")).toBeTruthy();
    expect(screen.getByText("已确认备份")).toBeTruthy();
    expect(screen.getByText("待确认候选")).toBeTruthy();
    expect(screen.getByText("只读比较，不会覆盖或恢复 FLP")).toBeTruthy();

    fireEvent.change(screen.getByLabelText("起始版本"), { target: { value: "backup" } });
    fireEvent.change(screen.getByLabelText("目标版本"), { target: { value: "current" } });

    expect(await screen.findByText("3 项结构变化")).toBeTruthy();
    expect(screen.getByText("BPM：126 → 128")).toBeTruthy();
    expect(screen.getByText("新增 Pattern：Bridge")).toBeTruthy();
    expect(screen.getByText("新增插件：Serum")).toBeTruthy();
    expect(screen.queryByRole("button", { name: /覆盖|恢复/ })).toBeNull();
  });

  it("confirms a candidate and refreshes the timeline", async () => {
    vi.mocked(studioApi.getStudioVersions)
      .mockResolvedValueOnce(versions)
      .mockResolvedValueOnce([{ ...versions[2], confirmed: true, kind: "backup" }, ...versions.slice(0, 2)]);
    render(<VersionTimeline projectId="project-1" />);
    await screen.findByText("待确认候选");

    fireEvent.click(screen.getByRole("button", { name: "确认 Untitled.flp 属于此工程" }));

    await waitFor(() => expect(studioApi.confirmStudioVersion).toHaveBeenCalledWith("project-1", "association-2"));
    await waitFor(() => expect(studioApi.getStudioVersions).toHaveBeenCalledTimes(2));
  });

  it("cancels stale requests when the project changes", async () => {
    const signals: AbortSignal[] = [];
    vi.mocked(studioApi.getStudioVersions).mockImplementation((_projectId, options) => {
      signals.push(options.signal!);
      return Promise.resolve(versions);
    });
    const view = render(<VersionTimeline projectId="project-1" />);
    view.rerender(<VersionTimeline projectId="project-2" />);

    await waitFor(() => expect(signals).toHaveLength(2));
    expect(signals[0].aborted).toBe(true);
  });
});

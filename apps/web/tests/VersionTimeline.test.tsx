import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import * as studioApi from "../src/api/studioClient";
import { VersionTimeline } from "../src/components/studio/VersionTimeline";

vi.mock("../src/api/studioClient", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/api/studioClient")>();
  return {
    ...actual,
    getStudioVersions: vi.fn(),
    confirmStudioVersion: vi.fn(),
    getStudioDiff: vi.fn(),
    openStudioAsset: vi.fn()
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
const versionsPage = { items: versions, nextCursor: null };

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(studioApi.getStudioVersions).mockResolvedValue(versionsPage);
  vi.mocked(studioApi.confirmStudioVersion).mockResolvedValue({
    id: "association-2", projectId: "project-1", candidateProjectId: "candidate-project",
    snapshotId: "candidate", score: 0.63, confirmed: true,
    createdAt: "2026-07-13T09:40:00Z", updatedAt: "2026-07-14T10:00:00Z"
  });
  vi.mocked(studioApi.openStudioAsset).mockResolvedValue(undefined);
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
      .mockResolvedValueOnce(versionsPage);
    render(<VersionTimeline projectId="project-1" />);
    await screen.findByText("待确认候选");

    fireEvent.click(screen.getByRole("button", { name: "确认 Untitled.flp 属于此工程" }));

    await waitFor(() => expect(studioApi.confirmStudioVersion).toHaveBeenCalledWith(
      "project-1",
      "association-2",
      { signal: expect.any(AbortSignal) }
    ));
    await waitFor(() => expect(screen.getAllByText("已确认备份").length).toBeGreaterThan(1));
    expect(screen.getByRole("button", { name: "打开 Untitled.flp 所在位置" })).toBeTruthy();
    expect(studioApi.getStudioVersions).toHaveBeenCalledTimes(1);
  });

  it("opens only confirmed backup associations through the allowlisted action", async () => {
    render(<VersionTimeline projectId="project-1" />);
    await screen.findByText("已确认备份");

    expect(screen.queryByRole("button", { name: "打开 Untitled.flp 所在位置" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "打开 Blue Hour backup.flp 所在位置" }));

    await waitFor(() => expect(studioApi.openStudioAsset).toHaveBeenCalledWith(
      "project-1",
      { kind: "backup", entityId: "association-1" },
      { signal: expect.any(AbortSignal) }
    ));
  });

  it("keeps an inline pending and error state for backup open actions", async () => {
    let rejectOpen!: (cause: unknown) => void;
    vi.mocked(studioApi.openStudioAsset).mockImplementation(() => new Promise((_resolve, reject) => {
      rejectOpen = reject;
    }));
    render(<VersionTimeline projectId="project-1" />);
    const openButton = await screen.findByRole("button", { name: "打开 Blue Hour backup.flp 所在位置" });

    fireEvent.click(openButton);
    expect(openButton.hasAttribute("disabled")).toBe(true);
    expect(openButton.getAttribute("aria-busy")).toBe("true");
    await act(async () => rejectOpen(new Error("备份位置已失效")));

    expect((await screen.findByRole("alert")).textContent).toContain("备份位置已失效");
    expect(openButton.hasAttribute("disabled")).toBe(false);
  });

  it("aborts and ignores a stale backup open action after project change", async () => {
    let settleOpen!: () => void;
    let openSignal: AbortSignal | undefined;
    vi.mocked(studioApi.openStudioAsset).mockImplementation((_projectId, _action, options) => new Promise((_resolve, reject) => {
      openSignal = options.signal;
      settleOpen = () => reject(new Error("stale open failed"));
    }));
    const view = render(<VersionTimeline projectId="project-1" />);
    fireEvent.click(await screen.findByRole("button", { name: "打开 Blue Hour backup.flp 所在位置" }));

    view.rerender(<VersionTimeline projectId="project-2" />);
    await act(async () => settleOpen());

    await waitFor(() => expect(openSignal?.aborted).toBe(true));
    expect(screen.queryByText("stale open failed")).toBeNull();
  });

  it("cancels stale requests when the project changes", async () => {
    const signals: AbortSignal[] = [];
    vi.mocked(studioApi.getStudioVersions).mockImplementation((_projectId, options) => {
      signals.push(options.signal!);
      return Promise.resolve(versionsPage);
    });
    const view = render(<VersionTimeline projectId="project-1" />);
    view.rerender(<VersionTimeline projectId="project-2" />);

    await waitFor(() => expect(signals).toHaveLength(2));
    expect(signals[0].aborted).toBe(true);
  });

  it.each(["resolve", "reject"] as const)(
    "ignores a stale confirmation that later %s after switching projects",
    async (outcome) => {
      let settle!: (value?: unknown) => void;
      let confirmationSignal: AbortSignal | undefined;
      vi.mocked(studioApi.confirmStudioVersion).mockImplementation(
        (_projectId, _candidateId, options) => new Promise((resolve, reject) => {
          confirmationSignal = options.signal;
          settle = outcome === "resolve"
            ? () => resolve({
                id: "association-2", projectId: "project-1", candidateProjectId: "candidate-project",
                snapshotId: "candidate", score: 0.63, confirmed: true,
                createdAt: "2026-07-13T09:40:00Z", updatedAt: "2026-07-14T10:00:00Z"
              })
            : () => reject(new Error("stale confirmation failed"));
        })
      );
      const view = render(<VersionTimeline projectId="project-1" />);
      await screen.findByText("待确认候选");
      fireEvent.click(screen.getByRole("button", { name: "确认 Untitled.flp 属于此工程" }));

      view.rerender(<VersionTimeline projectId="project-2" />);
      await waitFor(() => expect(studioApi.getStudioVersions).toHaveBeenCalledTimes(2));
      await act(async () => {
        settle();
        await Promise.resolve();
      });

      await waitFor(() => expect(confirmationSignal?.aborted).toBe(true));
      expect(studioApi.getStudioVersions).toHaveBeenCalledTimes(2);
      expect(screen.queryByText("stale confirmation failed")).toBeNull();
    }
  );

  it("loads additional version pages without losing deep candidates", async () => {
    vi.mocked(studioApi.getStudioVersions)
      .mockResolvedValueOnce({ items: versions.slice(0, 2), nextCursor: "page-2" })
      .mockResolvedValueOnce({ items: [versions[2]], nextCursor: null });
    render(<VersionTimeline projectId="project-1" />);
    await screen.findByText("当前工程");

    fireEvent.click(screen.getByRole("button", { name: "加载更多版本" }));

    expect(await screen.findByText("待确认候选")).toBeTruthy();
    expect(studioApi.getStudioVersions).toHaveBeenNthCalledWith(
      2,
      "project-1",
      expect.objectContaining({ cursor: "page-2", signal: expect.any(AbortSignal) })
    );
  });

  it("keeps loaded versions visible and retries an inline load-more failure", async () => {
    vi.mocked(studioApi.getStudioVersions)
      .mockResolvedValueOnce({ items: [versions[0]], nextCursor: "page-2" })
      .mockRejectedValueOnce(new Error("更多版本读取失败"))
      .mockResolvedValueOnce({ items: [versions[2]], nextCursor: null });
    render(<VersionTimeline projectId="project-1" />);
    await screen.findByText("当前工程");

    fireEvent.click(screen.getByRole("button", { name: "加载更多版本" }));

    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toContain("更多版本读取失败");
    expect(screen.getByText("当前工程")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "重试加载更多" }));

    expect(await screen.findByText("待确认候选")).toBeTruthy();
    await waitFor(() => expect(screen.queryByText("更多版本读取失败")).toBeNull());
    expect(studioApi.getStudioVersions).toHaveBeenCalledTimes(3);
  });

  it("deduplicates a confirmed candidate by association identity across pages", async () => {
    vi.mocked(studioApi.getStudioVersions)
      .mockResolvedValueOnce({ items: [versions[0], versions[2]], nextCursor: "page-2" })
      .mockResolvedValueOnce({ items: [versions[2], versions[1]], nextCursor: null });
    render(<VersionTimeline projectId="project-1" />);
    await screen.findByText("待确认候选");

    fireEvent.click(screen.getByRole("button", { name: "确认 Untitled.flp 属于此工程" }));
    await waitFor(() => expect(screen.queryByRole("button", { name: "确认 Untitled.flp 属于此工程" })).toBeNull());
    fireEvent.click(screen.getByRole("button", { name: "加载更多版本" }));

    await screen.findByText("Blue Hour backup.flp");
    expect(screen.queryByRole("button", { name: "确认 Untitled.flp 属于此工程" })).toBeNull();
  });
});

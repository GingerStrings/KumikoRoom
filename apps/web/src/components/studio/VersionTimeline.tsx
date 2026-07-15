"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { confirmStudioVersion, getStudioDiff, getStudioVersions } from "../../api/studioClient";
import type { StudioSnapshotDiff, StudioVersion } from "../../api/studioTypes";
import studioCss from "./Studio.module.css";

interface VersionTimelineProps {
  projectId: string;
}

type TimelineState =
  | { phase: "loading" }
  | { phase: "error"; message: string }
  | { phase: "ready"; versions: StudioVersion[] };

type DiffState =
  | { phase: "idle" }
  | { phase: "loading" }
  | { phase: "error"; message: string }
  | { phase: "ready"; diff: StudioSnapshotDiff };

const sectionLabels: Array<[keyof Pick<StudioSnapshotDiff, "patterns" | "notes" | "channels" | "plugins" | "playlistClips" | "mixerInserts" | "dependencies">, string]> = [
  ["patterns", "Pattern"],
  ["notes", "音符"],
  ["channels", "Channel"],
  ["plugins", "插件"],
  ["playlistClips", "Playlist Clip"],
  ["mixerInserts", "Mixer Insert"],
  ["dependencies", "依赖"]
];

export function VersionTimeline({ projectId }: VersionTimelineProps) {
  const [refreshKey, setRefreshKey] = useState(0);
  const [state, setState] = useState<TimelineState>({ phase: "loading" });
  const [fromId, setFromId] = useState("");
  const [toId, setToId] = useState("");
  const [confirmingId, setConfirmingId] = useState<string | null>(null);
  const [diffState, setDiffState] = useState<DiffState>({ phase: "idle" });
  const confirmationController = useRef<AbortController | null>(null);
  const projectIdentity = useRef(projectId);
  projectIdentity.current = projectId;

  useEffect(() => {
    const controller = new AbortController();
    setState({ phase: "loading" });
    setFromId("");
    setToId("");
    void getStudioVersions(projectId, { signal: controller.signal })
      .then((versions) => {
        if (controller.signal.aborted) return;
        setState({ phase: "ready", versions });
        const selectable = versions.filter((item) => item.confirmed);
        const current = selectable.find((item) => item.kind === "current") ?? selectable[0];
        const previous = selectable.find((item) => item.snapshotId !== current?.snapshotId);
        setToId(current?.snapshotId ?? "");
        setFromId(previous?.snapshotId ?? current?.snapshotId ?? "");
      })
      .catch((cause) => {
        if (!controller.signal.aborted) setState({ phase: "error", message: errorMessage(cause) });
      });
    return () => controller.abort();
  }, [projectId, refreshKey]);

  useEffect(() => {
    confirmationController.current?.abort();
    confirmationController.current = null;
    setConfirmingId(null);
    return () => confirmationController.current?.abort();
  }, [projectId]);

  useEffect(() => {
    if (!fromId || !toId) {
      setDiffState({ phase: "idle" });
      return;
    }
    const controller = new AbortController();
    setDiffState({ phase: "loading" });
    void getStudioDiff(projectId, fromId, toId, { signal: controller.signal })
      .then((diff) => {
        if (!controller.signal.aborted) setDiffState({ phase: "ready", diff });
      })
      .catch((cause) => {
        if (!controller.signal.aborted) setDiffState({ phase: "error", message: errorMessage(cause) });
      });
    return () => controller.abort();
  }, [projectId, fromId, toId]);

  const selectable = useMemo(
    () => state.phase === "ready" ? state.versions.filter((version) => version.confirmed) : [],
    [state]
  );

  async function confirmCandidate(version: StudioVersion) {
    if (!version.associationId) return;
    confirmationController.current?.abort();
    const controller = new AbortController();
    const requestedProjectId = projectId;
    confirmationController.current = controller;
    setConfirmingId(version.associationId);
    try {
      await confirmStudioVersion(projectId, version.associationId, {
        signal: controller.signal
      });
      if (
        controller.signal.aborted
        || projectIdentity.current !== requestedProjectId
      ) return;
      setRefreshKey((value) => value + 1);
    } catch (cause) {
      if (
        controller.signal.aborted
        || projectIdentity.current !== requestedProjectId
      ) return;
      setState({ phase: "error", message: errorMessage(cause) });
    } finally {
      if (confirmationController.current === controller) {
        confirmationController.current = null;
        if (projectIdentity.current === requestedProjectId) {
          setConfirmingId(null);
        }
      }
    }
  }

  if (state.phase === "loading") {
    return <section className={studioCss.versionState} role="status">正在整理版本时间线…</section>;
  }
  if (state.phase === "error") {
    return (
      <section className={studioCss.versionState} role="alert">
        <strong>版本记录暂时无法读取</strong>
        <p>{state.message}</p>
        <button type="button" onClick={() => setRefreshKey((value) => value + 1)}>重试</button>
      </section>
    );
  }
  if (state.versions.length === 0) {
    return <section className={studioCss.versionState}>这个工程还没有可比较的分析快照。</section>;
  }

  return (
    <section className={studioCss.versionArchive} aria-labelledby="version-archive-title">
      <header className={studioCss.versionHeader}>
        <div>
          <p>VERSION ARCHIVE</p>
          <h2 id="version-archive-title">自动备份时间线</h2>
        </div>
        <p className={studioCss.readOnlyNote}>只读比较，不会覆盖或恢复 FLP</p>
      </header>

      <div className={studioCss.versionLayout}>
        <ol className={studioCss.versionRail} aria-label="工程版本">
          {state.versions.map((version) => (
            <li key={`${version.kind}-${version.snapshotId}`} data-kind={version.kind}>
              <span className={studioCss.versionDot} aria-hidden="true" />
              <div className={studioCss.versionCard}>
                <div>
                  <strong>{kindLabel(version.kind)}</strong>
                  <time dateTime={version.analyzedAt}>{formatDate(version.analyzedAt)}</time>
                </div>
                <h3>{version.title || fileName(version.sourcePath)}</h3>
                <p>{formatVersionSummary(version)}</p>
                <small title={version.sourcePath}>{fileName(version.sourcePath)}</small>
                {!version.confirmed && version.associationId && (
                  <button
                    type="button"
                    disabled={confirmingId === version.associationId}
                    onClick={() => void confirmCandidate(version)}
                    aria-label={`确认 ${fileName(version.sourcePath)} 属于此工程`}
                  >
                    {confirmingId === version.associationId ? "确认中…" : "确认归组"}
                  </button>
                )}
              </div>
            </li>
          ))}
        </ol>

        <section className={studioCss.diffDesk} aria-labelledby="version-diff-title">
          <div className={studioCss.diffHeading}>
            <div><span>STRUCTURAL DIFF</span><h3 id="version-diff-title">结构差异</h3></div>
            <div className={studioCss.diffSelectors}>
              <label>起始版本<select aria-label="起始版本" value={fromId} onChange={(event) => setFromId(event.target.value)}>{selectable.map(versionOption)}</select></label>
              <span aria-hidden="true">→</span>
              <label>目标版本<select aria-label="目标版本" value={toId} onChange={(event) => setToId(event.target.value)}>{selectable.map(versionOption)}</select></label>
            </div>
          </div>
          <DiffPanel state={diffState} />
        </section>
      </div>
    </section>
  );
}

function DiffPanel({ state }: { state: DiffState }) {
  if (state.phase === "idle") return <p className={studioCss.diffEmpty}>确认至少一个版本后即可比较。</p>;
  if (state.phase === "loading") return <p className={studioCss.diffEmpty} role="status">正在计算结构差异…</p>;
  if (state.phase === "error") return <p className={studioCss.diffError} role="alert">{state.message}</p>;
  const { diff } = state;
  if (diff.summary.changeCount === 0) return <p className={studioCss.diffEmpty}>两个版本的已解析结构一致。</p>;
  return (
    <div className={studioCss.diffResults} aria-live="polite">
      <p className={studioCss.diffSummary}>{diff.summary.changeCount} 项结构变化</p>
      <ul aria-label="指标变化">
        {diff.projectMetrics.changed.map((item, index) => (
          <li key={`metric-${index}`}>{metricText(item)}</li>
        ))}
      </ul>
      {sectionLabels.map(([key, label]) => {
        const section = diff[key];
        const rows = [
          ...section.added.map((item) => changeText("新增", label, item)),
          ...section.removed.map((item) => changeText("移除", label, item)),
          ...section.changed.map((item) => changeText("修改", label, item))
        ];
        return rows.length ? <section key={key}><h4>{label}</h4><ul>{rows.map((row, index) => <li key={`${row}-${index}`}>{row}</li>)}</ul></section> : null;
      })}
    </div>
  );
}

function versionOption(version: StudioVersion) {
  return <option key={version.snapshotId} value={version.snapshotId}>{kindLabel(version.kind)} · {formatDate(version.analyzedAt)}</option>;
}

function kindLabel(kind: StudioVersion["kind"]): string {
  return { current: "当前工程", history: "主工程历史", backup: "已确认备份", candidate: "待确认候选" }[kind];
}

function formatVersionSummary(version: StudioVersion): string {
  const values = [version.tempo === null ? null : `${version.tempo} BPM`, `${version.patternCount} Patterns`];
  if (version.score !== null) values.push(`可信度 ${Math.round(version.score * 100)}%`);
  return values.filter(Boolean).join(" · ");
}

function formatDate(value: string): string {
  try {
    return new Intl.DateTimeFormat("zh-CN", { month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hour12: false }).format(new Date(value));
  } catch {
    return value;
  }
}

function fileName(path: string): string {
  return path.split(/[\\/]/).pop() || path;
}

function metricText(item: Record<string, unknown>): string {
  const labels: Record<string, string> = { tempo: "BPM", ppq: "PPQ", pattern_count: "Pattern 数", channel_count: "Channel 数", plugin_count: "插件数", playlist_clip_count: "Playlist Clip 数", mixer_insert_count: "Mixer Insert 数", dependency_count: "依赖数" };
  const field = String(item.field ?? "指标");
  return `${labels[field] || field}：${String(item.before ?? "—")} → ${String(item.after ?? "—")}`;
}

function entityName(item: Record<string, unknown>): string {
  const nested = item.after && typeof item.after === "object" ? item.after as Record<string, unknown> : item;
  return String(nested.name ?? nested.path ?? nested.id ?? item.pattern_id ?? "未命名项");
}

function changeText(action: string, label: string, item: Record<string, unknown>): string {
  const separator = /^[A-Z]/.test(label) ? " " : "";
  return `${action}${separator}${label}：${entityName(item)}`;
}

function errorMessage(cause: unknown): string {
  return cause instanceof Error && cause.message ? cause.message : "版本请求失败";
}

"use client";

import { useEffect, useState } from "react";
import { ApiError } from "../../api/client";
import { getStudioAnalysis, getStudioProject } from "../../api/studioClient";
import type { StudioAnalysis, StudioProjectDetail } from "../../api/studioTypes";
import { ArrangementAnalysis } from "./ArrangementAnalysis";
import { PatternExplorer } from "./PatternExplorer";
import { ProjectDashboard } from "./ProjectDashboard";
import studioCss from "./Studio.module.css";

interface ProjectWorkspaceProps {
  projectId: string;
}

type WorkspaceState =
  | { phase: "loading" }
  | { phase: "ready"; project: StudioProjectDetail; analysis: StudioAnalysis; snapshotNotice: string | null }
  | { phase: "pending"; project: StudioProjectDetail; title: string; message: string; loading: boolean }
  | { phase: "failed"; project: StudioProjectDetail; message: string }
  | { phase: "not-found" }
  | { phase: "error"; message: string };

type WorkspaceTab = "overview" | "arrangement" | "pattern" | "plugins" | "dependencies" | "versions";

const tabs: Array<{ id: WorkspaceTab; label: string; available: boolean }> = [
  { id: "overview", label: "总览", available: true },
  { id: "arrangement", label: "编曲", available: true },
  { id: "pattern", label: "Pattern", available: true },
  { id: "plugins", label: "插件与 Mixer", available: false },
  { id: "dependencies", label: "依赖", available: false },
  { id: "versions", label: "版本", available: false }
] as const;

export function ProjectWorkspace({ projectId }: ProjectWorkspaceProps) {
  const [state, setState] = useState<WorkspaceState>({ phase: "loading" });
  const [retryKey, setRetryKey] = useState(0);
  const [activeTab, setActiveTab] = useState<WorkspaceTab>("overview");
  const [selectedPatternId, setSelectedPatternId] = useState<string | null>(null);

  useEffect(() => {
    const controller = new AbortController();
    setState({ phase: "loading" });
    setActiveTab("overview");
    setSelectedPatternId(null);
    void loadWorkspace(projectId, controller.signal).then((next) => {
      if (!controller.signal.aborted) setState(next);
    });
    return () => controller.abort();
  }, [projectId, retryKey]);

  if (state.phase === "loading") {
    return <WorkspaceShell><StatePanel role="status" title="正在读取工程分析…" body="正在核对快照、解析说明与依赖状态。" loading /></WorkspaceShell>;
  }

  if (state.phase === "not-found") {
    return <WorkspaceShell><StatePanel title="没有找到这个工程" body="它可能已从资料室移除，或本地路径发生了变化。" /></WorkspaceShell>;
  }

  if (state.phase === "error") {
    return (
      <WorkspaceShell>
        <StatePanel role="alert" title="暂时无法读取工程" body={state.message}>
          <button type="button" className={studioCss.retryButton} onClick={() => setRetryKey((value) => value + 1)}>重试</button>
        </StatePanel>
      </WorkspaceShell>
    );
  }

  if (state.phase === "pending") {
    return (
      <WorkspaceShell projectName={state.project.displayName} status={state.project.status}>
        <StatePanel role="status" title={state.title} body={state.message} loading={state.loading} />
      </WorkspaceShell>
    );
  }

  if (state.phase === "failed") {
    return <WorkspaceShell projectName={state.project.displayName} status={state.project.status}><StatePanel role="alert" title={`${state.project.displayName} 解析失败`} body={state.message} /></WorkspaceShell>;
  }

  return (
    <WorkspaceShell projectName={state.project.displayName} status={state.project.status}>
      <div className={studioCss.workspaceContent}>
        <nav className={studioCss.workspaceTabs} role="tablist" aria-label="工程分析视图">
          {tabs.map((tab) => (
            <button
              key={tab.label}
              type="button"
              role="tab"
              id={`workspace-tab-${tab.id}`}
              aria-controls={`workspace-panel-${tab.id}`}
              aria-selected={activeTab === tab.id}
              disabled={!tab.available}
              title={tab.available ? undefined : "该视图将在后续分析阶段开放"}
              onClick={() => tab.available && setActiveTab(tab.id)}
            >
              {tab.label}
            </button>
          ))}
        </nav>
        {state.snapshotNotice && (
          <aside className={studioCss.snapshotNotice} role="status" aria-label="快照状态">
            {state.snapshotNotice}
          </aside>
        )}
        {state.analysis.status === "partial" && (
          <aside className={studioCss.partialNotice} role="status" aria-label="部分解析">
            这个快照只完成了部分解析，已展示可确认的数据；详情见解析说明。
          </aside>
        )}
        <div
          id={`workspace-panel-${activeTab}`}
          className={studioCss.workspaceScroll}
          role="tabpanel"
          aria-labelledby={`workspace-tab-${activeTab}`}
          aria-label={tabs.find((tab) => tab.id === activeTab)?.label}
        >
          {activeTab === "overview" && <ProjectDashboard analysis={state.analysis} project={state.project} />}
          {activeTab === "arrangement" && (
            <ArrangementAnalysis
              analysis={state.analysis}
              onSelectPattern={(patternId) => {
                setSelectedPatternId(patternId);
                setActiveTab("pattern");
              }}
            />
          )}
          {activeTab === "pattern" && (
            <PatternExplorer
              analysis={state.analysis}
              selectedPatternId={selectedPatternId}
              onSelectPattern={setSelectedPatternId}
            />
          )}
        </div>
      </div>
    </WorkspaceShell>
  );
}

async function loadWorkspace(projectId: string, signal: AbortSignal): Promise<WorkspaceState> {
  let project: StudioProjectDetail;
  try {
    project = await getStudioProject(projectId, { signal });
  } catch (cause) {
    if (cause instanceof ApiError && cause.status === 404) return { phase: "not-found" };
    return { phase: "error", message: errorMessage(cause) };
  }

  if (project.latestSnapshotId === null) {
    return stateWithoutSnapshot(project);
  }

  try {
    const analysis = await getStudioAnalysis(projectId, { signal });
    return {
      phase: "ready",
      project,
      analysis,
      snapshotNotice: snapshotNoticeFor(project.status)
    };
  } catch (cause) {
    if (
      cause instanceof ApiError
      && cause.status === 404
      && project.status !== "ready"
      && project.status !== "partial"
    ) {
      return stateWithoutSnapshot(project);
    }
    if (project.status === "failed") {
      return { phase: "failed", project, message: errorMessage(cause) };
    }
    return { phase: "error", message: errorMessage(cause) };
  }
}

function stateWithoutSnapshot(project: StudioProjectDetail): WorkspaceState {
  switch (project.status) {
    case "discovered":
      return {
        phase: "pending",
        project,
        title: "工程已发现",
        message: "这个工程正在等待开始解析，完成后会在这里生成第一份分析快照。",
        loading: false
      };
    case "queued":
      return {
        phase: "pending",
        project,
        title: "等待解析",
        message: "工程已进入解析队列，当前还没有可浏览的分析快照。",
        loading: true
      };
    case "parsing":
      return {
        phase: "pending",
        project,
        title: "正在解析工程",
        message: "解析正在进行，第一份分析快照完成后会自动出现在这里。",
        loading: true
      };
    case "failed":
      return {
        phase: "failed",
        project,
        message: "当前解析失败，且没有可浏览的成功快照。请在重新扫描后再试。"
      };
    case "stale":
      return {
        phase: "pending",
        project,
        title: "工程待更新",
        message: "源工程已经变化，正在等待生成新快照。",
        loading: false
      };
    case "ready":
    case "partial":
      return {
        phase: "error",
        message: "工程状态与分析快照不一致：当前没有可用的分析快照。"
      };
  }
}

function snapshotNoticeFor(status: StudioProjectDetail["status"]): string | null {
  switch (status) {
    case "queued": return "新一轮解析正在等待；展示上次成功快照。";
    case "parsing": return "新一轮解析正在进行；展示上次成功快照。";
    case "failed": return "当前解析失败；展示上次成功快照。";
    case "stale": return "源工程已变化；展示上次成功快照，等待更新。";
    case "discovered": return "工程已重新发现；展示最近一次成功快照。";
    case "ready":
    case "partial":
      return null;
  }
}

function WorkspaceShell({
  children,
  projectName,
  status
}: {
  children: React.ReactNode;
  projectName?: string;
  status?: StudioAnalysis["status"];
}) {
  return (
    <main className="studio-workbench" aria-label="工程资料室">
      <section className={`studio-window ${studioCss.workspaceWindow}`}>
        <aside className={`studio-shelf ${studioCss.workspaceShelf}`} aria-label="工程导航">
          <div className="studio-brand"><p className="eyebrow">KumikoRoom</p><h1>资料室</h1></div>
          <div className={studioCss.workspaceIdentity}>
            <span>当前工程</span>
            <strong>{projectName || "工程档案"}</strong>
            {status && <small data-status={status}>{statusLabel(status)}</small>}
          </div>
          <div className="studio-links"><a className="studio-link" href="/studio">返回工程库</a><a className="studio-link" href="/room">回到聊天</a></div>
        </aside>
        <section className={`studio-desk ${studioCss.workspaceDesk}`} aria-label="工程分析">
          <header className={`studio-desk__header ${studioCss.workspaceHeader}`}>
            <div><span>工程档案</span><strong>{projectName || "分析工作台"}</strong></div>
            <p>只读快照 · 不修改源 FLP</p>
          </header>
          {children}
        </section>
      </section>
    </main>
  );
}

function StatePanel({
  title,
  body,
  role,
  loading = false,
  children
}: {
  title: string;
  body: string;
  role?: "status" | "alert";
  loading?: boolean;
  children?: React.ReactNode;
}) {
  return (
    <section className={studioCss.workspaceState} role={role}>
      {loading && <span className={studioCss.loadingLine} aria-hidden="true" />}
      <p className={studioCss.panelKicker}>PROJECT ARCHIVE</p>
      <h2>{title}</h2>
      <p>{body}</p>
      {children}
    </section>
  );
}

function errorMessage(cause: unknown): string {
  return cause instanceof Error && cause.message ? cause.message : "工程分析请求失败";
}

function statusLabel(status: StudioAnalysis["status"]): string {
  const labels: Record<StudioAnalysis["status"], string> = {
    discovered: "已发现",
    queued: "等待解析",
    parsing: "解析中",
    ready: "解析完成",
    partial: "部分解析",
    failed: "解析失败",
    stale: "需要更新"
  };
  return labels[status];
}

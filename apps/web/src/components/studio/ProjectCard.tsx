import type { StudioAnalysis, StudioProjectDetail, StudioProjectSummary } from "../../api/studioTypes";
import studioCss from "./Studio.module.css";

const statusLabels: Record<StudioProjectSummary["status"], string> = {
  discovered: "待解析",
  queued: "排队中",
  parsing: "解析中",
  ready: "解析完成",
  partial: "部分解析",
  failed: "解析失败",
  stale: "需要更新"
};

interface ProjectCardProps {
  project: StudioProjectSummary;
  analysis?: StudioAnalysis;
  detail?: StudioProjectDetail | null;
}
export function ProjectCard({ project, analysis, detail }: ProjectCardProps) {
  const missingDependencies = analysis?.dependencies.filter((item) => !item.exists).length ?? 0;
  const dependencyStatus = analysis === undefined
    ? "unknown"
    : missingDependencies > 0
      ? "missing"
      : "complete";
  const issueCount = project.warningCount + project.errorCount;
  const pluginNames = Array.from(new Set(analysis?.plugins.map((plugin) => plugin.name) ?? [])).slice(0, 3);

  return (
    <a className={studioCss.projectCard} href={`/studio/projects/${encodeURIComponent(project.id)}`}>
      <header className={studioCss.projectCardHeader}>
        <div>
          <span className={studioCss.projectFormat}>FLP</span>
          <h3>{project.displayName}</h3>
        </div>
        <span className={studioCss.statusMark} data-status={project.status}>{statusLabels[project.status]}</span>
      </header>

      <dl className={studioCss.projectMetrics}>
        <div><dt>速度</dt><dd>{project.tempo === null ? "—" : `${formatTempo(project.tempo)} BPM`}</dd></div>
        <div><dt>调式</dt><dd>{project.inferredKey ?? "未推测"}</dd></div>
        <div><dt>Pattern</dt><dd>{project.patternCount}</dd></div>
      </dl>

      <div className={studioCss.projectSignals}>
        {issueCount > 0 ? <span data-tone="warm">{issueCount} 个提醒</span> : <span>结构平稳</span>}
        {dependencyStatus === "missing" ? <span data-tone="danger">缺少 {missingDependencies} 项依赖</span> : null}
        {dependencyStatus === "complete" ? <span>依赖完整</span> : null}
        {dependencyStatus === "unknown" ? <span data-tone="unknown">依赖尚未分析</span> : null}
      </div>

      {pluginNames.length > 0 ? (
        <p className={studioCss.pluginLine} title={pluginNames.join("、")}>插件 · {pluginNames.join("、")}</p>
      ) : null}

      <footer className={studioCss.projectCardFooter}>
        <span>最近编辑 {formatDate(project.modifiedAt)}</span>
        <span>上次分析 {detail === undefined ? "待载入" : detail === null ? "不可用" : formatDate(detail.latestSnapshotAnalyzedAt)}</span>
      </footer>
    </a>
  );
}

function formatTempo(value: number): string {
  return Number.isInteger(value) ? String(value) : value.toFixed(1);
}

function formatDate(value: string | null): string {
  if (!value) return "未知";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "未知";
  return new Intl.DateTimeFormat("zh-CN", { month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" }).format(date);
}

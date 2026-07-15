import type { StudioAnalysis, StudioAnalysisDiagnostic, StudioProjectDetail } from "../../api/studioTypes";
import { MusicalFingerprint } from "./MusicalFingerprint";
import studioCss from "./Studio.module.css";

interface ProjectDashboardProps {
  analysis: StudioAnalysis;
  project?: StudioProjectDetail;
}

const severityLabels: Record<StudioAnalysisDiagnostic["severity"], string> = {
  error: "错误",
  warning: "提醒",
  notice: "说明"
};

export function ProjectDashboard({ analysis, project }: ProjectDashboardProps) {
  const title = analysis.project.title?.trim() || project?.displayName || fileStem(analysis.sourcePath);
  const tempo = analysis.project.tempo ?? project?.tempo ?? null;
  const missingDependencies = analysis.dependencies.filter((dependency) => !dependency.exists);
  const timeSignature = analysis.project.timeSignatureNumerator !== null && analysis.project.timeSignatureDenominator !== null
    ? `${analysis.project.timeSignatureNumerator}/${analysis.project.timeSignatureDenominator}`
    : "未读取";

  return (
    <article className={studioCss.dashboard}>
      <header className={studioCss.projectHero}>
        <div>
          <p className={studioCss.panelKicker}>FL STUDIO PROJECT DOSSIER</p>
          <h1>{title}</h1>
          <p className={studioCss.projectPath}>{analysis.sourcePath}</p>
        </div>
        <dl className={studioCss.heroMetadata} aria-label="工程元数据">
          <Meta label="作者" value={analysis.project.author || "未署名"} />
          <Meta label="FL Studio" value={analysis.project.flVersion || "版本未读取"} />
          <Meta label="拍号" value={timeSignature} />
          <Meta label="PPQ" value={formatNumber(analysis.project.ppq)} />
        </dl>
      </header>

      <section className={studioCss.metricLedger} aria-label="工程指标">
        <Metric value={tempo === null ? "BPM 未读取" : `${formatDecimal(tempo)} BPM`} label="速度" />
        <Metric value={`${analysis.patterns.length} Patterns`} label="Pattern 数量" />
        <Metric value={`${analysis.channels.length} Channels`} label="Channel 数量" />
        <Metric value={`${analysis.playlistClips.length} Clips`} label="Playlist 片段" />
        <Metric value={`${analysis.plugins.length} Plugins`} label="插件实例" />
        <Metric value={`${missingDependencies.length} 条依赖提醒`} label="缺失文件" tone={missingDependencies.length > 0 ? "warm" : "quiet"} />
      </section>

      <MusicalFingerprint fingerprint={analysis.fingerprint} />

      <section className={studioCss.dashboardLower}>
        <section className={studioCss.paperPanel} aria-labelledby="diagnostics-heading">
          <header className={studioCss.paperPanelHeader}>
            <div>
              <p className={studioCss.panelKicker}>PARSER NOTES</p>
              <h2 id="diagnostics-heading">解析说明</h2>
            </div>
            <span>{analysis.diagnostics.length} 条</span>
          </header>
          {analysis.diagnostics.length > 0 ? (
            <ul className={studioCss.diagnosticList}>
              {analysis.diagnostics.map((diagnostic, index) => (
                <li key={`${diagnostic.code}-${diagnostic.targetId ?? index}`} data-severity={diagnostic.severity}>
                  <span>{severityLabels[diagnostic.severity]}</span>
                  <div><strong>{diagnostic.message}</strong><small>{diagnostic.code}</small></div>
                </li>
              ))}
            </ul>
          ) : <p className={studioCss.panelEmpty}>当前快照没有解析提醒。</p>}
        </section>

        <section className={studioCss.paperPanel} aria-labelledby="dependency-heading">
          <header className={studioCss.paperPanelHeader}>
            <div>
              <p className={studioCss.panelKicker}>DEPENDENCY HEALTH</p>
              <h2 id="dependency-heading">依赖概况</h2>
            </div>
            <span>{missingDependencies.length}/{analysis.dependencies.length}</span>
          </header>
          {missingDependencies.length > 0 ? (
            <ul className={studioCss.dependencyPreview}>
              {missingDependencies.slice(0, 4).map((dependency) => (
                <li key={`${dependency.kind}-${dependency.path}`}><strong>{leafName(dependency.path)}</strong><span>{dependency.kind}</span></li>
              ))}
            </ul>
          ) : <p className={studioCss.panelEmpty}>{analysis.dependencies.length > 0 ? "已记录的依赖均可用。" : "工程没有报告外部依赖。"}</p>}
        </section>
      </section>
    </article>
  );
}

function Metric({ value, label, tone = "default" }: { value: string; label: string; tone?: "default" | "warm" | "quiet" }) {
  return <div data-tone={tone}><strong>{value}</strong><span>{label}</span></div>;
}

function Meta({ label, value }: { label: string; value: string }) {
  return <div><dt>{label}</dt><dd>{value}</dd></div>;
}

function formatDecimal(value: number): string {
  return Number.isInteger(value) ? String(value) : value.toFixed(2).replace(/0+$/, "").replace(/\.$/, "");
}

function formatNumber(value: number | null): string {
  return value === null ? "未读取" : formatDecimal(value);
}

function fileStem(path: string): string {
  const name = leafName(path);
  return name.replace(/\.flp$/i, "") || "未命名工程";
}

function leafName(path: string): string {
  return path.split(/[\\/]/).filter(Boolean).at(-1) || path;
}

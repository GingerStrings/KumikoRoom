"use client";

import type { StudioAnalysis, StudioAnalysisDiagnostic, StudioDependencyReference } from "../../api/studioTypes";
import type { PluginMixerTarget } from "./PluginMixerView";
import studioCss from "./Studio.module.css";

export type DiagnosticNavigation =
  | { tab: "pattern"; patternId: string }
  | { tab: "plugins"; target: PluginMixerTarget }
  | { tab: "dependencies" };

interface DependencyReportProps {
  analysis: StudioAnalysis;
  onNavigate?: (navigation: DiagnosticNavigation) => void;
}

export function DependencyReport({ analysis, onNavigate }: DependencyReportProps) {
  const missing = analysis.dependencies.filter((dependency) => dependency.exists === false);
  const available = analysis.dependencies.filter((dependency) => dependency.exists === true);
  const severities = (["error", "warning", "notice"] as const).map((severity) => ({
    severity,
    diagnostics: analysis.diagnostics.filter((diagnostic) => diagnostic.severity === severity)
  }));

  return (
    <article className={studioCss.analysisView} aria-label="依赖与结构诊断">
      <header className={studioCss.analysisViewHeader}>
        <div><p className={studioCss.panelKicker}>PROJECT INTEGRITY</p><h1>依赖与诊断</h1><p>文件状态来自解析快照；诊断跳转只在目标能唯一确认时开放。</p></div>
        <div className={studioCss.dependencyTotals} aria-label="依赖摘要"><strong>{missing.length}</strong><span>缺失</span><strong>{available.length}</strong><span>可用</span></div>
      </header>

      <section className={studioCss.dependencyColumns} aria-label="依赖分组">
        <DependencyGroup title="缺失" tone="missing" dependencies={missing} empty="没有已报告的缺失依赖。" />
        <DependencyGroup title="可用" tone="available" dependencies={available} empty="没有已报告的可用依赖。" />
        <section className={studioCss.dependencyGroup} data-tone="unknown" aria-labelledby="dependency-unknown-heading">
          <header><h2 id="dependency-unknown-heading">未知</h2><span>—</span></header>
          <p className={studioCss.dependencyUnknown}>当前模型只携带已报告依赖的 exists 布尔值；解析器未报告的依赖无法判断。{analysis.dependencies.length === 0 ? " 这个快照没有依赖数据。" : " 缺失项保留在“缺失”组。"}</p>
        </section>
      </section>

      <section className={studioCss.diagnosticReport} aria-labelledby="diagnostic-report-heading">
        <header><div><p className={studioCss.panelKicker}>PARSER NOTES</p><h2 id="diagnostic-report-heading">解析说明</h2></div><span>{analysis.diagnostics.length}</span></header>
        {analysis.diagnostics.length > 0 ? severities.map(({ severity, diagnostics }) => diagnostics.length > 0 && (
          <DiagnosticSeverity key={severity} severity={severity} diagnostics={diagnostics} analysis={analysis} onNavigate={onNavigate} />
        )) : <p className={studioCss.signalEmpty}>快照没有报告解析诊断。</p>}
      </section>
    </article>
  );
}

function DependencyGroup({ title, tone, dependencies, empty }: {
  title: string;
  tone: "missing" | "available";
  dependencies: StudioDependencyReference[];
  empty: string;
}) {
  return (
    <section className={studioCss.dependencyGroup} data-tone={tone} aria-labelledby={`dependency-${tone}-heading`}>
      <header><h2 id={`dependency-${tone}-heading`}>{title}</h2><span>{dependencies.length}</span></header>
      {dependencies.length > 0 ? <ul>{dependencies.map((dependency, index) => {
        const name = fileName(dependency.path);
        return <li key={`${dependency.path}-${index}`}><div><strong title={dependency.path}>{name}</strong><small>{dependency.kind || "类型未知"} · {dependency.path}</small></div><button type="button" disabled aria-describedby="locate-capability-note" aria-label={`查看 ${name} 所在位置`}>定位</button></li>;
      })}</ul> : <p>{empty}</p>}
      <small id={tone === "missing" ? "locate-capability-note" : undefined} className={studioCss.locateNote}>Task13 本地打开能力接入后可用</small>
    </section>
  );
}

function DiagnosticSeverity({ severity, diagnostics, analysis, onNavigate }: {
  severity: StudioAnalysisDiagnostic["severity"];
  diagnostics: StudioAnalysisDiagnostic[];
  analysis: StudioAnalysis;
  onNavigate?: (navigation: DiagnosticNavigation) => void;
}) {
  const groups = groupByTarget(diagnostics);
  return (
    <section className={studioCss.diagnosticSeverity} data-severity={severity} aria-labelledby={`diagnostic-${severity}-heading`}>
      <h3 id={`diagnostic-${severity}-heading`}>{severityLabel(severity)} · {diagnostics.length}</h3>
      {groups.map((group) => <section key={group.key} className={studioCss.diagnosticTargetGroup}>
        <h4>{group.label}</h4>
        <ul>{group.items.map((diagnostic, index) => {
          const navigation = diagnosticNavigation(diagnostic, analysis);
          return <li key={`${diagnostic.code}-${index}`}><div><strong>{diagnostic.code}</strong><p>{diagnostic.message}</p></div><button type="button" disabled={!navigation} title={navigation ? "跳转到相关分析" : "当前模型无法识别这个诊断目标"} onClick={() => navigation && onNavigate?.(navigation)}>{navigation ? "查看目标" : "无法定位"}</button></li>;
        })}</ul>
      </section>)}
    </section>
  );
}

function groupByTarget(diagnostics: StudioAnalysisDiagnostic[]) {
  const groups = new Map<string, { key: string; label: string; items: StudioAnalysisDiagnostic[] }>();
  for (const diagnostic of diagnostics) {
    const key = `${diagnostic.targetType ?? "project"}:${diagnostic.targetId ?? ""}`;
    const label = diagnostic.targetType && diagnostic.targetId ? `${diagnostic.targetType} · ${diagnostic.targetId}` : "工程级";
    const group = groups.get(key) ?? { key, label, items: [] };
    group.items.push(diagnostic);
    groups.set(key, group);
  }
  return [...groups.values()];
}

function diagnosticNavigation(diagnostic: StudioAnalysisDiagnostic, analysis: StudioAnalysis): DiagnosticNavigation | null {
  if (!diagnostic.targetType || !diagnostic.targetId) return null;
  const type = diagnostic.targetType.trim().toLowerCase().replace(/-/g, "_");
  const id = diagnostic.targetId;
  if (type === "pattern" && analysis.patterns.some((item) => item.id === id)) return { tab: "pattern", patternId: id };
  if (type === "channel" && analysis.channels.some((item) => item.id === id)) return { tab: "plugins", target: { type: "channel", id } };
  if (type === "plugin" && analysis.plugins.some((item) => item.id === id)) return { tab: "plugins", target: { type: "plugin", id } };
  if (["mixer", "mixer_insert", "insert"].includes(type) && analysis.mixerInserts.some((item) => item.id === id)) return { tab: "plugins", target: { type: "mixer_insert", id } };
  if (["dependency", "asset", "path"].includes(type) && analysis.dependencies.some((item) => item.path === id)) return { tab: "dependencies" };
  return null;
}

function severityLabel(severity: StudioAnalysisDiagnostic["severity"]): string {
  return severity === "error" ? "错误" : severity === "warning" ? "警告" : "提示";
}

function fileName(value: string): string {
  const segments = value.replace(/\\/g, "/").split("/").filter(Boolean);
  return segments[segments.length - 1] || value || "未命名依赖";
}

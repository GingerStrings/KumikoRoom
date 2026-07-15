"use client";

import { useEffect, useId, useRef, useState } from "react";
import { openStudioAsset } from "../../api/studioClient";
import type { StudioAnalysis, StudioAnalysisDiagnostic, StudioDependencyReference } from "../../api/studioTypes";
import type { PluginMixerTarget } from "./PluginMixerView";
import studioCss from "./Studio.module.css";

export type DiagnosticNavigation =
  | { tab: "pattern"; patternId: string }
  | { tab: "plugins"; target: PluginMixerTarget }
  | { tab: "dependencies" };

interface DependencyReportProps {
  analysis: StudioAnalysis;
  projectId?: string;
  onNavigate?: (navigation: DiagnosticNavigation) => void;
}

export function DependencyReport({ analysis, projectId, onNavigate }: DependencyReportProps) {
  const instanceId = useId();
  const requestSequence = useRef(0);
  const controller = useRef<AbortController | null>(null);
  const [openingEntityId, setOpeningEntityId] = useState<string | null>(null);
  const [openError, setOpenError] = useState<string | null>(null);
  const diagnosticReportHeadingId = `${instanceId}-diagnostic-report-heading`;
  const unresolvedTargets = new Set(analysis.diagnostics
    .filter((diagnostic) => (
      diagnostic.code === "unresolved_dependency"
      && normalizeTargetType(diagnostic.targetType) === "dependency"
      && typeof diagnostic.targetId === "string"
      && diagnostic.targetId.length > 0
    ))
    .map((diagnostic) => diagnostic.targetId as string));
  const missing = analysis.dependencies.filter((dependency) => dependency.exists === false && !unresolvedTargets.has(dependency.path));
  const available = analysis.dependencies.filter((dependency) => dependency.exists === true);
  const unknown = analysis.dependencies.filter((dependency) => dependency.exists === false && unresolvedTargets.has(dependency.path));
  const severities = (["error", "warning", "notice"] as const).map((severity) => ({
    severity,
    diagnostics: analysis.diagnostics.filter((diagnostic) => diagnostic.severity === severity)
  }));

  useEffect(() => () => {
    requestSequence.current += 1;
    controller.current?.abort();
  }, [projectId]);

  async function openDependency(entityId: string) {
    if (!projectId) return;
    controller.current?.abort();
    const currentController = new AbortController();
    const sequence = requestSequence.current + 1;
    requestSequence.current = sequence;
    controller.current = currentController;
    setOpeningEntityId(entityId);
    setOpenError(null);
    try {
      await openStudioAsset(projectId, { kind: "dependency", entityId }, { signal: currentController.signal });
    } catch (cause) {
      if (!currentController.signal.aborted && requestSequence.current === sequence) {
        setOpenError(localOpenError(cause));
      }
    } finally {
      if (requestSequence.current === sequence) setOpeningEntityId(null);
    }
  }

  return (
    <article className={studioCss.analysisView} aria-label="依赖与结构诊断">
      <header className={studioCss.analysisViewHeader}>
        <div><p className={studioCss.panelKicker}>PROJECT INTEGRITY</p><h1>依赖与诊断</h1><p>文件状态来自解析快照；诊断跳转只在目标能唯一确认时开放。</p></div>
        <div className={studioCss.dependencyTotals} aria-label="依赖摘要"><strong>{missing.length}</strong><span>缺失</span><strong>{available.length}</strong><span>可用</span><strong>{unknown.length}</strong><span>未知</span></div>
      </header>

      <section className={studioCss.dependencyColumns} aria-label="依赖分组">
        <DependencyGroup idPrefix={instanceId} title="缺失" tone="missing" dependencies={missing} empty="没有已报告的缺失依赖。" projectId={projectId} openingEntityId={openingEntityId} onOpen={openDependency} />
        <DependencyGroup idPrefix={instanceId} title="可用" tone="available" dependencies={available} empty="没有已报告的可用依赖。" projectId={projectId} openingEntityId={openingEntityId} onOpen={openDependency} />
        <DependencyGroup
          idPrefix={instanceId}
          title="未知"
          tone="unknown"
          dependencies={unknown}
          empty="没有被 unresolved_dependency 精确标记的未知依赖。"
          description={unknown.length > 0
            ? "解析器明确标记为未解析，这些路径的存在性暂时无法确认。"
            : analysis.dependencies.length === 0
              ? "当前模型没有可判断的记录；这个快照没有依赖数据。"
              : "当前模型只会把 unresolved_dependency 精确指向的路径列为未知。"}
          projectId={projectId}
          openingEntityId={openingEntityId}
          onOpen={openDependency}
        />
      </section>

      {openError && <p className={studioCss.localOpenError} role="alert">{openError}</p>}

      <section className={studioCss.diagnosticReport} aria-labelledby={diagnosticReportHeadingId}>
        <header><div><p className={studioCss.panelKicker}>PARSER NOTES</p><h2 id={diagnosticReportHeadingId}>解析说明</h2></div><span>{analysis.diagnostics.length}</span></header>
        {analysis.diagnostics.length > 0 ? severities.map(({ severity, diagnostics }) => diagnostics.length > 0 && (
          <DiagnosticSeverity key={severity} idPrefix={instanceId} severity={severity} diagnostics={diagnostics} analysis={analysis} onNavigate={onNavigate} />
        )) : <p className={studioCss.signalEmpty}>快照没有报告解析诊断。</p>}
      </section>
    </article>
  );
}

function DependencyGroup({ idPrefix, title, tone, dependencies, empty, description, projectId, openingEntityId, onOpen }: {
  idPrefix: string;
  title: string;
  tone: "missing" | "available" | "unknown";
  dependencies: StudioDependencyReference[];
  empty: string;
  description?: string;
  projectId?: string;
  openingEntityId: string | null;
  onOpen: (entityId: string) => void;
}) {
  const headingId = `${idPrefix}-dependency-${tone}-heading`;
  const locateCapabilityId = `${idPrefix}-locate-capability-${tone}`;
  return (
    <section className={studioCss.dependencyGroup} data-tone={tone} aria-labelledby={headingId}>
      <header><h2 id={headingId}>{title}</h2><span>{dependencies.length}</span></header>
      {description && <p className={studioCss.dependencyUnknown}>{description}</p>}
      {dependencies.length > 0 ? <ul>{dependencies.map((dependency, index) => {
        const name = fileName(dependency.path);
        const entityId = dependency.entityId;
        const opening = Boolean(entityId && openingEntityId === entityId);
        return <li key={`${dependency.path}-${index}`}><div><strong title={dependency.path}>{name}</strong><small>{dependency.kind || "类型未知"} · {dependency.path}</small></div><button type="button" disabled={!projectId || !entityId || opening} aria-busy={opening || undefined} aria-describedby={locateCapabilityId} aria-label={`查看 ${name} 所在位置`} onClick={() => entityId && onOpen(entityId)}>{opening ? "定位中…" : "定位"}</button></li>;
      })}</ul> : <p>{empty}</p>}
      <small id={locateCapabilityId} className={studioCss.locateNote}>{projectId ? "路径由资料室记录安全定位" : "请从工程详情页使用本地定位"}</small>
    </section>
  );
}

function DiagnosticSeverity({ idPrefix, severity, diagnostics, analysis, onNavigate }: {
  idPrefix: string;
  severity: StudioAnalysisDiagnostic["severity"];
  diagnostics: StudioAnalysisDiagnostic[];
  analysis: StudioAnalysis;
  onNavigate?: (navigation: DiagnosticNavigation) => void;
}) {
  const groups = groupByTarget(diagnostics);
  const headingId = `${idPrefix}-diagnostic-${severity}-heading`;
  return (
    <section className={studioCss.diagnosticSeverity} data-severity={severity} aria-labelledby={headingId}>
      <h3 id={headingId}>{severityLabel(severity)} · {diagnostics.length}</h3>
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
  const type = normalizeTargetType(diagnostic.targetType);
  const id = diagnostic.targetId;
  if (type === "pattern" && countMatches(analysis.patterns, (item) => item.id === id) === 1) return { tab: "pattern", patternId: id };
  if (type === "channel" && countMatches(analysis.channels, (item) => item.id === id) === 1) return { tab: "plugins", target: { type: "channel", id } };
  if (type === "plugin" && countMatches(analysis.plugins, (item) => item.id === id) === 1) return { tab: "plugins", target: { type: "plugin", id } };
  if (["mixer", "mixer_insert", "insert"].includes(type) && countMatches(analysis.mixerInserts, (item) => item.id === id) === 1) return { tab: "plugins", target: { type: "mixer_insert", id } };
  if (["dependency", "asset", "path"].includes(type) && countMatches(analysis.dependencies, (item) => item.path === id) === 1) return { tab: "dependencies" };
  return null;
}

function normalizeTargetType(targetType: string | null): string {
  return targetType?.trim().toLowerCase().replace(/-/g, "_") ?? "";
}

function countMatches<T>(items: T[], predicate: (item: T) => boolean): number {
  return items.reduce((count, item) => count + (predicate(item) ? 1 : 0), 0);
}

function severityLabel(severity: StudioAnalysisDiagnostic["severity"]): string {
  return severity === "error" ? "错误" : severity === "warning" ? "警告" : "提示";
}

function fileName(value: string): string {
  const segments = value.replace(/\\/g, "/").split("/").filter(Boolean);
  return segments[segments.length - 1] || value || "未命名依赖";
}

function localOpenError(cause: unknown): string {
  return cause instanceof Error && cause.message ? cause.message : "暂时无法打开本地位置";
}

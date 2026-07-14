"use client";

import { FormEvent, useEffect, useMemo, useState } from "react";
import {
  addStudioRoot,
  getStudioAnalysis,
  getStudioProject,
  getStudioProjects,
  getStudioScan,
  removeStudioRoot,
  startStudioScan
} from "../../api/studioClient";
import type { StudioAnalysis, StudioProjectDetail, StudioProjectSummary, StudioRoot, StudioScanJob } from "../../api/studioTypes";
import { ProjectCard } from "./ProjectCard";
import { ScanStatus } from "./ScanStatus";
import studioCss from "./Studio.module.css";

interface StudioLibraryProps {
  initialProjects: StudioProjectSummary[];
  initialRoots: StudioRoot[];
  initialAnalyses?: Record<string, StudioAnalysis>;
  initialDetails?: Record<string, StudioProjectDetail>;
}
type Metadata = {
  analyses: Record<string, StudioAnalysis>;
  details: Record<string, StudioProjectDetail>;
};

export function StudioLibrary({ initialProjects, initialRoots, initialAnalyses = {}, initialDetails = {} }: StudioLibraryProps) {
  const [projects, setProjects] = useState(initialProjects);
  const [roots, setRoots] = useState(initialRoots);
  const [analyses, setAnalyses] = useState(initialAnalyses);
  const [details, setDetails] = useState(initialDetails);
  const [scanJob, setScanJob] = useState<StudioScanJob | null>(null);
  const [path, setPath] = useState("");
  const [query, setQuery] = useState("");
  const [status, setStatus] = useState("all");
  const [bpm, setBpm] = useState("all");
  const [key, setKey] = useState("all");
  const [plugin, setPlugin] = useState("all");
  const [dependency, setDependency] = useState("all");
  const [sort, setSort] = useState("recent");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!scanJob || (scanJob.status !== "queued" && scanJob.status !== "running")) return;
    const timer = window.setTimeout(async () => {
      try {
        const next = await getStudioScan(scanJob.id);
        setScanJob(next);
        if (next.status === "completed") await refreshProjects();
        if (next.status === "failed" && next.error) setError(next.error);
      } catch (cause) {
        setError(errorMessage(cause));
      }
    }, 1000);
    return () => window.clearTimeout(timer);
  }, [scanJob]);

  const keys = useMemo(() => uniqueSorted(projects.map((project) => project.inferredKey)), [projects]);
  const plugins = useMemo(() => uniqueSorted(Object.values(analyses).flatMap((analysis) => analysis.plugins.map((item) => item.name))), [analyses]);
  const filteredProjects = useMemo(() => {
    const normalizedQuery = query.trim().toLocaleLowerCase();
    return [...projects]
      .filter((project) => {
        const projectPlugins = analyses[project.id]?.plugins.map((item) => item.name) ?? [];
        const projectAnalysis = analyses[project.id];
        const dependencyStatus = projectAnalysis === undefined
          ? "unknown"
          : projectAnalysis.dependencies.some((item) => !item.exists)
            ? "missing"
            : "complete";
        return (!normalizedQuery || `${project.displayName} ${project.canonicalPath}`.toLocaleLowerCase().includes(normalizedQuery))
          && (status === "all" || project.status === status)
          && matchesBpm(project.tempo, bpm)
          && (key === "all" || project.inferredKey === key)
          && (plugin === "all" || projectPlugins.includes(plugin))
          && (dependency === "all" || dependency === dependencyStatus);
      })
      .sort((left, right) => sort === "name"
        ? left.displayName.localeCompare(right.displayName, "zh-CN")
        : dateValue(right.modifiedAt) - dateValue(left.modifiedAt));
  }, [analyses, bpm, dependency, key, plugin, projects, query, sort, status]);

  async function refreshProjects() {
    const nextProjects = await getStudioProjects();
    setProjects(nextProjects);
    const metadata = await loadMetadata(nextProjects);
    setAnalyses(metadata.analyses);
    setDetails(metadata.details);
  }

  async function beginScan() {
    setBusy(true);
    setError(null);
    try {
      setScanJob(await startStudioScan());
    } catch (cause) {
      setError(errorMessage(cause));
    } finally {
      setBusy(false);
    }
  }

  async function submitRoot(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const normalizedPath = path.trim();
    if (!normalizedPath) return;
    setBusy(true);
    setError(null);
    try {
      const added = await addStudioRoot(normalizedPath);
      setRoots((current) => current.some((root) => root.id === added.id) ? current : [...current, added]);
      setPath("");
      setScanJob(await startStudioScan());
    } catch (cause) {
      setError(errorMessage(cause));
    } finally {
      setBusy(false);
    }
  }

  async function deleteRoot(root: StudioRoot) {
    setBusy(true);
    setError(null);
    try {
      await removeStudioRoot(root.id);
      setRoots((current) => current.filter((item) => item.id !== root.id));
    } catch (cause) {
      setError(errorMessage(cause));
    } finally {
      setBusy(false);
    }
  }

  const scanActive = scanJob?.status === "queued" || scanJob?.status === "running";

  return (
    <div className={studioCss.library}>
      <section className={studioCss.libraryTopline}>
        <form className={studioCss.pathForm} aria-label="添加工程目录" onSubmit={submitRoot}>
          <label htmlFor="studio-root-path">工程目录</label>
          <div>
            <input id="studio-root-path" value={path} onChange={(event) => setPath(event.target.value)} placeholder="D:\\Music\\Projects" disabled={busy} />
            <button type="submit" disabled={busy || !path.trim()}>添加并扫描</button>
          </div>
        </form>
        <button className={studioCss.scanButton} type="button" onClick={beginScan} disabled={busy || scanActive || roots.length === 0}>
          {scanActive ? "扫描进行中" : "重新扫描"}
        </button>
      </section>

      {roots.length > 0 ? (
        <div className={studioCss.rootList} aria-label="已连接目录">
          {roots.map((root) => (
            <span key={root.id} title={root.path}>
              <span>{root.path}</span>
              <button type="button" aria-label={`移除 ${root.path}`} onClick={() => deleteRoot(root)} disabled={busy}>移除</button>
            </span>
          ))}
        </div>
      ) : null}

      {error ? <div className={studioCss.libraryError} role="alert">{error}</div> : null}
      {scanJob ? <ScanStatus job={scanJob} /> : null}

      {projects.length === 0 ? (
        <section className={studioCss.emptyState}>
          <p className={studioCss.kicker}>LOCAL ARCHIVE</p>
          <h2>{roots.length === 0 ? "添加第一个工程目录" : "目录里还没有发现 FLP 工程"}</h2>
          <p>{roots.length === 0 ? "连接保存 FL Studio 工程的文件夹，资料室会以只读方式建立档案。" : "可以重新扫描，或添加另一个保存工程的目录。"}</p>
        </section>
      ) : (
        <>
          <section className={studioCss.filters} aria-label="筛选工程">
            <label className={studioCss.searchField}>搜索工程<input type="search" aria-label="搜索工程" value={query} onChange={(event) => setQuery(event.target.value)} placeholder="名称或路径" /></label>
            <Filter label="解析状态" value={status} onChange={setStatus} options={[["all", "全部状态"], ["discovered", "待解析"], ["queued", "排队中"], ["parsing", "解析中"], ["ready", "解析完成"], ["partial", "部分解析"], ["failed", "解析失败"], ["stale", "需要更新"]]} />
            <Filter label="BPM 范围" value={bpm} onChange={setBpm} options={[["all", "全部速度"], ["slow", "低于 90"], ["medium", "90–119"], ["fast", "120 以上"]]} />
            <Filter label="推测调式" value={key} onChange={setKey} options={[["all", "全部调式"], ...keys.map((item) => [item, item] as [string, string])]} />
            <Filter label="插件" value={plugin} onChange={setPlugin} options={[["all", "全部插件"], ...plugins.map((item) => [item, item] as [string, string])]} />
            <Filter label="依赖状态" value={dependency} onChange={setDependency} options={[["all", "全部依赖"], ["complete", "依赖完整"], ["missing", "存在缺失"], ["unknown", "尚未分析"]]} />
            <Filter label="排序" value={sort} onChange={setSort} options={[["recent", "最近编辑"], ["name", "工程名称"]]} />
          </section>

          <div className={studioCss.resultBar}><span>{filteredProjects.length} / {projects.length} 个工程</span><span>档案保持只读</span></div>
          {filteredProjects.length > 0 ? (
            <section className={studioCss.projectGrid} aria-label="工程列表">
              {filteredProjects.map((project) => <ProjectCard key={project.id} project={project} analysis={analyses[project.id]} detail={details[project.id]} />)}
            </section>
          ) : (
            <section className={studioCss.noResults}><h2>没有符合条件的工程</h2><p>调整筛选条件后，工程档案会重新出现。</p></section>
          )}
        </>
      )}
    </div>
  );
}

function Filter({ label, value, onChange, options }: { label: string; value: string; onChange: (value: string) => void; options: Array<[string, string]> }) {
  return <label>{label}<select aria-label={label} value={value} onChange={(event) => onChange(event.target.value)}>{options.map(([optionValue, name]) => <option key={optionValue} value={optionValue}>{name}</option>)}</select></label>;
}

async function loadMetadata(projects: StudioProjectSummary[]): Promise<Metadata> {
  const records = await Promise.all(projects.filter((project) => project.latestSnapshotId).map(async (project) => {
    const [analysis, detail] = await Promise.allSettled([getStudioAnalysis(project.id), getStudioProject(project.id)]);
    return { id: project.id, analysis, detail };
  }));
  const analyses: Record<string, StudioAnalysis> = {};
  const details: Record<string, StudioProjectDetail> = {};
  for (const record of records) {
    if (record.analysis.status === "fulfilled") analyses[record.id] = record.analysis.value;
    if (record.detail.status === "fulfilled") details[record.id] = record.detail.value;
  }
  return { analyses, details };
}

function matchesBpm(tempo: number | null, range: string): boolean {
  if (range === "all") return true;
  if (tempo === null) return false;
  if (range === "slow") return tempo < 90;
  if (range === "medium") return tempo >= 90 && tempo < 120;
  return tempo >= 120;
}

function dateValue(value: string | null): number {
  if (!value) return 0;
  const parsed = Date.parse(value);
  return Number.isNaN(parsed) ? 0 : parsed;
}

function uniqueSorted(values: Array<string | null>): string[] {
  return Array.from(new Set(values.filter((value): value is string => Boolean(value)))).sort((a, b) => a.localeCompare(b, "zh-CN"));
}

function errorMessage(cause: unknown): string {
  return cause instanceof Error && cause.message ? cause.message : "资料室请求失败，请稍后重试。";
}

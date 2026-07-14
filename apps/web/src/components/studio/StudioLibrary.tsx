"use client";

import { FormEvent, useEffect, useMemo, useRef, useState } from "react";
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
const METADATA_REQUEST_CONCURRENCY = 4;
const METADATA_REQUEST_TIMEOUT_MS = 10000;
const MAX_SCAN_POLL_RETRIES = 3;

export function StudioLibrary({ initialProjects, initialRoots, initialAnalyses = {}, initialDetails = {} }: StudioLibraryProps) {
  const [projects, setProjects] = useState(initialProjects);
  const [roots, setRoots] = useState(initialRoots);
  const [analyses, setAnalyses] = useState(initialAnalyses);
  const [details, setDetails] = useState<Record<string, StudioProjectDetail | null>>(initialDetails);
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
  const scanGeneration = useRef(0);
  const metadataGeneration = useRef(0);
  const firstMetadataPass = useRef(true);

  useEffect(() => {
    if (!scanJob || (scanJob.status !== "queued" && scanJob.status !== "running")) return;
    const jobId = scanJob.id;
    const generation = scanGeneration.current;
    let cancelled = false;
    let timer: number | undefined;
    let retryCount = 0;

    const schedule = (delay: number) => {
      timer = window.setTimeout(poll, delay);
    };
    const poll = async () => {
      try {
        const next = await getStudioScan(jobId);
        if (cancelled || scanGeneration.current !== generation) return;
        retryCount = 0;
        setError(null);
        setScanJob((current) => current?.id === jobId ? next : current);
        if (next.status === "completed") await refreshProjects(generation);
        if (next.status === "failed" && next.error) setError(next.error);
      } catch (cause) {
        if (cancelled || scanGeneration.current !== generation) return;
        const message = errorMessage(cause);
        setError(message);
        retryCount += 1;
        if (retryCount <= MAX_SCAN_POLL_RETRIES) {
          schedule(1000 * (2 ** retryCount));
        } else {
          setScanJob((current) => current?.id === jobId
            ? { ...current, status: "failed", error: `无法继续获取扫描状态：${message}` }
            : current);
        }
      }
    };

    schedule(1000);
    return () => {
      cancelled = true;
      if (timer !== undefined) window.clearTimeout(timer);
    };
  }, [scanJob]);

  useEffect(() => {
    const generation = ++metadataGeneration.current;
    let cancelled = false;
    const generationController = new AbortController();
    const isFirstPass = firstMetadataPass.current;
    firstMetadataPass.current = false;
    const seededAnalyses = isFirstPass ? initialAnalyses : {};
    const seededDetails = isFirstPass ? initialDetails : {};

    if (!isFirstPass) {
      setAnalyses({});
      setDetails({});
    }

    const tasks: Array<(signal: AbortSignal) => Promise<void>> = [];
    for (const project of projects) {
      if (!project.latestSnapshotId) continue;
      if (!seededAnalyses[project.id]) {
        tasks.push(async (signal) => {
          try {
            const value = await metadataRequest(
              (requestSignal) => getStudioAnalysis(project.id, { signal: requestSignal }),
              signal
            );
            if (!cancelled && metadataGeneration.current === generation) {
              setAnalyses((current) => ({ ...current, [project.id]: value }));
            }
          } catch {
            // Metadata failures stay local; the summary remains available.
          }
        });
      }
      if (!seededDetails[project.id]) {
        tasks.push(async (signal) => {
          try {
            const value = await metadataRequest(
              (requestSignal) => getStudioProject(project.id, { signal: requestSignal }),
              signal
            );
            if (!cancelled && metadataGeneration.current === generation) {
              setDetails((current) => ({ ...current, [project.id]: value }));
            }
          } catch {
            if (!cancelled && metadataGeneration.current === generation) {
              setDetails((current) => ({ ...current, [project.id]: null }));
            }
          }
        });
      }
    }
    void runBounded(tasks, METADATA_REQUEST_CONCURRENCY, generationController.signal);

    return () => {
      cancelled = true;
      generationController.abort();
    };
  }, [projects]);

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

  async function refreshProjects(expectedScanGeneration: number) {
    const nextProjects = await getStudioProjects();
    if (scanGeneration.current !== expectedScanGeneration) return;
    metadataGeneration.current += 1;
    setAnalyses({});
    setDetails({});
    setProjects(nextProjects);
  }

  async function beginScan() {
    setBusy(true);
    setError(null);
    try {
      const generation = ++scanGeneration.current;
      const job = await startStudioScan();
      if (scanGeneration.current === generation) setScanJob(job);
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
      const generation = ++scanGeneration.current;
      const job = await startStudioScan();
      if (scanGeneration.current === generation) setScanJob(job);
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

async function runBounded(
  tasks: Array<(signal: AbortSignal) => Promise<void>>,
  limit: number,
  signal: AbortSignal
): Promise<void> {
  let nextIndex = 0;
  const worker = async () => {
    while (!signal.aborted && nextIndex < tasks.length) {
      const task = tasks[nextIndex];
      nextIndex += 1;
      await task(signal);
    }
  };
  const workers = Array.from({ length: Math.min(limit, tasks.length) }, () => worker());
  await Promise.all(workers);
}

async function metadataRequest<T>(
  requestValue: (signal: AbortSignal) => Promise<T>,
  generationSignal: AbortSignal
): Promise<T> {
  if (generationSignal.aborted) throw abortError();

  const requestController = new AbortController();
  const abortRequest = () => requestController.abort();
  generationSignal.addEventListener("abort", abortRequest, { once: true });
  const timeout = window.setTimeout(abortRequest, METADATA_REQUEST_TIMEOUT_MS);
  const aborted = new Promise<never>((_resolve, reject) => {
    requestController.signal.addEventListener("abort", () => reject(abortError()), { once: true });
  });

  try {
    return await Promise.race([
      Promise.resolve().then(() => requestValue(requestController.signal)),
      aborted
    ]);
  } finally {
    window.clearTimeout(timeout);
    generationSignal.removeEventListener("abort", abortRequest);
  }
}

function abortError(): DOMException {
  return new DOMException("Metadata request aborted", "AbortError");
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

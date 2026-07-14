"use client";

import { useCallback, useEffect, useState } from "react";
import { getStudioProjects, getStudioRoots } from "../api/studioClient";
import type { StudioProjectSummary, StudioRoot } from "../api/studioTypes";
import { StudioLibrary } from "./studio/StudioLibrary";
import studioCss from "./studio/Studio.module.css";

type LoadState =
  | { phase: "loading" }
  | { phase: "error"; message: string }
  | {
      phase: "ready";
      roots: StudioRoot[];
      projects: StudioProjectSummary[];
    };

const studioTabs = ["工程", "素材", "笔记"];

export function StudioEntry() {
  const [state, setState] = useState<LoadState>({ phase: "loading" });

  const load = useCallback(async () => {
    setState({ phase: "loading" });
    try {
      const [roots, projects] = await Promise.all([getStudioRoots(), getStudioProjects()]);
      setState({ phase: "ready", roots, projects });
    } catch (cause) {
      setState({ phase: "error", message: cause instanceof Error && cause.message ? cause.message : "无法读取工程库" });
    }
  }, []);

  useEffect(() => { void load(); }, [load]);

  return (
    <main className="studio-workbench" aria-label="资料室">
      <section className="studio-window">
        <aside className="studio-shelf" aria-label="资料分类">
          <div className="studio-brand"><p className="eyebrow">KumikoRoom</p><h1>资料室</h1></div>
          <nav className="studio-tabs" aria-label="资料分类">
            {studioTabs.map((tab) => <button type="button" key={tab} data-active={tab === "工程" ? "true" : undefined} disabled={tab !== "工程"}>{tab}</button>)}
          </nav>
          <div className="studio-links"><a className="studio-link" href="/room">回到聊天</a><a className="studio-link" href="/">回到入口</a></div>
        </aside>

        <section className={`studio-desk ${studioCss.liveDesk}`} aria-label="工程档案">
          <header className={`studio-desk__header ${studioCss.deskHeader}`}>
            <div><span>工程</span><strong>本地创作档案</strong></div>
            <p>只读解析 · FL Studio 21</p>
          </header>

          {state.phase === "loading" ? (
            <section className={studioCss.entryState} role="status"><span className={studioCss.loadingLine} /><p>正在整理工程档案…</p></section>
          ) : state.phase === "error" ? (
            <section className={studioCss.entryState} role="alert"><p>{state.message}</p><button type="button" onClick={() => void load()}>重试</button></section>
          ) : (
            <StudioLibrary initialProjects={state.projects} initialRoots={state.roots} />
          )}
        </section>
      </section>
    </main>
  );
}

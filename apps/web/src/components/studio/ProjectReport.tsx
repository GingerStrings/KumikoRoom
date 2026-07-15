"use client";

import type { StudioAnalysis, StudioProjectDetail } from "../../api/studioTypes";
import studioCss from "./Studio.module.css";

interface ProjectReportProps {
  project: StudioProjectDetail;
  analysis: StudioAnalysis;
}

export function ProjectReport({ project, analysis }: ProjectReportProps) {
  const title = analysis.project.title?.trim() || project.displayName;
  const validClips = analysis.playlistClips.filter(validClip);
  const arrangementEnd = validClips.reduce((end, clip) => Math.max(end, clip.start + clip.length), 0);
  const displayedClips = validClips.slice(0, 120);
  const notes = analysis.patterns.reduce((count, pattern) => (
    count + pattern.notes.filter((note) => Number.isFinite(note.key) && Number.isFinite(note.position) && Number.isFinite(note.length) && note.length > 0).length
  ), 0);
  const missingDependencies = analysis.dependencies.filter((item) => item.exists === false).length;
  const unsupportedPlugins = analysis.plugins.filter((item) => !item.stateSupported).length;
  const diagnostics = (["error", "warning", "notice"] as const).flatMap((severity) => (
    analysis.diagnostics.filter((item) => item.severity === severity)
  ));

  return (
    <article className={studioCss.reportDossier} aria-label={`${title} 工程报告`}>
      <header className={studioCss.reportMasthead}>
        <div>
          <p className={studioCss.reportEdition}>KUMIKOROOM · PROJECT DOSSIER</p>
          <h1>{title}</h1>
          <p>{analysis.project.author?.trim() || "作者未记录"} · {project.status === "partial" ? "部分解析快照" : "只读解析快照"}</p>
        </div>
        <div className={studioCss.reportActions}>
          <button type="button" onClick={() => window.print()}>打印报告</button>
          <small>浏览器打印 · 不修改源 FLP</small>
        </div>
      </header>

      <section className={studioCss.reportMetadata} aria-label="工程元数据">
        <ReportDatum label="FL Studio" value={analysis.project.flVersion || "未读取"} />
        <ReportDatum label="Tempo" value={formatNumber(analysis.project.tempo, " BPM")} />
        <ReportDatum label="PPQ" value={formatNumber(analysis.project.ppq)} />
        <ReportDatum label="拍号" value={timeSignature(analysis)} />
        <ReportDatum label="Pattern" value={String(analysis.patterns.length)} />
        <ReportDatum label="Playlist Clip" value={String(analysis.playlistClips.length)} />
        <ReportDatum label="快照时间" value={project.latestSnapshotAnalyzedAt || "未记录"} />
        <ReportDatum label="源文件" value={project.canonicalPath} wide />
      </section>

      <div className={studioCss.reportLeadGrid}>
        <section className={studioCss.reportFingerprint} aria-label="音乐指纹摘要">
          <div className={studioCss.reportSectionLabel}>01 · MUSICAL FINGERPRINT</div>
          <div className={studioCss.reportKeyMark}>
            <strong>{analysis.fingerprint.inferredKey || "调式未推断"}</strong>
            <span>{analysis.fingerprint.inferredKey ? `${percent(analysis.fingerprint.inferredKeyConfidence)} 置信度` : "当前快照没有可靠调式结论"}</span>
          </div>
          <dl>
            <ReportMetric label="音域" value={noteRange(analysis)} />
            <ReportMetric label="音符" value={String(notes)} />
            <ReportMetric label="密度" value={formatDecimal(analysis.fingerprint.noteDensity)} />
            <ReportMetric label="平均力度" value={formatDecimal(analysis.fingerprint.velocityMean)} />
            <ReportMetric label="Pattern 复用" value={percent(analysis.fingerprint.patternReuse)} />
          </dl>
          {analysis.fingerprint.inferredKeyEvidence.length > 0 && (
            <p className={studioCss.reportEvidence}>{analysis.fingerprint.inferredKeyEvidence.join(" · ")}</p>
          )}
        </section>

        <section className={studioCss.reportCounts} aria-label="插件与依赖统计">
          <div className={studioCss.reportSectionLabel}>02 · SIGNAL INVENTORY</div>
          <dl>
            <ReportMetric label="Channel" value={String(analysis.channels.length)} />
            <ReportMetric label="插件实例" value={String(analysis.plugins.length)} />
            <ReportMetric label="Mixer Insert" value={String(analysis.mixerInserts.length)} />
            <ReportMetric label="Automation" value={String(analysis.automations.length)} />
            <ReportMetric label="依赖记录" value={String(analysis.dependencies.length)} />
            <ReportMetric label="缺失依赖" value={String(missingDependencies)} />
          </dl>
          <p>{unsupportedPlugins > 0 ? `${unsupportedPlugins} 个插件状态未完整解析` : "已报告插件状态均在解析器覆盖范围内"}</p>
        </section>
      </div>

      <section className={studioCss.reportArrangement}>
        <div className={studioCss.reportSectionHeading}>
          <div><span>03 · ARRANGEMENT PLATE</span><h2>编曲结构</h2></div>
          <p>{validClips.length} 个有效片段 · {uniqueTracks(validClips)} 条轨道</p>
        </div>
        {displayedClips.length > 0 && arrangementEnd > 0 ? (
          <div className={studioCss.reportArrangementPlate} role="img" aria-label="编曲结构缩略图">
            {displayedClips.map((clip) => (
              <span
                key={clip.id}
                data-kind={clip.clipType}
                title={`${clip.clipType} · track ${clip.trackIndex}`}
                style={{
                  left: `${Math.max(0, clip.start) / arrangementEnd * 100}%`,
                  width: `${Math.max(0.35, Math.min(100, clip.length / arrangementEnd * 100))}%`,
                  top: `${trackPosition(validClips, clip.trackIndex)}%`
                }}
              />
            ))}
          </div>
        ) : <p className={studioCss.reportEmpty}>快照没有可绘制的 Playlist 片段。</p>}
        {validClips.length > displayedClips.length && <small>缩略图绘制前 120 个片段；统计保留全部 {validClips.length} 个有效片段。</small>}
      </section>

      <div className={studioCss.reportBottomGrid}>
        <section className={studioCss.reportDiagnostics} aria-label="诊断摘录">
          <div className={studioCss.reportSectionLabel}>04 · DIAGNOSTIC INDEX</div>
          {diagnostics.length > 0 ? (
            <ol>{diagnostics.slice(0, 12).map((diagnostic, index) => (
              <li key={`${diagnostic.code}-${index}`} data-severity={diagnostic.severity}>
                <span>{diagnostic.severity.toUpperCase()}</span>
                <div><strong>{diagnostic.code}</strong><p>{diagnostic.message}</p></div>
              </li>
            ))}</ol>
          ) : <p className={studioCss.reportEmpty}>快照没有报告解析诊断。</p>}
          {diagnostics.length > 12 && <small>报告摘录 12 / {diagnostics.length} 条；完整清单见“依赖”视图。</small>}
        </section>

        <section className={studioCss.reportCoverage} aria-label="解析覆盖">
          <div className={studioCss.reportSectionLabel}>05 · PARSER COVERAGE</div>
          <dl>
            <ReportMetric label="快照状态" value={analysis.status} />
            <ReportMetric label="未知事件" value={String(analysis.unknownEventCount)} />
            <ReportMetric label="插件状态覆盖" value={`${analysis.plugins.length - unsupportedPlugins} / ${analysis.plugins.length}`} />
            <ReportMetric label="诊断记录" value={String(analysis.diagnostics.length)} />
          </dl>
          <p>报告只汇总解析器能够确认的工程结构；推断项保留置信度，未知项保持未定。</p>
          <code title={analysis.sourceHash}>{analysis.sourceHash || "source hash unavailable"}</code>
        </section>
      </div>
    </article>
  );
}

function ReportDatum({ label, value, wide = false }: { label: string; value: string; wide?: boolean }) {
  return <dl data-wide={wide || undefined}><dt>{label}</dt><dd title={value}>{value}</dd></dl>;
}

function ReportMetric({ label, value }: { label: string; value: string }) {
  return <div><dt>{label}</dt><dd>{value}</dd></div>;
}

function validClip(clip: StudioAnalysis["playlistClips"][number]): boolean {
  return Number.isFinite(clip.trackIndex) && clip.trackIndex >= 0
    && Number.isFinite(clip.start) && Number.isFinite(clip.length)
    && clip.length > 0 && clip.start + clip.length > 0;
}

function trackPosition(clips: StudioAnalysis["playlistClips"], trackIndex: number): number {
  const tracks = [...new Set(clips.map((clip) => clip.trackIndex))].sort((a, b) => a - b);
  const index = Math.max(0, tracks.indexOf(trackIndex));
  return tracks.length <= 1 ? 42 : 8 + index / (tracks.length - 1) * 76;
}

function uniqueTracks(clips: StudioAnalysis["playlistClips"]): number {
  return new Set(clips.map((clip) => clip.trackIndex)).size;
}

function timeSignature(analysis: StudioAnalysis): string {
  const numerator = analysis.project.timeSignatureNumerator;
  const denominator = analysis.project.timeSignatureDenominator;
  return Number.isFinite(numerator) && Number.isFinite(denominator) && numerator! > 0 && denominator! > 0
    ? `${numerator}/${denominator}`
    : "未读取";
}

function noteRange(analysis: StudioAnalysis): string {
  const low = analysis.fingerprint.noteMin;
  const high = analysis.fingerprint.noteMax;
  return Number.isFinite(low) && Number.isFinite(high) ? `${low}–${high}` : "未读取";
}

function formatNumber(value: number | null, suffix = ""): string {
  return Number.isFinite(value) ? `${value}${suffix}` : "未读取";
}

function formatDecimal(value: number | null): string {
  return Number.isFinite(value) ? Number(value).toFixed(2) : "未读取";
}

function percent(value: number): string {
  return Number.isFinite(value) ? `${Math.round(Math.max(0, Math.min(1, value)) * 100)}%` : "未读取";
}

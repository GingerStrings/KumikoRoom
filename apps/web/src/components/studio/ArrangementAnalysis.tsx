"use client";

import { useMemo, useState } from "react";
import type { KeyboardEvent } from "react";
import type { StudioAnalysis, StudioPlaylistClipSummary } from "../../api/studioTypes";
import studioCss from "./Studio.module.css";

interface ArrangementAnalysisProps {
  analysis: StudioAnalysis;
  onSelectPattern: (patternId: string) => void;
}

type Zoom = 1 | 2 | 4;

interface PositionedClip {
  clip: StudioPlaylistClipSummary;
  trackIndex: number;
  start: number;
  end: number;
  length: number;
  patternName: string | null;
}

const DENSITY_BUCKETS = 24;

export function ArrangementAnalysis({ analysis, onSelectPattern }: ArrangementAnalysisProps) {
  const [zoom, setZoom] = useState<Zoom>(1);
  const arrangement = useMemo(() => buildArrangement(analysis), [analysis]);

  return (
    <article className={studioCss.analysisView} aria-labelledby="arrangement-heading">
      <header className={studioCss.analysisViewHeader}>
        <div>
          <p className={studioCss.panelKicker}>PLAYLIST STRUCTURE</p>
          <h1 id="arrangement-heading">编曲结构</h1>
          <p>{arrangement.timingDescription}</p>
        </div>
        <div className={studioCss.zoomControls} role="group" aria-label="编曲缩放">
          {([1, 2, 4] as const).map((value) => (
            <button
              key={value}
              type="button"
              aria-pressed={zoom === value}
              onClick={() => setZoom(value)}
            >
              {value === 1 ? "整曲" : `${value}×`}
            </button>
          ))}
        </div>
      </header>

      {arrangement.clips.length === 0 ? (
        <section className={studioCss.analysisEmpty}>
          <h2>没有可绘制的 Playlist Clip。</h2>
          <p>快照中没有带有效位置与长度的 Playlist 条目。</p>
        </section>
      ) : (
        <div
          className={studioCss.arrangementViewport}
          aria-label="Playlist 编曲时间线"
          tabIndex={0}
          onKeyDown={handleTimelineKeyDown}
        >
          <div
            className={studioCss.arrangementCanvas}
            data-testid="arrangement-canvas"
            data-zoom={zoom}
            style={{ width: `${zoom * 100}%` }}
          >
            <div className={studioCss.arrangementRuler} aria-hidden="true">
              {arrangement.ruler.map((mark) => (
                <span key={mark.position} style={{ left: `${mark.position}%` }}>{mark.label}</span>
              ))}
            </div>

            <div className={studioCss.densityOverlay} aria-label="编曲密度覆盖层">
              {arrangement.density.map((density, index) => (
                <span
                  key={index}
                  title={`区间 ${index + 1}：${density} 个重叠片段`}
                  style={{ opacity: Math.min(0.78, 0.08 + density * 0.14) }}
                />
              ))}
            </div>

            {arrangement.gaps.map((gap) => (
              <span
                key={`${gap.start}-${gap.end}`}
                className={studioCss.longGapMarker}
                title={gap.title}
                style={{ left: percent(gap.start, arrangement.projectEnd), width: percent(gap.end - gap.start, arrangement.projectEnd) }}
              />
            ))}

            <div className={studioCss.trackStack}>
              {arrangement.tracks.map((trackIndex) => (
                <section key={trackIndex} className={studioCss.trackLane} aria-label={`Playlist track ${trackIndex}`}>
                  <span className={studioCss.trackLabel}>TRACK {trackIndex}</span>
                  <div className={studioCss.trackClips}>
                    {(arrangement.clipsByTrack.get(trackIndex) ?? []).map((item) => (
                      <Clip
                        key={item.clip.id}
                        item={item}
                        projectEnd={arrangement.projectEnd}
                        ppq={arrangement.ppq}
                        barTicks={arrangement.barTicks}
                        onSelectPattern={onSelectPattern}
                      />
                    ))}
                  </div>
                </section>
              ))}
            </div>
          </div>
        </div>
      )}

      <footer className={studioCss.analysisFootnote}>
        <span>{arrangement.clips.length} clips · {arrangement.tracks.length} tracks</span>
        <span>方向键滚动 · Home / End 跳转</span>
      </footer>
    </article>
  );
}

function Clip({
  item,
  projectEnd,
  ppq,
  barTicks,
  onSelectPattern
}: {
  item: PositionedClip;
  projectEnd: number;
  ppq: number | null;
  barTicks: number | null;
  onSelectPattern: (patternId: string) => void;
}) {
  const isLinkedPattern = item.patternName !== null && item.clip.sourceId !== null;
  const typeLabel = clipTypeLabel(item.clip.clipType);
  const positionLabel = barTicks === null
    ? `tick ${formatTick(item.start)}`
    : `bar ${Math.floor(item.start / barTicks) + 1}`;
  const label = item.patternName ?? typeLabel;
  const accessibleName = `${label} clip at ${positionLabel}`;
  const style = {
    left: percent(item.start, projectEnd),
    width: percent(item.length, projectEnd)
  };

  if (isLinkedPattern) {
    return (
      <button
        type="button"
        className={studioCss.timelineClip}
        data-clip-type="pattern"
        style={style}
        aria-label={accessibleName}
        title={`${label} · ${positionLabel} · ${formatDuration(item.length, ppq)}`}
        onClick={() => onSelectPattern(item.clip.sourceId as string)}
      >
        <strong>{label}</strong><small>{typeLabel}</small>
      </button>
    );
  }

  return (
    <span
      className={studioCss.timelineClip}
      data-clip-type={normalizedClipType(item.clip.clipType)}
      style={style}
      aria-label={accessibleName}
      title={`${label} · ${positionLabel} · ${formatDuration(item.length, ppq)}`}
    >
      <strong>{label}</strong><small>{typeLabel}</small>
    </span>
  );
}

function buildArrangement(analysis: StudioAnalysis) {
  const patternNames = new Map(analysis.patterns.map((pattern) => [pattern.id, pattern.name.trim() || "未命名 Pattern"]));
  const clips = analysis.playlistClips.flatMap<PositionedClip>((clip) => {
    if (!Number.isFinite(clip.start) || !Number.isFinite(clip.length) || clip.length <= 0) return [];
    const start = Math.max(0, clip.start);
    const end = start + clip.length;
    if (!Number.isFinite(end) || end <= start) return [];
    const rawTrack = Number.isFinite(clip.trackIndex) ? Math.trunc(clip.trackIndex) : 0;
    const trackIndex = Math.max(0, rawTrack);
    return [{
      clip,
      trackIndex,
      start,
      end,
      length: clip.length,
      patternName: normalizedClipType(clip.clipType) === "pattern" && clip.sourceId !== null
        ? patternNames.get(clip.sourceId) ?? null
        : null
    }];
  });
  const projectEnd = Math.max(1, ...clips.map((item) => item.end));
  const tracks = [...new Set(clips.map((item) => item.trackIndex))].sort((a, b) => a - b);
  const clipsByTrack = new Map<number, PositionedClip[]>();
  for (const clip of clips) {
    const trackClips = clipsByTrack.get(clip.trackIndex);
    if (trackClips) trackClips.push(clip);
    else clipsByTrack.set(clip.trackIndex, [clip]);
  }
  const ppq = finitePositive(analysis.project.ppq);
  const numerator = finitePositive(analysis.project.timeSignatureNumerator) ?? 4;
  const denominator = finitePositive(analysis.project.timeSignatureDenominator) ?? 4;
  const barTicks = ppq === null ? null : ppq * numerator * (4 / denominator);
  const timingDescription = ppq === null
    ? "PPQ 未读取；时间线保留工程中的原始 tick 位置。"
    : `${formatTick(ppq)} PPQ · ${numerator}/${denominator} 拍号 · 坐标按工程时基归一化`;

  return {
    clips,
    clipsByTrack,
    tracks,
    projectEnd,
    ppq,
    barTicks,
    timingDescription,
    density: densityBuckets(clips, projectEnd),
    gaps: longGaps(clips, projectEnd, barTicks),
    ruler: rulerMarks(projectEnd, barTicks)
  };
}

function densityBuckets(clips: PositionedClip[], projectEnd: number): number[] {
  return Array.from({ length: DENSITY_BUCKETS }, (_, index) => {
    const start = (index / DENSITY_BUCKETS) * projectEnd;
    const end = ((index + 1) / DENSITY_BUCKETS) * projectEnd;
    return clips.filter((clip) => clip.start < end && clip.end > start).length;
  });
}

function longGaps(clips: PositionedClip[], projectEnd: number, barTicks: number | null) {
  if (barTicks === null || clips.length === 0) return [];
  const intervals = clips
    .map((clip) => ({ start: clip.start, end: clip.end }))
    .sort((a, b) => a.start - b.start);
  const merged: Array<{ start: number; end: number }> = [];
  for (const interval of intervals) {
    const last = merged.at(-1);
    if (last && interval.start <= last.end) last.end = Math.max(last.end, interval.end);
    else merged.push({ ...interval });
  }
  const threshold = barTicks * 2;
  return merged.slice(0, -1).flatMap((interval, index) => {
    const start = interval.end;
    const end = merged[index + 1].start;
    if (end - start < threshold || end > projectEnd) return [];
    const firstBar = Math.floor(start / barTicks) + 1;
    const lastBar = Math.floor(end / barTicks) + 1;
    return [{ start, end, title: `长空白：第 ${firstBar}–${lastBar} 小节` }];
  });
}

function rulerMarks(projectEnd: number, barTicks: number | null) {
  return Array.from({ length: 9 }, (_, index) => {
    const tick = projectEnd * index / 8;
    return {
      position: index * 12.5,
      label: barTicks === null ? formatTick(tick) : String(Math.floor(tick / barTicks) + 1)
    };
  });
}

function handleTimelineKeyDown(event: KeyboardEvent<HTMLDivElement>) {
  const viewport = event.currentTarget;
  const maximum = Math.max(0, viewport.scrollWidth - viewport.clientWidth);
  const step = Math.max(80, viewport.clientWidth * 0.65);
  if (event.key === "ArrowRight") viewport.scrollLeft = Math.min(maximum, viewport.scrollLeft + step);
  else if (event.key === "ArrowLeft") viewport.scrollLeft = Math.max(0, viewport.scrollLeft - step);
  else if (event.key === "Home") viewport.scrollLeft = 0;
  else if (event.key === "End") viewport.scrollLeft = maximum;
  else return;
  event.preventDefault();
}

function normalizedClipType(value: string): string {
  const normalized = value.trim().toLowerCase();
  if (normalized.includes("pattern")) return "pattern";
  if (normalized.includes("automation")) return "automation";
  if (normalized.includes("audio")) return "audio";
  return "unknown";
}

function clipTypeLabel(value: string): string {
  const labels = { pattern: "Pattern", automation: "Automation", audio: "Audio", unknown: "未知类型" };
  return labels[normalizedClipType(value) as keyof typeof labels];
}

function formatDuration(ticks: number, ppq: number | null): string {
  return ppq === null ? `${formatTick(ticks)} ticks` : `${formatDecimal(ticks / ppq)} beats`;
}

function formatTick(value: number): string {
  return Number.isInteger(value) ? String(value) : formatDecimal(value);
}

function formatDecimal(value: number): string {
  return Number.isFinite(value) ? value.toFixed(2).replace(/\.00$/, "").replace(/0$/, "") : "未读取";
}

function percent(value: number, total: number): string {
  const normalized = total > 0 && Number.isFinite(value / total) ? Math.max(0, Math.min(100, value / total * 100)) : 0;
  return `${normalized}%`;
}

function finitePositive(value: number | null): number | null {
  return value !== null && Number.isFinite(value) && value > 0 ? value : null;
}

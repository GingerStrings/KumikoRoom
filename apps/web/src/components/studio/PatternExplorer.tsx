"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import type { StudioAnalysis, StudioNoteSummary, StudioPatternSummary } from "../../api/studioTypes";
import studioCss from "./Studio.module.css";

interface PatternExplorerProps {
  analysis: StudioAnalysis;
  selectedPatternId: string | null;
  onSelectPattern: (patternId: string) => void;
}

interface DrawableNote {
  key: number;
  position: number;
  length: number;
  velocity: number;
  channelId: string | null;
}

const ROW_HEIGHT = 52;
const LIST_HEIGHT = 364;
const OVERSCAN = 4;

export function PatternExplorer({ analysis, selectedPatternId, onSelectPattern }: PatternExplorerProps) {
  const [query, setQuery] = useState("");
  const [scrollTop, setScrollTop] = useState(0);
  const listRef = useRef<HTMLDivElement>(null);
  const selectedPattern = analysis.patterns.find((pattern) => pattern.id === selectedPatternId) ?? analysis.patterns[0] ?? null;
  const filteredPatterns = useMemo(() => {
    const needle = query.trim().toLocaleLowerCase();
    return needle
      ? analysis.patterns.filter((pattern) => displayPatternName(pattern).toLocaleLowerCase().includes(needle))
      : analysis.patterns;
  }, [analysis.patterns, query]);

  useEffect(() => {
    setScrollTop(0);
    if (listRef.current) listRef.current.scrollTop = 0;
  }, [query]);

  return (
    <article className={studioCss.analysisView} aria-labelledby="pattern-explorer-heading">
      <header className={studioCss.analysisViewHeader}>
        <div>
          <p className={studioCss.panelKicker}>PATTERN &amp; MIDI</p>
          <h1 id="pattern-explorer-heading">Pattern Explorer</h1>
          <p>{timingDescription(analysis)}</p>
        </div>
        <label className={studioCss.patternSearch}>
          <span>搜索 Pattern</span>
          <input
            type="search"
            value={query}
            aria-label="搜索 Pattern"
            placeholder="名称"
            onChange={(event) => setQuery(event.target.value)}
          />
        </label>
      </header>

      <div className={studioCss.patternExplorerGrid}>
        <PatternList
          patterns={filteredPatterns}
          totalCount={analysis.patterns.length}
          selectedPatternId={selectedPattern?.id ?? null}
          scrollTop={scrollTop}
          onScroll={setScrollTop}
          onSelectPattern={onSelectPattern}
          listRef={listRef}
        />
        {selectedPattern === null ? (
          <section className={studioCss.analysisEmpty}>
            <h2>工程中没有 Pattern。</h2>
            <p>当前快照没有可浏览的 Pattern 数据。</p>
          </section>
        ) : (
          <PatternDetail analysis={analysis} pattern={selectedPattern} onSelectPattern={onSelectPattern} />
        )}
      </div>
    </article>
  );
}

function PatternList({
  patterns,
  totalCount,
  selectedPatternId,
  scrollTop,
  onScroll,
  onSelectPattern,
  listRef
}: {
  patterns: StudioPatternSummary[];
  totalCount: number;
  selectedPatternId: string | null;
  scrollTop: number;
  onScroll: (value: number) => void;
  onSelectPattern: (patternId: string) => void;
  listRef: React.RefObject<HTMLDivElement>;
}) {
  const virtualized = patterns.length > 100;
  const start = virtualized ? Math.max(0, Math.floor(scrollTop / ROW_HEIGHT) - OVERSCAN) : 0;
  const end = virtualized
    ? Math.min(patterns.length, Math.ceil((scrollTop + LIST_HEIGHT) / ROW_HEIGHT) + OVERSCAN)
    : patterns.length;
  const visible = patterns.slice(start, end);

  return (
    <aside className={studioCss.patternIndex} aria-label="Pattern 索引">
      <div className={studioCss.patternIndexHeader}>
        <strong>{patterns.length} / {totalCount}</strong><span>可见 / 全部</span>
      </div>
      {patterns.length === 0 ? <p className={studioCss.patternNoResults}>没有匹配的 Pattern。</p> : (
        <div
          ref={listRef}
          className={studioCss.patternList}
          role="listbox"
          aria-label="Pattern 列表"
          data-virtualized={virtualized ? "true" : "false"}
          onScroll={(event) => onScroll(event.currentTarget.scrollTop)}
        >
          <div className={studioCss.patternListWindow} style={{ height: virtualized ? `${patterns.length * ROW_HEIGHT}px` : "auto" }}>
            {visible.map((pattern, offset) => {
              const index = start + offset;
              return (
                <button
                  key={pattern.id}
                  type="button"
                  role="option"
                  aria-selected={pattern.id === selectedPatternId}
                  aria-posinset={index + 1}
                  aria-setsize={patterns.length}
                  className={studioCss.patternRow}
                  style={virtualized ? { position: "absolute", top: `${index * ROW_HEIGHT}px` } : undefined}
                  onClick={() => onSelectPattern(pattern.id)}
                >
                  <span><strong>{displayPatternName(pattern)}</strong><small>{pattern.notes.length} notes</small></span>
                  <em data-used={pattern.usedInPlaylist}>{pattern.usedInPlaylist ? "已使用" : "未使用"}</em>
                </button>
              );
            })}
          </div>
        </div>
      )}
    </aside>
  );
}

function PatternDetail({ analysis, pattern, onSelectPattern }: {
  analysis: StudioAnalysis;
  pattern: StudioPatternSummary;
  onSelectPattern: (patternId: string) => void;
}) {
  const notes = sanitizeNotes(pattern.notes);
  const metrics = patternMetrics(notes, finitePositive(analysis.project.ppq));
  const similarities = similarPatterns(pattern, analysis.patterns);
  const channelNames = new Map(analysis.channels.map((channel) => [channel.id, channel.name.trim() || channel.id]));
  const channelLegend = buildChannelLegend(notes, channelNames);
  const name = displayPatternName(pattern);
  const summary = noteSummary(metrics);

  return (
    <section className={studioCss.patternDetail} aria-label={`${name} Pattern 详情`} title={`${name}：${summary}`}>
      <header className={studioCss.patternDetailHeader}>
        <div><p className={studioCss.panelKicker}>SELECTED PATTERN</p><h2>{name}</h2></div>
        <span data-used={pattern.usedInPlaylist}>{pattern.usedInPlaylist ? "Playlist 已使用" : "Playlist 未使用"}</span>
      </header>

      <p className={studioCss.patternTextSummary} aria-label={`${name} 音符摘要`}>{summary}</p>
      <dl className={studioCss.patternMetrics}>
        <Metric label="音符" value={String(metrics.count)} />
        <Metric label="音域" value={metrics.rangeLabel} />
        <Metric label="密度" value={metrics.densityLabel} />
        <Metric label="平均力度" value={metrics.velocityLabel} />
      </dl>

      {notes.length === 0 ? (
        <section className={studioCss.pianoEmpty}>
          <h3>这个 Pattern 没有可绘制的 MIDI 音符。</h3>
          <p>空 Pattern 仍保留在索引中，方便检查使用状态。</p>
        </section>
      ) : (
        <PianoRoll name={name} notes={notes} channelNames={channelNames} />
      )}

      <div className={studioCss.patternDetailLower}>
        <section className={studioCss.patternSubpanel} aria-label="Channel 图例">
          <header><span>CHANNEL LEGEND</span><strong>{channelLegend.length}</strong></header>
          <ul className={studioCss.channelLegend}>
            {channelLegend.map((channel) => (
              <li key={channel.id}><i data-tone={channel.tone} /><span>{channel.name}</span><small>{channel.count} notes</small></li>
            ))}
          </ul>
        </section>

        <section className={studioCss.patternSubpanel} aria-labelledby="similar-patterns-heading">
          <header><span id="similar-patterns-heading">相似 PATTERN</span><strong>{similarities.length}</strong></header>
          {similarities.length > 0 ? (
            <div className={studioCss.similarityLinks}>
              {similarities.map(({ pattern: similar, score }) => (
                <button key={similar.id} type="button" onClick={() => onSelectPattern(similar.id)}>
                  {displayPatternName(similar)} · 相似度 {Math.round(score * 100)}%
                </button>
              ))}
            </div>
          ) : <p>当前音符证据不足，或没有达到阈值的相似 Pattern。</p>}
        </section>
      </div>

      <InferenceNote analysis={analysis} />
    </section>
  );
}

function PianoRoll({ name, notes, channelNames }: {
  name: string;
  notes: DrawableNote[];
  channelNames: Map<string, string>;
}) {
  const minKey = Math.min(...notes.map((note) => note.key));
  const maxKey = Math.max(...notes.map((note) => note.key));
  const duration = Math.max(1, ...notes.map((note) => note.position + note.length));
  const pitchSpan = Math.max(1, maxKey - minKey + 1);
  const toneByChannel = toneMap(notes);

  return (
    <figure className={studioCss.pianoFigure}>
      <figcaption><strong>Piano Roll</strong><span>上方音高 · 下方力度</span></figcaption>
      <svg
        className={studioCss.pianoRoll}
        viewBox="0 0 1000 280"
        role="img"
        aria-label={`${name} Piano Roll`}
      >
        <title>{`${name} Piano Roll：${notes.length} 个可绘制音符，音域 ${minKey}–${maxKey}`}</title>
        <rect className={studioCss.pianoBackground} x="0" y="0" width="1000" height="220" />
        {Array.from({ length: 13 }, (_, index) => (
          <line key={index} className={studioCss.pianoGuide} x1="0" x2="1000" y1={index * (220 / 12)} y2={index * (220 / 12)} />
        ))}
        <g aria-label={`${name} 音符与力度条`}>
          {notes.map((note, index) => {
            const x = note.position / duration * 1000;
            const width = Math.max(2, note.length / duration * 1000);
            const y = (maxKey - note.key) / pitchSpan * 210 + 4;
            const tone = toneByChannel.get(note.channelId ?? "__unknown__") ?? 0;
            const channelName = note.channelId === null ? "未知 Channel" : channelNames.get(note.channelId) ?? "未知 Channel";
            return (
              <g key={`${note.key}-${note.position}-${index}`}>
                <rect className={`${studioCss.pianoNote} ${studioCss[`noteTone${tone}`]}`} x={x} y={y} width={width} height="9" rx="1">
                  <title>{`音高 ${note.key} · tick ${formatNumber(note.position)} · 力度 ${note.velocity} · ${channelName}`}</title>
                </rect>
                <rect className={`${studioCss.velocityNote} ${studioCss[`noteTone${tone}`]}`} x={x} y={274 - note.velocity / 127 * 42} width={Math.max(2, Math.min(7, width))} height={note.velocity / 127 * 42}>
                  <title>{`力度 ${note.velocity}`}</title>
                </rect>
              </g>
            );
          })}
        </g>
        <line className={studioCss.velocityBaseline} x1="0" x2="1000" y1="274" y2="274" />
      </svg>
    </figure>
  );
}

function InferenceNote({ analysis }: { analysis: StudioAnalysis }) {
  const confidence = clamp01(analysis.fingerprint.inferredKeyConfidence);
  return (
    <aside className={studioCss.inferenceNote} aria-label="调性推断说明">
      <div>
        <p className={studioCss.panelKicker}>PROJECT-LEVEL INFERENCE</p>
        <h3>工程调性推断</h3>
      </div>
      {analysis.fingerprint.inferredKey ? (
        <div>
          <strong>{analysis.fingerprint.inferredKey} · {Math.round(confidence * 100)}% 可信度</strong>
          <ul>
            {analysis.fingerprint.inferredKeyEvidence.length > 0
              ? analysis.fingerprint.inferredKeyEvidence.map((evidence) => <li key={evidence}>{evidence}</li>)
              : <li>当前快照没有提供推断依据说明。</li>}
          </ul>
        </div>
      ) : <p>当前 MIDI 证据不足，未推断调性。</p>}
    </aside>
  );
}

function Metric({ label, value }: { label: string; value: string }) {
  return <div><dt>{label}</dt><dd>{value}</dd></div>;
}

function sanitizeNotes(notes: StudioNoteSummary[]): DrawableNote[] {
  return notes.flatMap((note) => {
    if (!Number.isFinite(note.key) || note.key < 0 || note.key > 127) return [];
    if (!Number.isFinite(note.position) || !Number.isFinite(note.length) || note.length < 0) return [];
    const position = Math.max(0, note.position);
    const end = position + note.length;
    if (!Number.isFinite(end)) return [];
    return [{
      key: Math.round(note.key),
      position,
      length: note.length,
      velocity: Number.isFinite(note.velocity) ? Math.round(Math.max(0, Math.min(127, note.velocity))) : 0,
      channelId: note.channelId
    }];
  });
}

function patternMetrics(notes: DrawableNote[], ppq: number | null) {
  if (notes.length === 0) {
    return { count: 0, rangeLabel: "—", densityLabel: ppq === null ? "PPQ 未读取" : "0 / 拍", velocityLabel: "—", minKey: null, maxKey: null };
  }
  const minKey = Math.min(...notes.map((note) => note.key));
  const maxKey = Math.max(...notes.map((note) => note.key));
  const end = Math.max(...notes.map((note) => note.position + note.length));
  const density = ppq !== null && end > 0 ? notes.length / (end / ppq) : null;
  const velocity = notes.reduce((total, note) => total + note.velocity, 0) / notes.length;
  return {
    count: notes.length,
    rangeLabel: `${minKey}–${maxKey}`,
    densityLabel: density === null ? (ppq === null ? "PPQ 未读取" : "时长不可用") : `${formatNumber(density)} / 拍`,
    velocityLabel: formatNumber(velocity),
    minKey,
    maxKey
  };
}

function noteSummary(metrics: ReturnType<typeof patternMetrics>): string {
  if (metrics.count === 0) return "0 个音符 · 音域不可用 · 平均力度不可用";
  return `${metrics.count} 个音符 · 音域 ${metrics.minKey}–${metrics.maxKey} · 密度 ${metrics.densityLabel} · 平均力度 ${metrics.velocityLabel}`;
}

function buildChannelLegend(notes: DrawableNote[], channelNames: Map<string, string>) {
  const tones = toneMap(notes);
  const counts = new Map<string, number>();
  for (const note of notes) {
    const id = note.channelId !== null && channelNames.has(note.channelId) ? note.channelId : "__unknown__";
    counts.set(id, (counts.get(id) ?? 0) + 1);
  }
  return [...counts.entries()].map(([id, count]) => ({
    id,
    name: id === "__unknown__" ? "未知 Channel" : channelNames.get(id) as string,
    count,
    tone: tones.get(id) ?? 0
  }));
}

function toneMap(notes: DrawableNote[]): Map<string, number> {
  const ids = [...new Set(notes.map((note) => note.channelId ?? "__unknown__"))];
  return new Map(ids.map((id, index) => [id, index % 4]));
}

function similarPatterns(selected: StudioPatternSummary, patterns: StudioPatternSummary[]) {
  const selectedNotes = sanitizeNotes(selected.notes);
  if (selectedNotes.length < 2) return [];
  const selectedSignature = noteSignature(selectedNotes);
  return patterns
    .filter((pattern) => pattern.id !== selected.id)
    .flatMap((pattern) => {
      const notes = sanitizeNotes(pattern.notes);
      if (notes.length < 2) return [];
      const score = jaccard(selectedSignature, noteSignature(notes));
      return score >= 0.5 ? [{ pattern, score }] : [];
    })
    .sort((a, b) => b.score - a.score || displayPatternName(a.pattern).localeCompare(displayPatternName(b.pattern)))
    .slice(0, 3);
}

function noteSignature(notes: DrawableNote[]): Set<string> {
  const minKey = Math.min(...notes.map((note) => note.key));
  const duration = Math.max(1, ...notes.map((note) => note.position + note.length));
  return new Set(notes.map((note) => {
    const positionBin = Math.round(note.position / duration * 16);
    const lengthBin = Math.round(note.length / duration * 16);
    return `${note.key - minKey}:${positionBin}:${lengthBin}`;
  }));
}

function jaccard(left: Set<string>, right: Set<string>): number {
  const intersection = [...left].filter((token) => right.has(token)).length;
  const union = new Set([...left, ...right]).size;
  return union === 0 ? 0 : intersection / union;
}

function displayPatternName(pattern: StudioPatternSummary): string {
  return pattern.name.trim() || "未命名 Pattern";
}

function timingDescription(analysis: StudioAnalysis): string {
  const ppq = finitePositive(analysis.project.ppq);
  return ppq === null
    ? "PPQ 未读取；音符位置继续使用快照中的原始 tick。"
    : `${formatNumber(ppq)} PPQ · 音符密度按工程拍长计算`;
}

function finitePositive(value: number | null): number | null {
  return value !== null && Number.isFinite(value) && value > 0 ? value : null;
}

function formatNumber(value: number): string {
  return Number.isFinite(value) ? (Number.isInteger(value) ? String(value) : value.toFixed(2).replace(/0+$/, "").replace(/\.$/, "")) : "未读取";
}

function clamp01(value: number): number {
  return Number.isFinite(value) ? Math.max(0, Math.min(1, value)) : 0;
}

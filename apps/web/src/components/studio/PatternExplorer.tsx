"use client";

import { useEffect, useId, useMemo, useRef, useState } from "react";
import type { KeyboardEvent as ReactKeyboardEvent } from "react";
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
const MAX_DRAWN_NOTES = 1000;

export function PatternExplorer({ analysis, selectedPatternId, onSelectPattern }: PatternExplorerProps) {
  const [query, setQuery] = useState("");
  const [scrollTop, setScrollTop] = useState(0);
  const listRef = useRef<HTMLDivElement>(null);
  const ppq = finitePositive(analysis.project.ppq);
  const selectedPattern = analysis.patterns.find((pattern) => pattern.id === selectedPatternId) ?? analysis.patterns[0] ?? null;
  const filteredPatterns = useMemo(() => {
    const needle = query.trim().toLocaleLowerCase();
    return needle
      ? analysis.patterns.filter((pattern) => displayPatternName(pattern).toLocaleLowerCase().includes(needle))
      : analysis.patterns;
  }, [analysis.patterns, query]);

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
          ppq={ppq}
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
  ppq,
  selectedPatternId,
  scrollTop,
  onScroll,
  onSelectPattern,
  listRef
}: {
  patterns: StudioPatternSummary[];
  totalCount: number;
  ppq: number | null;
  selectedPatternId: string | null;
  scrollTop: number;
  onScroll: (value: number) => void;
  onSelectPattern: (patternId: string) => void;
  listRef: React.RefObject<HTMLDivElement>;
}) {
  const virtualized = patterns.length > 100;
  const listId = useId();
  const selectedIndex = patterns.findIndex((pattern) => pattern.id === selectedPatternId);
  const [activePatternId, setActivePatternId] = useState<string | null>(
    selectedIndex >= 0 ? patterns[selectedIndex].id : patterns[0]?.id ?? null
  );
  const activeIndex = Math.max(0, patterns.findIndex((pattern) => pattern.id === activePatternId));
  const start = virtualized ? Math.max(0, Math.floor(scrollTop / ROW_HEIGHT) - OVERSCAN) : 0;
  const end = virtualized
    ? Math.min(patterns.length, Math.ceil((scrollTop + LIST_HEIGHT) / ROW_HEIGHT) + OVERSCAN)
    : patterns.length;
  const visible = patterns.slice(start, end);

  function optionId(patternId: string): string {
    return `${listId}-pattern-${encodeURIComponent(patternId)}`;
  }

  function ensureIndexVisible(index: number) {
    const list = listRef.current;
    if (!list || !virtualized || index < 0) return;
    const rowTop = index * ROW_HEIGHT;
    const rowBottom = rowTop + ROW_HEIGHT;
    let nextScrollTop = list.scrollTop;
    if (rowTop < list.scrollTop) nextScrollTop = rowTop;
    else if (rowBottom > list.scrollTop + LIST_HEIGHT) nextScrollTop = rowBottom - LIST_HEIGHT;
    if (nextScrollTop !== list.scrollTop) {
      list.scrollTop = nextScrollTop;
      onScroll(nextScrollTop);
    }
  }

  useEffect(() => {
    const nextIndex = selectedIndex >= 0 ? selectedIndex : 0;
    const nextPattern = patterns[nextIndex] ?? null;
    setActivePatternId(nextPattern?.id ?? null);
    if (nextPattern === null) {
      if (listRef.current) listRef.current.scrollTop = 0;
      onScroll(0);
      return;
    }
    ensureIndexVisible(nextIndex);
  }, [patterns, selectedPatternId]);

  function selectIndex(index: number) {
    const next = patterns[Math.max(0, Math.min(patterns.length - 1, index))];
    if (!next) return;
    const nextIndex = patterns.indexOf(next);
    setActivePatternId(next.id);
    ensureIndexVisible(nextIndex);
    onSelectPattern(next.id);
  }

  function handleKeyDown(event: ReactKeyboardEvent<HTMLDivElement>) {
    if (patterns.length === 0) return;
    const page = Math.max(1, Math.floor(LIST_HEIGHT / ROW_HEIGHT));
    let nextIndex: number;
    if (event.key === "ArrowDown") nextIndex = activeIndex + 1;
    else if (event.key === "ArrowUp") nextIndex = activeIndex - 1;
    else if (event.key === "Home") nextIndex = 0;
    else if (event.key === "End") nextIndex = patterns.length - 1;
    else if (event.key === "PageDown") nextIndex = activeIndex + page;
    else if (event.key === "PageUp") nextIndex = activeIndex - page;
    else return;
    event.preventDefault();
    selectIndex(nextIndex);
  }

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
          aria-activedescendant={patterns.length > 0 ? optionId(patterns[activeIndex].id) : undefined}
          tabIndex={0}
          data-virtualized={virtualized ? "true" : "false"}
          onScroll={(event) => onScroll(event.currentTarget.scrollTop)}
          onKeyDown={handleKeyDown}
        >
          <div className={studioCss.patternListWindow} style={{ height: virtualized ? `${patterns.length * ROW_HEIGHT}px` : "auto" }}>
            {visible.map((pattern, offset) => {
              const index = start + offset;
              const validated = validateNotes(pattern.notes);
              const metrics = patternMetrics(validated.notes, ppq);
              return (
                <button
                  key={pattern.id}
                  id={optionId(pattern.id)}
                  type="button"
                  role="option"
                  tabIndex={-1}
                  aria-selected={pattern.id === selectedPatternId}
                  aria-posinset={index + 1}
                  aria-setsize={patterns.length}
                  className={studioCss.patternRow}
                  style={virtualized ? { position: "absolute", top: `${index * ROW_HEIGHT}px` } : undefined}
                  onClick={() => {
                    setActivePatternId(pattern.id);
                    onSelectPattern(pattern.id);
                  }}
                >
                  <span>
                    <strong>{displayPatternName(pattern)}</strong>
                    <small>{validated.notes.length} notes · {metrics.lengthLabel}{validated.ignoredCount > 0 ? ` · ${validated.ignoredCount} ignored` : ""}</small>
                  </span>
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
  const ppq = finitePositive(analysis.project.ppq);
  const validated = validateNotes(pattern.notes);
  const notes = validated.notes;
  const metrics = patternMetrics(notes, ppq);
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
      {validated.ignoredCount > 0 && (
        <p className={studioCss.patternDataNotice} role="status">已忽略 {validated.ignoredCount} 条无效音符记录。</p>
      )}
      <dl className={studioCss.patternMetrics}>
        <Metric label="音符" value={String(metrics.count)} />
        <Metric label="Pattern 长度" value={metrics.lengthLabel} />
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

      <div className={studioCss.patternDistributions}>
        <DurationDistribution notes={notes} ppq={ppq} />
        <OnsetDistribution notes={notes} ppq={ppq} />
      </div>

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
  const { minKey, maxKey, duration } = noteExtent(notes);
  const drawnNotes = sampleNotes(notes, MAX_DRAWN_NOTES);
  const pitchSpan = Math.max(1, maxKey - minKey + 1);
  const toneByChannel = toneMap(notes);

  return (
    <figure className={studioCss.pianoFigure}>
      <figcaption>
        <strong>Piano Roll</strong>
        <span aria-label="Piano Roll 绘制范围">绘制 {drawnNotes.length} / 总 {notes.length} 个音符 · 上方音高 · 下方力度</span>
      </figcaption>
      <svg
        className={studioCss.pianoRoll}
        viewBox="0 0 1000 280"
        role="img"
        aria-label={`${name} Piano Roll`}
      >
        <title>{`${name} Piano Roll：绘制 ${drawnNotes.length} / 总 ${notes.length} 个音符，音域 ${minKey}–${maxKey}`}</title>
        <rect className={studioCss.pianoBackground} x="0" y="0" width="1000" height="220" />
        {Array.from({ length: 13 }, (_, index) => (
          <line key={index} className={studioCss.pianoGuide} x1="0" x2="1000" y1={index * (220 / 12)} y2={index * (220 / 12)} />
        ))}
        <g aria-label={`${name} 音符与力度条`}>
          {drawnNotes.map((note, index) => {
            const x = note.position / duration * 1000;
            const width = Math.max(2, note.length / duration * 1000);
            const y = (maxKey - note.key) / pitchSpan * 210 + 4;
            const tone = toneByChannel.get(note.channelId ?? "__unknown__") ?? 0;
            const channelName = note.channelId === null ? "未知 Channel" : channelNames.get(note.channelId) ?? "未知 Channel";
            return (
              <g key={`${note.key}-${note.position}-${index}`} data-drawn-note="true">
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

function DurationDistribution({ notes, ppq }: { notes: DrawableNote[]; ppq: number | null }) {
  if (notes.length === 0) {
    return <DistributionPanel label="音符时值分布" title="音符时值" summary="没有有效音符可统计时值。" bins={[]} />;
  }
  if (ppq === null) {
    const bins = exactBins(notes.map((note) => note.length), (value) => `${formatNumber(value)} ticks`);
    return (
      <DistributionPanel
        label="音符时值分布"
        title="音符时值（tick）"
        summary={bins.map((bin) => `${bin.label} × ${bin.count}`).join(" · ")}
        bins={bins}
        note="PPQ 未读取；保留原始 tick 时值。"
      />
    );
  }
  const bins = [
    { label: "短", count: notes.filter((note) => note.length / ppq < 0.5).length },
    { label: "中", count: notes.filter((note) => note.length / ppq >= 0.5 && note.length / ppq < 1).length },
    { label: "长", count: notes.filter((note) => note.length / ppq >= 1).length }
  ];
  return (
    <DistributionPanel
      label="音符时值分布"
      title="音符时值"
      summary={bins.map((bin) => `${bin.label} ${bin.count}`).join(" · ")}
      bins={bins}
      note="短 < 0.5 拍 · 中 0.5–<1 拍 · 长 ≥ 1 拍"
    />
  );
}

function OnsetDistribution({ notes, ppq }: { notes: DrawableNote[]; ppq: number | null }) {
  if (notes.length === 0) {
    return <DistributionPanel label="起音节奏分布" title="起音节奏" summary="没有有效音符可统计起音位置。" bins={[]} />;
  }
  if (ppq === null) {
    const bins = exactBins(notes.map((note) => note.position), (value) => `tick ${formatNumber(value)}`);
    return (
      <DistributionPanel
        label="起音节奏分布"
        title="起音位置（tick）"
        summary={bins.map((bin) => `${bin.label} × ${bin.count}`).join(" · ")}
        bins={bins}
        note="PPQ 未读取，无法推断正拍/反拍。"
      />
    );
  }
  const counts = { downbeat: 0, offbeat: 0, other: 0 };
  for (const note of notes) {
    const remainder = note.position % ppq;
    if (approximately(remainder, 0) || approximately(remainder, ppq)) counts.downbeat += 1;
    else if (approximately(remainder, ppq / 2)) counts.offbeat += 1;
    else counts.other += 1;
  }
  const bins = [
    { label: "正拍", count: counts.downbeat },
    { label: "反拍", count: counts.offbeat },
    { label: "其他", count: counts.other }
  ];
  return (
    <DistributionPanel
      label="起音节奏分布"
      title="起音节奏"
      summary={bins.map((bin) => `${bin.label} ${bin.count}`).join(" · ")}
      bins={bins}
      note="正拍 = 整拍起音 · 反拍 = 半拍起音"
    />
  );
}

function DistributionPanel({ label, title, summary, bins, note }: {
  label: string;
  title: string;
  summary: string;
  bins: Array<{ label: string; count: number }>;
  note?: string;
}) {
  const maximum = bins.reduce((largest, bin) => Math.max(largest, bin.count), 1);
  return (
    <section className={studioCss.distributionPanel} aria-label={label}>
      <header><h3>{title}</h3><span>{bins.reduce((total, bin) => total + bin.count, 0)} notes</span></header>
      <p>{summary}</p>
      {bins.length > 0 && (
        <ul aria-hidden="true">
          {bins.map((bin) => (
            <li key={bin.label} title={`${bin.label}：${bin.count}`}>
              <span>{bin.label}</span><i><b style={{ width: `${bin.count / maximum * 100}%` }} /></i><strong>{bin.count}</strong>
            </li>
          ))}
        </ul>
      )}
      {note && <small>{note}</small>}
    </section>
  );
}

function validateNotes(notes: StudioNoteSummary[]): { notes: DrawableNote[]; ignoredCount: number } {
  const valid: DrawableNote[] = [];
  let ignoredCount = 0;
  for (const note of notes) {
    const validKey = Number.isInteger(note.key) && note.key >= 0 && note.key <= 127;
    const validPosition = Number.isFinite(note.position) && note.position >= 0;
    const validLength = Number.isFinite(note.length) && note.length > 0;
    const validVelocity = Number.isFinite(note.velocity) && note.velocity >= 0 && note.velocity <= 127;
    const end = note.position + note.length;
    if (!validKey || !validPosition || !validLength || !validVelocity || !Number.isFinite(end)) {
      ignoredCount += 1;
      continue;
    }
    valid.push({
      key: note.key,
      position: note.position,
      length: note.length,
      velocity: note.velocity,
      channelId: note.channelId
    });
  }
  return { notes: valid, ignoredCount };
}

function patternMetrics(notes: DrawableNote[], ppq: number | null) {
  if (notes.length === 0) {
    return {
      count: 0,
      lengthTicks: 0,
      lengthLabel: formatPatternLength(0, ppq),
      rangeLabel: "—",
      densityLabel: ppq === null ? "PPQ 未读取" : "0 / 拍",
      velocityLabel: "—",
      minKey: null,
      maxKey: null
    };
  }
  const { minKey, maxKey, duration: end } = noteExtent(notes);
  const density = ppq !== null && end > 0 ? notes.length / (end / ppq) : null;
  const velocity = notes.reduce((total, note) => total + note.velocity, 0) / notes.length;
  return {
    count: notes.length,
    lengthTicks: end,
    lengthLabel: formatPatternLength(end, ppq),
    rangeLabel: `${minKey}–${maxKey}`,
    densityLabel: density === null ? (ppq === null ? "PPQ 未读取" : "时长不可用") : `${formatNumber(density)} / 拍`,
    velocityLabel: formatNumber(velocity),
    minKey,
    maxKey
  };
}

function noteSummary(metrics: ReturnType<typeof patternMetrics>): string {
  if (metrics.count === 0) return `0 个音符 · 长度 ${metrics.lengthLabel} · 音域不可用 · 平均力度不可用`;
  return `${metrics.count} 个音符 · 长度 ${metrics.lengthLabel} · 音域 ${metrics.minKey}–${metrics.maxKey} · 密度 ${metrics.densityLabel} · 平均力度 ${metrics.velocityLabel}`;
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
  const tones = new Map<string, number>();
  for (const note of notes) {
    const id = note.channelId ?? "__unknown__";
    if (!tones.has(id)) tones.set(id, tones.size % 4);
  }
  return tones;
}

function similarPatterns(selected: StudioPatternSummary, patterns: StudioPatternSummary[]) {
  const selectedNotes = validateNotes(selected.notes).notes;
  if (selectedNotes.length < 2) return [];
  const selectedSignature = noteSignature(selectedNotes);
  return patterns
    .filter((pattern) => pattern.id !== selected.id)
    .flatMap((pattern) => {
      const notes = validateNotes(pattern.notes).notes;
      if (notes.length < 2) return [];
      const score = jaccard(selectedSignature, noteSignature(notes));
      return score >= 0.5 ? [{ pattern, score }] : [];
    })
    .sort((a, b) => b.score - a.score || displayPatternName(a.pattern).localeCompare(displayPatternName(b.pattern)))
    .slice(0, 3);
}

function noteSignature(notes: DrawableNote[]): Set<string> {
  const { minKey, duration } = noteExtent(notes);
  return new Set(notes.map((note) => {
    const positionBin = Math.round(note.position / duration * 16);
    const lengthBin = Math.round(note.length / duration * 16);
    return `${note.key - minKey}:${positionBin}:${lengthBin}`;
  }));
}

function noteExtent(notes: DrawableNote[]): { minKey: number; maxKey: number; duration: number } {
  let minKey = 127;
  let maxKey = 0;
  let duration = 1;
  for (const note of notes) {
    minKey = Math.min(minKey, note.key);
    maxKey = Math.max(maxKey, note.key);
    duration = Math.max(duration, note.position + note.length);
  }
  return { minKey, maxKey, duration };
}

function sampleNotes(notes: DrawableNote[], limit: number): DrawableNote[] {
  if (notes.length <= limit) return notes;
  const chronological = notes
    .map((note, index) => ({ note, index }))
    .sort((left, right) => (
      left.note.position - right.note.position
      || left.note.key - right.note.key
      || left.index - right.index
    ));
  let minPitchIndex = 0;
  let maxPitchIndex = 0;
  let earliestIndex = 0;
  let latestEndIndex = 0;
  for (let index = 1; index < notes.length; index += 1) {
    if (notes[index].key < notes[minPitchIndex].key) minPitchIndex = index;
    if (notes[index].key > notes[maxPitchIndex].key) maxPitchIndex = index;
    if (notes[index].position < notes[earliestIndex].position) earliestIndex = index;
    if (notes[index].position + notes[index].length > notes[latestEndIndex].position + notes[latestEndIndex].length) latestEndIndex = index;
  }
  const selected = new Set([minPitchIndex, maxPitchIndex, earliestIndex, latestEndIndex]);
  const remaining = limit - selected.size;
  for (let slot = 0; slot < remaining; slot += 1) {
    const chronologicalIndex = Math.floor((slot + 0.5) * chronological.length / remaining);
    selected.add(chronological[Math.min(chronological.length - 1, chronologicalIndex)].index);
  }
  for (const item of chronological) {
    if (selected.size >= limit) break;
    selected.add(item.index);
  }
  return chronological.filter((item) => selected.has(item.index)).map((item) => item.note);
}

function jaccard(left: Set<string>, right: Set<string>): number {
  const intersection = [...left].filter((token) => right.has(token)).length;
  const union = new Set([...left, ...right]).size;
  return union === 0 ? 0 : intersection / union;
}

function formatPatternLength(ticks: number, ppq: number | null): string {
  return ppq === null
    ? `${formatNumber(ticks)} ticks`
    : `${formatNumber(ticks)} ticks · ${formatNumber(ticks / ppq)} beats`;
}

function exactBins(values: number[], label: (value: number) => string): Array<{ label: string; count: number }> {
  const counts = new Map<number, number>();
  for (const value of values) counts.set(value, (counts.get(value) ?? 0) + 1);
  const entries = [...counts.entries()].sort((left, right) => left[0] - right[0]);
  const visible = entries.slice(0, 7).map(([value, count]) => ({ label: label(value), count }));
  if (entries.length <= 7) return visible;
  return [
    ...visible,
    {
      label: `其他 ${entries.length - 7} 种`,
      count: entries.slice(7).reduce((total, [, count]) => total + count, 0)
    }
  ];
}

function approximately(left: number, right: number): boolean {
  return Math.abs(left - right) < 1e-6;
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

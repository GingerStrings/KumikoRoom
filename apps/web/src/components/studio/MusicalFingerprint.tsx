import type { StudioMusicalFingerprint } from "../../api/studioTypes";
import studioCss from "./Studio.module.css";

interface MusicalFingerprintProps {
  fingerprint: StudioMusicalFingerprint;
}

const clamp01 = (value: number) => Number.isFinite(value) ? Math.min(1, Math.max(0, value)) : 0;
const percent = (value: number) => Math.round(clamp01(value) * 100);

export function MusicalFingerprint({ fingerprint }: MusicalFingerprintProps) {
  const density = Number.isFinite(fingerprint.noteDensity) ? Math.max(0, fingerprint.noteDensity) : 0;
  const densityLabel = density.toFixed(2).replace(/0+$/, "").replace(/\.$/, "");
  const densityScale = Math.round(clamp01(density / 8) * 100);
  const reuse = percent(fingerprint.patternReuse);
  const confidence = percent(fingerprint.inferredKeyConfidence);
  const velocity = fingerprint.velocityMean === null || !Number.isFinite(fingerprint.velocityMean)
    ? null
    : Math.round(Math.min(127, Math.max(0, fingerprint.velocityMean)));
  const hasRange = fingerprint.noteMin !== null && fingerprint.noteMax !== null;
  const noteMin = hasRange ? Math.min(127, Math.max(0, fingerprint.noteMin as number)) : null;
  const noteMax = hasRange ? Math.min(127, Math.max(noteMin as number, fingerprint.noteMax as number)) : null;
  const key = fingerprint.inferredKey?.trim() || null;
  const title = [
    `音乐指纹：音域 ${hasRange ? `${noteMin} 到 ${noteMax}` : "未读取"}`,
    `音符密度 ${densityLabel} 个/拍`,
    `平均力度 ${velocity ?? "未读取"}`,
    `Pattern 复用 ${reuse}%`,
    `推断调性 ${key ?? "未推断"}`,
    `可信度 ${confidence}%`
  ].join("，");
  const rangeX = hasRange ? 42 + ((noteMin as number) / 127) * 476 : 42;
  const rangeWidth = hasRange ? Math.max(3, (((noteMax as number) - (noteMin as number)) / 127) * 476) : 0;

  return (
    <section className={studioCss.fingerprint} aria-label="音乐指纹">
      <header className={studioCss.fingerprintHeader}>
        <div>
          <p className={studioCss.panelKicker}>SPECTRAL MUSICAL FINGERPRINT</p>
          <h2>音乐指纹</h2>
        </div>
        <p className={studioCss.keyInference}>
          <strong>{key ? `${key} · ${confidence}% 可信度` : "调性未推断"}</strong>
          <span>{key ? "基于当前可读取的 MIDI 音符" : "需要更多可读取的 MIDI 音符"}</span>
        </p>
      </header>

      <svg
        className={studioCss.fingerprintSvg}
        viewBox="0 0 560 210"
        role="img"
        aria-label={title}
        preserveAspectRatio="xMidYMid meet"
      >
        <title>{title}</title>
        <defs>
          <linearGradient id="studio-spectrum" x1="0" y1="0" x2="1" y2="0">
            <stop offset="0" stopColor="#6d8da5" />
            <stop offset=".38" stopColor="#8fb6b0" />
            <stop offset=".7" stopColor="#b7a2b1" />
            <stop offset="1" stopColor="#c9aa83" />
          </linearGradient>
          <linearGradient id="studio-spectrum-soft" x1="0" y1="0" x2="1" y2="1">
            <stop offset="0" stopColor="#d9e9eb" stopOpacity=".78" />
            <stop offset="1" stopColor="#eee1d5" stopOpacity=".56" />
          </linearGradient>
        </defs>
        <rect x="1" y="1" width="558" height="208" fill="url(#studio-spectrum-soft)" stroke="#c9d8d5" />
        <g fill="none" stroke="#7d9392" strokeOpacity=".22">
          <path d="M42 38H518M42 74H518M42 110H518M42 146H518" />
          <path d="M42 38V174M161 38V174M280 38V174M399 38V174M518 38V174" />
        </g>
        <g fill="#566d70" fontSize="10" fontFamily="ui-monospace, SFMono-Regular, Consolas, monospace">
          <text x="42" y="28">NOTE RANGE</text>
          <text x="42" y="194">C−1</text>
          <text x="503" y="194">G9</text>
        </g>
        {hasRange ? (
          <g>
            <rect x={rangeX} y="52" width={rangeWidth} height="32" fill="url(#studio-spectrum)" opacity=".9" />
            <line x1={rangeX} y1="45" x2={rangeX} y2="91" stroke="#425e63" />
            <line x1={rangeX + rangeWidth} y1="45" x2={rangeX + rangeWidth} y2="91" stroke="#425e63" />
          </g>
        ) : (
          <path d="M42 68H518" stroke="#91a3a1" strokeDasharray="4 6" />
        )}
        <g transform="translate(42 112)">
          <FingerprintBar label="DENSITY · NOTES/BEAT" value={densityScale} display={`${densityLabel}/拍`} x={0} />
          <FingerprintBar label="VELOCITY" value={velocity === null ? 0 : Math.round((velocity / 127) * 100)} display={velocity === null ? "—" : `${velocity}/127`} x={166} muted={velocity === null} />
          <FingerprintBar label="REUSE" value={reuse} display={`${reuse}%`} x={332} />
        </g>
      </svg>

      <div className={studioCss.fingerprintSummary}>
        <p>
          {hasRange
            ? `音域 ${noteMin}–${noteMax}；音符密度 ${densityLabel} 个/拍；平均力度 ${velocity ?? "未读取"}；Pattern 复用 ${reuse}%。`
            : "没有足够的 MIDI 音符来估算音域与平均力度。"}
        </p>
        {fingerprint.inferredKeyEvidence.length > 0 ? (
          <ul aria-label="调性推断依据">
            {fingerprint.inferredKeyEvidence.map((evidence) => <li key={evidence}>{evidence}</li>)}
          </ul>
        ) : (
          <p className={studioCss.mutedCopy}>当前没有调性推断依据。</p>
        )}
      </div>
    </section>
  );
}

function FingerprintBar({ label, value, display, x, muted = false }: { label: string; value: number; display: string; x: number; muted?: boolean }) {
  const bounded = Math.min(100, Math.max(0, value));
  return (
    <g transform={`translate(${x} 0)`}>
      <text x="0" y="0" fill="#566d70" fontSize="9" fontFamily="ui-monospace, SFMono-Regular, Consolas, monospace">{label}</text>
      <rect x="0" y="12" width="144" height="7" fill="#fffdf8" stroke="#c9d8d5" />
      <rect x="0" y="12" width={144 * bounded / 100} height="7" fill={muted ? "#aab7b5" : "url(#studio-spectrum)"} />
      <text x="144" y="36" textAnchor="end" fill="#405b5f" fontSize="11" fontWeight="700">{display}</text>
    </g>
  );
}

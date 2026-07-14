import type { StudioScanJob } from "../../api/studioTypes";
import studioCss from "./Studio.module.css";

const statusLabels: Record<StudioScanJob["status"], string> = {
  queued: "等待扫描",
  running: "正在扫描",
  completed: "扫描完成",
  failed: "扫描中断"
};

export function ScanStatus({ job }: { job: StudioScanJob }) {
  const total = Math.max(job.discoveredCount, job.parsedCount + job.cachedCount + job.failedCount, 1);
  const complete = Math.min(job.parsedCount + job.cachedCount + job.failedCount, total);
  const progress = job.status === "completed" ? 100 : Math.round((complete / total) * 100);

  return (
    <section className={studioCss.scanStatus} aria-live="polite" data-status={job.status}>
      <div className={studioCss.scanStatusHeader}>
        <strong>{statusLabels[job.status]}</strong>
        <span>{job.discoveredCount} 个工程</span>
      </div>
      <div className={studioCss.scanTrack} aria-label={`扫描进度 ${progress}%`}>
        <span style={{ width: `${progress}%` }} />
      </div>
      <p>
        已解析 {job.parsedCount} · 使用缓存 {job.cachedCount}
        {job.failedCount > 0 ? ` · 失败 ${job.failedCount}` : ""}
      </p>
      {job.error ? <p className={studioCss.scanError}>{job.error}</p> : null}
    </section>
  );
}

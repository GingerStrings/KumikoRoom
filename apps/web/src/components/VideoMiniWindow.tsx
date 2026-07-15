"use client";

import type { MusicItem } from "../lib/musicItems";

interface VideoMiniWindowProps {
  item: MusicItem;
  size: "compact" | "large";
  onClose: () => void;
  onToggleSize: () => void;
}

export function VideoMiniWindow({ item, size, onClose, onToggleSize }: VideoMiniWindowProps) {
  if (!item.embedUrl) {
    return null;
  }

  const toggleLabel = size === "large" ? "缩小视频小窗" : "放大视频小窗";

  return (
    <aside
      className={`video-mini-window video-mini-window--${size}`}
      role="dialog"
      aria-label="B站视频小窗"
    >
      <header className="video-mini-window__header">
        <div className="video-mini-window__meta">
          <span className="video-mini-window__source">Bilibili</span>
          <strong className="video-mini-window__title">{item.title}</strong>
        </div>
        <div className="video-mini-window__actions">
          <button type="button" aria-label={toggleLabel} onClick={onToggleSize}>
            {size === "large" ? "－" : "＋"}
          </button>
          <button type="button" aria-label="关闭视频小窗" onClick={onClose}>
            ×
          </button>
        </div>
      </header>

      <iframe
        className="video-mini-window__frame"
        title={`${item.title} 视频播放`}
        src={item.embedUrl}
        allow="autoplay; fullscreen; picture-in-picture"
        allowFullScreen
      />

      {item.pageUrl ? (
        <a
          className="video-mini-window__link"
          href={item.pageUrl}
          target="_blank"
          rel="noreferrer"
        >
          在 B站 打开
        </a>
      ) : null}
    </aside>
  );
}

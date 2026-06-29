import { fireEvent, render, screen } from "@testing-library/react";
import React from "react";
import { describe, expect, it, vi } from "vitest";
import { makeBilibiliMusicItem } from "../src/lib/musicItems";
import { VideoMiniWindow } from "../src/components/VideoMiniWindow";

const bilibiliItem = makeBilibiliMusicItem({
  id: "test-video-mini-window",
  title: "Rehearsal Video",
  creator: "Rehearsal Archive",
  url: "https://www.bilibili.com/video/BV1xx411c7mD",
  tags: ["bilibili", "test"]
});

describe("VideoMiniWindow", () => {
  it("renders a Bilibili item as an optional mini player surface", () => {
    render(
      <VideoMiniWindow
        item={bilibiliItem}
        size="compact"
        onClose={vi.fn()}
        onToggleSize={vi.fn()}
      />
    );

    expect(screen.getByRole("dialog", { name: "B站视频小窗" })).toBeTruthy();
    expect(screen.getByText(bilibiliItem.title)).toBeTruthy();
    const frame = screen.getByTitle(`${bilibiliItem.title} 视频播放`);
    expect(frame.classList.contains("video-mini-window__frame")).toBe(true);
    expect(frame.getAttribute("src")).toBe(bilibiliItem.embedUrl);
    expect(frame.getAttribute("allow")).toContain("autoplay");
    expect(frame.hasAttribute("allowfullscreen")).toBe(true);
    const link = screen.getByRole("link", { name: "在 B站 打开" });
    expect(link.classList.contains("video-mini-window__link")).toBe(true);
    expect(link.getAttribute("href")).toBe(bilibiliItem.pageUrl);
    expect(link.getAttribute("target")).toBe("_blank");
    expect(link.getAttribute("rel")).toContain("noreferrer");
  });

  it("exposes close and size controls", () => {
    const onClose = vi.fn();
    const onToggleSize = vi.fn();

    render(
      <VideoMiniWindow
        item={bilibiliItem}
        size="large"
        onClose={onClose}
        onToggleSize={onToggleSize}
      />
    );

    fireEvent.click(screen.getByRole("button", { name: "缩小视频小窗" }));
    fireEvent.click(screen.getByRole("button", { name: "关闭视频小窗" }));

    expect(onToggleSize).toHaveBeenCalledTimes(1);
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("renders nothing when the item has no embed URL", () => {
    const { container } = render(
      <VideoMiniWindow
        item={{ ...bilibiliItem, embedUrl: undefined }}
        size="compact"
        onClose={vi.fn()}
        onToggleSize={vi.fn()}
      />
    );

    expect(container.firstChild).toBeNull();
  });
});

import { fireEvent, render, screen } from "@testing-library/react";
import React from "react";
import { describe, expect, it, vi } from "vitest";
import { PLAYER_TRACKS } from "../src/lib/musicItems";
import { VideoMiniWindow } from "../src/components/VideoMiniWindow";

const bilibiliItem = PLAYER_TRACKS.find((item) => item.source === "bilibili")!;

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
    expect(frame.getAttribute("src")).toBe(bilibiliItem.embedUrl);
    expect(frame.getAttribute("allow")).toContain("autoplay");
    expect(screen.getByRole("link", { name: "在 B站 打开" }).getAttribute("href")).toBe(bilibiliItem.pageUrl);
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
        item={{ ...PLAYER_TRACKS[0], embedUrl: undefined }}
        size="compact"
        onClose={vi.fn()}
        onToggleSize={vi.fn()}
      />
    );

    expect(container.firstChild).toBeNull();
  });
});

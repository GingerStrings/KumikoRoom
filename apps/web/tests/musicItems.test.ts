import { describe, expect, it } from "vitest";
import {
  PLAYER_TRACKS,
  buildBilibiliEmbedUrl,
  buildListeningContext,
  makeBilibiliMusicItem,
  parseBilibiliVideoUrl
} from "../src/lib/musicItems";

describe("music item platform helpers", () => {
  it("parses common Bilibili video links into page and embed URLs", () => {
    expect(parseBilibiliVideoUrl("https://www.bilibili.com/video/BV1xx411c7mD/?spm_id_from=333.337.search-card.all.click")).toEqual({
      bvid: "BV1xx411c7mD",
      pageUrl: "https://www.bilibili.com/video/BV1xx411c7mD",
      embedUrl: "https://player.bilibili.com/player.html?bvid=BV1xx411c7mD&page=1&high_quality=1&autoplay=0"
    });
  });

  it("parses short Bilibili links that still contain a BV id", () => {
    expect(parseBilibiliVideoUrl("b23.tv/BV1xx411c7mD")).toMatchObject({
      bvid: "BV1xx411c7mD",
      pageUrl: "https://www.bilibili.com/video/BV1xx411c7mD"
    });
  });

  it("parses a raw BV id", () => {
    expect(parseBilibiliVideoUrl("BV1xx411c7mD")).toMatchObject({
      bvid: "BV1xx411c7mD",
      pageUrl: "https://www.bilibili.com/video/BV1xx411c7mD"
    });
  });

  it("returns null for text without a Bilibili BV id", () => {
    expect(parseBilibiliVideoUrl("https://music.163.com/song?id=123")).toBeNull();
  });

  it("rejects BV tokens embedded in non-Bilibili URLs or unrelated text", () => {
    expect(parseBilibiliVideoUrl("https://example.com/BV1xx411c7mD")).toBeNull();
    expect(parseBilibiliVideoUrl("play this BV1xx411c7mD later")).toBeNull();
  });

  it("encodes Bilibili embed bvid values", () => {
    expect(buildBilibiliEmbedUrl("BV1xx411c7mD&autoplay=1")).toBe(
      "https://player.bilibili.com/player.html?bvid=BV1xx411c7mD%26autoplay%3D1&page=1&high_quality=1&autoplay=0"
    );
  });

  it("creates a Bilibili music item with an embeddable video surface", () => {
    const item = makeBilibiliMusicItem({
      id: "test-bv",
      title: "Blue Bird rehearsal",
      creator: "demo up",
      url: "https://www.bilibili.com/video/BV1xx411c7mD"
    });

    expect(item).toMatchObject({
      id: "test-bv",
      source: "bilibili",
      title: "Blue Bird rehearsal",
      creator: "demo up",
      pageUrl: "https://www.bilibili.com/video/BV1xx411c7mD",
      embedUrl: "https://player.bilibili.com/player.html?bvid=BV1xx411c7mD&page=1&high_quality=1&autoplay=0",
      tags: ["bilibili"],
      canOpenVideo: true
    });
  });

  it("throws when creating a Bilibili item from an invalid URL", () => {
    expect(() =>
      makeBilibiliMusicItem({
        id: "bad-bv",
        title: "Broken rehearsal",
        creator: "demo up",
        url: "https://music.163.com/song?id=123"
      })
    ).toThrow("Invalid Bilibili video URL");
  });

  it("keeps the default queue source-aware while preserving the current first track label", () => {
    expect(PLAYER_TRACKS[0]).toMatchObject({
      source: "local",
      title: "雨后的走廊",
      creator: "练习室 · 傍晚",
      canOpenVideo: false
    });
    expect(PLAYER_TRACKS.some((track) => track.source === "bilibili" && track.canOpenVideo)).toBe(true);
  });

  it("preserves default player item ids and visible labels", () => {
    expect(PLAYER_TRACKS).toMatchObject([
      {
        id: "local-rain-corridor",
        source: "local",
        title: "雨后的走廊",
        creator: "练习室 · 傍晚",
        canOpenVideo: false
      },
      {
        id: "bilibili-blue-bird-rehearsal",
        source: "bilibili",
        title: "合奏前调音",
        creator: "部室 · 木管声部",
        canOpenVideo: true
      },
      {
        id: "local-bluebird-bridge",
        source: "local",
        title: "青鸟的间奏",
        creator: "长笛 · 双簧管",
        canOpenVideo: false
      }
    ]);
  });

  it("builds compact listening context for chat requests", () => {
    expect(buildListeningContext(PLAYER_TRACKS[1], true)).toEqual({
      source: PLAYER_TRACKS[1].source,
      title: PLAYER_TRACKS[1].title,
      creator: PLAYER_TRACKS[1].creator,
      isPlaying: true,
      pageUrl: PLAYER_TRACKS[1].pageUrl ?? null,
      tags: PLAYER_TRACKS[1].tags
    });
  });

  it("copies tags when building listening context", () => {
    const item = makeBilibiliMusicItem({
      id: "tag-copy",
      title: "Tag Copy",
      creator: "demo up",
      url: "https://www.bilibili.com/video/BV1xx411c7mD",
      tags: ["rehearsal"]
    });

    const context = buildListeningContext(item, true);

    expect(context.tags).toEqual(["rehearsal"]);
    expect(context.tags).not.toBe(item.tags);

    context.tags.push("mutated");
    expect(item.tags).toEqual(["rehearsal"]);
  });
});

import { describe, expect, it } from "vitest";
import * as musicItems from "../src/lib/musicItems";
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

  it("parses Netease song links and raw ids into page, player, and remote stream URLs", () => {
    expect(typeof musicItems.parseNeteaseSongUrl).toBe("function");

    const expected = {
      songId: "1822942870",
      pageUrl: "https://music.163.com/#/song?id=1822942870",
      embedUrl: "https://music.163.com/outchain/player?type=2&id=1822942870&auto=0&height=66",
      platformAudioUrl: "https://music.163.com/song/media/outer/url?id=1822942870.mp3"
    };

    expect(musicItems.parseNeteaseSongUrl("https://music.163.com/song?id=1822942870")).toEqual(expected);
    expect(musicItems.parseNeteaseSongUrl("https://music.163.com/#/song?id=1822942870")).toEqual(expected);
    expect(musicItems.parseNeteaseSongUrl("1822942870")).toEqual(expected);
  });

  it("creates a player item from a backend client action item", () => {
    expect(
      musicItems.makeMusicItemFromClientActionItem({
        id: "netease-song-2",
        source: "netease",
        title: "晴天 (原唱 周杰伦)",
        creator: "RyaVocal",
        durationMs: 270738,
        pageUrl: "https://music.163.com/#/song?id=2",
        platformAudioUrl: "https://music.163.com/song/media/outer/url?id=2.mp3",
        tags: ["netease", "agent-selected"],
        canOpenVideo: false
      })
    ).toMatchObject({
      id: "netease-song-2",
      source: "netease",
      title: "晴天 (原唱 周杰伦)",
      creator: "RyaVocal",
      durationMs: 270738,
      pageUrl: "https://music.163.com/#/song?id=2",
      embedUrl: "https://music.163.com/outchain/player?type=2&id=2&auto=0&height=66",
      platformAudioUrl: "https://music.163.com/song/media/outer/url?id=2.mp3",
      tags: ["netease", "agent-selected"],
      canOpenVideo: false
    });
  });

  it("ships no hard-coded player defaults", () => {
    expect(PLAYER_TRACKS).toEqual([]);
  });

  it("does not ship the deleted sticky default tracks", () => {
    expect(PLAYER_TRACKS.map((track) => track.id)).not.toEqual(
      expect.arrayContaining(["netease-red-horse-instrumental", "bilibili-blue-bird-rehearsal"])
    );
    expect(PLAYER_TRACKS.map((track) => track.title)).not.toEqual(
      expect.arrayContaining(["\u7ea2\u9a6c (\u4f34\u594f)", "\u5b57\u5e55\u541b\u4ea4\u6d41\u573a\u6240"])
    );
  });

  it("does not ship local default tracks or local playback URLs", () => {
    expect(PLAYER_TRACKS.every((track) => track.source !== "local")).toBe(true);

    for (const track of PLAYER_TRACKS) {
      const playbackUrl = track.platformAudioUrl ?? track.embedUrl ?? track.pageUrl;

      expect(playbackUrl).toBeTruthy();
      expect(playbackUrl).not.toMatch(/^\/|^\.\/|^\.\.\/|\/assets\//);
    }
  });

  it("builds compact listening context for chat requests", () => {
    const item = makeBilibiliMusicItem({
      id: "context-copy",
      title: "Context Copy",
      creator: "demo up",
      url: "https://www.bilibili.com/video/BV1xx411c7mD",
      tags: ["rehearsal"]
    });

    expect(buildListeningContext(item, true)).toEqual({
      source: item.source,
      title: item.title,
      creator: item.creator,
      isPlaying: true,
      pageUrl: item.pageUrl ?? null,
      tags: item.tags
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

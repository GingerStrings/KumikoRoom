import type { ClientMusicItem } from "../api/types";

export type MusicSourceKind = "bilibili" | "netease";

export interface MusicItem {
  id: string;
  source: MusicSourceKind;
  title: string;
  creator: string;
  durationMs: number;
  coverUrl?: string;
  pageUrl?: string;
  embedUrl?: string;
  platformAudioUrl?: string;
  tags: string[];
  notes?: string;
  canOpenVideo: boolean;
}

export interface ListeningContext {
  source: MusicSourceKind;
  title: string;
  creator: string;
  isPlaying: boolean;
  pageUrl: string | null;
  tags: string[];
}

export interface ParsedBilibiliVideo {
  bvid: string;
  pageUrl: string;
  embedUrl: string;
}

export interface ParsedNeteaseSong {
  songId: string;
  pageUrl: string;
  embedUrl: string;
  platformAudioUrl: string;
}

export interface MusicSearchResultItem {
  source: "netease";
  id: string;
  songId: string;
  title: string;
  creator: string;
  durationMs: number;
  pageUrl: string;
  platformAudioUrl: string;
  tags: string[];
  playable: boolean;
  popularity: number | null;
  commentCount: number | null;
  hotCommentLikedCount: number | null;
  score: number;
  evidence: string[];
}

interface BilibiliMusicItemInput {
  id: string;
  title: string;
  creator: string;
  durationMs?: number;
  url: string;
  coverUrl?: string;
  tags?: string[];
  notes?: string;
}

interface NeteaseMusicItemInput {
  id: string;
  title: string;
  creator: string;
  durationMs: number;
  url: string;
  coverUrl?: string;
  tags?: string[];
  notes?: string;
}

const BILIBILI_BVID_PATTERN = /BV[a-zA-Z0-9]{10}/;
const BILIBILI_BVID_ONLY_PATTERN = /^BV[a-zA-Z0-9]{10}$/;
const BILIBILI_HOSTS = new Set([
  "bilibili.com",
  "www.bilibili.com",
  "m.bilibili.com",
  "player.bilibili.com",
  "b23.tv"
]);

const NETEASE_SONG_ID_ONLY_PATTERN = /^\d+$/;
const NETEASE_HOSTS = new Set(["music.163.com", "www.music.163.com"]);
const DELETED_STICKY_DEFAULT_TRACK_IDS = new Set([
  "netease-red-horse-instrumental",
  "bilibili-blue-bird-rehearsal"
]);
const DELETED_STICKY_DEFAULT_TRACK_TITLES = new Set([
  "\u7ea2\u9a6c (\u4f34\u594f)",
  "\u5b57\u5e55\u541b\u4ea4\u6d41\u573a\u6240"
]);

export function buildBilibiliEmbedUrl(bvid: string): string {
  return `https://player.bilibili.com/player.html?bvid=${encodeURIComponent(bvid)}&page=1&high_quality=1&autoplay=0`;
}

export function parseBilibiliVideoUrl(input: string): ParsedBilibiliVideo | null {
  const trimmedInput = input.trim();
  const isRawBvid = BILIBILI_BVID_ONLY_PATTERN.test(trimmedInput);

  if (!isRawBvid) {
    const parsedUrl = parseUrlWithOptionalProtocol(trimmedInput);

    if (!parsedUrl || !BILIBILI_HOSTS.has(parsedUrl.hostname.toLowerCase())) {
      return null;
    }
  }

  const match = trimmedInput.match(BILIBILI_BVID_PATTERN);

  if (!match) {
    return null;
  }

  const bvid = match[0];

  return {
    bvid,
    pageUrl: `https://www.bilibili.com/video/${bvid}`,
    embedUrl: buildBilibiliEmbedUrl(bvid)
  };
}

export function parseNeteaseSongUrl(input: string): ParsedNeteaseSong | null {
  const trimmedInput = input.trim();
  let songId: string | null = null;

  if (NETEASE_SONG_ID_ONLY_PATTERN.test(trimmedInput)) {
    songId = trimmedInput;
  } else {
    const parsedUrl = parseUrlWithOptionalProtocol(trimmedInput);

    if (!parsedUrl || !NETEASE_HOSTS.has(parsedUrl.hostname.toLowerCase())) {
      return null;
    }

    songId = parsedUrl.searchParams.get("id") ?? parseNeteaseHashSongId(parsedUrl.hash);
  }

  if (!songId || !NETEASE_SONG_ID_ONLY_PATTERN.test(songId)) {
    return null;
  }

  return {
    songId,
    pageUrl: `https://music.163.com/#/song?id=${songId}`,
    embedUrl: `https://music.163.com/outchain/player?type=2&id=${songId}&auto=0&height=66`,
    platformAudioUrl: `https://music.163.com/song/media/outer/url?id=${songId}.mp3`
  };
}

function parseNeteaseHashSongId(hash: string): string | null {
  const queryStart = hash.indexOf("?");

  if (queryStart === -1) {
    return null;
  }

  return new URLSearchParams(hash.slice(queryStart + 1)).get("id");
}

function parseUrlWithOptionalProtocol(input: string): URL | null {
  try {
    return new URL(input);
  } catch {
    try {
      return new URL(`https://${input}`);
    } catch {
      return null;
    }
  }
}

export function makeBilibiliMusicItem(input: BilibiliMusicItemInput): MusicItem {
  const parsedVideo = parseBilibiliVideoUrl(input.url);

  if (!parsedVideo) {
    throw new Error("Invalid Bilibili video URL");
  }

  return {
    id: input.id,
    source: "bilibili",
    title: input.title,
    creator: input.creator,
    durationMs: input.durationMs ?? 0,
    coverUrl: input.coverUrl,
    pageUrl: parsedVideo.pageUrl,
    embedUrl: parsedVideo.embedUrl,
    tags: input.tags ?? ["bilibili"],
    notes: input.notes,
    canOpenVideo: true
  };
}

export function makeNeteaseMusicItem(input: NeteaseMusicItemInput): MusicItem {
  const parsedSong = parseNeteaseSongUrl(input.url);

  if (!parsedSong) {
    throw new Error("Invalid Netease song URL");
  }

  return {
    id: input.id,
    source: "netease",
    title: input.title,
    creator: input.creator,
    durationMs: input.durationMs,
    coverUrl: input.coverUrl,
    pageUrl: parsedSong.pageUrl,
    embedUrl: parsedSong.embedUrl,
    platformAudioUrl: parsedSong.platformAudioUrl,
    tags: input.tags ?? ["netease"],
    notes: input.notes,
    canOpenVideo: false
  };
}

export function makeMusicItemFromSearchResult(result: MusicSearchResultItem): MusicItem {
  const parsedSong = parseNeteaseSongUrl(result.pageUrl);

  return {
    id: result.id,
    source: result.source,
    title: result.title,
    creator: result.creator,
    durationMs: result.durationMs,
    pageUrl: result.pageUrl,
    embedUrl: parsedSong?.embedUrl,
    platformAudioUrl: result.platformAudioUrl,
    tags: result.tags,
    canOpenVideo: false
  };
}

export function makeMusicItemFromClientActionItem(item: ClientMusicItem): MusicItem {
  const neteaseSong = item.pageUrl ? parseNeteaseSongUrl(item.pageUrl) : null;
  const bilibiliVideo = item.pageUrl ? parseBilibiliVideoUrl(item.pageUrl) : null;

  return {
    id: item.id,
    source: item.source,
    title: item.title,
    creator: item.creator,
    durationMs: item.durationMs,
    pageUrl: item.pageUrl ?? undefined,
    embedUrl: neteaseSong?.embedUrl ?? bilibiliVideo?.embedUrl,
    platformAudioUrl: item.platformAudioUrl ?? undefined,
    tags: item.tags,
    canOpenVideo: item.canOpenVideo
  };
}

export function isDeletedStickyDefaultMusicItem(item: Pick<MusicItem, "id" | "title">): boolean {
  return DELETED_STICKY_DEFAULT_TRACK_IDS.has(item.id) || DELETED_STICKY_DEFAULT_TRACK_TITLES.has(item.title);
}

export const PLAYER_TRACKS: MusicItem[] = [];

export function buildListeningContext(item: MusicItem, isPlaying: boolean): ListeningContext {
  return {
    source: item.source,
    title: item.title,
    creator: item.creator,
    isPlaying,
    pageUrl: item.pageUrl ?? null,
    tags: [...item.tags]
  };
}

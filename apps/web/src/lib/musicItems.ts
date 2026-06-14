export type MusicSourceKind = "local" | "bilibili" | "netease";

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

export const PLAYER_TRACKS: MusicItem[] = [
  makeNeteaseMusicItem({
    id: "netease-red-horse-instrumental",
    title: "红马 (伴奏)",
    creator: "闫杰晨",
    durationMs: 215866,
    url: "https://music.163.com/song?id=1822942870",
    coverUrl: "https://p2.music.126.net/ScAVTeetyrGEwgCMtuGuGg==/109951165758549216.jpg",
    tags: ["netease", "instrumental"]
  }),
  makeBilibiliMusicItem({
    id: "bilibili-blue-bird-rehearsal",
    title: "字幕君交流场所",
    creator: "碧诗",
    durationMs: 2055000,
    url: "https://www.bilibili.com/video/BV1xx411c7mD",
    tags: ["bilibili"]
  })
];

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

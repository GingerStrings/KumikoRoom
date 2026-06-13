export type MusicSourceKind = "local" | "bilibili" | "netease";

export interface MusicItem {
  id: string;
  source: MusicSourceKind;
  title: string;
  creator: string;
  coverUrl?: string;
  pageUrl?: string;
  embedUrl?: string;
  audioUrl?: string;
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

interface BilibiliMusicItemInput {
  id: string;
  title: string;
  creator: string;
  url: string;
  coverUrl?: string;
  tags?: string[];
  notes?: string;
}

const BILIBILI_BVID_PATTERN = /BV[a-zA-Z0-9]{10}/;

function makeLocalMusicItem(input: {
  id: string;
  title: string;
  creator: string;
  coverUrl?: string;
  audioUrl?: string;
  tags?: string[];
  notes?: string;
}): MusicItem {
  return {
    id: input.id,
    source: "local",
    title: input.title,
    creator: input.creator,
    coverUrl: input.coverUrl,
    audioUrl: input.audioUrl,
    tags: input.tags ?? [],
    notes: input.notes,
    canOpenVideo: false
  };
}

export function buildBilibiliEmbedUrl(bvid: string): string {
  return `https://player.bilibili.com/player.html?bvid=${encodeURIComponent(bvid)}&page=1&high_quality=1&autoplay=0`;
}

export function parseBilibiliVideoUrl(input: string): ParsedBilibiliVideo | null {
  const match = input.match(BILIBILI_BVID_PATTERN);

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
    coverUrl: input.coverUrl,
    pageUrl: parsedVideo.pageUrl,
    embedUrl: parsedVideo.embedUrl,
    tags: input.tags ?? ["bilibili"],
    notes: input.notes,
    canOpenVideo: true
  };
}

export const PLAYER_TRACKS: MusicItem[] = [
  makeLocalMusicItem({
    id: "rainy-corridor",
    title: "雨后的走廊",
    creator: "练习室 · 傍晚",
    tags: ["practice", "evening"]
  }),
  makeBilibiliMusicItem({
    id: "ensemble-tuning",
    title: "合奏前调音",
    creator: "北宇治吹奏部",
    url: "https://www.bilibili.com/video/BV1xx411c7mD",
    tags: ["ensemble", "tuning"]
  }),
  makeLocalMusicItem({
    id: "blue-bird-interlude",
    title: "青鸟的间奏",
    creator: "久美子 · 独奏练习",
    tags: ["interlude", "euphonium"]
  })
];

export function buildListeningContext(item: MusicItem, isPlaying: boolean): ListeningContext {
  return {
    source: item.source,
    title: item.title,
    creator: item.creator,
    isPlaying,
    pageUrl: item.pageUrl ?? null,
    tags: item.tags
  };
}

import type { MusicItem } from "./musicItems";
import type { MusicQueueAddedBy } from "./musicQueue";

export interface MusicPlaylistItem {
  id: string;
  item: MusicItem;
  addedAt: string;
  addedBy: MusicQueueAddedBy;
}

export interface MusicPlaylist {
  id: string;
  name: string;
  description?: string;
  items: MusicPlaylistItem[];
  createdAt: string;
  updatedAt: string;
}

export interface MusicLibraryState {
  playlists: MusicPlaylist[];
}

export interface MusicPlaylistSummary {
  id: string;
  name: string;
  description?: string;
  itemCount: number;
  updatedAt: string;
}

type UnknownRecord = Record<string, unknown>;

const KNOWN_PLAYLIST_SLUGS: Record<string, string> = {
  "夜晚写作": "night-writing",
};

export function createInitialMusicLibrary(): MusicLibraryState {
  return { playlists: [] };
}

export function createMusicPlaylist(
  state: MusicLibraryState,
  input: { id?: string; name: string; description?: string },
  now = currentIsoTime()
): MusicLibraryState {
  const name = input.name.trim();

  if (!name) {
    return state;
  }

  const requestedId = input.id?.trim();

  const playlist: MusicPlaylist = {
    id: requestedId
      ? createUniquePlaylistIdFromBase(requestedId, state.playlists.map((candidate) => candidate.id))
      : createUniquePlaylistId(name, state.playlists.map((candidate) => candidate.id)),
    name,
    items: [],
    createdAt: now,
    updatedAt: now,
  };

  if (input.description !== undefined) {
    playlist.description = input.description;
  }

  return {
    playlists: [
      ...state.playlists.map(clonePlaylist),
      playlist,
    ],
  };
}

export function getAvailableMusicPlaylistId(state: MusicLibraryState, preferredId: string): string {
  const trimmedId = preferredId.trim();
  const baseId = trimmedId || "playlist";
  return createUniquePlaylistIdFromBase(baseId, state.playlists.map((playlist) => playlist.id));
}

export function renameMusicPlaylist(
  state: MusicLibraryState,
  playlistIdOrName: string,
  name: string,
  now = currentIsoTime()
): MusicLibraryState {
  const trimmedName = name.trim();
  const playlist = findPlaylist(state, playlistIdOrName);

  if (!playlist || !trimmedName) {
    return state;
  }

  return {
    playlists: state.playlists.map((candidate) => {
      const cloned = clonePlaylist(candidate);
      return candidate.id === playlist.id
        ? {
            ...cloned,
            name: trimmedName,
            updatedAt: now,
          }
        : cloned;
    }),
  };
}

export function deleteMusicPlaylist(state: MusicLibraryState, playlistIdOrName: string): MusicLibraryState {
  const playlist = findPlaylist(state, playlistIdOrName);

  if (!playlist) {
    return state;
  }

  return {
    playlists: state.playlists
      .filter((candidate) => candidate.id !== playlist.id)
      .map(clonePlaylist),
  };
}

export function addMusicItemToPlaylist(
  state: MusicLibraryState,
  playlistIdOrName: string,
  item: MusicItem,
  addedBy: MusicQueueAddedBy,
  now = currentIsoTime()
): MusicLibraryState {
  const playlist = findPlaylist(state, playlistIdOrName);

  if (!playlist) {
    return state;
  }

  return {
    playlists: state.playlists.map((candidate) => {
      if (candidate.id !== playlist.id) {
        return clonePlaylist(candidate);
      }

      const existingItem = candidate.items.find((entry) => entry.id === item.id);
      const items = existingItem
        ? candidate.items.map((entry) =>
            entry.id === item.id
              ? {
                  ...entry,
                  item: cloneMusicItem(item),
                  addedBy,
                }
              : clonePlaylistItem(entry)
          )
        : [
            ...candidate.items.map(clonePlaylistItem),
            {
              id: item.id,
              item: cloneMusicItem(item),
              addedAt: now,
              addedBy,
            },
          ];

      return {
        ...clonePlaylist(candidate),
        items,
        updatedAt: now,
      };
    }),
  };
}

export function removeMusicItemFromPlaylist(
  state: MusicLibraryState,
  playlistIdOrName: string,
  itemId: string,
  now = currentIsoTime()
): MusicLibraryState {
  const playlist = findPlaylist(state, playlistIdOrName);

  if (!playlist || !playlist.items.some((entry) => entry.id === itemId)) {
    return state;
  }

  return {
    playlists: state.playlists.map((candidate) =>
      candidate.id === playlist.id
        ? {
            ...clonePlaylist(candidate),
            items: candidate.items
              .filter((entry) => entry.id !== itemId)
              .map(clonePlaylistItem),
            updatedAt: now,
          }
        : clonePlaylist(candidate)
    ),
  };
}

export function getMusicPlaylistByIdOrName(state: MusicLibraryState, playlistIdOrName: string): MusicPlaylist | null {
  const playlist = findPlaylist(state, playlistIdOrName);
  return playlist ? clonePlaylist(playlist) : null;
}

export function getMusicPlaylistSummaries(state: MusicLibraryState): MusicPlaylistSummary[] {
  return state.playlists.map((playlist) => {
    const summary: MusicPlaylistSummary = {
      id: playlist.id,
      name: playlist.name,
      itemCount: playlist.items.length,
      updatedAt: playlist.updatedAt,
    };

    if (playlist.description !== undefined) {
      summary.description = playlist.description;
    }

    return summary;
  });
}

export function isMusicLibraryState(value: unknown): value is MusicLibraryState {
  if (!isRecord(value) || !Array.isArray(value.playlists)) {
    return false;
  }

  return value.playlists.every(isMusicPlaylistLike);
}

function findPlaylist(state: MusicLibraryState, playlistIdOrName: string): MusicPlaylist | null {
  return (
    state.playlists.find((playlist) => playlist.id === playlistIdOrName) ??
    state.playlists.find((playlist) => playlist.name === playlistIdOrName) ??
    null
  );
}

function createUniquePlaylistId(name: string, existingIds: string[]): string {
  return createUniquePlaylistIdFromBase(`playlist-${slugPlaylistName(name)}`, existingIds);
}

function createUniquePlaylistIdFromBase(baseId: string, existingIds: string[]): string {
  const existing = new Set(existingIds);
  if (!existing.has(baseId)) {
    return baseId;
  }

  let suffix = 2;
  while (existing.has(`${baseId}-${suffix}`)) {
    suffix += 1;
  }

  return `${baseId}-${suffix}`;
}

function slugPlaylistName(name: string): string {
  const trimmedName = name.trim();
  const knownSlug = KNOWN_PLAYLIST_SLUGS[trimmedName];

  if (knownSlug) {
    return knownSlug;
  }

  const words = trimmedName
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .match(/[a-z0-9]+/g);

  return words?.join("-") || "playlist";
}

function clonePlaylist(playlist: MusicPlaylist): MusicPlaylist {
  const cloned: MusicPlaylist = {
    id: playlist.id,
    name: playlist.name,
    items: playlist.items.map(clonePlaylistItem),
    createdAt: playlist.createdAt,
    updatedAt: playlist.updatedAt,
  };

  if (playlist.description !== undefined) {
    cloned.description = playlist.description;
  }

  return cloned;
}

function clonePlaylistItem(entry: MusicPlaylistItem): MusicPlaylistItem {
  return {
    id: entry.id,
    item: cloneMusicItem(entry.item),
    addedAt: entry.addedAt,
    addedBy: entry.addedBy,
  };
}

function cloneMusicItem(item: MusicItem): MusicItem {
  return {
    ...item,
    tags: [...item.tags],
  };
}

function isMusicPlaylistLike(value: unknown): value is MusicPlaylist {
  if (!isRecord(value)) {
    return false;
  }

  return (
    typeof value.id === "string" &&
    typeof value.name === "string" &&
    isOptionalString(value.description) &&
    Array.isArray(value.items) &&
    value.items.every(isMusicPlaylistItemLike) &&
    typeof value.createdAt === "string" &&
    typeof value.updatedAt === "string"
  );
}

function isMusicPlaylistItemLike(value: unknown): value is MusicPlaylistItem {
  if (!isRecord(value)) {
    return false;
  }

  return (
    typeof value.id === "string" &&
    isMusicItemLike(value.item) &&
    typeof value.addedAt === "string" &&
    isMusicQueueAddedBy(value.addedBy)
  );
}

function isMusicItemLike(value: unknown): value is MusicItem {
  if (!isRecord(value)) {
    return false;
  }

  return (
    typeof value.id === "string" &&
    isMusicSource(value.source) &&
    typeof value.title === "string" &&
    typeof value.creator === "string" &&
    typeof value.durationMs === "number" &&
    Number.isFinite(value.durationMs) &&
    isOptionalString(value.coverUrl) &&
    isOptionalString(value.pageUrl) &&
    isOptionalString(value.embedUrl) &&
    isOptionalString(value.platformAudioUrl) &&
    Array.isArray(value.tags) &&
    value.tags.every((tag) => typeof tag === "string") &&
    isOptionalString(value.notes) &&
    typeof value.canOpenVideo === "boolean"
  );
}

function isMusicSource(value: unknown): value is MusicItem["source"] {
  return value === "bilibili" || value === "netease";
}

function isMusicQueueAddedBy(value: unknown): value is MusicQueueAddedBy {
  return value === "agent" || value === "user" || value === "default";
}

function isOptionalString(value: unknown): value is string | undefined {
  return value === undefined || typeof value === "string";
}

function isRecord(value: unknown): value is UnknownRecord {
  return typeof value === "object" && value !== null;
}

function currentIsoTime(): string {
  return new Date().toISOString();
}

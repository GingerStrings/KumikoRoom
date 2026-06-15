import type { ClientMusicItem } from "../api/types";
import type { MusicItem, MusicSourceKind } from "./musicItems";
import { makeMusicItemFromClientActionItem } from "./musicItems";

export type MusicQueueStatus = "current" | "queued" | "played";
export type MusicQueueAddedBy = "agent" | "user" | "default";

export interface MusicQueueEntry {
  id: string;
  item: MusicItem;
  status: MusicQueueStatus;
  addedBy: MusicQueueAddedBy;
  addedAt: string;
  lastPlayedAt?: string;
  playCount: number;
  sourceQuery?: string;
  selectedReason?: string;
  selectionEvidence?: string[];
  selectionScore?: number;
  saved?: boolean;
}

type ClientMusicQueueItem = ClientMusicItem & {
  sourceQuery?: string | null;
  selectedReason?: string | null;
  selectionEvidence?: string[] | null;
  selectionScore?: number | null;
};

type MusicItemUpdate = Omit<MusicItem, "pageUrl" | "embedUrl" | "platformAudioUrl"> & {
  pageUrl?: string | null;
  embedUrl?: string | null;
  platformAudioUrl?: string | null;
};

export interface MusicQueueState {
  entries: MusicQueueEntry[];
  currentId: string | null;
  recentLimit: number;
}

export interface QueuePreview {
  nextEntryId: string | null;
  nextTitle: string | null;
  nextCreator: string | null;
  nextSource: MusicSourceKind | null;
  remainingCount: number;
}

export const DEFAULT_RECENT_LIMIT = 30;

export function createInitialMusicQueue(
  items: MusicItem[],
  now = currentIsoTime(),
  recentLimit = DEFAULT_RECENT_LIMIT
): MusicQueueState {
  const entries = items.map<MusicQueueEntry>((item, index) => ({
    id: item.id,
    item,
    status: index === 0 ? "current" : "queued",
    addedBy: "default",
    addedAt: now,
    playCount: index === 0 ? 1 : 0,
    lastPlayedAt: index === 0 ? now : undefined,
  }));

  return {
    entries,
    currentId: entries[0]?.id ?? null,
    recentLimit,
  };
}

export function getCurrentQueueEntry(state: MusicQueueState): MusicQueueEntry | null {
  return state.entries.find((entry) => entry.id === state.currentId && entry.status === "current") ?? null;
}

export function getPlaybackQueueEntries(state: MusicQueueState): MusicQueueEntry[] {
  const currentEntry = getCurrentQueueEntry(state);
  const queuedEntries = getUpcomingQueueEntries(state);

  return currentEntry ? [currentEntry, ...queuedEntries] : queuedEntries;
}

export function getUpcomingQueueEntries(state: MusicQueueState): MusicQueueEntry[] {
  return state.entries.filter((entry) => entry.status === "queued");
}

export function getRecentQueueEntries(state: MusicQueueState): MusicQueueEntry[] {
  return state.entries
    .filter((entry) => entry.id !== state.currentId && entry.playCount > 0)
    .sort((left, right) => (right.lastPlayedAt ?? "").localeCompare(left.lastPlayedAt ?? ""))
    .slice(0, state.recentLimit);
}

export function getSavedQueueEntries(state: MusicQueueState): MusicQueueEntry[] {
  return state.entries.filter((entry) => entry.saved);
}

export function getQueuePreview(state: MusicQueueState): QueuePreview {
  const playbackEntries = getPlaybackQueueEntries(state);
  const currentIndex = playbackEntries.findIndex((entry) => entry.status === "current");
  const remainingEntries = currentIndex >= 0 ? playbackEntries.slice(currentIndex + 1) : playbackEntries;
  const nextEntry = remainingEntries[0] ?? null;

  return {
    nextEntryId: nextEntry?.id ?? null,
    nextTitle: nextEntry?.item.title ?? null,
    nextCreator: nextEntry?.item.creator ?? null,
    nextSource: nextEntry?.item.source ?? null,
    remainingCount: remainingEntries.length,
  };
}

export function applyClientMusicActionToQueue(
  state: MusicQueueState,
  item: ClientMusicQueueItem,
  now = currentIsoTime()
): MusicQueueState {
  const musicItem = makeMusicItemUpdateFromClientActionItem(item);
  const upserted = upsertQueueItem(
    state,
    musicItem,
    getClientItemQueueMetadata(item),
    now
  );

  return playQueueItem(upserted, musicItem.id, now);
}

export function playMusicItemsAsQueue(
  state: MusicQueueState,
  items: MusicItem[],
  addedBy: MusicQueueAddedBy = "user",
  now = currentIsoTime()
): MusicQueueState {
  if (items.length === 0) {
    return state;
  }

  const [firstItem, ...remainingItems] = items;
  const cleared = clearUpcomingQueue(state);
  const upsertedFirst = upsertQueueItem(cleared, musicItemToUpdate(firstItem), { addedBy }, now);
  const playingFirst = playQueueItem(upsertedFirst, firstItem.id, now);

  return appendMusicItemsToQueue(playingFirst, remainingItems, addedBy, now);
}

export function appendMusicItemsToQueue(
  state: MusicQueueState,
  items: MusicItem[],
  addedBy: MusicQueueAddedBy = "user",
  now = currentIsoTime()
): MusicQueueState {
  if (items.length === 0) {
    return state;
  }

  return items.reduce((queueState, item) => {
    const upserted = upsertQueueItem(queueState, musicItemToUpdate(item), { addedBy }, now);
    const entry = upserted.entries.find((candidate) => candidate.id === item.id);

    if (!entry || entry.status === "current") {
      return upserted;
    }

    return {
      ...upserted,
      entries: [
        ...upserted.entries.filter((candidate) => candidate.id !== item.id),
        {
          ...entry,
          status: "queued",
          addedAt: now,
        },
      ],
    };
  }, state);
}

export function addQueueItem(
  state: MusicQueueState,
  item: ClientMusicItem,
  now = currentIsoTime()
): MusicQueueState {
  if (getCurrentQueueEntry(state)?.id === item.id) {
    return state;
  }

  const musicItem = makeMusicItemUpdateFromClientActionItem(item);
  const upserted = upsertQueueItem(state, musicItem, getClientItemQueueMetadata(item), now);
  const entry = upserted.entries.find((candidate) => candidate.id === musicItem.id);

  if (!entry || entry.status === "current") {
    return upserted;
  }

  return {
    ...upserted,
    entries: [
      ...upserted.entries.filter((candidate) => candidate.id !== musicItem.id),
      {
        ...entry,
        status: "queued",
        addedAt: now,
      },
    ],
  };
}

export function saveQueueItem(
  state: MusicQueueState,
  item: ClientMusicItem,
  now = currentIsoTime()
): MusicQueueState {
  const isKnownItem = state.entries.some((entry) => entry.id === item.id);
  const musicItem = makeMusicItemUpdateFromClientActionItem(item);
  const upserted = upsertQueueItem(state, musicItem, getClientItemQueueMetadata(item), now);

  return {
    ...upserted,
    entries: upserted.entries.map((entry) =>
      entry.id === musicItem.id
        ? {
            ...entry,
            status: isKnownItem ? entry.status : "played",
            saved: true,
          }
        : entry
    ),
  };
}

export function unsaveQueueItem(state: MusicQueueState, itemId: string): MusicQueueState {
  const entry = state.entries.find((candidate) => candidate.id === itemId);
  if (!entry?.saved) {
    return state;
  }

  return capRecentRecords({
    ...state,
    entries: state.entries.flatMap((candidate) => {
      if (candidate.id !== itemId) {
        return [candidate];
      }
      if (candidate.status === "played" && candidate.playCount === 0) {
        return [];
      }
      return [{ ...candidate, saved: false }];
    }),
  });
}

export function clearUpcomingQueue(state: MusicQueueState): MusicQueueState {
  if (!state.entries.some((entry) => entry.status === "queued")) {
    return state;
  }

  return capRecentRecords({
    ...state,
    entries: state.entries.flatMap((entry) => {
      if (entry.status !== "queued") {
        return [entry];
      }
      if (entry.playCount > 0 || entry.saved) {
        return [{ ...entry, status: "played" as const }];
      }
      return [];
    }),
  });
}

export function upsertQueueItem(
  state: MusicQueueState,
  item: MusicItemUpdate,
  metadata: Partial<Pick<
    MusicQueueEntry,
    "addedBy" | "sourceQuery" | "selectedReason" | "selectionEvidence" | "selectionScore"
  >> = {},
  now = currentIsoTime()
): MusicQueueState {
  const existingIndex = state.entries.findIndex((entry) => entry.id === item.id);
  if (existingIndex >= 0) {
    const entries = state.entries.map((entry, index) =>
      index === existingIndex
        ? {
            ...entry,
            item: mergeKnownMusicItem(entry.item, item),
            addedBy: metadata.addedBy ?? entry.addedBy,
            sourceQuery: metadata.sourceQuery ?? entry.sourceQuery,
            selectedReason: metadata.selectedReason ?? entry.selectedReason,
            selectionEvidence:
              metadata.selectionEvidence === undefined
                ? entry.selectionEvidence
                : cloneSelectionEvidence(metadata.selectionEvidence),
            selectionScore: metadata.selectionScore ?? entry.selectionScore,
          }
        : entry
    );
    return { ...state, entries };
  }

  return {
    ...state,
    entries: [
      ...state.entries,
      {
        id: item.id,
        item: materializeMusicItemUpdate(item),
        status: "queued",
        addedBy: metadata.addedBy ?? "user",
        addedAt: now,
        playCount: 0,
        sourceQuery: metadata.sourceQuery,
        selectedReason: metadata.selectedReason,
        selectionEvidence: cloneSelectionEvidence(metadata.selectionEvidence),
        selectionScore: metadata.selectionScore,
      },
    ],
  };
}

export function playQueueItem(state: MusicQueueState, itemId: string, now = currentIsoTime()): MusicQueueState {
  if (!state.entries.some((entry) => entry.id === itemId)) {
    return state;
  }

  const entries = state.entries.map((entry) => {
    if (entry.id === itemId) {
      return {
        ...entry,
        status: "current" as const,
        lastPlayedAt: now,
        playCount: entry.playCount + 1,
      };
    }

    if (entry.status === "current") {
      return {
        ...entry,
        status: "played" as const,
        lastPlayedAt: now,
      };
    }

    return entry;
  });

  return capRecentRecords({ ...state, currentId: itemId, entries });
}

export function removeQueueEntry(state: MusicQueueState, itemId: string, now = currentIsoTime()): MusicQueueState {
  const removedEntry = state.entries.find((entry) => entry.id === itemId);
  if (!removedEntry) {
    return state;
  }

  const entriesWithoutItem = state.entries.flatMap((entry) => {
    if (entry.id !== itemId) {
      return [entry];
    }
    if (entry.status === "queued" && entry.playCount > 0) {
      return [{ ...entry, status: "played" as const }];
    }
    if (entry.saved) {
      return [{
        ...entry,
        status: "played" as const,
        lastPlayedAt: entry.status === "current" ? now : entry.lastPlayedAt,
      }];
    }
    return [];
  });

  if (state.currentId !== itemId) {
    return capRecentRecords({
      ...state,
      entries: entriesWithoutItem,
    });
  }

  const nextQueued = entriesWithoutItem.find((entry) => entry.status === "queued");
  if (!nextQueued) {
    return capRecentRecords({
      ...state,
      currentId: null,
      entries: entriesWithoutItem,
    });
  }

  return playQueueItem(
    {
      ...state,
      currentId: null,
      entries: entriesWithoutItem,
    },
    nextQueued.id,
    now
  );
}

export function toggleQueueEntrySaved(state: MusicQueueState, itemId: string): MusicQueueState {
  const target = state.entries.find((entry) => entry.id === itemId);
  if (!target) {
    return state;
  }

  const toggled = {
    ...state,
    entries: state.entries.map((entry) =>
      entry.id === itemId ? { ...entry, saved: !entry.saved } : entry
    ),
  };

  return target.saved ? capRecentRecords(toggled) : toggled;
}

function cloneSelectionEvidence(selectionEvidence: string[] | undefined): string[] | undefined {
  return selectionEvidence ? [...selectionEvidence] : selectionEvidence;
}

function musicItemToUpdate(item: MusicItem): MusicItemUpdate {
  const update: MusicItemUpdate = {
    id: item.id,
    source: item.source,
    title: item.title,
    creator: item.creator,
    durationMs: item.durationMs,
    tags: [...item.tags],
    canOpenVideo: item.canOpenVideo,
  };

  if (item.coverUrl !== undefined) {
    update.coverUrl = item.coverUrl;
  }
  if (item.pageUrl !== undefined) {
    update.pageUrl = item.pageUrl;
  }
  if (item.embedUrl !== undefined) {
    update.embedUrl = item.embedUrl;
  }
  if (item.platformAudioUrl !== undefined) {
    update.platformAudioUrl = item.platformAudioUrl;
  }
  if (item.notes !== undefined) {
    update.notes = item.notes;
  }

  return update;
}

function makeMusicItemUpdateFromClientActionItem(item: ClientMusicItem): MusicItemUpdate {
  const musicItem = makeMusicItemFromClientActionItem(item) as MusicItemUpdate;

  if (item.pageUrl === null) {
    musicItem.pageUrl = null;
    musicItem.embedUrl = null;
  }
  if (item.platformAudioUrl === null) {
    musicItem.platformAudioUrl = null;
  }

  return musicItem;
}

function mergeKnownMusicItem(existing: MusicItem, incoming: MusicItemUpdate): MusicItem {
  const merged: Partial<MusicItem> = { ...existing };

  for (const [key, value] of Object.entries(incoming) as Array<[keyof MusicItemUpdate, unknown]>) {
    if (value === undefined) continue;
    if (value === null) {
      delete (merged as Record<string, unknown>)[key as string];
      continue;
    }
    if (key === "tags") {
      merged.tags = [...(value as string[])];
      continue;
    }
    (merged as Record<string, unknown>)[key as string] = value;
  }

  return merged as MusicItem;
}

function materializeMusicItemUpdate(item: MusicItemUpdate): MusicItem {
  const materialized = Object.fromEntries(
    Object.entries(item).filter(([, value]) => value !== undefined && value !== null)
  ) as unknown as MusicItem;

  return {
    ...materialized,
    tags: [...item.tags],
  };
}

function getClientItemQueueMetadata(
  item: ClientMusicQueueItem
): Partial<Pick<
  MusicQueueEntry,
  "addedBy" | "sourceQuery" | "selectedReason" | "selectionEvidence" | "selectionScore"
>> {
  return {
    addedBy: item.tags.includes("agent-selected") ? "agent" : "user",
    sourceQuery: item.sourceQuery ?? undefined,
    selectedReason: item.selectedReason ?? undefined,
    selectionEvidence: item.selectionEvidence ?? undefined,
    selectionScore: item.selectionScore ?? undefined,
  };
}

function capRecentRecords(state: MusicQueueState): MusicQueueState {
  const recentEntries = getRecentQueueEntries(state);
  const allowedRecentIds = new Set(recentEntries.slice(0, state.recentLimit).map((entry) => entry.id));
  return {
    ...state,
    entries: state.entries.filter(
      (entry) => entry.status !== "played" || entry.saved || allowedRecentIds.has(entry.id)
    ),
  };
}

function currentIsoTime(): string {
  return new Date().toISOString();
}

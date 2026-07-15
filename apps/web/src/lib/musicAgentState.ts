import type { MusicAgentState, MusicAgentTrack } from "../api/types";
import type { MusicItem } from "./musicItems";
import { createInitialMusicLibrary, type MusicLibraryState } from "./musicLibrary";
import {
  getCurrentQueueEntry,
  getRecentQueueEntries,
  getSavedQueueEntries,
  getUpcomingQueueEntries,
  type MusicQueueEntry,
  type MusicQueueState,
} from "./musicQueue";

interface MusicPlaybackState {
  isPlaying: boolean;
  currentTimeMs: number;
  durationMs: number;
}

export function buildMusicAgentState(
  queue: MusicQueueState,
  playback: MusicPlaybackState,
  library: MusicLibraryState = createInitialMusicLibrary()
): MusicAgentState {
  const currentEntry = getCurrentQueueEntry(queue);
  const upcomingEntries = getUpcomingQueueEntries(queue);
  const recentEntries = getRecentQueueEntries(queue);

  return {
    isPlaying: currentEntry ? playback.isPlaying : false,
    currentTimeMs: currentEntry ? playback.currentTimeMs : 0,
    durationMs: currentEntry ? playback.durationMs : 0,
    current: mapQueueEntryToAgentTrack(currentEntry),
    previous: mapQueueEntryToAgentTrack(recentEntries[0] ?? null),
    next: mapQueueEntryToAgentTrack(upcomingEntries[0] ?? null),
    upcoming: upcomingEntries.map(mapQueueEntryToAgentTrackRequired),
    recent: recentEntries.map(mapQueueEntryToAgentTrackRequired),
    saved: getSavedQueueEntries(queue).map(mapQueueEntryToAgentTrackRequired),
    playlists: library.playlists.map((playlist) => ({
      id: playlist.id,
      name: playlist.name,
      description: playlist.description,
      itemCount: playlist.items.length,
      updatedAt: playlist.updatedAt,
      items: playlist.items.map((entry) => mapMusicItemToAgentTrack(entry.item, false)),
    })),
  };
}

function mapQueueEntryToAgentTrack(entry: MusicQueueEntry | null): MusicAgentTrack | null {
  return entry ? mapQueueEntryToAgentTrackRequired(entry) : null;
}

function mapQueueEntryToAgentTrackRequired(entry: MusicQueueEntry): MusicAgentTrack {
  const track = mapMusicItemToAgentTrack(entry.item, entry.saved === true);

  return {
    ...track,
    id: entry.id,
    pageUrl: track.pageUrl ?? null,
    platformAudioUrl: track.platformAudioUrl ?? null,
  };
}

function mapMusicItemToAgentTrack(item: MusicItem, saved: boolean): MusicAgentTrack {
  return {
    id: item.id,
    source: item.source,
    title: item.title,
    creator: item.creator,
    durationMs: item.durationMs,
    pageUrl: item.pageUrl,
    platformAudioUrl: item.platformAudioUrl,
    tags: [...item.tags],
    canOpenVideo: item.canOpenVideo,
    saved,
  };
}

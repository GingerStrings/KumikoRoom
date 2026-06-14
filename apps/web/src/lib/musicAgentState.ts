import type { MusicAgentState, MusicAgentTrack } from "../api/types";
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
  playback: MusicPlaybackState
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
  };
}

function mapQueueEntryToAgentTrack(entry: MusicQueueEntry | null): MusicAgentTrack | null {
  return entry ? mapQueueEntryToAgentTrackRequired(entry) : null;
}

function mapQueueEntryToAgentTrackRequired(entry: MusicQueueEntry): MusicAgentTrack {
  return {
    id: entry.id,
    source: entry.item.source,
    title: entry.item.title,
    creator: entry.item.creator,
    durationMs: entry.item.durationMs,
    pageUrl: entry.item.pageUrl ?? null,
    platformAudioUrl: entry.item.platformAudioUrl ?? null,
    tags: [...entry.item.tags],
    canOpenVideo: entry.item.canOpenVideo,
    saved: entry.saved === true,
  };
}

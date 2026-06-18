import type { AutoDjSettings } from "../api/types";
import {
  getPlaybackQueueEntries,
  type MusicQueueState
} from "./musicQueue";

interface ShouldRequestAutoDjRefillInput {
  enabled: boolean;
  hydrated: boolean;
  queue: MusicQueueState;
  settings: AutoDjSettings;
  inFlightSignature: string | null;
  lastRequestedSignature: string | null;
}

export function getPlayableQueueDepth(queue: MusicQueueState): number {
  return getPlaybackQueueEntries(queue).filter((entry) => entry.status === "current" || entry.status === "queued").length;
}

export function createAutoDjQueueSignature(queue: MusicQueueState, settings: AutoDjSettings): string {
  const ids = getPlaybackQueueEntries(queue).map((entry) => `${entry.status}:${entry.id}`).join("|");
  return `${ids}::${settings.count}:${settings.queueDepthTrigger}:${settings.similarCount}:${settings.explorationCount}`;
}

export function shouldRequestAutoDjRefill(input: ShouldRequestAutoDjRefillInput): string | null {
  if (!input.enabled || !input.hydrated) return null;
  if (getPlayableQueueDepth(input.queue) > input.settings.queueDepthTrigger) return null;

  const signature = createAutoDjQueueSignature(input.queue, input.settings);
  if (input.inFlightSignature === signature || input.lastRequestedSignature === signature) {
    return null;
  }

  return signature;
}

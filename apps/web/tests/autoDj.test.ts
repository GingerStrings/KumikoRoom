import type { AutoDjRecommendResponse, AutoDjSettings } from "../src/api/types";
import { createAutoDjQueueSignature, getPlayableQueueDepth, shouldRequestAutoDjRefill } from "../src/lib/autoDj";
import type { MusicQueueState } from "../src/lib/musicQueue";

function queueState(ids: string[], currentId: string | null = ids[0] ?? null): MusicQueueState {
  return {
    currentId,
    recentLimit: 30,
    entries: ids.map((id, index) => ({
      id,
      item: {
        id,
        source: "netease",
        title: `Song ${id}`,
        creator: "Artist",
        durationMs: 180000,
        pageUrl: `https://example.test/${id}`,
        platformAudioUrl: `https://example.test/${id}.mp3`,
        tags: ["netease"],
        canOpenVideo: false
      },
      status: index === 0 ? "current" : "queued",
      addedBy: "user",
      addedAt: "2026-06-18T00:00:00.000Z",
      playCount: index === 0 ? 1 : 0
    }))
  };
}

const settings: AutoDjSettings = {
  count: 3,
  queueDepthTrigger: 2,
  similarCount: 2,
  explorationCount: 1
};

describe("autoDj", () => {
  it("counts current plus upcoming playable entries", () => {
    expect(getPlayableQueueDepth(queueState(["a", "b", "c"]))).toBe(3);
    expect(getPlayableQueueDepth(queueState(["a", "b"]))).toBe(2);
  });

  it("requests refill only when enabled, hydrated, shallow, and signature is new", () => {
    const queue = queueState(["a", "b"]);
    const signature = createAutoDjQueueSignature(queue, settings);

    expect(shouldRequestAutoDjRefill({ enabled: true, hydrated: true, queue, settings, inFlightSignature: null, lastRequestedSignature: null })).toBe(signature);
    expect(shouldRequestAutoDjRefill({ enabled: false, hydrated: true, queue, settings, inFlightSignature: null, lastRequestedSignature: null })).toBeNull();
    expect(shouldRequestAutoDjRefill({ enabled: true, hydrated: false, queue, settings, inFlightSignature: null, lastRequestedSignature: null })).toBeNull();
    expect(shouldRequestAutoDjRefill({ enabled: true, hydrated: true, queue, settings, inFlightSignature: signature, lastRequestedSignature: null })).toBeNull();
    expect(shouldRequestAutoDjRefill({ enabled: true, hydrated: true, queue, settings, inFlightSignature: null, lastRequestedSignature: signature })).toBeNull();
  });
});

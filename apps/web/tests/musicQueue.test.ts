import type { MusicItem } from "../src/lib/musicItems";
import {
  applyClientMusicActionToQueue,
  createInitialMusicQueue,
  getCurrentQueueEntry,
  getPlaybackQueueEntries,
  getQueuePreview,
  getRecentQueueEntries,
  getSavedQueueEntries,
  playQueueItem,
  removeQueueEntry,
  toggleQueueEntrySaved,
} from "../src/lib/musicQueue";

function makeItem(id: string, title: string, source: MusicItem["source"] = "netease"): MusicItem {
  return {
    id,
    source,
    title,
    creator: `${title} creator`,
    durationMs: 180000,
    pageUrl: `https://example.test/${id}`,
    platformAudioUrl: source === "netease" ? `https://example.test/${id}.mp3` : undefined,
    tags: [source],
    canOpenVideo: source === "bilibili",
  };
}

describe("musicQueue", () => {
  it("creates a current item and queued items from defaults", () => {
    const state = createInitialMusicQueue([makeItem("a", "Alpha"), makeItem("b", "Beta")], "2026-06-14T00:00:00.000Z");

    expect(getCurrentQueueEntry(state)?.id).toBe("a");
    expect(getPlaybackQueueEntries(state).map((entry) => entry.id)).toEqual(["a", "b"]);
    expect(getPlaybackQueueEntries(state).map((entry) => entry.status)).toEqual(["current", "queued"]);
  });

  it("plays a queued item and moves the previous current item into recent records", () => {
    const initial = createInitialMusicQueue([makeItem("a", "Alpha"), makeItem("b", "Beta")], "2026-06-14T00:00:00.000Z");
    const state = playQueueItem(initial, "b", "2026-06-14T00:01:00.000Z");

    expect(getCurrentQueueEntry(state)?.id).toBe("b");
    expect(getRecentQueueEntries(state).map((entry) => entry.id)).toEqual(["a"]);
    expect(getRecentQueueEntries(state)[0].lastPlayedAt).toBe("2026-06-14T00:01:00.000Z");
  });

  it("applies agent metadata from a client action item", () => {
    const initial = createInitialMusicQueue([makeItem("a", "Alpha")], "2026-06-14T00:00:00.000Z");
    const state = applyClientMusicActionToQueue(
      initial,
      {
        id: "netease-song-2",
        source: "netease",
        title: "Sunny",
        creator: "Composer",
        durationMs: 200000,
        pageUrl: "https://music.163.com/#/song?id=2",
        platformAudioUrl: "https://music.163.com/song/media/outer/url?id=2.mp3",
        tags: ["netease", "agent-selected"],
        canOpenVideo: false,
        sourceQuery: "play Sunny",
        selectedReason: "ranked score 120",
        selectionEvidence: ["title exact match", "comment_count=10"],
        selectionScore: 120,
      },
      "2026-06-14T00:02:00.000Z"
    );

    const current = getCurrentQueueEntry(state);
    expect(current?.id).toBe("netease-song-2");
    expect(current?.addedBy).toBe("agent");
    expect(current?.sourceQuery).toBe("play Sunny");
    expect(current?.selectedReason).toBe("ranked score 120");
    expect(current?.selectionEvidence).toEqual(["title exact match", "comment_count=10"]);
    expect(current?.selectionScore).toBe(120);
  });

  it("builds a compact preview from the next queued item", () => {
    const state = createInitialMusicQueue(
      [makeItem("a", "Alpha"), makeItem("b", "Beta"), makeItem("c", "Gamma")],
      "2026-06-14T00:00:00.000Z"
    );

    expect(getQueuePreview(state)).toEqual({
      nextEntryId: "b",
      nextTitle: "Beta",
      nextCreator: "Beta creator",
      nextSource: "netease",
      remainingCount: 2,
    });
  });

  it("keeps playback order and preview aligned after playing an out-of-order item", () => {
    const initial = createInitialMusicQueue(
      [makeItem("a", "Alpha"), makeItem("b", "Beta"), makeItem("c", "Gamma")],
      "2026-06-14T00:00:00.000Z"
    );
    const state = playQueueItem(initial, "c", "2026-06-14T00:01:00.000Z");

    expect(getPlaybackQueueEntries(state).map((entry) => entry.id)).toEqual(["c", "b"]);
    expect(getPlaybackQueueEntries(state).map((entry) => entry.status)).toEqual(["current", "queued"]);
    expect(getQueuePreview(state)).toEqual({
      nextEntryId: "b",
      nextTitle: "Beta",
      nextCreator: "Beta creator",
      nextSource: "netease",
      remainingCount: 1,
    });
  });

  it("caps recent records at the configured limit", () => {
    const initial = createInitialMusicQueue(
      [makeItem("a", "Alpha"), makeItem("b", "Beta"), makeItem("c", "Gamma"), makeItem("d", "Delta")],
      "2026-06-14T00:00:00.000Z",
      2
    );
    const playedB = playQueueItem(initial, "b", "2026-06-14T00:01:00.000Z");
    const playedC = playQueueItem(playedB, "c", "2026-06-14T00:02:00.000Z");
    const state = playQueueItem(playedC, "d", "2026-06-14T00:03:00.000Z");

    expect(getRecentQueueEntries(state).map((entry) => entry.id)).toEqual(["c", "b"]);
    expect(state.entries.some((entry) => entry.id === "a")).toBe(false);
  });

  it("returns the same state for unknown play, remove, and save requests", () => {
    const state = createInitialMusicQueue([makeItem("a", "Alpha")], "2026-06-14T00:00:00.000Z");

    expect(playQueueItem(state, "missing", "2026-06-14T00:01:00.000Z")).toBe(state);
    expect(removeQueueEntry(state, "missing", "2026-06-14T00:01:00.000Z")).toBe(state);
    expect(toggleQueueEntrySaved(state, "missing")).toBe(state);
  });

  it("creates an empty initial queue", () => {
    const state = createInitialMusicQueue([], "2026-06-14T00:00:00.000Z");

    expect(getCurrentQueueEntry(state)).toBeNull();
    expect(getPlaybackQueueEntries(state)).toEqual([]);
    expect(getRecentQueueEntries(state)).toEqual([]);
    expect(getSavedQueueEntries(state)).toEqual([]);
    expect(getQueuePreview(state)).toEqual({
      nextEntryId: null,
      nextTitle: null,
      nextCreator: null,
      nextSource: null,
      remainingCount: 0,
    });
  });

  it("keeps saved records visible after queue removal", () => {
    const initial = createInitialMusicQueue([makeItem("a", "Alpha"), makeItem("b", "Beta")], "2026-06-14T00:00:00.000Z");
    const saved = toggleQueueEntrySaved(initial, "b");
    const removed = removeQueueEntry(saved, "b", "2026-06-14T00:03:00.000Z");

    expect(getPlaybackQueueEntries(removed).map((entry) => entry.id)).toEqual(["a"]);
    expect(getSavedQueueEntries(removed).map((entry) => entry.id)).toEqual(["b"]);
    expect(getSavedQueueEntries(removed)[0].status).toBe("played");
  });

  it("moves to the next item when removing the current item", () => {
    const initial = createInitialMusicQueue([makeItem("a", "Alpha"), makeItem("b", "Beta")], "2026-06-14T00:00:00.000Z");
    const state = removeQueueEntry(initial, "a", "2026-06-14T00:04:00.000Z");

    expect(getCurrentQueueEntry(state)?.id).toBe("b");
    expect(getPlaybackQueueEntries(state).map((entry) => entry.id)).toEqual(["b"]);
  });

  it("keeps a saved current item as played when removing it", () => {
    const initial = createInitialMusicQueue([makeItem("a", "Alpha"), makeItem("b", "Beta")], "2026-06-14T00:00:00.000Z");
    const saved = toggleQueueEntrySaved(initial, "a");
    const state = removeQueueEntry(saved, "a", "2026-06-14T00:04:00.000Z");

    expect(getCurrentQueueEntry(state)?.id).toBe("b");
    expect(getPlaybackQueueEntries(state).map((entry) => entry.id)).toEqual(["b"]);
    expect(getSavedQueueEntries(state).map((entry) => entry.id)).toEqual(["a"]);
    expect(getSavedQueueEntries(state)[0].status).toBe("played");
    expect(getSavedQueueEntries(state)[0].lastPlayedAt).toBe("2026-06-14T00:04:00.000Z");
  });

  it("isolates selection evidence from caller mutations", () => {
    const selectionEvidence = ["title exact match", "comment_count=10"];
    const initial = createInitialMusicQueue([makeItem("a", "Alpha")], "2026-06-14T00:00:00.000Z");
    const state = applyClientMusicActionToQueue(
      initial,
      {
        id: "netease-song-2",
        source: "netease",
        title: "Sunny",
        creator: "Composer",
        durationMs: 200000,
        pageUrl: "https://music.163.com/#/song?id=2",
        platformAudioUrl: "https://music.163.com/song/media/outer/url?id=2.mp3",
        tags: ["netease", "agent-selected"],
        canOpenVideo: false,
        selectionEvidence,
      },
      "2026-06-14T00:02:00.000Z"
    );

    selectionEvidence.push("mutated after queue write");

    expect(getCurrentQueueEntry(state)?.selectionEvidence).toEqual(["title exact match", "comment_count=10"]);
  });
});

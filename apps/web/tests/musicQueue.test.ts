import type { MusicItem } from "../src/lib/musicItems";
import type { ClientMusicItem } from "../src/api/types";
import {
  advanceQueuePlayback,
  addQueueItem,
  appendMusicItemsToQueue,
  applyClientMusicActionToQueue,
  clearUpcomingQueue,
  createInitialMusicQueue,
  getCurrentQueueEntry,
  getPlaybackQueueEntries,
  getQueuePreview,
  getRecentQueueEntries,
  getSavedQueueEntries,
  getUpcomingQueueEntries,
  playMusicItemsAsQueue,
  playQueueItem,
  removeQueueEntry,
  saveQueueItem,
  toggleQueueEntrySaved,
  unsaveQueueItem,
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

function makeClientItem(id: string, title: string, source: ClientMusicItem["source"] = "netease"): ClientMusicItem {
  return {
    id,
    source,
    title,
    creator: `${title} creator`,
    durationMs: 180000,
    pageUrl: `https://example.test/${id}`,
    platformAudioUrl: source === "netease" ? `https://example.test/${id}.mp3` : null,
    tags: [source, "agent-selected"],
    canOpenVideo: source === "bilibili",
  };
}

function makeExtendedItem(id: string, title: string): MusicItem {
  return {
    ...makeItem(id, title),
    coverUrl: `https://example.test/${id}.jpg`,
    embedUrl: `https://example.test/embed/${id}`,
    notes: `${title} notes`,
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
    expect(getPlaybackQueueEntries(state).map((entry) => entry.id)).toEqual(["a", "b"]);
    expect(getRecentQueueEntries(state).map((entry) => entry.id)).toEqual(["a"]);
    expect(getRecentQueueEntries(state)[0].lastPlayedAt).toBe("2026-06-14T00:01:00.000Z");
  });

  it("keeps full queue order while previewing only items after the current track", () => {
    const initial = createInitialMusicQueue(
      [makeItem("a", "Alpha"), makeItem("b", "Beta"), makeItem("c", "Gamma")],
      "2026-06-14T00:00:00.000Z"
    );
    const state = playQueueItem(initial, "b", "2026-06-14T00:01:00.000Z");

    expect(getPlaybackQueueEntries(state).map((entry) => entry.id)).toEqual(["a", "b", "c"]);
    expect(getUpcomingQueueEntries(state).map((entry) => entry.id)).toEqual(["c"]);
    expect(getQueuePreview(state)).toEqual({
      nextEntryId: "c",
      nextTitle: "Gamma",
      nextCreator: "Gamma creator",
      nextSource: "netease",
      remainingCount: 1,
    });
  });

  it("advances to the next queue item in sequence mode without removing played tracks", () => {
    const initial = createInitialMusicQueue(
      [makeItem("a", "Alpha"), makeItem("b", "Beta"), makeItem("c", "Gamma")],
      "2026-06-14T00:00:00.000Z"
    );
    const result = advanceQueuePlayback(initial, "sequence", "2026-06-14T00:01:00.000Z");

    expect(result.shouldContinue).toBe(true);
    expect(result.currentEntry?.id).toBe("b");
    expect(getPlaybackQueueEntries(result.state).map((entry) => entry.id)).toEqual(["a", "b", "c"]);
    expect(getRecentQueueEntries(result.state).map((entry) => entry.id)).toEqual(["a"]);
  });

  it("wraps from the last queue item to the first in sequence mode", () => {
    const initial = createInitialMusicQueue(
      [makeItem("a", "Alpha"), makeItem("b", "Beta")],
      "2026-06-14T00:00:00.000Z"
    );
    const playingLast = playQueueItem(initial, "b", "2026-06-14T00:01:00.000Z");
    const result = advanceQueuePlayback(playingLast, "sequence", "2026-06-14T00:02:00.000Z");

    expect(result.shouldContinue).toBe(true);
    expect(result.currentEntry?.id).toBe("a");
    expect(getPlaybackQueueEntries(result.state).map((entry) => entry.id)).toEqual(["a", "b"]);
  });

  it("replays the current queue item in repeat-one mode", () => {
    const initial = createInitialMusicQueue([makeItem("a", "Alpha")], "2026-06-14T00:00:00.000Z");
    const result = advanceQueuePlayback(initial, "repeat-one", "2026-06-14T00:01:00.000Z");

    expect(result.shouldContinue).toBe(true);
    expect(result.currentEntry?.id).toBe("a");
    expect(result.currentEntry?.playCount).toBe(2);
  });

  it("selects another queue item in shuffle mode", () => {
    const initial = createInitialMusicQueue(
      [makeItem("a", "Alpha"), makeItem("b", "Beta"), makeItem("c", "Gamma")],
      "2026-06-14T00:00:00.000Z"
    );
    const result = advanceQueuePlayback(
      initial,
      "shuffle",
      "2026-06-14T00:01:00.000Z",
      () => 0.99
    );

    expect(result.shouldContinue).toBe(true);
    expect(result.currentEntry?.id).toBe("c");
    expect(getPlaybackQueueEntries(result.state).map((entry) => entry.id)).toEqual(["a", "b", "c"]);
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

  it.each([
    ["play", (state: ReturnType<typeof createInitialMusicQueue>, item: ClientMusicItem) =>
      applyClientMusicActionToQueue(state, item, "2026-06-14T00:02:00.000Z")],
    ["add", (state: ReturnType<typeof createInitialMusicQueue>, item: ClientMusicItem) =>
      addQueueItem(state, item, "2026-06-14T00:02:00.000Z")],
    ["save", (state: ReturnType<typeof createInitialMusicQueue>, item: ClientMusicItem) =>
      saveQueueItem(state, item, "2026-06-14T00:02:00.000Z")],
  ])("preserves existing item extensions while %s updates playback fields", (_, updateItem) => {
    const initial = createInitialMusicQueue(
      [makeItem("current", "Current"), makeExtendedItem("known", "Known")],
      "2026-06-14T00:00:00.000Z"
    );
    const incoming = {
      ...makeClientItem("known", "Updated"),
      creator: "Updated creator",
      durationMs: 240000,
      pageUrl: "https://music.163.com/#/song?id=42",
      platformAudioUrl: "https://music.163.com/song/media/outer/url?id=42.mp3",
      tags: ["netease", "updated"],
    };
    const state = updateItem(initial, incoming);
    const updated = state.entries.find((entry) => entry.id === "known")?.item;

    expect(updated).toMatchObject({
      title: "Updated",
      creator: "Updated creator",
      durationMs: 240000,
      pageUrl: "https://music.163.com/#/song?id=42",
      platformAudioUrl: "https://music.163.com/song/media/outer/url?id=42.mp3",
      tags: ["netease", "updated"],
      coverUrl: "https://example.test/known.jpg",
      notes: "Known notes",
    });
  });

  it.each([
    ["play", (state: ReturnType<typeof createInitialMusicQueue>, item: ClientMusicItem) =>
      applyClientMusicActionToQueue(state, item, "2026-06-14T00:02:00.000Z")],
    ["add", (state: ReturnType<typeof createInitialMusicQueue>, item: ClientMusicItem) =>
      addQueueItem(state, item, "2026-06-14T00:02:00.000Z")],
    ["save", (state: ReturnType<typeof createInitialMusicQueue>, item: ClientMusicItem) =>
      saveQueueItem(state, item, "2026-06-14T00:02:00.000Z")],
  ])("clears stale playback URLs when %s receives explicit null fields", (_, updateItem) => {
    const initial = createInitialMusicQueue(
      [makeItem("current", "Current"), makeExtendedItem("known", "Known")],
      "2026-06-14T00:00:00.000Z"
    );
    const state = updateItem(initial, {
      ...makeClientItem("known", "Updated"),
      pageUrl: null,
      platformAudioUrl: null,
      tags: ["netease", "updated"],
    });
    const updated = state.entries.find((entry) => entry.id === "known")?.item;

    expect(updated?.pageUrl).toBeUndefined();
    expect(updated?.platformAudioUrl).toBeUndefined();
    expect(updated?.embedUrl).toBeUndefined();
    expect(updated?.coverUrl).toBe("https://example.test/known.jpg");
    expect(updated?.notes).toBe("Known notes");
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

  it("keeps full playback order and preview aligned after playing an out-of-order item", () => {
    const initial = createInitialMusicQueue(
      [makeItem("a", "Alpha"), makeItem("b", "Beta"), makeItem("c", "Gamma")],
      "2026-06-14T00:00:00.000Z"
    );
    const state = playQueueItem(initial, "c", "2026-06-14T00:01:00.000Z");

    expect(getPlaybackQueueEntries(state).map((entry) => entry.id)).toEqual(["a", "b", "c"]);
    expect(getPlaybackQueueEntries(state).map((entry) => entry.status)).toEqual(["queued", "queued", "current"]);
    expect(getQueuePreview(state)).toEqual({
      nextEntryId: null,
      nextTitle: null,
      nextCreator: null,
      nextSource: null,
      remainingCount: 0,
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
    expect(state.entries.some((entry) => entry.id === "a")).toBe(true);
  });

  it("keeps a played item in recent after adding it back to upcoming", () => {
    const initial = createInitialMusicQueue(
      [makeItem("a", "Alpha"), makeItem("b", "Beta")],
      "2026-06-14T00:00:00.000Z"
    );
    const playedB = playQueueItem(initial, "b", "2026-06-14T00:01:00.000Z");
    const state = addQueueItem(playedB, makeClientItem("a", "Alpha"), "2026-06-14T00:02:00.000Z");

    expect(getUpcomingQueueEntries(state).map((entry) => entry.id)).toEqual(["a"]);
    expect(getRecentQueueEntries(state).map((entry) => entry.id)).toEqual(["a"]);
  });

  it("does not let saved played records make recent exceed its limit", () => {
    const initial = createInitialMusicQueue(
      [makeItem("a", "Alpha"), makeItem("b", "Beta"), makeItem("c", "Gamma"), makeItem("d", "Delta")],
      "2026-06-14T00:00:00.000Z",
      2
    );
    const playedB = playQueueItem(initial, "b", "2026-06-14T00:01:00.000Z");
    const savedA = toggleQueueEntrySaved(playedB, "a");
    const playedC = playQueueItem(savedA, "c", "2026-06-14T00:02:00.000Z");
    const state = playQueueItem(playedC, "d", "2026-06-14T00:03:00.000Z");

    expect(getSavedQueueEntries(state).map((entry) => entry.id)).toEqual(["a"]);
    expect(getRecentQueueEntries(state).map((entry) => entry.id)).toEqual(["c", "b"]);
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

  it("keeps an unsaved played item in recent when removing it from upcoming", () => {
    const initial = createInitialMusicQueue(
      [makeItem("a", "Alpha"), makeItem("b", "Beta")],
      "2026-06-14T00:00:00.000Z"
    );
    const playedB = playQueueItem(initial, "b", "2026-06-14T00:01:00.000Z");
    const requeuedA = addQueueItem(playedB, makeClientItem("a", "Alpha"), "2026-06-14T00:02:00.000Z");
    const state = removeQueueEntry(requeuedA, "a", "2026-06-14T00:03:00.000Z");

    expect(getUpcomingQueueEntries(state)).toEqual([]);
    expect(getRecentQueueEntries(state).map((entry) => entry.id)).toEqual(["a"]);
    expect(state.entries.find((entry) => entry.id === "a")?.status).toBe("played");
    expect(state.entries.find((entry) => entry.id === "a")?.lastPlayedAt).toBe("2026-06-14T00:01:00.000Z");
  });

  it("preserves saved playback time and recent limit when removing a played upcoming item", () => {
    const initial = createInitialMusicQueue(
      [makeItem("a", "Alpha"), makeItem("b", "Beta"), makeItem("c", "Gamma")],
      "2026-06-14T00:00:00.000Z",
      1
    );
    const playedB = playQueueItem(initial, "b", "2026-06-14T00:01:00.000Z");
    const savedA = toggleQueueEntrySaved(playedB, "a");
    const requeuedA = addQueueItem(savedA, makeClientItem("a", "Alpha"), "2026-06-14T00:01:30.000Z");
    const playedC = playQueueItem(requeuedA, "c", "2026-06-14T00:02:00.000Z");
    const state = removeQueueEntry(playedC, "a", "2026-06-14T00:03:00.000Z");

    expect(getSavedQueueEntries(state).map((entry) => entry.id)).toEqual(["a"]);
    expect(state.entries.find((entry) => entry.id === "a")?.status).toBe("played");
    expect(state.entries.find((entry) => entry.id === "a")?.lastPlayedAt).toBe("2026-06-14T00:01:00.000Z");
    expect(getRecentQueueEntries(state).map((entry) => entry.id)).toEqual(["b"]);
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

  it("adds an item to upcoming without changing the current item", () => {
    const initial = createInitialMusicQueue([makeItem("current", "Current")], "2026-06-14T00:00:00.000Z");
    const state = addQueueItem(initial, makeClientItem("next", "Next"), "2026-06-14T00:01:00.000Z");

    expect(getCurrentQueueEntry(state)?.id).toBe("current");
    expect(getUpcomingQueueEntries(state).map((entry) => entry.id)).toEqual(["next"]);
    expect(getUpcomingQueueEntries(state)[0].addedBy).toBe("agent");
  });

  it("treats adding the current item as an idempotent no-op", () => {
    const state = createInitialMusicQueue([makeItem("current", "Current")], "2026-06-14T00:00:00.000Z");

    expect(addQueueItem(state, makeClientItem("current", "Current"), "2026-06-14T00:01:00.000Z")).toBe(state);
    expect(getUpcomingQueueEntries(state)).toEqual([]);
  });

  it("inserts and explicitly saves an item", () => {
    const initial = createInitialMusicQueue([makeItem("current", "Current")], "2026-06-14T00:00:00.000Z");
    const state = saveQueueItem(initial, makeClientItem("saved", "Saved"), "2026-06-14T00:01:00.000Z");

    expect(getCurrentQueueEntry(state)?.id).toBe("current");
    expect(getSavedQueueEntries(state).map((entry) => entry.id)).toEqual(["saved"]);
    expect(getUpcomingQueueEntries(state)).toEqual([]);
    expect(getRecentQueueEntries(state)).toEqual([]);
  });

  it("explicitly unsaves an item without toggling other records", () => {
    const initial = createInitialMusicQueue([makeItem("current", "Current")], "2026-06-14T00:00:00.000Z");
    const saved = saveQueueItem(initial, makeClientItem("saved", "Saved"), "2026-06-14T00:01:00.000Z");
    const state = unsaveQueueItem(saved, "saved");

    expect(getSavedQueueEntries(state)).toEqual([]);
    expect(unsaveQueueItem(state, "saved")).toBe(state);
    expect(unsaveQueueItem(state, "missing")).toBe(state);
  });

  it("caps recent records after unsaving an old played item", () => {
    const initial = createInitialMusicQueue(
      [makeItem("a", "Alpha"), makeItem("b", "Beta"), makeItem("c", "Gamma")],
      "2026-06-14T00:00:00.000Z",
      1
    );
    const playedB = playQueueItem(initial, "b", "2026-06-14T00:01:00.000Z");
    const savedA = toggleQueueEntrySaved(playedB, "a");
    const playedC = playQueueItem(savedA, "c", "2026-06-14T00:02:00.000Z");
    const state = unsaveQueueItem(playedC, "a");

    expect(getSavedQueueEntries(state)).toEqual([]);
    expect(getRecentQueueEntries(state).map((entry) => entry.id)).toEqual(["b"]);
    expect(state.entries.some((entry) => entry.id === "a")).toBe(true);
  });

  it("caps recent records after toggling off a saved old played item", () => {
    const initial = createInitialMusicQueue(
      [makeItem("a", "Alpha"), makeItem("b", "Beta"), makeItem("c", "Gamma")],
      "2026-06-14T00:00:00.000Z",
      1
    );
    const playedB = playQueueItem(initial, "b", "2026-06-14T00:01:00.000Z");
    const savedA = toggleQueueEntrySaved(playedB, "a");
    const playedC = playQueueItem(savedA, "c", "2026-06-14T00:02:00.000Z");
    const state = toggleQueueEntrySaved(playedC, "a");

    expect(getSavedQueueEntries(state)).toEqual([]);
    expect(getRecentQueueEntries(state).map((entry) => entry.id)).toEqual(["b"]);
    expect(state.entries.some((entry) => entry.id === "a")).toBe(true);
  });

  it("clears only upcoming entries while preserving current, recent, and saved records", () => {
    const initial = createInitialMusicQueue(
      [makeItem("recent", "Recent"), makeItem("current", "Current"), makeItem("saved", "Saved")],
      "2026-06-14T00:00:00.000Z"
    );
    const playingCurrent = playQueueItem(initial, "current", "2026-06-14T00:01:00.000Z");
    const withSavedUpcoming = saveQueueItem(
      playingCurrent,
      makeClientItem("saved", "Saved"),
      "2026-06-14T00:02:00.000Z"
    );
    const state = clearUpcomingQueue(withSavedUpcoming);

    expect(getCurrentQueueEntry(state)?.id).toBe("current");
    expect(getUpcomingQueueEntries(state)).toEqual([]);
    expect(getRecentQueueEntries(state).map((entry) => entry.id)).toEqual(["recent"]);
    expect(getSavedQueueEntries(state).map((entry) => entry.id)).toEqual(["saved"]);
  });

  it("moves played upcoming entries back to recent when clearing upcoming", () => {
    const initial = createInitialMusicQueue(
      [makeItem("a", "Alpha"), makeItem("b", "Beta")],
      "2026-06-14T00:00:00.000Z"
    );
    const playedB = playQueueItem(initial, "b", "2026-06-14T00:01:00.000Z");
    const requeuedA = addQueueItem(playedB, makeClientItem("a", "Alpha"), "2026-06-14T00:02:00.000Z");
    const state = clearUpcomingQueue(requeuedA);

    expect(getUpcomingQueueEntries(state)).toEqual([]);
    expect(getRecentQueueEntries(state).map((entry) => entry.id)).toEqual(["a"]);
    expect(state.entries.find((entry) => entry.id === "a")?.status).toBe("played");
  });

  it("plays a list of music items as the current queue", () => {
    const initial = createInitialMusicQueue([makeItem("old", "Old"), makeItem("stale", "Stale")], "2026-06-15T00:00:00.000Z");
    const state = playMusicItemsAsQueue(
      initial,
      [makeItem("a", "Alpha"), makeItem("b", "Beta"), makeItem("c", "Gamma")],
      "user",
      "2026-06-15T00:01:00.000Z"
    );

    expect(getCurrentQueueEntry(state)?.id).toBe("a");
    expect(getPlaybackQueueEntries(state).map((entry) => entry.id)).toEqual(["a", "b", "c"]);
    expect(getRecentQueueEntries(state).map((entry) => entry.id)).toEqual(["old"]);
    expect(getUpcomingQueueEntries(state).map((entry) => entry.addedBy)).toEqual(["user", "user"]);
  });

  it("keeps a repeated current item in playlist order when playing a list", () => {
    const current = makeItem("current", "Current");
    const initial = createInitialMusicQueue([current, makeItem("stale", "Stale")], "2026-06-15T00:00:00.000Z");
    const state = playMusicItemsAsQueue(
      initial,
      [makeItem("a", "Alpha"), current, makeItem("b", "Beta")],
      "user",
      "2026-06-15T00:01:00.000Z"
    );

    expect(getCurrentQueueEntry(state)?.id).toBe("a");
    expect(getPlaybackQueueEntries(state).map((entry) => entry.id)).toEqual(["a", "current", "b"]);
    expect(getUpcomingQueueEntries(state).map((entry) => entry.id)).toEqual(["current", "b"]);
    expect(getUpcomingQueueEntries(state)[0].playCount).toBe(1);
  });

  it("appends a list of music items to upcoming without interrupting current", () => {
    const initial = createInitialMusicQueue([makeItem("current", "Current")], "2026-06-15T00:00:00.000Z");
    const state = appendMusicItemsToQueue(
      initial,
      [makeItem("a", "Alpha"), makeItem("b", "Beta")],
      "agent",
      "2026-06-15T00:01:00.000Z"
    );

    expect(getCurrentQueueEntry(state)?.id).toBe("current");
    expect(getUpcomingQueueEntries(state).map((entry) => entry.id)).toEqual(["a", "b"]);
    expect(getUpcomingQueueEntries(state).map((entry) => entry.addedBy)).toEqual(["agent", "agent"]);
  });

  it("preserves optional item fields and clones tags when appending music items", () => {
    const tags = ["netease", "playlist"];
    const item: MusicItem = {
      ...makeItem("detailed", "Detailed"),
      coverUrl: "https://example.test/detailed.jpg",
      pageUrl: "https://example.test/detailed",
      embedUrl: "https://example.test/embed/detailed",
      platformAudioUrl: "https://example.test/detailed.mp3",
      notes: "Detailed notes",
      tags,
    };
    const initial = createInitialMusicQueue([makeItem("current", "Current")], "2026-06-15T00:00:00.000Z");
    const state = appendMusicItemsToQueue(initial, [item], "user", "2026-06-15T00:01:00.000Z");

    tags.push("mutated");

    const queuedItem = getUpcomingQueueEntries(state)[0].item;
    expect(queuedItem).toMatchObject({
      coverUrl: "https://example.test/detailed.jpg",
      pageUrl: "https://example.test/detailed",
      embedUrl: "https://example.test/embed/detailed",
      platformAudioUrl: "https://example.test/detailed.mp3",
      notes: "Detailed notes",
      tags: ["netease", "playlist"],
    });
    expect(queuedItem.tags).not.toBe(tags);
  });

  it("returns the same queue when asked to play or append an empty list", () => {
    const state = createInitialMusicQueue([makeItem("current", "Current")], "2026-06-15T00:00:00.000Z");

    expect(playMusicItemsAsQueue(state, [], "user", "2026-06-15T00:01:00.000Z")).toBe(state);
    expect(appendMusicItemsToQueue(state, [], "user", "2026-06-15T00:01:00.000Z")).toBe(state);
  });
});

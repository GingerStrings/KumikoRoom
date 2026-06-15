import type { MusicItem } from "../src/lib/musicItems";
import {
  addMusicItemToPlaylist,
  createInitialMusicLibrary,
  createMusicPlaylist,
  deleteMusicPlaylist,
  getMusicPlaylistByIdOrName,
  getMusicPlaylistSummaries,
  isMusicLibraryState,
  removeMusicItemFromPlaylist,
  renameMusicPlaylist,
} from "../src/lib/musicLibrary";

function makeItem(id: string, title: string): MusicItem {
  return {
    id,
    source: "netease",
    title,
    creator: `${title} creator`,
    durationMs: 180000,
    pageUrl: `https://example.test/${id}`,
    platformAudioUrl: `https://example.test/${id}.mp3`,
    tags: ["netease"],
    canOpenVideo: false,
  };
}

function makeStoredLibrary(item: unknown) {
  return {
    playlists: [
      {
        id: "playlist-a",
        name: "A",
        items: [
          {
            id: "a",
            item,
            addedAt: "2026-06-15T00:01:00.000Z",
            addedBy: "user",
          },
        ],
        createdAt: "2026-06-15T00:00:00.000Z",
        updatedAt: "2026-06-15T00:01:00.000Z",
      },
    ],
  };
}

describe("musicLibrary", () => {
  it("creates an empty library", () => {
    expect(createInitialMusicLibrary()).toEqual({ playlists: [] });
  });

  it("returns the unchanged state for blank playlist names", () => {
    const empty = createInitialMusicLibrary();
    const library = createMusicPlaylist(empty, { name: "A" }, "2026-06-15T00:00:00.000Z");

    expect(createMusicPlaylist(empty, { name: "   " }, "2026-06-15T00:01:00.000Z")).toBe(empty);
    expect(renameMusicPlaylist(library, "playlist-a", "   ", "2026-06-15T00:02:00.000Z")).toBe(library);
  });

  it("creates, resolves, and summarizes playlists", () => {
    const library = createMusicPlaylist(
      createInitialMusicLibrary(),
      { name: "夜晚写作", description: "quiet songs" },
      "2026-06-15T00:00:00.000Z"
    );
    const playlist = library.playlists[0];

    expect(playlist.id).toBe("playlist-night-writing");
    expect(getMusicPlaylistByIdOrName(library, playlist.id)?.name).toBe("夜晚写作");
    expect(getMusicPlaylistByIdOrName(library, "夜晚写作")?.id).toBe(playlist.id);
    expect(getMusicPlaylistSummaries(library)).toEqual([
      {
        id: playlist.id,
        name: "夜晚写作",
        description: "quiet songs",
        itemCount: 0,
        updatedAt: "2026-06-15T00:00:00.000Z",
      },
    ]);
  });

  it("keeps duplicate playlist names addressable with stable ids", () => {
    const name = "\u6b4c\u5355";
    const first = createMusicPlaylist(createInitialMusicLibrary(), { name }, "2026-06-15T00:00:00.000Z");
    const second = createMusicPlaylist(first, { name }, "2026-06-15T00:01:00.000Z");
    const third = createMusicPlaylist(second, { name }, "2026-06-15T00:02:00.000Z");

    expect(third.playlists.map((playlist) => playlist.id)).toEqual(["playlist-playlist", "playlist-playlist-2", "playlist-playlist-3"]);
    expect(third.playlists.map((playlist) => playlist.name)).toEqual([name, name, name]);
  });

  it("renames and deletes playlists without touching other playlists", () => {
    const first = createMusicPlaylist(createInitialMusicLibrary(), { name: "A" }, "2026-06-15T00:00:00.000Z");
    const second = createMusicPlaylist(first, { name: "B" }, "2026-06-15T00:01:00.000Z");
    const renamed = renameMusicPlaylist(second, "playlist-a", "A2", "2026-06-15T00:02:00.000Z");
    const deleted = deleteMusicPlaylist(renamed, "playlist-b");

    expect(deleted.playlists.map((playlist) => playlist.name)).toEqual(["A2"]);
    expect(deleted.playlists[0].updatedAt).toBe("2026-06-15T00:02:00.000Z");
  });

  it("adds a music item, deduplicates by item id, and preserves first added time", () => {
    const library = createMusicPlaylist(createInitialMusicLibrary(), { name: "Queue seeds" }, "2026-06-15T00:00:00.000Z");
    const withSong = addMusicItemToPlaylist(library, "playlist-queue-seeds", makeItem("song", "Song"), "user", "2026-06-15T00:01:00.000Z");
    const updated = addMusicItemToPlaylist(withSong, "playlist-queue-seeds", { ...makeItem("song", "Song Updated"), tags: ["updated"] }, "agent", "2026-06-15T00:02:00.000Z");

    expect(updated.playlists[0].items).toHaveLength(1);
    expect(updated.playlists[0].items[0].item.title).toBe("Song Updated");
    expect(updated.playlists[0].items[0].addedAt).toBe("2026-06-15T00:01:00.000Z");
    expect(updated.playlists[0].items[0].addedBy).toBe("agent");
    expect(updated.playlists[0].updatedAt).toBe("2026-06-15T00:02:00.000Z");
  });

  it("clones returned arrays and items without mutating input state", () => {
    const item = makeItem("song", "Song");
    const library = createMusicPlaylist(createInitialMusicLibrary(), { name: "A" }, "2026-06-15T00:00:00.000Z");
    const withSong = addMusicItemToPlaylist(library, "playlist-a", item, "user", "2026-06-15T00:01:00.000Z");
    const resolved = getMusicPlaylistByIdOrName(withSong, "playlist-a");

    item.tags.push("mutated-input");

    expect(library.playlists[0].items).toEqual([]);
    expect(withSong).not.toBe(library);
    expect(withSong.playlists).not.toBe(library.playlists);
    expect(withSong.playlists[0]).not.toBe(library.playlists[0]);
    expect(withSong.playlists[0].items).not.toBe(library.playlists[0].items);
    expect(withSong.playlists[0].items[0].item).not.toBe(item);
    expect(withSong.playlists[0].items[0].item.tags).toEqual(["netease"]);

    expect(resolved).not.toBeNull();
    const resolvedPlaylist = resolved!;
    expect(resolvedPlaylist).not.toBe(withSong.playlists[0]);
    expect(resolvedPlaylist.items).not.toBe(withSong.playlists[0].items);
    expect(resolvedPlaylist.items[0]).not.toBe(withSong.playlists[0].items[0]);
    expect(resolvedPlaylist.items[0].item).not.toBe(withSong.playlists[0].items[0].item);

    resolvedPlaylist.items[0].item.tags.push("mutated-resolved");

    expect(withSong.playlists[0].items[0].item.tags).toEqual(["netease"]);
  });

  it("removes one item from a playlist", () => {
    const library = createMusicPlaylist(createInitialMusicLibrary(), { name: "A" }, "2026-06-15T00:00:00.000Z");
    const withA = addMusicItemToPlaylist(library, "playlist-a", makeItem("a", "A"), "user", "2026-06-15T00:01:00.000Z");
    const withB = addMusicItemToPlaylist(withA, "playlist-a", makeItem("b", "B"), "user", "2026-06-15T00:02:00.000Z");
    const removed = removeMusicItemFromPlaylist(withB, "playlist-a", "a", "2026-06-15T00:03:00.000Z");

    expect(removed.playlists[0].items.map((entry) => entry.id)).toEqual(["b"]);
    expect(removed.playlists[0].updatedAt).toBe("2026-06-15T00:03:00.000Z");
  });

  it("validates stored library shape", () => {
    const library = createMusicPlaylist(createInitialMusicLibrary(), { name: "A" }, "2026-06-15T00:00:00.000Z");

    expect(isMusicLibraryState(library)).toBe(true);
    expect(isMusicLibraryState({ playlists: [{ id: "bad", name: "Bad", items: [{}] }] })).toBe(false);
  });

  it("rejects stored music items with invalid hydration fields", () => {
    const nonArrayTags = { ...makeItem("a", "A"), tags: "netease" };
    const missingCanOpenVideo: Record<string, unknown> = { ...makeItem("b", "B") };
    delete missingCanOpenVideo.canOpenVideo;

    expect(isMusicLibraryState(makeStoredLibrary(nonArrayTags))).toBe(false);
    expect(isMusicLibraryState(makeStoredLibrary(missingCanOpenVideo))).toBe(false);
  });
});

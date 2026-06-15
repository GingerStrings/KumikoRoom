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

describe("musicLibrary", () => {
  it("creates an empty library", () => {
    expect(createInitialMusicLibrary()).toEqual({ playlists: [] });
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
    const first = createMusicPlaylist(createInitialMusicLibrary(), { name: "歌单" }, "2026-06-15T00:00:00.000Z");
    const second = createMusicPlaylist(first, { name: "歌单" }, "2026-06-15T00:01:00.000Z");

    expect(second.playlists.map((playlist) => playlist.id)).toEqual(["playlist-playlist", "playlist-playlist-2"]);
    expect(second.playlists.map((playlist) => playlist.name)).toEqual(["歌单", "歌单"]);
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
});

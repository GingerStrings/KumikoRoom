import type { MusicItem } from "../src/lib/musicItems";
import { buildMusicAgentState } from "../src/lib/musicAgentState";
import type { MusicQueueState } from "../src/lib/musicQueue";

function makeItem(
  id: string,
  title: string,
  options: Partial<
    Pick<MusicItem, "source" | "durationMs" | "pageUrl" | "platformAudioUrl" | "tags" | "canOpenVideo">
  > = {}
): MusicItem {
  const source = options.source ?? "netease";
  return {
    id,
    source,
    title,
    creator: `${title} creator`,
    durationMs: options.durationMs ?? 180000,
    pageUrl: options.pageUrl,
    platformAudioUrl:
      options.platformAudioUrl ?? (source === "netease" ? `https://example.test/${id}.mp3` : undefined),
    tags: options.tags ?? [source],
    canOpenVideo: options.canOpenVideo ?? source === "bilibili",
  };
}

describe("buildMusicAgentState", () => {
  it("builds the authoritative current, previous, upcoming, recent, and saved snapshot", () => {
    const queue: MusicQueueState = {
      currentId: "current",
      recentLimit: 30,
      entries: [
        {
          id: "current",
          item: makeItem("current", "Current", { pageUrl: undefined }),
          status: "current",
          addedBy: "user",
          addedAt: "2026-06-14T00:00:00.000Z",
          lastPlayedAt: "2026-06-14T00:04:00.000Z",
          playCount: 1,
        },
        {
          id: "recent",
          item: makeItem("recent", "Recent"),
          status: "played",
          addedBy: "user",
          addedAt: "2026-06-14T00:00:00.000Z",
          lastPlayedAt: "2026-06-14T00:03:00.000Z",
          playCount: 1,
        },
        {
          id: "next",
          item: makeItem("next", "Next"),
          status: "queued",
          addedBy: "agent",
          addedAt: "2026-06-14T00:01:00.000Z",
          playCount: 0,
        },
        {
          id: "later",
          item: makeItem("later", "Later", { source: "bilibili", canOpenVideo: true }),
          status: "queued",
          addedBy: "agent",
          addedAt: "2026-06-14T00:02:00.000Z",
          playCount: 0,
        },
        {
          id: "saved",
          item: makeItem("saved", "Saved"),
          status: "played",
          addedBy: "user",
          addedAt: "2026-06-14T00:00:00.000Z",
          lastPlayedAt: "2026-06-14T00:02:00.000Z",
          playCount: 1,
          saved: true,
        },
      ],
    };

    const snapshot = buildMusicAgentState(queue, {
      isPlaying: false,
      currentTimeMs: 42000,
      durationMs: 180000,
    });

    expect(snapshot.current).toEqual({
      id: "current",
      source: "netease",
      title: "Current",
      creator: "Current creator",
      durationMs: 180000,
      pageUrl: null,
      platformAudioUrl: "https://example.test/current.mp3",
      tags: ["netease"],
      canOpenVideo: false,
      saved: false,
    });
    expect(snapshot.previous?.id).toBe("recent");
    expect(snapshot.next?.id).toBe("next");
    expect(snapshot.upcoming.map((item) => item.id)).toEqual(["next", "later"]);
    expect(snapshot.recent.map((item) => item.id)).toEqual(["recent", "saved"]);
    expect(snapshot.saved.map((item) => item.id)).toEqual(["saved"]);
    expect(snapshot.isPlaying).toBe(false);
    expect(snapshot.currentTimeMs).toBe(42000);
    expect(snapshot.durationMs).toBe(180000);
  });

  it("isolates queue item tags from snapshot mutations", () => {
    const queue: MusicQueueState = {
      currentId: "current",
      recentLimit: 30,
      entries: [
        {
          id: "current",
          item: makeItem("current", "Current", { tags: ["netease", "focus"] }),
          status: "current",
          addedBy: "user",
          addedAt: "2026-06-14T00:00:00.000Z",
          playCount: 1,
        },
      ],
    };

    const snapshot = buildMusicAgentState(queue, {
      isPlaying: true,
      currentTimeMs: 0,
      durationMs: 180000,
    });
    snapshot.current!.tags.push("mutated");

    expect(queue.entries[0].item.tags).toEqual(["netease", "focus"]);
  });

  it("returns empty tracks and zero progress when there is no current item", () => {
    const snapshot = buildMusicAgentState(
      {
        currentId: null,
        recentLimit: 30,
        entries: [],
      },
      {
        isPlaying: true,
        currentTimeMs: 42000,
        durationMs: 180000,
      }
    );

    expect(snapshot).toEqual({
      isPlaying: false,
      currentTimeMs: 0,
      durationMs: 0,
      current: null,
      previous: null,
      next: null,
      upcoming: [],
      recent: [],
      saved: [],
    });
  });
});

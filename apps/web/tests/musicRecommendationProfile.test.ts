import type {
  AutoDjRecommendation,
  MusicRecommendationProfile,
  RecommendationProfilePatch,
} from "../src/api/types";
import {
  applyRecommendationProfilePatch,
  createInitialMusicRecommendationProfile,
  dislikeRecommendedItem,
  isMusicRecommendationProfile,
  markRecommendedItemAccepted,
  markRecommendedItemSkipped,
} from "../src/lib/musicRecommendationProfile";

const NOW = "2026-06-18T00:00:00.000Z";
const LATER = "2026-06-18T00:05:00.000Z";

function makeProfile(overrides: Partial<MusicRecommendationProfile> = {}): MusicRecommendationProfile {
  return {
    version: 1,
    updatedAt: NOW,
    artistWeights: {},
    tagWeights: {},
    sourceWeights: {},
    queryWeights: {},
    recentThemes: [],
    cooldowns: [],
    recommendedItems: [],
    refillHistory: [],
    ...overrides,
  };
}

function makeRecommendation(overrides: Partial<AutoDjRecommendation> = {}): AutoDjRecommendation {
  return {
    item: {
      id: "track-1",
      source: "netease",
      title: "Moonlit Room",
      creator: "Kumiko Ensemble",
      durationMs: 180000,
      pageUrl: "https://example.test/track-1",
      platformAudioUrl: "https://example.test/track-1.mp3",
      tags: ["Night Jazz", "Quiet"],
      canOpenVideo: false,
    },
    score: 10,
    intent: "similar_mood",
    reason: "Matches the current quiet mood.",
    evidence: ["tag:Night Jazz"],
    ...overrides,
  };
}

function makePatch(overrides: Partial<RecommendationProfilePatch> = {}): RecommendationProfilePatch {
  return {
    recommendedItems: [],
    cooldowns: [],
    refillHistory: [],
    ...overrides,
  };
}

function minutesAfterJune17(minutes: number): string {
  return new Date(Date.UTC(2026, 5, 17, 0, minutes, 0)).toISOString();
}

describe("musicRecommendationProfile", () => {
  it("creates a version 1 profile with updatedAt and empty maps/lists", () => {
    expect(createInitialMusicRecommendationProfile(NOW)).toEqual({
      version: 1,
      updatedAt: NOW,
      artistWeights: {},
      tagWeights: {},
      sourceWeights: {},
      queryWeights: {},
      recentThemes: [],
      cooldowns: [],
      recommendedItems: [],
      refillHistory: [],
    });
  });

  it("validates a real profile and rejects invalid profile shapes", () => {
    const profile = makeProfile({
      artistWeights: { "kumiko ensemble": 1 },
      tagWeights: { quiet: 0.5 },
      sourceWeights: { netease: 0.25 },
      queryWeights: { "quiet piano": 0.1 },
      recentThemes: [{ key: "quiet", weight: 0.75, lastSeenAt: NOW }],
      cooldowns: [{
        kind: "artist",
        key: "kumiko ensemble",
        weight: 1,
        expiresAt: "2026-06-19T00:00:00.000Z",
        reason: "dislike",
      }],
      recommendedItems: [{
        itemId: "track-1",
        title: "Moonlit Room",
        creator: "Kumiko Ensemble",
        source: "netease",
        recommendedAt: NOW,
        played: false,
        disliked: false,
        reason: "Matches the current quiet mood.",
      }],
      refillHistory: [{
        refillId: "refill-1",
        createdAt: NOW,
        selectedItemIds: ["track-1"],
        dominantThemes: ["quiet"],
        explorationCount: 1,
      }],
    });

    expect(isMusicRecommendationProfile(profile)).toBe(true);
    expect(isMusicRecommendationProfile({ version: 2 })).toBe(false);
    expect(isMusicRecommendationProfile({ ...profile, cooldowns: "bad" })).toBe(false);
  });

  it("merges backend patches without duplicate history or refill entries, caps history, and updates updatedAt", () => {
    const existingRecommendedItems = Array.from({ length: 79 }, (_, index) => ({
      itemId: `old-${index}`,
      title: `Old ${index}`,
      creator: "Archive",
      source: "netease" as const,
      recommendedAt: minutesAfterJune17(index),
      played: false,
      disliked: false,
      reason: "older",
    }));
    const existingRefills = Array.from({ length: 19 }, (_, index) => ({
      refillId: `old-refill-${index}`,
      createdAt: minutesAfterJune17(index),
      selectedItemIds: [`old-${index}`],
      dominantThemes: ["archive"],
      explorationCount: 0,
    }));
    const profile = makeProfile({
      cooldowns: [{
        kind: "artist",
        key: "kumiko ensemble",
        weight: 0.5,
        expiresAt: "2026-06-20T00:00:00.000Z",
        reason: "recently_recommended",
      }],
      recommendedItems: [
        ...existingRecommendedItems,
        {
          itemId: "track-1",
          title: "Moonlit Room",
          creator: "Kumiko Ensemble",
          source: "netease",
          recommendedAt: "2026-06-17T23:59:00.000Z",
          played: false,
          disliked: false,
          reason: "old reason",
        },
      ],
      refillHistory: [
        ...existingRefills,
        {
          refillId: "refill-1",
          createdAt: "2026-06-17T23:59:00.000Z",
          selectedItemIds: ["track-1"],
          dominantThemes: ["quiet"],
          explorationCount: 1,
        },
      ],
    });
    const patch = makePatch({
      cooldowns: [
        {
          kind: "artist",
          key: "KUMIKO ENSEMBLE",
          weight: 0.9,
          expiresAt: "2026-06-21T00:00:00.000Z",
          reason: "recently_recommended",
        },
        {
          kind: "item",
          key: "track-2",
          weight: 1,
          expiresAt: "2026-06-19T00:00:00.000Z",
          reason: "recently_recommended",
        },
      ],
      recommendedItems: [
        {
          itemId: "track-1",
          title: "Moonlit Room",
          creator: "Kumiko Ensemble",
          source: "netease",
          recommendedAt: LATER,
          played: false,
          disliked: false,
          reason: "new reason",
        },
        {
          itemId: "track-2",
          title: "Rain Study",
          creator: "Other Artist",
          source: "bilibili",
          recommendedAt: LATER,
          played: false,
          disliked: false,
          reason: "new item",
        },
      ],
      refillHistory: [
        {
          refillId: "refill-1",
          createdAt: LATER,
          selectedItemIds: ["track-1", "track-2"],
          dominantThemes: ["quiet"],
          explorationCount: 2,
        },
        {
          refillId: "refill-2",
          createdAt: LATER,
          selectedItemIds: ["track-2"],
          dominantThemes: ["rain"],
          explorationCount: 1,
        },
      ],
    });

    const result = applyRecommendationProfilePatch(profile, patch, LATER);

    expect(result).not.toBe(profile);
    expect(result.updatedAt).toBe(LATER);
    expect(result.recommendedItems).toHaveLength(80);
    expect(result.recommendedItems.filter((entry) => entry.itemId === "track-1")).toHaveLength(1);
    expect(result.recommendedItems[0]).toMatchObject({ itemId: "track-1", reason: "new reason" });
    expect(result.recommendedItems.map((entry) => entry.itemId)).toContain("track-2");
    expect(result.recommendedItems.map((entry) => entry.itemId)).not.toContain("old-0");
    expect(result.refillHistory).toHaveLength(20);
    expect(result.refillHistory.filter((entry) => entry.refillId === "refill-1")).toHaveLength(1);
    expect(result.refillHistory[0]).toMatchObject({ refillId: "refill-1", explorationCount: 2 });
    expect(result.cooldowns.filter((cooldown) => cooldown.kind === "artist" && cooldown.key === "kumiko ensemble")).toHaveLength(1);
    expect(result.cooldowns.find((cooldown) => cooldown.kind === "artist" && cooldown.key === "kumiko ensemble"))
      .toMatchObject({ weight: 0.9, expiresAt: "2026-06-21T00:00:00.000Z" });
    expect(profile.recommendedItems).toHaveLength(80);
    expect(profile.refillHistory).toHaveLength(20);
  });

  it("bumps artist, tag, and source weights, marks history played, and updates updatedAt when accepted", () => {
    const profile = makeProfile({
      artistWeights: { "kumiko ensemble": 0.2 },
      tagWeights: { quiet: 0.1 },
      sourceWeights: { netease: 0.25 },
      recommendedItems: [{
        itemId: "track-1",
        title: "Moonlit Room",
        creator: "Kumiko Ensemble",
        source: "netease",
        recommendedAt: NOW,
        played: false,
        disliked: false,
        reason: "Matches the current quiet mood.",
      }],
    });

    const result = markRecommendedItemAccepted(profile, makeRecommendation(), LATER);

    expect(result.updatedAt).toBe(LATER);
    expect(result.artistWeights["kumiko ensemble"]).toBeGreaterThan(profile.artistWeights["kumiko ensemble"]);
    expect(result.tagWeights["night jazz"]).toBeGreaterThan(0);
    expect(result.tagWeights.quiet).toBeGreaterThan(profile.tagWeights.quiet);
    expect(result.sourceWeights.netease).toBeGreaterThan(profile.sourceWeights.netease!);
    expect(result.recommendedItems[0]).toMatchObject({ itemId: "track-1", played: true, disliked: false });
    expect(profile.recommendedItems[0].played).toBe(false);
  });

  it("lightly downweights artist and tags and updates updatedAt when skipped", () => {
    const profile = makeProfile({
      artistWeights: { "kumiko ensemble": 1 },
      tagWeights: { "night jazz": 1, quiet: 1 },
    });

    const result = markRecommendedItemSkipped(profile, makeRecommendation(), LATER);

    expect(result.updatedAt).toBe(LATER);
    expect(result.artistWeights["kumiko ensemble"]).toBeLessThan(profile.artistWeights["kumiko ensemble"]);
    expect(result.tagWeights["night jazz"]).toBeLessThan(profile.tagWeights["night jazz"]);
    expect(result.tagWeights.quiet).toBeLessThan(profile.tagWeights.quiet);
    expect(result.artistWeights["kumiko ensemble"]).toBeGreaterThan(0);
  });

  it("downweights recommendation signals, creates cooldowns, marks history disliked, and updates updatedAt when disliked", () => {
    const profile = makeProfile({
      artistWeights: { "kumiko ensemble": 1 },
      tagWeights: { "night jazz": 1, quiet: 1 },
      recommendedItems: [{
        itemId: "track-1",
        title: "Moonlit Room",
        creator: "Kumiko Ensemble",
        source: "netease",
        recommendedAt: NOW,
        played: false,
        disliked: false,
        reason: "Matches the current quiet mood.",
      }],
    });

    const result = dislikeRecommendedItem(profile, makeRecommendation(), LATER);

    expect(result.updatedAt).toBe(LATER);
    expect(result.artistWeights["kumiko ensemble"]).toBeLessThan(profile.artistWeights["kumiko ensemble"]);
    expect(result.tagWeights["night jazz"]).toBeLessThan(profile.tagWeights["night jazz"]);
    expect(result.tagWeights.quiet).toBeLessThan(profile.tagWeights.quiet);
    expect(result.recommendedItems[0]).toMatchObject({ itemId: "track-1", played: false, disliked: true });
    expect(result.cooldowns).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: "item", key: "track-1", reason: "dislike" }),
      expect.objectContaining({ kind: "artist", key: "kumiko ensemble", reason: "dislike" }),
      expect.objectContaining({ kind: "tag", key: "night jazz", reason: "dislike" }),
      expect.objectContaining({ kind: "tag", key: "quiet", reason: "dislike" }),
    ]));
    expect(result.cooldowns.every((cooldown) => cooldown.expiresAt > LATER)).toBe(true);
    expect(profile.cooldowns).toEqual([]);
    expect(profile.recommendedItems[0].disliked).toBe(false);
  });
});

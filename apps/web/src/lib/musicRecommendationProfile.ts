import type {
  AutoDjRecommendation,
  MusicRecommendationProfile,
  RecommendationCooldown,
  RecommendationHistoryEntry,
  RecommendationProfilePatch,
  RecommendationRefillHistoryEntry,
  RecommendationThemeSignal,
} from "../api/types";

type UnknownRecord = Record<string, unknown>;

const RECOMMENDED_HISTORY_LIMIT = 80;
const REFILL_HISTORY_LIMIT = 20;
const ACCEPT_ARTIST_DELTA = 1;
const ACCEPT_TAG_DELTA = 0.75;
const ACCEPT_SOURCE_DELTA = 0.5;
const ACCEPT_QUERY_DELTA = 0.5;
const SKIP_ARTIST_DELTA = -0.15;
const SKIP_TAG_DELTA = -0.1;
const SKIP_SOURCE_DELTA = -0.1;
const SKIP_QUERY_DELTA = -0.1;
const DISLIKE_ARTIST_DELTA = -1;
const DISLIKE_TAG_DELTA = -0.75;
const DISLIKE_SOURCE_DELTA = -0.5;
const DISLIKE_QUERY_DELTA = -0.75;
const MIN_WEIGHT = -5;
const MAX_WEIGHT = 5;
const DISLIKE_COOLDOWN_HOURS = 12;

export function createInitialMusicRecommendationProfile(
  now = currentIsoTime()
): MusicRecommendationProfile {
  return {
    version: 1,
    updatedAt: now,
    artistWeights: {},
    tagWeights: {},
    sourceWeights: {},
    queryWeights: {},
    recentThemes: [],
    cooldowns: [],
    recommendedItems: [],
    refillHistory: [],
  };
}

export function isMusicRecommendationProfile(value: unknown): value is MusicRecommendationProfile {
  if (!isRecord(value)) {
    return false;
  }

  return (
    value.version === 1 &&
    isIsoDateString(value.updatedAt) &&
    isWeightRecord(value.artistWeights) &&
    isWeightRecord(value.tagWeights) &&
    isSourceWeights(value.sourceWeights) &&
    isWeightRecord(value.queryWeights) &&
    Array.isArray(value.recentThemes) &&
    value.recentThemes.every(isRecommendationThemeSignal) &&
    Array.isArray(value.cooldowns) &&
    value.cooldowns.every(isRecommendationCooldown) &&
    Array.isArray(value.recommendedItems) &&
    value.recommendedItems.every(isRecommendationHistoryEntry) &&
    Array.isArray(value.refillHistory) &&
    value.refillHistory.every(isRecommendationRefillHistoryEntry)
  );
}

export function applyRecommendationProfilePatch(
  profile: MusicRecommendationProfile,
  patch: RecommendationProfilePatch,
  now = currentIsoTime()
): MusicRecommendationProfile {
  return {
    ...cloneMusicRecommendationProfile(profile),
    updatedAt: now,
    cooldowns: mergeCooldowns(profile.cooldowns, patch.cooldowns),
    recommendedItems: capRecommendedHistory(
      mergeById(
        profile.recommendedItems,
        patch.recommendedItems,
        (entry) => entry.itemId,
        cloneRecommendationHistoryEntry
      ),
      RECOMMENDED_HISTORY_LIMIT
    ),
    refillHistory: capRefillHistory(
      mergeById(
        profile.refillHistory,
        patch.refillHistory,
        (entry) => entry.refillId,
        cloneRecommendationRefillHistoryEntry
      ),
      REFILL_HISTORY_LIMIT
    ),
  };
}

export function markRecommendedItemAccepted(
  profile: MusicRecommendationProfile,
  recommendation: AutoDjRecommendation,
  now = currentIsoTime()
): MusicRecommendationProfile {
  const item = recommendation.item;
  const artistKey = normalizeSignalKey(item.creator);
  const tagKeys = getNormalizedTagKeys(item.tags);
  const queryKey = normalizeOptionalSignalKey(item.sourceQuery);

  return {
    ...cloneMusicRecommendationProfile(profile),
    updatedAt: now,
    artistWeights: adjustSignalWeights(profile.artistWeights, artistKey ? [artistKey] : [], ACCEPT_ARTIST_DELTA),
    tagWeights: adjustSignalWeights(profile.tagWeights, tagKeys, ACCEPT_TAG_DELTA),
    sourceWeights: adjustSourceWeight(profile.sourceWeights, item.source, ACCEPT_SOURCE_DELTA),
    queryWeights: adjustSignalWeights(profile.queryWeights, queryKey ? [queryKey] : [], ACCEPT_QUERY_DELTA),
    recommendedItems: profile.recommendedItems.map((entry) =>
      entry.itemId === item.id
        ? {
            ...cloneRecommendationHistoryEntry(entry),
            played: true,
            disliked: false,
          }
        : cloneRecommendationHistoryEntry(entry)
    ),
  };
}

export function markRecommendedItemSkipped(
  profile: MusicRecommendationProfile,
  recommendation: AutoDjRecommendation,
  now = currentIsoTime()
): MusicRecommendationProfile {
  const item = recommendation.item;
  const artistKey = normalizeSignalKey(item.creator);
  const tagKeys = getNormalizedTagKeys(item.tags);
  const queryKey = normalizeOptionalSignalKey(item.sourceQuery);

  return {
    ...cloneMusicRecommendationProfile(profile),
    updatedAt: now,
    artistWeights: adjustSignalWeights(profile.artistWeights, artistKey ? [artistKey] : [], SKIP_ARTIST_DELTA),
    tagWeights: adjustSignalWeights(profile.tagWeights, tagKeys, SKIP_TAG_DELTA),
    sourceWeights: adjustSourceWeight(profile.sourceWeights, item.source, SKIP_SOURCE_DELTA),
    queryWeights: adjustSignalWeights(profile.queryWeights, queryKey ? [queryKey] : [], SKIP_QUERY_DELTA),
  };
}

export function dislikeRecommendedItem(
  profile: MusicRecommendationProfile,
  recommendation: AutoDjRecommendation,
  now = currentIsoTime()
): MusicRecommendationProfile {
  const item = recommendation.item;
  const artistKey = normalizeSignalKey(item.creator);
  const tagKeys = getNormalizedTagKeys(item.tags);
  const queryKey = normalizeOptionalSignalKey(item.sourceQuery);
  const dislikeCooldowns = createDislikeCooldowns(item.id, artistKey, tagKeys, queryKey, now);

  return {
    ...cloneMusicRecommendationProfile(profile),
    updatedAt: now,
    artistWeights: adjustSignalWeights(profile.artistWeights, artistKey ? [artistKey] : [], DISLIKE_ARTIST_DELTA),
    tagWeights: adjustSignalWeights(profile.tagWeights, tagKeys, DISLIKE_TAG_DELTA),
    sourceWeights: adjustSourceWeight(profile.sourceWeights, item.source, DISLIKE_SOURCE_DELTA),
    queryWeights: adjustSignalWeights(profile.queryWeights, queryKey ? [queryKey] : [], DISLIKE_QUERY_DELTA),
    cooldowns: mergeCooldowns(profile.cooldowns, dislikeCooldowns),
    recommendedItems: profile.recommendedItems.map((entry) =>
      entry.itemId === item.id
        ? {
            ...cloneRecommendationHistoryEntry(entry),
            disliked: true,
          }
        : cloneRecommendationHistoryEntry(entry)
    ),
  };
}

function cloneMusicRecommendationProfile(profile: MusicRecommendationProfile): MusicRecommendationProfile {
  return {
    version: 1,
    updatedAt: profile.updatedAt,
    artistWeights: cloneNumberRecord(profile.artistWeights, normalizeSignalKey),
    tagWeights: cloneNumberRecord(profile.tagWeights, normalizeSignalKey),
    sourceWeights: { ...profile.sourceWeights },
    queryWeights: { ...profile.queryWeights },
    recentThemes: profile.recentThemes.map(cloneRecommendationThemeSignal),
    cooldowns: profile.cooldowns.map(cloneRecommendationCooldown),
    recommendedItems: profile.recommendedItems.map(cloneRecommendationHistoryEntry),
    refillHistory: profile.refillHistory.map(cloneRecommendationRefillHistoryEntry),
  };
}

function cloneRecommendationThemeSignal(signal: RecommendationThemeSignal): RecommendationThemeSignal {
  return {
    key: signal.key,
    weight: signal.weight,
    lastSeenAt: signal.lastSeenAt,
  };
}

function cloneRecommendationCooldown(cooldown: RecommendationCooldown): RecommendationCooldown {
  return {
    key: normalizeCooldownKey(cooldown),
    kind: cooldown.kind,
    weight: cooldown.weight,
    expiresAt: cooldown.expiresAt,
    reason: cooldown.reason,
  };
}

function cloneRecommendationHistoryEntry(entry: RecommendationHistoryEntry): RecommendationHistoryEntry {
  return {
    itemId: entry.itemId,
    title: entry.title,
    creator: entry.creator,
    source: entry.source,
    recommendedAt: entry.recommendedAt,
    played: entry.played,
    disliked: entry.disliked,
    reason: entry.reason,
  };
}

function cloneRecommendationRefillHistoryEntry(
  entry: RecommendationRefillHistoryEntry
): RecommendationRefillHistoryEntry {
  return {
    refillId: entry.refillId,
    createdAt: entry.createdAt,
    selectedItemIds: [...entry.selectedItemIds],
    dominantThemes: [...entry.dominantThemes],
    explorationCount: entry.explorationCount,
  };
}

function cloneNumberRecord(
  record: Record<string, number>,
  normalizeKey: (key: string) => string = (key) => key
): Record<string, number> {
  return Object.fromEntries(
    Object.entries(record)
      .map(([key, value]) => [normalizeKey(key), value] as const)
      .filter(([key]) => key.length > 0)
  );
}

function adjustSignalWeights(
  weights: Record<string, number>,
  keys: string[],
  delta: number
): Record<string, number> {
  const next = cloneNumberRecord(weights, normalizeSignalKey);

  for (const key of keys) {
    next[key] = clampWeight((next[key] ?? 0) + delta);
  }

  return next;
}

function adjustSourceWeight(
  weights: MusicRecommendationProfile["sourceWeights"],
  source: AutoDjRecommendation["item"]["source"],
  delta: number
): MusicRecommendationProfile["sourceWeights"] {
  return {
    ...weights,
    [source]: clampWeight((weights[source] ?? 0) + delta),
  };
}

function mergeCooldowns(
  current: RecommendationCooldown[],
  incoming: RecommendationCooldown[]
): RecommendationCooldown[] {
  const merged = new Map<string, RecommendationCooldown>();

  for (const cooldown of [...current, ...incoming]) {
    const cloned = cloneRecommendationCooldown(cooldown);
    merged.set(getCooldownMergeKey(cloned), cloned);
  }

  return [...merged.values()];
}

function mergeById<T>(
  current: T[],
  incoming: T[],
  getId: (entry: T) => string,
  clone: (entry: T) => T
): T[] {
  const merged = new Map<string, { entry: T; sequence: number }>();
  let sequence = 0;

  for (const entry of [...current, ...incoming]) {
    merged.set(getId(entry), {
      entry: clone(entry),
      sequence,
    });
    sequence += 1;
  }

  return [...merged.values()]
    .sort((left, right) => left.sequence - right.sequence)
    .map(({ entry }) => entry);
}

function capRecommendedHistory(
  entries: RecommendationHistoryEntry[],
  limit: number
): RecommendationHistoryEntry[] {
  return entries
    .map((entry, index) => ({ entry, index }))
    .sort((left, right) => compareIsoDescending(left.entry.recommendedAt, right.entry.recommendedAt) || left.index - right.index)
    .slice(0, limit)
    .map(({ entry }) => entry);
}

function capRefillHistory(
  entries: RecommendationRefillHistoryEntry[],
  limit: number
): RecommendationRefillHistoryEntry[] {
  if (limit <= 0) {
    return [];
  }

  return entries
    .map((entry, index) => ({ entry, index }))
    .sort((left, right) => left.entry.createdAt.localeCompare(right.entry.createdAt) || left.index - right.index)
    .slice(-limit)
    .map(({ entry }) => entry);
}

function createDislikeCooldowns(
  itemId: string,
  artistKey: string,
  tagKeys: string[],
  queryKey: string,
  now: string
): RecommendationCooldown[] {
  const expiresAt = addHoursIso(now, DISLIKE_COOLDOWN_HOURS);
  const cooldowns: RecommendationCooldown[] = [
    {
      kind: "item",
      key: itemId,
      weight: 1,
      expiresAt,
      reason: "dislike",
    },
  ];

  if (artistKey) {
    cooldowns.push({
      kind: "artist",
      key: artistKey,
      weight: 1,
      expiresAt,
      reason: "dislike",
    });
  }

  for (const key of tagKeys) {
    cooldowns.push({
      kind: "tag",
      key,
      weight: 1,
      expiresAt,
      reason: "dislike",
    });
  }

  if (queryKey) {
    cooldowns.push({
      kind: "query",
      key: queryKey,
      weight: 1,
      expiresAt,
      reason: "dislike",
    });
  }

  return cooldowns;
}

function normalizeCooldownKey(cooldown: RecommendationCooldown): string {
  if (cooldown.kind === "artist" || cooldown.kind === "tag") {
    return normalizeSignalKey(cooldown.key);
  }

  return cooldown.key;
}

function getCooldownMergeKey(cooldown: RecommendationCooldown): string {
  return `${cooldown.kind}:${normalizeCooldownKey(cooldown)}`;
}

function getNormalizedTagKeys(tags: string[]): string[] {
  return [...new Set(tags.map(normalizeSignalKey).filter((tag) => tag.length > 0))];
}

function normalizeSignalKey(key: string): string {
  return key.trim().toLowerCase();
}

function normalizeOptionalSignalKey(key: string | null | undefined): string {
  return typeof key === "string" ? normalizeSignalKey(key) : "";
}

function clampWeight(value: number): number {
  return Math.max(MIN_WEIGHT, Math.min(MAX_WEIGHT, value));
}

function compareIsoDescending(left: string, right: string): number {
  return right.localeCompare(left);
}

function addHoursIso(now: string, hours: number): string {
  const date = new Date(now);
  date.setUTCHours(date.getUTCHours() + hours);
  return date.toISOString();
}

function isRecommendationThemeSignal(value: unknown): value is RecommendationThemeSignal {
  if (!isRecord(value)) {
    return false;
  }

  return (
    isNonEmptyString(value.key) &&
    isBoundedWeight(value.weight) &&
    isIsoDateString(value.lastSeenAt)
  );
}

function isRecommendationCooldown(value: unknown): value is RecommendationCooldown {
  if (!isRecord(value)) {
    return false;
  }

  return (
    isNonEmptyString(value.key) &&
    isCooldownKind(value.kind) &&
    isCooldownWeight(value.weight) &&
    isIsoDateString(value.expiresAt) &&
    isCooldownReason(value.reason)
  );
}

function isRecommendationHistoryEntry(value: unknown): value is RecommendationHistoryEntry {
  if (!isRecord(value)) {
    return false;
  }

  return (
    isNonEmptyString(value.itemId) &&
    isNonEmptyString(value.title) &&
    isNonEmptyString(value.creator) &&
    isMusicSource(value.source) &&
    isIsoDateString(value.recommendedAt) &&
    typeof value.played === "boolean" &&
    typeof value.disliked === "boolean" &&
    isNonEmptyString(value.reason)
  );
}

function isRecommendationRefillHistoryEntry(value: unknown): value is RecommendationRefillHistoryEntry {
  if (!isRecord(value)) {
    return false;
  }

  return (
    isNonEmptyString(value.refillId) &&
    isIsoDateString(value.createdAt) &&
    Array.isArray(value.selectedItemIds) &&
    value.selectedItemIds.every(isNonEmptyString) &&
    Array.isArray(value.dominantThemes) &&
    value.dominantThemes.every(isNonEmptyString) &&
    isNonNegativeInteger(value.explorationCount)
  );
}

function isWeightRecord(value: unknown): value is Record<string, number> {
  return (
    isRecord(value) &&
    !Array.isArray(value) &&
    Object.entries(value).every(([key, weight]) => normalizeSignalKey(key).length > 0 && isBoundedWeight(weight))
  );
}

function isSourceWeights(value: unknown): value is MusicRecommendationProfile["sourceWeights"] {
  return (
    isRecord(value) &&
    !Array.isArray(value) &&
    Object.entries(value).every(([key, weight]) =>
      (key === "bilibili" || key === "netease") && isBoundedWeight(weight)
    )
  );
}

function isCooldownKind(value: unknown): value is RecommendationCooldown["kind"] {
  return value === "item" || value === "artist" || value === "tag" || value === "query";
}

function isCooldownReason(value: unknown): value is RecommendationCooldown["reason"] {
  return value === "dislike" || value === "recently_played" || value === "recently_recommended";
}

function isMusicSource(value: unknown): value is AutoDjRecommendation["item"]["source"] {
  return value === "bilibili" || value === "netease";
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function isBoundedWeight(value: unknown): value is number {
  return isFiniteNumber(value) && value >= MIN_WEIGHT && value <= MAX_WEIGHT;
}

function isCooldownWeight(value: unknown): value is number {
  return isFiniteNumber(value) && value >= 0;
}

function isNonNegativeInteger(value: unknown): value is number {
  return Number.isInteger(value) && (value as number) >= 0;
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function isIsoDateString(value: unknown): value is string {
  if (typeof value !== "string") {
    return false;
  }
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) && value.includes("T");
}

function isRecord(value: unknown): value is UnknownRecord {
  return typeof value === "object" && value !== null;
}

function currentIsoTime(): string {
  return new Date().toISOString();
}

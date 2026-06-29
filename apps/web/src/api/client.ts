import type {
  AutoDjRecommendRequest,
  AutoDjRecommendation,
  AutoDjRecommendResponse,
  AutoDjTrace,
  AutoDjTraceCandidate,
  AutoDjTraceQuery,
  ChatRequest,
  ChatResponse,
  ChatSession,
  ClientMusicItem,
  LLMConfig,
  LLMTestResult,
  MusicAgentState,
  MemoryEvent,
  MusicSearchResult,
  RecommendationCooldown,
  RecommendationHistoryEntry,
  RecommendationProfilePatch,
  RecommendationRefillHistoryEntry,
  RecommendationThemeSignal,
  RoomClientAction,
  RoomState,
  StoredChatMessage
} from "./types";

const LOCAL_API_BASE_URL = "http://127.0.0.1:8000";

export class ApiError extends Error {
  constructor(
    message: string,
    public readonly status: number,
    public readonly body: unknown
  ) {
    super(message);
    this.name = "ApiError";
  }
}

export async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
  const headers = new Headers(init.headers);
  if (init.body !== undefined && !headers.has("Content-Type")) {
    headers.set("Content-Type", "application/json");
  }

  const response = await fetch(resolveApiRequestUrl(path), {
    ...init,
    headers
  });
  const body = await parseResponseBody(response);

  if (!response.ok) {
    throw new ApiError(getErrorMessage(body, response.statusText), response.status, body);
  }

  return body as T;
}

export function resolveApiRequestUrl(path: string): string {
  return `${resolveApiBaseUrl()}${path}`;
}

function resolveApiBaseUrl(): string {
  const configuredBaseUrl = process.env.NEXT_PUBLIC_KUMIKOROOM_API_BASE_URL;
  if (configuredBaseUrl !== undefined) {
    return configuredBaseUrl;
  }

  if (process.env.NODE_ENV === "test") {
    return "";
  }

  const location = globalThis.location;
  if (!location) {
    return "";
  }

  const isLocalWebHost =
    (location.hostname === "127.0.0.1" || location.hostname === "localhost") &&
    (location.port === "3000" || location.port === "3001");
  return isLocalWebHost ? LOCAL_API_BASE_URL : "";
}

export function getRoomState(): Promise<RoomState> {
  return request<RoomStateApi>("/api/room/state").then(mapRoomState);
}

export function getSessions(): Promise<ChatSession[]> {
  return request<ChatSessionApi[]>("/api/room/sessions").then((items) =>
    items.map(mapChatSession)
  );
}

export function createSession(): Promise<ChatSession> {
  return request<ChatSessionApi>("/api/room/sessions", {
    method: "POST"
  }).then(mapChatSession);
}

export function getSessionMessages(sessionId: string): Promise<StoredChatMessage[]> {
  return request<StoredChatMessageApi[]>(
    `/api/room/sessions/${encodeURIComponent(sessionId)}/messages`
  ).then((items) => items.map(mapStoredChatMessage));
}

export function renameSession(sessionId: string, title: string): Promise<ChatSession> {
  return request<ChatSessionApi>(`/api/room/sessions/${encodeURIComponent(sessionId)}`, {
    method: "PATCH",
    body: JSON.stringify({ title })
  }).then(mapChatSession);
}

export function deleteSession(sessionId: string): Promise<void> {
  return request<void>(`/api/room/sessions/${encodeURIComponent(sessionId)}`, {
    method: "DELETE"
  });
}

export function postChat(payload: ChatRequest): Promise<ChatResponse> {
  return request<ChatResponseApi>("/api/room/chat", {
    method: "POST",
    body: JSON.stringify({
      message: payload.message,
      room_state: mapRoomStateRequest(payload.roomState),
      listening_context: mapListeningContextRequest(payload.listeningContext),
      ...(payload.musicState
        ? { music_state: mapMusicAgentStateRequest(payload.musicState) }
        : {}),
      recent_messages: payload.recentMessages ?? [],
      persona_strength: payload.personaStrength ?? "medium",
      memory_enabled: payload.memoryEnabled ?? true,
      session_id: payload.sessionId ?? null,
      ...(payload.llmConfig ? { llm_config: mapLLMConfigRequest(payload.llmConfig) } : {})
    })
  }).then(mapChatResponse);
}

export function testLLMConnection(config: LLMConfig): Promise<LLMTestResult> {
  return request<LLMTestResultApi>("/api/room/llm/test", {
    method: "POST",
    body: JSON.stringify(mapLLMConfigRequest(config))
  }).then(mapLLMTestResult);
}

function mapLLMConfigRequest(config: LLMConfig): LLMConfigApi {
  return {
    provider: config.provider,
    base_url: config.baseUrl,
    api_key: config.apiKey,
    model: config.model
  };
}

function mapLLMTestResult(value: LLMTestResultApi): LLMTestResult {
  return {
    ok: value.ok,
    error: value.error,
    model: value.model,
    latencyMs: value.latency_ms
  };
}

interface LLMConfigApi {
  provider: LLMConfig["provider"];
  base_url: string | null;
  api_key: string | null;
  model: string | null;
}

interface LLMTestResultApi {
  ok: boolean;
  error: string | null;
  model: string | null;
  latency_ms: number | null;
}

export function searchMusic(query: string, limit = 5): Promise<MusicSearchResult[]> {
  const params = new URLSearchParams({
    q: query,
    limit: String(limit)
  });

  return request<MusicSearchResultApi[]>(`/api/room/music/search?${params.toString()}`).then(
    (items) => items.map(mapMusicSearchResult)
  );
}

export function recommendAutoDj(payload: AutoDjRecommendRequest): Promise<AutoDjRecommendResponse> {
  return request<AutoDjRecommendResponseApi>("/api/room/music/auto-dj/recommend", {
    method: "POST",
    body: JSON.stringify({
      music_state: payload.musicState === null ? null : mapMusicAgentStateRequest(payload.musicState),
      recommendation_profile: mapRecommendationProfileRequest(payload.recommendationProfile),
      recent_messages: payload.recentMessages,
      settings: {
        count: payload.settings.count,
        queue_depth_trigger: payload.settings.queueDepthTrigger,
        similar_count: payload.settings.similarCount,
        exploration_count: payload.settings.explorationCount
      },
      ...(payload.llmConfig ? { llm_config: mapLLMConfigRequest(payload.llmConfig) } : {})
    })
  }).then(mapAutoDjRecommendResponse);
}

export function getMemories(): Promise<MemoryEvent[]> {
  return request<MemoryEventApi[]>("/api/room/memory").then((items) => items.map(mapMemoryEvent));
}

export function deleteMemory(memoryId: string): Promise<void> {
  return request<void>(`/api/room/memory/${encodeURIComponent(memoryId)}`, {
    method: "DELETE"
  });
}

export function clearMemories(): Promise<void> {
  return request<void>("/api/room/memory", {
    method: "DELETE"
  });
}

async function parseResponseBody(response: Response): Promise<unknown> {
  const text = await response.text();
  if (!text) return undefined;

  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

function getErrorMessage(body: unknown, fallback: string): string {
  if (body && typeof body === "object" && "detail" in body) {
    const detail = (body as { detail: unknown }).detail;
    if (typeof detail === "string") return detail;
  }

  return fallback || "请求失败";
}

interface RoomStateApi {
  app_name: string;
  room_name: string;
  character: {
    display_name: string;
    romanized_name: string;
    expression: RoomState["character"]["expression"];
    status_text: string;
  };
  music: {
    current_track_title: string | null;
    current_artist: string | null;
    listening_mood: string | null;
  };
  diary_summary: string;
  inspiration_count: number;
  studio: {
    label: string;
    route: string;
    unfinished_count: number;
  };
}

interface ChatResponseApi {
  reply: ChatResponse["reply"];
  expression: ChatResponse["expression"];
  suggested_actions: ChatResponse["suggestedActions"];
  provider_status: ChatResponse["providerStatus"];
  memory_events: MemoryEventApi[];
  session: ChatSessionApi | null;
  client_actions?: RoomClientActionApi[];
  agent_trace?: AgentTraceApi;
  novel_rag?: NovelRagTraceApi;
}

interface ChatSessionApi {
  id: string;
  title: string;
  latest_message_preview: string | null;
  created_at: string;
  updated_at: string;
}

interface StoredChatMessageApi {
  id: string;
  session_id: string;
  role: StoredChatMessage["role"];
  content: string;
  created_at: string;
  provider: StoredChatMessage["provider"];
  provider_model: string | null;
  provider_configured: boolean | null;
  provider_label: string | null;
}

interface MemoryEventApi {
  id: string;
  category: MemoryEvent["category"];
  text: string;
  confidence: number;
  created_at: string;
}

interface MusicSearchResultApi {
  source: MusicSearchResult["source"];
  id: string;
  song_id: string;
  title: string;
  creator: string;
  duration_ms: number;
  page_url: string;
  platform_audio_url: string;
  tags: string[];
  playable: boolean;
  popularity: number | null;
  comment_count: number | null;
  hot_comment_liked_count: number | null;
  score: number;
  evidence: string[];
}

interface ClientMusicItemApi {
  id: string;
  source: ClientMusicItem["source"];
  title: string;
  creator: string;
  duration_ms: number;
  page_url: string | null;
  platform_audio_url: string | null;
  tags: string[];
  can_open_video: boolean;
  source_query?: string | null;
  selected_reason?: string | null;
  selection_evidence?: string[];
  selection_score?: number | null;
}

interface RecommendationThemeSignalApi {
  key: string;
  weight: number;
  last_seen_at: string;
}

interface RecommendationCooldownApi {
  key: string;
  kind: RecommendationCooldown["kind"];
  weight: number;
  expires_at: string;
  reason: RecommendationCooldown["reason"];
}

interface RecommendationHistoryEntryApi {
  item_id: string;
  title: string;
  creator: string;
  source: RecommendationHistoryEntry["source"];
  recommended_at: string;
  played: boolean;
  disliked: boolean;
  reason: string;
}

interface RecommendationRefillHistoryEntryApi {
  refill_id: string;
  created_at: string;
  selected_item_ids: string[];
  dominant_themes: string[];
  exploration_count: number;
}

interface RecommendationProfileApi {
  version: 1;
  updated_at: string;
  artist_weights: Record<string, number>;
  tag_weights: Record<string, number>;
  source_weights: Partial<Record<ClientMusicItem["source"], number>>;
  query_weights: Record<string, number>;
  recent_themes: RecommendationThemeSignalApi[];
  cooldowns: RecommendationCooldownApi[];
  recommended_items: RecommendationHistoryEntryApi[];
  refill_history: RecommendationRefillHistoryEntryApi[];
}

interface RecommendationProfilePatchApi {
  recommended_items: RecommendationHistoryEntryApi[];
  cooldowns: RecommendationCooldownApi[];
  refill_history: RecommendationRefillHistoryEntryApi[];
}

interface AutoDjRecommendationApi {
  item: ClientMusicItemApi;
  score: number;
  intent: AutoDjRecommendation["intent"];
  reason: string;
  evidence: string[];
}

interface AutoDjTraceQueryApi {
  query: string;
  intent: AutoDjTraceQuery["intent"];
  themes: string[];
}

interface AutoDjTraceCandidateApi {
  item_id: string;
  title: string;
  creator: string;
  source: AutoDjTraceCandidate["source"];
  query: string;
  intent: AutoDjTraceCandidate["intent"];
  score: number;
  reason: string;
  evidence: string[];
  selected: boolean;
}

interface AutoDjTraceApi {
  planner_queries?: AutoDjTraceQueryApi[];
  candidate_count?: number;
  scored_count?: number;
  selected_item_ids?: string[];
  candidates?: AutoDjTraceCandidateApi[];
  source_errors?: string[];
  error?: string | null;
}

interface AutoDjRecommendResponseApi {
  ok: boolean;
  refill_id: string | null;
  notice: string;
  client_actions?: RoomClientActionApi[];
  recommendations: AutoDjRecommendationApi[];
  profile_patch: RecommendationProfilePatchApi;
  error: string | null;
  source_errors: string[];
  trace?: AutoDjTraceApi;
}

interface RoomClientActionApi {
  type: string;
  item?: ClientMusicItemApi | null;
  item_id?: string | null;
  playlist_id?: string | null;
  playlist_name?: string | null;
  description?: string | null;
}

interface AgentTraceApi {
  tool_calls?: Array<{
    id: string;
    name: string;
    ok: boolean;
  }>;
}

interface NovelRagTraceApi {
  used?: boolean;
  query?: string | null;
  sources?: string[];
  reason?: string | null;
}

function mapRoomState(value: RoomStateApi): RoomState {
  return {
    appName: value.app_name,
    roomName: value.room_name,
    character: {
      displayName: value.character.display_name,
      romanizedName: value.character.romanized_name,
      expression: value.character.expression,
      statusText: value.character.status_text
    },
    music: {
      currentTrackTitle: value.music.current_track_title,
      currentArtist: value.music.current_artist,
      listeningMood: value.music.listening_mood
    },
    diarySummary: value.diary_summary,
    inspirationCount: value.inspiration_count,
    studio: {
      label: value.studio.label,
      route: value.studio.route,
      unfinishedCount: value.studio.unfinished_count
    }
  };
}

function mapRoomStateRequest(value: RoomState): RoomStateApi {
  return {
    app_name: value.appName,
    room_name: value.roomName,
    character: {
      display_name: value.character.displayName,
      romanized_name: value.character.romanizedName,
      expression: value.character.expression,
      status_text: value.character.statusText
    },
    music: {
      current_track_title: value.music.currentTrackTitle,
      current_artist: value.music.currentArtist,
      listening_mood: value.music.listeningMood
    },
    diary_summary: value.diarySummary,
    inspiration_count: value.inspirationCount,
    studio: {
      label: value.studio.label,
      route: value.studio.route,
      unfinished_count: value.studio.unfinishedCount
    }
  };
}

function mapListeningContextRequest(value: ChatRequest["listeningContext"]) {
  if (!value) return null;

  return {
    source: value.source,
    title: value.title,
    creator: value.creator,
    is_playing: value.isPlaying,
    page_url: value.pageUrl,
    tags: value.tags
  };
}

function mapMusicAgentStateRequest(value: MusicAgentState) {
  return {
    is_playing: value.isPlaying,
    current_time_ms: value.currentTimeMs,
    duration_ms: value.durationMs,
    current: mapMusicAgentTrackRequest(value.current),
    previous: mapMusicAgentTrackRequest(value.previous),
    next: mapMusicAgentTrackRequest(value.next),
    upcoming: value.upcoming.map(mapMusicAgentTrackRequest),
    recent: value.recent.map(mapMusicAgentTrackRequest),
    saved: value.saved.map(mapMusicAgentTrackRequest),
    playlists: value.playlists.map(mapMusicAgentPlaylistRequest)
  };
}

function mapMusicAgentTrackRequest(value: MusicAgentState["current"]) {
  if (value === null) return null;

  return {
    id: value.id,
    source: value.source,
    title: value.title,
    creator: value.creator,
    duration_ms: value.durationMs,
    page_url: value.pageUrl,
    platform_audio_url: value.platformAudioUrl,
    tags: value.tags,
    can_open_video: value.canOpenVideo,
    saved: value.saved
  };
}

function mapMusicAgentPlaylistRequest(value: MusicAgentState["playlists"][number]) {
  return {
    id: value.id,
    name: value.name,
    description: value.description ?? null,
    item_count: value.itemCount,
    updated_at: value.updatedAt,
    items: value.items.map(mapMusicAgentTrackRequest)
  };
}

function mapChatResponse(value: ChatResponseApi): ChatResponse {
  return {
    reply: value.reply,
    expression: value.expression,
    suggestedActions: value.suggested_actions,
    providerStatus: value.provider_status,
    memoryEvents: value.memory_events.map(mapMemoryEvent),
    session: value.session === null ? null : mapChatSession(value.session),
    clientActions: (value.client_actions ?? []).map(mapRoomClientAction).filter(isRoomClientAction),
    agentTrace: {
      toolCalls: value.agent_trace?.tool_calls ?? []
    },
    novelRag: mapNovelRagTrace(value.novel_rag)
  };
}

function mapNovelRagTrace(value: NovelRagTraceApi | undefined): ChatResponse["novelRag"] {
  return {
    used: value?.used === true,
    query: typeof value?.query === "string" ? value.query : null,
    sources: Array.isArray(value?.sources)
      ? value.sources.filter((source): source is string => typeof source === "string")
      : [],
    reason: typeof value?.reason === "string" ? value.reason : null
  };
}

function mapChatSession(value: ChatSessionApi): ChatSession {
  return {
    id: value.id,
    title: value.title,
    latestMessagePreview: value.latest_message_preview,
    createdAt: value.created_at,
    updatedAt: value.updated_at
  };
}

function mapStoredChatMessage(value: StoredChatMessageApi): StoredChatMessage {
  return {
    id: value.id,
    sessionId: value.session_id,
    role: value.role,
    content: value.content,
    createdAt: value.created_at,
    provider: value.provider,
    providerModel: value.provider_model,
    providerConfigured: value.provider_configured,
    providerLabel: value.provider_label
  };
}

function mapMemoryEvent(value: MemoryEventApi): MemoryEvent {
  return {
    id: value.id,
    category: value.category,
    text: value.text,
    confidence: value.confidence,
    createdAt: value.created_at
  };
}

function mapMusicSearchResult(value: MusicSearchResultApi): MusicSearchResult {
  return {
    source: value.source,
    id: value.id,
    songId: value.song_id,
    title: value.title,
    creator: value.creator,
    durationMs: value.duration_ms,
    pageUrl: value.page_url,
    platformAudioUrl: value.platform_audio_url,
    tags: value.tags,
    playable: value.playable,
    popularity: value.popularity,
    commentCount: value.comment_count,
    hotCommentLikedCount: value.hot_comment_liked_count,
    score: value.score,
    evidence: value.evidence
  };
}

function mapRoomClientAction(value: RoomClientActionApi): RoomClientAction | null {
  if (!isRecord(value)) return null;

  if (
    value.type === "play_music_item" ||
    value.type === "add_music_to_queue" ||
    value.type === "save_music_item" ||
    value.type === "open_video_window"
  ) {
    if (!isClientMusicItemApi(value.item)) return null;
    return {
      type: value.type,
      item: mapClientMusicItem(value.item)
    };
  }

  if (value.type === "remove_music_from_queue" || value.type === "unsave_music_item") {
    const itemId = typeof value.item_id === "string" ? value.item_id.trim() : "";
    if (!itemId) return null;
    return {
      type: value.type,
      itemId
    };
  }

  if (value.type === "clear_music_queue") {
    if (Object.entries(value).some(([key, fieldValue]) => key !== "type" && fieldValue != null)) {
      return null;
    }
    return { type: "clear_music_queue" };
  }

  if (value.type === "create_music_playlist") {
    const playlistId = typeof value.playlist_id === "string" ? value.playlist_id.trim() : "";
    const playlistName = typeof value.playlist_name === "string" ? value.playlist_name.trim() : "";
    if (!playlistId || !playlistName) return null;
    return {
      type: "create_music_playlist",
      playlistId,
      playlistName,
      description: typeof value.description === "string" ? value.description : null
    };
  }

  if (value.type === "rename_music_playlist") {
    const playlistId = typeof value.playlist_id === "string" ? value.playlist_id.trim() : "";
    const playlistName = typeof value.playlist_name === "string" ? value.playlist_name.trim() : "";
    if (!playlistId || !playlistName) return null;
    return {
      type: "rename_music_playlist",
      playlistId,
      playlistName
    };
  }

  if (value.type === "delete_music_playlist" || value.type === "play_music_playlist" || value.type === "add_playlist_to_queue") {
    const playlistId = typeof value.playlist_id === "string" ? value.playlist_id.trim() : "";
    if (!playlistId) return null;
    return {
      type: value.type,
      playlistId
    };
  }

  if (value.type === "add_music_to_playlist") {
    const playlistId = typeof value.playlist_id === "string" ? value.playlist_id.trim() : "";
    if (!playlistId || !isClientMusicItemApi(value.item)) return null;
    return {
      type: "add_music_to_playlist",
      playlistId,
      item: mapClientMusicItem(value.item)
    };
  }

  if (value.type === "remove_music_from_playlist") {
    const playlistId = typeof value.playlist_id === "string" ? value.playlist_id.trim() : "";
    const itemId = typeof value.item_id === "string" ? value.item_id.trim() : "";
    if (!playlistId || !itemId) return null;
    return {
      type: "remove_music_from_playlist",
      playlistId,
      itemId
    };
  }

  return null;
}

function mapClientMusicItem(value: ClientMusicItemApi): ClientMusicItem {
  return {
    id: value.id,
    source: value.source,
    title: value.title,
    creator: value.creator,
    durationMs: value.duration_ms,
    pageUrl: value.page_url,
    platformAudioUrl: value.platform_audio_url,
    tags: value.tags,
    canOpenVideo: value.can_open_video,
    sourceQuery: value.source_query ?? null,
    selectedReason: value.selected_reason ?? null,
    selectionEvidence: value.selection_evidence ?? [],
    selectionScore: value.selection_score ?? null
  };
}

function mapRecommendationProfileRequest(
  value: AutoDjRecommendRequest["recommendationProfile"]
): RecommendationProfileApi {
  return {
    version: value.version,
    updated_at: value.updatedAt,
    artist_weights: value.artistWeights,
    tag_weights: value.tagWeights,
    source_weights: value.sourceWeights,
    query_weights: value.queryWeights,
    recent_themes: value.recentThemes.map(mapRecommendationThemeRequest),
    cooldowns: value.cooldowns.map(mapRecommendationCooldownRequest),
    recommended_items: value.recommendedItems.map(mapRecommendationHistoryRequest),
    refill_history: value.refillHistory.map(mapRecommendationRefillHistoryRequest)
  };
}

function mapRecommendationThemeRequest(
  value: RecommendationThemeSignal
): RecommendationThemeSignalApi {
  return {
    key: value.key,
    weight: value.weight,
    last_seen_at: value.lastSeenAt
  };
}

function mapRecommendationCooldownRequest(
  value: RecommendationCooldown
): RecommendationCooldownApi {
  return {
    key: value.key,
    kind: value.kind,
    weight: value.weight,
    expires_at: value.expiresAt,
    reason: value.reason
  };
}

function mapRecommendationHistoryRequest(
  value: RecommendationHistoryEntry
): RecommendationHistoryEntryApi {
  return {
    item_id: value.itemId,
    title: value.title,
    creator: value.creator,
    source: value.source,
    recommended_at: value.recommendedAt,
    played: value.played,
    disliked: value.disliked,
    reason: value.reason
  };
}

function mapRecommendationRefillHistoryRequest(
  value: RecommendationRefillHistoryEntry
): RecommendationRefillHistoryEntryApi {
  return {
    refill_id: value.refillId,
    created_at: value.createdAt,
    selected_item_ids: value.selectedItemIds,
    dominant_themes: value.dominantThemes,
    exploration_count: value.explorationCount
  };
}

function mapAutoDjRecommendResponse(
  value: AutoDjRecommendResponseApi
): AutoDjRecommendResponse {
  return {
    ok: value.ok,
    refillId: value.refill_id,
    notice: value.notice,
    clientActions: (value.client_actions ?? []).map(mapRoomClientAction).filter(isRoomClientAction),
    recommendations: value.recommendations.map(mapAutoDjRecommendation),
    profilePatch: mapRecommendationProfilePatch(value.profile_patch),
    error: value.error,
    sourceErrors: value.source_errors,
    trace: mapAutoDjTrace(value.trace)
  };
}

function mapAutoDjRecommendation(value: AutoDjRecommendationApi): AutoDjRecommendation {
  return {
    item: mapClientMusicItem(value.item),
    score: value.score,
    intent: value.intent,
    reason: value.reason,
    evidence: value.evidence
  };
}

function mapAutoDjTrace(value: AutoDjTraceApi | undefined): AutoDjTrace {
  return {
    plannerQueries: Array.isArray(value?.planner_queries)
      ? value.planner_queries.map(mapAutoDjTraceQuery)
      : [],
    candidateCount: typeof value?.candidate_count === "number" ? value.candidate_count : 0,
    scoredCount: typeof value?.scored_count === "number" ? value.scored_count : 0,
    selectedItemIds: Array.isArray(value?.selected_item_ids)
      ? value.selected_item_ids.filter((itemId): itemId is string => typeof itemId === "string")
      : [],
    candidates: Array.isArray(value?.candidates)
      ? value.candidates.map(mapAutoDjTraceCandidate)
      : [],
    sourceErrors: Array.isArray(value?.source_errors)
      ? value.source_errors.filter((error): error is string => typeof error === "string")
      : [],
    error: typeof value?.error === "string" ? value.error : null
  };
}

function mapAutoDjTraceQuery(value: AutoDjTraceQueryApi): AutoDjTraceQuery {
  return {
    query: value.query,
    intent: value.intent,
    themes: value.themes
  };
}

function mapAutoDjTraceCandidate(value: AutoDjTraceCandidateApi): AutoDjTraceCandidate {
  return {
    itemId: value.item_id,
    title: value.title,
    creator: value.creator,
    source: value.source,
    query: value.query,
    intent: value.intent,
    score: value.score,
    reason: value.reason,
    evidence: value.evidence,
    selected: value.selected
  };
}

function mapRecommendationProfilePatch(
  value: RecommendationProfilePatchApi
): RecommendationProfilePatch {
  return {
    recommendedItems: value.recommended_items.map(mapRecommendationHistory),
    cooldowns: value.cooldowns.map(mapRecommendationCooldown),
    refillHistory: value.refill_history.map(mapRecommendationRefillHistory)
  };
}

function mapRecommendationHistory(
  value: RecommendationHistoryEntryApi
): RecommendationHistoryEntry {
  return {
    itemId: value.item_id,
    title: value.title,
    creator: value.creator,
    source: value.source,
    recommendedAt: value.recommended_at,
    played: value.played,
    disliked: value.disliked,
    reason: value.reason
  };
}

function mapRecommendationCooldown(value: RecommendationCooldownApi): RecommendationCooldown {
  return {
    key: value.key,
    kind: value.kind,
    weight: value.weight,
    expiresAt: value.expires_at,
    reason: value.reason
  };
}

function mapRecommendationRefillHistory(
  value: RecommendationRefillHistoryEntryApi
): RecommendationRefillHistoryEntry {
  return {
    refillId: value.refill_id,
    createdAt: value.created_at,
    selectedItemIds: value.selected_item_ids,
    dominantThemes: value.dominant_themes,
    explorationCount: value.exploration_count
  };
}

function isRoomClientAction(value: RoomClientAction | null): value is RoomClientAction {
  return value !== null;
}

function isClientMusicItemApi(value: unknown): value is ClientMusicItemApi {
  if (!isRecord(value)) return false;

  return (
    typeof value.id === "string" &&
    (value.source === "bilibili" || value.source === "netease") &&
    typeof value.title === "string" &&
    typeof value.creator === "string" &&
    typeof value.duration_ms === "number" &&
    (value.page_url === null || typeof value.page_url === "string") &&
    (value.platform_audio_url === null || typeof value.platform_audio_url === "string") &&
    Array.isArray(value.tags) &&
    value.tags.every((tag) => typeof tag === "string") &&
    typeof value.can_open_video === "boolean"
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object";
}

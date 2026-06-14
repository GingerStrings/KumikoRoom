import type { ListeningContext } from "../lib/musicItems";

export interface CharacterState {
  displayName: string;
  romanizedName: string;
  expression: "neutral" | "listening" | "thinking" | "encouraging";
  statusText: string;
}

export interface MusicContext {
  currentTrackTitle: string | null;
  currentArtist: string | null;
  listeningMood: string | null;
}

export interface StudioSummary {
  label: string;
  route: string;
  unfinishedCount: number;
}

export interface RoomState {
  appName: string;
  roomName: string;
  character: CharacterState;
  music: MusicContext;
  diarySummary: string;
  inspirationCount: number;
  studio: StudioSummary;
}

export interface ChatMessage {
  id: string;
  role: "user" | "kumiko";
  content: string;
}

export interface ChatSession {
  id: string;
  title: string;
  latestMessagePreview: string | null;
  createdAt: string;
  updatedAt: string;
}

export type PersonaStrength = "medium" | "strong";

export type MemoryCategory = "preference" | "diary" | "creative_note" | "profile_fact";

export interface ProviderStatus {
  provider: "mock" | "deepseek";
  model: string | null;
  configured: boolean;
  label: string;
}

export interface StoredChatMessage extends ChatMessage {
  sessionId: string;
  createdAt: string;
  provider: ProviderStatus["provider"] | null;
  providerModel: string | null;
  providerConfigured: boolean | null;
  providerLabel: string | null;
}

export interface MemoryEvent {
  id: string;
  category: MemoryCategory;
  text: string;
  confidence: number;
  createdAt: string;
}

export interface ChatRequest {
  message: string;
  roomState: RoomState;
  sessionId?: string;
  recentMessages?: ChatMessage[];
  personaStrength?: PersonaStrength;
  memoryEnabled?: boolean;
  listeningContext?: ListeningContext;
}

export interface MusicSearchResult {
  source: "netease";
  id: string;
  songId: string;
  title: string;
  creator: string;
  durationMs: number;
  pageUrl: string;
  platformAudioUrl: string;
  tags: string[];
  playable: boolean;
  popularity: number | null;
  commentCount: number | null;
  hotCommentLikedCount: number | null;
  score: number;
  evidence: string[];
}

export interface ClientMusicItem {
  id: string;
  source: "bilibili" | "netease";
  title: string;
  creator: string;
  durationMs: number;
  pageUrl: string | null;
  platformAudioUrl: string | null;
  tags: string[];
  canOpenVideo: boolean;
  sourceQuery?: string | null;
  selectedReason?: string | null;
  selectionEvidence?: string[];
  selectionScore?: number | null;
}

export interface MusicAgentTrack {
  id: string;
  source: "bilibili" | "netease";
  title: string;
  creator: string;
  durationMs: number;
  pageUrl: string | null;
  platformAudioUrl: string | null;
  tags: string[];
  canOpenVideo: boolean;
  saved: boolean;
}

export interface MusicAgentState {
  isPlaying: boolean;
  currentTimeMs: number;
  durationMs: number;
  current: MusicAgentTrack | null;
  previous: MusicAgentTrack | null;
  next: MusicAgentTrack | null;
  upcoming: MusicAgentTrack[];
  recent: MusicAgentTrack[];
  saved: MusicAgentTrack[];
}

export type RoomClientAction =
  | {
      type: "play_music_item";
      item: ClientMusicItem;
    }
  | {
      type: "open_video_window";
      item: ClientMusicItem;
    };

export interface AgentTrace {
  toolCalls: Array<{
    id: string;
    name: string;
    ok: boolean;
  }>;
}

export interface ChatResponse {
  reply: ChatMessage;
  expression: CharacterState["expression"];
  suggestedActions: Array<"save_diary" | "save_inspiration" | "open_studio">;
  providerStatus: ProviderStatus;
  memoryEvents: MemoryEvent[];
  session: ChatSession | null;
  clientActions: RoomClientAction[];
  agentTrace: AgentTrace;
}

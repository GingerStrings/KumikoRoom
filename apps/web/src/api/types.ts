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

export interface ChatRequest {
  message: string;
  roomState: RoomState;
}

export interface ChatResponse {
  reply: ChatMessage;
  expression: CharacterState["expression"];
  suggestedActions: Array<"save_diary" | "save_inspiration" | "open_studio">;
}

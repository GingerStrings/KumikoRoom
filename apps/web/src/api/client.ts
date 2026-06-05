import type { ChatRequest, ChatResponse, RoomState } from "./types";

const API_BASE_URL = process.env.NEXT_PUBLIC_KUMIKOROOM_API_BASE_URL ?? "";

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

  const response = await fetch(`${API_BASE_URL}${path}`, {
    ...init,
    headers
  });
  const body = await parseResponseBody(response);

  if (!response.ok) {
    throw new ApiError(getErrorMessage(body, response.statusText), response.status, body);
  }

  return body as T;
}

export function getRoomState(): Promise<RoomState> {
  return request<RoomStateApi>("/api/room/state").then(mapRoomState);
}

export function postChat(payload: ChatRequest): Promise<ChatResponse> {
  return request<ChatResponseApi>("/api/room/chat", {
    method: "POST",
    body: JSON.stringify({ message: payload.message })
  }).then(mapChatResponse);
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

function mapChatResponse(value: ChatResponseApi): ChatResponse {
  return {
    reply: value.reply,
    expression: value.expression,
    suggestedActions: value.suggested_actions
  };
}

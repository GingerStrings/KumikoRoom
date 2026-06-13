import type { MusicItem } from "./musicItems";

export type RoomAgentToolName =
  | "play_item"
  | "open_video_window"
  | "save_music_note"
  | "recommend_next"
  | string;

export interface RoomAgentAction {
  id: string;
  toolName: RoomAgentToolName;
  input: Record<string, unknown>;
}

export interface RoomAgentState {
  activeItemId: string | null;
  videoWindowOpen: boolean;
  notes: string[];
}

export type RoomAgentEvent =
  | {
      type: "tool_start";
      actionId: string;
      toolName: RoomAgentToolName;
    }
  | {
      type: "tool_finish";
      actionId: string;
      toolName: RoomAgentToolName;
      ok: boolean;
    };

export interface RoomAgentToolResult {
  ok: boolean;
  toolName: RoomAgentToolName;
  message: string;
  state: RoomAgentState;
}

export type RoomAgentToolHandler = (
  runtime: RoomAgentRuntime,
  action: RoomAgentAction,
  queue: MusicItem[]
) => RoomAgentToolResult;

export type RoomAgentToolRegistry = Map<RoomAgentToolName, RoomAgentToolHandler>;

export interface RoomAgentRuntime {
  state: RoomAgentState;
  events: RoomAgentEvent[];
  registry: RoomAgentToolRegistry;
}

type RoomAgentToolEntry = readonly [RoomAgentToolName, RoomAgentToolHandler];

const VIDEO_INTENT_PATTERN = /视频|小窗|B站|b站|bilibili/i;
const NOTE_INTENT_PATTERN = /记一下|记录|note/i;
const PLAY_INTENT_PATTERN = /播放|听|放一下/;
const RECOMMEND_INTENT_PATTERN = /推荐|下一首/;

export function createRoomAgentRuntime(initialState: Partial<RoomAgentState> = {}): RoomAgentRuntime {
  return {
    state: {
      activeItemId: initialState.activeItemId ?? null,
      videoWindowOpen: initialState.videoWindowOpen ?? false,
      notes: [...(initialState.notes ?? [])]
    },
    events: [],
    registry: createRoomAgentToolRegistry(defaultRoomAgentToolEntries())
  };
}

export function createRoomAgentToolRegistry(entries: Iterable<RoomAgentToolEntry>): RoomAgentToolRegistry {
  const registry: RoomAgentToolRegistry = new Map();

  for (const [name, handler] of entries) {
    if (registry.has(name)) {
      throw new Error(`room agent tool already registered: ${name}`);
    }

    registry.set(name, handler);
  }

  return registry;
}

export function routeRoomAgentIntent(message: string, queue: MusicItem[]): RoomAgentAction {
  const trimmedMessage = message.trim();

  if (NOTE_INTENT_PATTERN.test(trimmedMessage)) {
    return {
      id: "agent-action-save-note",
      toolName: "save_music_note",
      input: { note: trimmedMessage }
    };
  }

  if (VIDEO_INTENT_PATTERN.test(trimmedMessage)) {
    const videoItem = queue.find((item) => item.canOpenVideo);

    if (videoItem) {
      return {
        id: `agent-action-open-video-${videoItem.id}`,
        toolName: "open_video_window",
        input: { itemId: videoItem.id }
      };
    }
  }

  if (PLAY_INTENT_PATTERN.test(trimmedMessage)) {
    const matchedItem = queue.find((item) => trimmedMessage.includes(item.title)) ?? queue[0];

    if (matchedItem) {
      return {
        id: `agent-action-play-${matchedItem.id}`,
        toolName: "play_item",
        input: { itemId: matchedItem.id }
      };
    }
  }

  if (RECOMMEND_INTENT_PATTERN.test(trimmedMessage)) {
    return {
      id: "agent-action-recommend-next",
      toolName: "recommend_next",
      input: {}
    };
  }

  return {
    id: "agent-action-save-note",
    toolName: "save_music_note",
    input: { note: trimmedMessage }
  };
}

export function dispatchRoomAgentAction(
  runtime: RoomAgentRuntime,
  action: RoomAgentAction,
  queue: MusicItem[]
): RoomAgentToolResult {
  runtime.events.push({ type: "tool_start", actionId: action.id, toolName: action.toolName });

  const handler = runtime.registry.get(action.toolName);
  const result =
    handler?.(runtime, action, queue) ??
    makeResult(false, action.toolName, `unsupported room agent tool: ${action.toolName}`, runtime.state);

  runtime.events.push({
    type: "tool_finish",
    actionId: action.id,
    toolName: action.toolName,
    ok: result.ok
  });

  return result;
}

function defaultRoomAgentToolEntries(): RoomAgentToolEntry[] {
  return [
    ["play_item", playItem],
    ["open_video_window", openVideoWindow],
    ["save_music_note", saveMusicNote],
    ["recommend_next", recommendNext]
  ];
}

function playItem(runtime: RoomAgentRuntime, action: RoomAgentAction, queue: MusicItem[]): RoomAgentToolResult {
  const item = findItemFromAction(action, queue);

  if (!item) {
    return makeResult(false, action.toolName, "music item not found", runtime.state);
  }

  runtime.state.activeItemId = item.id;
  runtime.state.videoWindowOpen = false;

  return makeResult(true, action.toolName, "playing music item", runtime.state);
}

function openVideoWindow(runtime: RoomAgentRuntime, action: RoomAgentAction, queue: MusicItem[]): RoomAgentToolResult {
  const item = findItemFromAction(action, queue);

  if (!item) {
    return makeResult(false, action.toolName, "music item not found", runtime.state);
  }

  if (!item.canOpenVideo) {
    return makeResult(false, action.toolName, "music item cannot open video", runtime.state);
  }

  runtime.state.activeItemId = item.id;
  runtime.state.videoWindowOpen = true;

  return makeResult(true, action.toolName, "opened video window", runtime.state);
}

function saveMusicNote(runtime: RoomAgentRuntime, action: RoomAgentAction): RoomAgentToolResult {
  const note = stringInput(action, "note").trim();

  if (!note) {
    return makeResult(false, action.toolName, "music note is empty", runtime.state);
  }

  runtime.state.notes = [...runtime.state.notes, note];

  return makeResult(true, action.toolName, "saved music note", runtime.state);
}

function recommendNext(runtime: RoomAgentRuntime, action: RoomAgentAction, queue: MusicItem[]): RoomAgentToolResult {
  if (queue.length === 0) {
    return makeResult(false, action.toolName, "no music items available", runtime.state);
  }

  const currentIndex = queue.findIndex((item) => item.id === runtime.state.activeItemId);
  const nextIndex = currentIndex >= 0 ? (currentIndex + 1) % queue.length : 0;
  const nextItem = queue[nextIndex];

  runtime.state.activeItemId = nextItem.id;
  runtime.state.videoWindowOpen = false;

  return makeResult(true, action.toolName, "recommended next music item", runtime.state);
}

function findItemFromAction(action: RoomAgentAction, queue: MusicItem[]): MusicItem | undefined {
  const itemId = stringInput(action, "itemId");

  return queue.find((item) => item.id === itemId);
}

function stringInput(action: RoomAgentAction, key: string): string {
  const value = action.input[key];

  return typeof value === "string" ? value : "";
}

function makeResult(
  ok: boolean,
  toolName: RoomAgentToolName,
  message: string,
  state: RoomAgentState
): RoomAgentToolResult {
  return {
    ok,
    toolName,
    message,
    state: cloneState(state)
  };
}

function cloneState(state: RoomAgentState): RoomAgentState {
  return {
    activeItemId: state.activeItemId,
    videoWindowOpen: state.videoWindowOpen,
    notes: [...state.notes]
  };
}

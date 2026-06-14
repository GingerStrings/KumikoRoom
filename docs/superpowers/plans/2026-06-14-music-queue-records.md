# Music Queue Records Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the right player bottom chip list with a compact queue preview and a manageable session-local queue/history/saved record panel.

**Architecture:** Add a pure `musicQueue` state helper around existing `MusicItem`, extend backend/client action metadata for agent evidence, then wire the helper into `RoomShell`. Keep the existing player card, audio element, progress, transport controls, and video mini-window behavior intact while changing the bottom list surface.

**Tech Stack:** Next.js 14, React 18, TypeScript, Vitest, Testing Library, FastAPI/Pydantic for the existing API schemas.

---

## File Structure

- Create `apps/web/src/lib/musicQueue.ts`: pure queue/history/saved state transitions for player records.
- Create `apps/web/tests/musicQueue.test.ts`: focused tests for queue state behavior.
- Modify `apps/api/kumikoroom/schemas.py`: add optional agent selection metadata to `ClientMusicItemOut`.
- Modify `apps/api/kumikoroom/agent_tools.py`: attach search query, evidence, score, and selected reason to client action items.
- Modify `apps/api/tests/test_conversation.py`: assert metadata is emitted by `play_music_item`.
- Modify `apps/web/src/api/types.ts`: add optional camelCase metadata fields to `ClientMusicItem`.
- Modify `apps/web/src/api/client.ts`: map metadata from API snake_case to client camelCase.
- Modify `apps/web/tests/client.test.ts`: assert metadata mapping.
- Modify `apps/web/src/components/RoomShell.tsx`: replace `playerQueue: MusicItem[]`/`playerTrackIndex` ownership with `musicQueue` helper state, render queue preview, and render the management panel.
- Modify `apps/web/tests/RoomShell.test.tsx`: assert preview, panel tabs/actions, record creation, saved records, and video-capable actions.
- Modify `apps/web/app/globals.css`: replace `.playlist` styles with queue preview and management panel styles.
- Modify `apps/web/tests/design-tokens.test.ts`: update layout regression checks from `.playlist` to `.queue-preview` and `.music-queue-panel`.

---

### Task 1: Add Pure Music Queue State Helper

**Files:**
- Create: `apps/web/src/lib/musicQueue.ts`
- Create: `apps/web/tests/musicQueue.test.ts`

- [ ] **Step 1: Write failing queue helper tests**

Create `apps/web/tests/musicQueue.test.ts` with this content:

```ts
import type { MusicItem } from "../src/lib/musicItems";
import {
  applyClientMusicActionToQueue,
  createInitialMusicQueue,
  getCurrentQueueEntry,
  getPlaybackQueueEntries,
  getQueuePreview,
  getRecentQueueEntries,
  getSavedQueueEntries,
  playQueueItem,
  removeQueueEntry,
  toggleQueueEntrySaved,
} from "../src/lib/musicQueue";

function makeItem(id: string, title: string, source: MusicItem["source"] = "netease"): MusicItem {
  return {
    id,
    source,
    title,
    creator: `${title} creator`,
    durationMs: 180000,
    pageUrl: `https://example.test/${id}`,
    platformAudioUrl: source === "netease" ? `https://example.test/${id}.mp3` : undefined,
    tags: [source],
    canOpenVideo: source === "bilibili",
  };
}

describe("musicQueue", () => {
  it("creates a current item and queued items from defaults", () => {
    const state = createInitialMusicQueue([makeItem("a", "Alpha"), makeItem("b", "Beta")], "2026-06-14T00:00:00.000Z");

    expect(getCurrentQueueEntry(state)?.id).toBe("a");
    expect(getPlaybackQueueEntries(state).map((entry) => entry.id)).toEqual(["a", "b"]);
    expect(getPlaybackQueueEntries(state).map((entry) => entry.status)).toEqual(["current", "queued"]);
  });

  it("plays a queued item and moves the previous current item into recent records", () => {
    const initial = createInitialMusicQueue([makeItem("a", "Alpha"), makeItem("b", "Beta")], "2026-06-14T00:00:00.000Z");
    const state = playQueueItem(initial, "b", "2026-06-14T00:01:00.000Z");

    expect(getCurrentQueueEntry(state)?.id).toBe("b");
    expect(getRecentQueueEntries(state).map((entry) => entry.id)).toEqual(["a"]);
    expect(getRecentQueueEntries(state)[0].lastPlayedAt).toBe("2026-06-14T00:01:00.000Z");
  });

  it("applies agent metadata from a client action item", () => {
    const initial = createInitialMusicQueue([makeItem("a", "Alpha")], "2026-06-14T00:00:00.000Z");
    const state = applyClientMusicActionToQueue(
      initial,
      {
        id: "netease-song-2",
        source: "netease",
        title: "Sunny",
        creator: "Composer",
        durationMs: 200000,
        pageUrl: "https://music.163.com/#/song?id=2",
        platformAudioUrl: "https://music.163.com/song/media/outer/url?id=2.mp3",
        tags: ["netease", "agent-selected"],
        canOpenVideo: false,
        sourceQuery: "play Sunny",
        selectedReason: "ranked score 120",
        selectionEvidence: ["title exact match", "comment_count=10"],
        selectionScore: 120,
      },
      "2026-06-14T00:02:00.000Z"
    );

    const current = getCurrentQueueEntry(state);
    expect(current?.id).toBe("netease-song-2");
    expect(current?.addedBy).toBe("agent");
    expect(current?.sourceQuery).toBe("play Sunny");
    expect(current?.selectedReason).toBe("ranked score 120");
    expect(current?.selectionEvidence).toEqual(["title exact match", "comment_count=10"]);
    expect(current?.selectionScore).toBe(120);
  });

  it("builds a compact preview from the next queued item", () => {
    const state = createInitialMusicQueue(
      [makeItem("a", "Alpha"), makeItem("b", "Beta"), makeItem("c", "Gamma")],
      "2026-06-14T00:00:00.000Z"
    );

    expect(getQueuePreview(state)).toEqual({
      nextEntryId: "b",
      nextTitle: "Beta",
      nextCreator: "Beta creator",
      nextSource: "netease",
      remainingCount: 2,
    });
  });

  it("keeps saved records visible after queue removal", () => {
    const initial = createInitialMusicQueue([makeItem("a", "Alpha"), makeItem("b", "Beta")], "2026-06-14T00:00:00.000Z");
    const saved = toggleQueueEntrySaved(initial, "b");
    const removed = removeQueueEntry(saved, "b", "2026-06-14T00:03:00.000Z");

    expect(getPlaybackQueueEntries(removed).map((entry) => entry.id)).toEqual(["a"]);
    expect(getSavedQueueEntries(removed).map((entry) => entry.id)).toEqual(["b"]);
    expect(getSavedQueueEntries(removed)[0].status).toBe("played");
  });

  it("moves to the next item when removing the current item", () => {
    const initial = createInitialMusicQueue([makeItem("a", "Alpha"), makeItem("b", "Beta")], "2026-06-14T00:00:00.000Z");
    const state = removeQueueEntry(initial, "a", "2026-06-14T00:04:00.000Z");

    expect(getCurrentQueueEntry(state)?.id).toBe("b");
    expect(getPlaybackQueueEntries(state).map((entry) => entry.id)).toEqual(["b"]);
  });
});
```

- [ ] **Step 2: Run the focused helper test and verify it fails**

Run:

```bash
npm run test --workspace apps/web -- apps/web/tests/musicQueue.test.ts
```

Expected: FAIL because `apps/web/src/lib/musicQueue.ts` does not exist.

- [ ] **Step 3: Implement the queue helper**

Create `apps/web/src/lib/musicQueue.ts` with this content:

```ts
import type { ClientMusicItem } from "../api/types";
import type { MusicItem, MusicSourceKind } from "./musicItems";
import { makeMusicItemFromClientActionItem } from "./musicItems";

export type MusicQueueStatus = "current" | "queued" | "played";
export type MusicQueueAddedBy = "agent" | "user" | "default";

export interface MusicQueueEntry {
  id: string;
  item: MusicItem;
  status: MusicQueueStatus;
  addedBy: MusicQueueAddedBy;
  addedAt: string;
  lastPlayedAt?: string;
  playCount: number;
  sourceQuery?: string;
  selectedReason?: string;
  selectionEvidence?: string[];
  selectionScore?: number;
  saved?: boolean;
}

export interface MusicQueueState {
  entries: MusicQueueEntry[];
  currentId: string | null;
  recentLimit: number;
}

export interface QueuePreview {
  nextEntryId: string | null;
  nextTitle: string | null;
  nextCreator: string | null;
  nextSource: MusicSourceKind | null;
  remainingCount: number;
}

export const DEFAULT_RECENT_LIMIT = 30;

export function createInitialMusicQueue(
  items: MusicItem[],
  now = currentIsoTime(),
  recentLimit = DEFAULT_RECENT_LIMIT
): MusicQueueState {
  const entries = items.map<MusicQueueEntry>((item, index) => ({
    id: item.id,
    item,
    status: index === 0 ? "current" : "queued",
    addedBy: "default",
    addedAt: now,
    playCount: index === 0 ? 1 : 0,
    lastPlayedAt: index === 0 ? now : undefined,
  }));

  return {
    entries,
    currentId: entries[0]?.id ?? null,
    recentLimit,
  };
}

export function getCurrentQueueEntry(state: MusicQueueState): MusicQueueEntry | null {
  return state.entries.find((entry) => entry.id === state.currentId && entry.status === "current") ?? null;
}

export function getPlaybackQueueEntries(state: MusicQueueState): MusicQueueEntry[] {
  return state.entries.filter((entry) => entry.status === "current" || entry.status === "queued");
}

export function getRecentQueueEntries(state: MusicQueueState): MusicQueueEntry[] {
  return state.entries
    .filter((entry) => entry.status === "played")
    .sort((left, right) => (right.lastPlayedAt ?? "").localeCompare(left.lastPlayedAt ?? ""));
}

export function getSavedQueueEntries(state: MusicQueueState): MusicQueueEntry[] {
  return state.entries.filter((entry) => entry.saved);
}

export function getQueuePreview(state: MusicQueueState): QueuePreview {
  const queuedEntries = state.entries.filter((entry) => entry.status === "queued");
  const nextEntry = queuedEntries[0] ?? null;

  return {
    nextEntryId: nextEntry?.id ?? null,
    nextTitle: nextEntry?.item.title ?? null,
    nextCreator: nextEntry?.item.creator ?? null,
    nextSource: nextEntry?.item.source ?? null,
    remainingCount: queuedEntries.length,
  };
}

export function applyClientMusicActionToQueue(
  state: MusicQueueState,
  item: ClientMusicItem,
  now = currentIsoTime()
): MusicQueueState {
  const musicItem = makeMusicItemFromClientActionItem(item);
  const upserted = upsertQueueItem(
    state,
    musicItem,
    {
      addedBy: item.tags.includes("agent-selected") ? "agent" : "user",
      sourceQuery: item.sourceQuery ?? undefined,
      selectedReason: item.selectedReason ?? undefined,
      selectionEvidence: item.selectionEvidence ?? undefined,
      selectionScore: item.selectionScore ?? undefined,
    },
    now
  );

  return playQueueItem(upserted, musicItem.id, now);
}

export function upsertQueueItem(
  state: MusicQueueState,
  item: MusicItem,
  metadata: Partial<Pick<
    MusicQueueEntry,
    "addedBy" | "sourceQuery" | "selectedReason" | "selectionEvidence" | "selectionScore"
  >> = {},
  now = currentIsoTime()
): MusicQueueState {
  const existingIndex = state.entries.findIndex((entry) => entry.id === item.id);
  if (existingIndex >= 0) {
    const entries = state.entries.map((entry, index) =>
      index === existingIndex
        ? {
            ...entry,
            item,
            addedBy: metadata.addedBy ?? entry.addedBy,
            sourceQuery: metadata.sourceQuery ?? entry.sourceQuery,
            selectedReason: metadata.selectedReason ?? entry.selectedReason,
            selectionEvidence: metadata.selectionEvidence ?? entry.selectionEvidence,
            selectionScore: metadata.selectionScore ?? entry.selectionScore,
          }
        : entry
    );
    return { ...state, entries };
  }

  return {
    ...state,
    entries: [
      ...state.entries,
      {
        id: item.id,
        item,
        status: "queued",
        addedBy: metadata.addedBy ?? "user",
        addedAt: now,
        playCount: 0,
        sourceQuery: metadata.sourceQuery,
        selectedReason: metadata.selectedReason,
        selectionEvidence: metadata.selectionEvidence,
        selectionScore: metadata.selectionScore,
      },
    ],
  };
}

export function playQueueItem(state: MusicQueueState, itemId: string, now = currentIsoTime()): MusicQueueState {
  if (!state.entries.some((entry) => entry.id === itemId)) {
    return state;
  }

  const entries = state.entries.map((entry) => {
    if (entry.id === itemId) {
      return {
        ...entry,
        status: "current" as const,
        lastPlayedAt: now,
        playCount: entry.playCount + 1,
      };
    }

    if (entry.status === "current") {
      return {
        ...entry,
        status: "played" as const,
        lastPlayedAt: now,
      };
    }

    return entry;
  });

  return capRecentRecords({ ...state, currentId: itemId, entries });
}

export function removeQueueEntry(state: MusicQueueState, itemId: string, now = currentIsoTime()): MusicQueueState {
  const removedEntry = state.entries.find((entry) => entry.id === itemId);
  if (!removedEntry) {
    return state;
  }

  const entriesWithoutItem = state.entries.flatMap((entry) => {
    if (entry.id !== itemId) {
      return [entry];
    }
    if (entry.saved) {
      return [{ ...entry, status: "played" as const, lastPlayedAt: now }];
    }
    return [];
  });

  if (state.currentId !== itemId) {
    return capRecentRecords({
      ...state,
      entries: entriesWithoutItem,
    });
  }

  const nextQueued = entriesWithoutItem.find((entry) => entry.status === "queued");
  if (!nextQueued) {
    return capRecentRecords({
      ...state,
      currentId: null,
      entries: entriesWithoutItem,
    });
  }

  return playQueueItem(
    {
      ...state,
      currentId: null,
      entries: entriesWithoutItem,
    },
    nextQueued.id,
    now
  );
}

export function toggleQueueEntrySaved(state: MusicQueueState, itemId: string): MusicQueueState {
  return {
    ...state,
    entries: state.entries.map((entry) =>
      entry.id === itemId ? { ...entry, saved: !entry.saved } : entry
    ),
  };
}

function capRecentRecords(state: MusicQueueState): MusicQueueState {
  const recentEntries = getRecentQueueEntries(state);
  const allowedRecentIds = new Set(recentEntries.slice(0, state.recentLimit).map((entry) => entry.id));
  return {
    ...state,
    entries: state.entries.filter(
      (entry) => entry.status !== "played" || entry.saved || allowedRecentIds.has(entry.id)
    ),
  };
}

function currentIsoTime(): string {
  return new Date().toISOString();
}
```

- [ ] **Step 4: Run helper tests and verify they pass**

Run:

```bash
npm run test --workspace apps/web -- apps/web/tests/musicQueue.test.ts
```

Expected: PASS.

- [ ] **Step 5: Commit Task 1**

```bash
git add apps/web/src/lib/musicQueue.ts apps/web/tests/musicQueue.test.ts
git commit -m "feat: add music queue state helper"
```

---

### Task 2: Carry Agent Selection Metadata Through API And Client

**Files:**
- Modify: `apps/api/kumikoroom/schemas.py`
- Modify: `apps/api/kumikoroom/agent_tools.py`
- Modify: `apps/api/tests/test_conversation.py`
- Modify: `apps/web/src/api/types.ts`
- Modify: `apps/web/src/api/client.ts`
- Modify: `apps/web/tests/client.test.ts`

- [ ] **Step 1: Write backend metadata assertions**

In `apps/api/tests/test_conversation.py`, extend `test_play_music_item_returns_ranked_client_action` or the nearest `play_music_item` test with these assertions after the existing item assertions:

```py
    assert response.client_actions[0].item.source_query == "晴天 周杰伦"
    assert response.client_actions[0].item.selected_reason is not None
    assert "comment_count=5918" in response.client_actions[0].item.selection_evidence
    assert response.client_actions[0].item.selection_score is not None
```

If the test creates the tool context directly, instantiate it with:

```py
    context = RoomAgentToolContext(
        candidates={candidate.id: candidate},
        candidate_queries={candidate.id: "晴天 周杰伦"},
    )
```

- [ ] **Step 2: Write frontend client mapping assertions**

In `apps/web/tests/client.test.ts`, update the `client_actions` fixture under the `postChat` mapping test by adding these snake_case fields to the item:

```ts
                source_query: "play Sunny",
                selected_reason: "ranked score 120",
                selection_evidence: ["title exact match", "comment_count=10"],
                selection_score: 120,
```

Extend the expected mapped item with:

```ts
          sourceQuery: "play Sunny",
          selectedReason: "ranked score 120",
          selectionEvidence: ["title exact match", "comment_count=10"],
          selectionScore: 120,
```

- [ ] **Step 3: Run focused tests and verify they fail**

Run:

```bash
python -m pytest apps/api/tests/test_conversation.py -q
npm run test --workspace apps/web -- apps/web/tests/client.test.ts
```

Expected: FAIL because metadata fields are not defined or mapped yet.

- [ ] **Step 4: Add metadata fields to backend schemas and tool output**

In `apps/api/kumikoroom/schemas.py`, add these fields to `ClientMusicItemOut`:

```py
    source_query: str | None = None
    selected_reason: str | None = None
    selection_evidence: list[str] = Field(default_factory=list)
    selection_score: float | None = None
```

In `apps/api/kumikoroom/agent_tools.py`, update the context dataclass:

```py
@dataclass
class RoomAgentToolContext:
    candidates: dict[str, MusicSearchCandidate] = field(default_factory=dict)
    candidate_queries: dict[str, str] = field(default_factory=dict)
    client_actions: list[RoomClientActionOut] = field(default_factory=list)
```

Inside `_search_music`, after `context.candidates[result.id] = result`, add:

```py
        context.candidate_queries[result.id] = query
```

In `_play_music_item`, replace:

```py
    item = music_result_to_client_item(candidate)
```

with:

```py
    item = music_result_to_client_item(
        candidate,
        source_query=context.candidate_queries.get(candidate.id),
    )
```

Change the function signature and add metadata values:

```py
def music_result_to_client_item(
    result: MusicSearchCandidate,
    source_query: str | None = None,
) -> ClientMusicItemOut:
    selected_reason = selection_reason_for_result(result)
    selection_evidence = list(result.evidence)
```

For the Bilibili return, add:

```py
            source_query=source_query,
            selected_reason=selected_reason,
            selection_evidence=selection_evidence,
            selection_score=result.score,
```

For the NetEase return, add the same four keyword arguments.

Add this helper above `_candidate_payload`:

```py
def selection_reason_for_result(result: MusicSearchCandidate) -> str:
    evidence = "; ".join(result.evidence[:2])
    rounded_score = round(result.score, 1)
    if evidence:
        return f"ranked score {rounded_score}: {evidence}"
    return f"ranked score {rounded_score}"
```

- [ ] **Step 5: Add metadata to frontend types and mapper**

In `apps/web/src/api/types.ts`, add optional fields to `ClientMusicItem`:

```ts
  sourceQuery?: string | null;
  selectedReason?: string | null;
  selectionEvidence?: string[];
  selectionScore?: number | null;
```

In `apps/web/src/api/client.ts`, add fields to `ClientMusicItemApi`:

```ts
  source_query?: string | null;
  selected_reason?: string | null;
  selection_evidence?: string[];
  selection_score?: number | null;
```

In `mapClientMusicItem`, add:

```ts
    sourceQuery: value.source_query ?? null,
    selectedReason: value.selected_reason ?? null,
    selectionEvidence: value.selection_evidence ?? [],
    selectionScore: value.selection_score ?? null,
```

- [ ] **Step 6: Run metadata tests and verify they pass**

Run:

```bash
python -m pytest apps/api/tests/test_conversation.py -q
npm run test --workspace apps/web -- apps/web/tests/client.test.ts
```

Expected: PASS.

- [ ] **Step 7: Commit Task 2**

```bash
git add apps/api/kumikoroom/schemas.py apps/api/kumikoroom/agent_tools.py apps/api/tests/test_conversation.py apps/web/src/api/types.ts apps/web/src/api/client.ts apps/web/tests/client.test.ts
git commit -m "feat: include music selection metadata"
```

---

### Task 3: Wire Queue State Into RoomShell Behavior

**Files:**
- Modify: `apps/web/src/components/RoomShell.tsx`
- Modify: `apps/web/tests/RoomShell.test.tsx`

- [ ] **Step 1: Write RoomShell behavior tests**

In `apps/web/tests/RoomShell.test.tsx`, update the named play request test so it no longer expects a button named exactly as the track in the old playlist. Replace that assertion with:

```ts
    expect(document.querySelector(".queue-preview")).toBeTruthy();
    expect(screen.getByRole("button", { name: /管理播放队列/ })).toBeTruthy();
```

Add a new test near the other music player tests:

```ts
  it("records agent-selected tracks in the queue panel", async () => {
    apiMocks.postChat.mockResolvedValueOnce(
      makeChatResponse({
        reply: { id: "reply-agent", role: "kumiko", content: "我选了这版。" },
        clientActions: [
          {
            type: "play_music_item",
            item: {
              id: "netease-song-2",
              source: "netease",
              title: "Sunny",
              creator: "Composer",
              durationMs: 200000,
              pageUrl: "https://music.163.com/#/song?id=2",
              platformAudioUrl: "https://music.163.com/song/media/outer/url?id=2.mp3",
              tags: ["netease", "search", "agent-selected"],
              canOpenVideo: false,
              sourceQuery: "play Sunny",
              selectedReason: "ranked score 120",
              selectionEvidence: ["title exact match", "comment_count=10"],
              selectionScore: 120,
            },
          },
        ],
      })
    );
    render(<RoomShell initialState={DEFAULT_ROOM_STATE} connectionStatus={connectionStatus} />);

    expect(await screen.findByRole("button", { name: defaultSession.title })).toBeTruthy();
    fireEvent.change(getComposerInput(), { target: { value: "play Sunny" } });
    fireEvent.click(getComposerSubmit());

    await waitFor(() => expect(apiMocks.postChat).toHaveBeenCalledTimes(1));
    fireEvent.click(screen.getByRole("button", { name: /管理播放队列/ }));

    const panel = screen.getByRole("dialog", { name: /音乐记录/ });
    expect(within(panel).getByText("Sunny")).toBeTruthy();
    expect(within(panel).getByText("来自: play Sunny")).toBeTruthy();
    expect(within(panel).getByText("ranked score 120")).toBeTruthy();
  });
```

Add a second test for saved records:

```ts
  it("saves the current track from the queue panel", async () => {
    render(<RoomShell initialState={DEFAULT_ROOM_STATE} connectionStatus={connectionStatus} />);

    expect(await screen.findByRole("button", { name: defaultSession.title })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: /管理播放队列/ }));
    const panel = screen.getByRole("dialog", { name: /音乐记录/ });
    fireEvent.click(within(panel).getAllByRole("button", { name: /收藏/ })[0]);
    fireEvent.click(within(panel).getByRole("button", { name: "收藏" }));

    expect(within(panel).getByText(PLAYER_TRACKS[0].title)).toBeTruthy();
  });
```

- [ ] **Step 2: Run RoomShell tests and verify they fail**

Run:

```bash
npm run test --workspace apps/web -- apps/web/tests/RoomShell.test.tsx
```

Expected: FAIL because `.queue-preview`, panel role, metadata rendering, and save behavior do not exist yet.

- [ ] **Step 3: Import queue helpers and replace primitive player queue state**

In `apps/web/src/components/RoomShell.tsx`, replace the current player queue state imports and state.

Add imports:

```ts
import {
  applyClientMusicActionToQueue,
  createInitialMusicQueue,
  getCurrentQueueEntry,
  getPlaybackQueueEntries,
  getQueuePreview,
  getRecentQueueEntries,
  getSavedQueueEntries,
  playQueueItem,
  removeQueueEntry,
  toggleQueueEntrySaved,
  upsertQueueItem,
  type MusicQueueEntry,
  type MusicQueueState,
} from "../lib/musicQueue";
```

Replace:

```ts
  const [playerTrackIndex, setPlayerTrackIndex] = useState(0);
  const [playerQueue, setPlayerQueue] = useState<MusicItem[]>(PLAYER_TRACKS);
```

with:

```ts
  const [musicQueue, setMusicQueue] = useState<MusicQueueState>(() => createInitialMusicQueue(PLAYER_TRACKS));
  const [queuePanelOpen, setQueuePanelOpen] = useState(false);
  const [queuePanelTab, setQueuePanelTab] = useState<"queue" | "recent" | "saved">("queue");
```

Add derived player values after the state declarations:

```ts
  const playerQueueEntries = getPlaybackQueueEntries(musicQueue);
  const playerQueue = playerQueueEntries.map((entry) => entry.item);
  const activeQueueEntry = getCurrentQueueEntry(musicQueue) ?? playerQueueEntries[0] ?? null;
  const activeTrack = activeQueueEntry?.item ?? PLAYER_TRACKS[0];
  const playerTrackIndex = Math.max(0, playerQueue.findIndex((track) => track.id === activeTrack.id));
  const queuePreview = getQueuePreview(musicQueue);
  const recentQueueEntries = getRecentQueueEntries(musicQueue);
  const savedQueueEntries = getSavedQueueEntries(musicQueue);
```

Remove the old `const activeTrack = playerQueue[playerTrackIndex] ?? playerQueue[0] ?? PLAYER_TRACKS[0];` line.

- [ ] **Step 4: Apply client actions through the queue helper**

Replace `applyRoomClientActions` with:

```ts
  function applyRoomClientActions(actions: RoomClientAction[]) {
    for (const clientAction of actions) {
      const item = makeMusicItemFromClientActionItem(clientAction.item);
      const toolName = clientAction.type === "open_video_window" ? "open_video_window" : "play_item";

      executeRoomAgentAction({
        id: `client-action-${clientAction.type}-${item.id}`,
        toolName,
        input: { itemId: item.id, item, clientItem: clientAction.item }
      });
    }
  }
```

Replace the entire `executeRoomAgentAction` function with:

```ts
  function executeRoomAgentAction(action: RoomAgentAction) {
    const previousActiveTrackId = activeTrack.id;
    const actionItem = getActionMusicItem(action);
    const clientItem = getActionClientMusicItem(action);
    const queueBeforeDispatch = clientItem
      ? applyClientMusicActionToQueue(musicQueue, clientItem)
      : actionItem
        ? upsertQueueItem(musicQueue, actionItem, { addedBy: "user" })
        : musicQueue;
    const nextQueueItems = getPlaybackQueueEntries(queueBeforeDispatch).map((entry) => entry.item);

    const runtime = createRoomAgentRuntime({
      activeItemId: activeTrack.id,
      videoWindowOpen
    });
    const result = dispatchRoomAgentAction(runtime, action, nextQueueItems);

    if (!result.ok) {
      return;
    }

    let nextQueueState = queueBeforeDispatch;
    if (result.state.activeItemId) {
      nextQueueState = playQueueItem(nextQueueState, result.state.activeItemId);
    }

    const nextActiveEntry = getCurrentQueueEntry(nextQueueState);
    const nextTrack = nextActiveEntry?.item ?? activeTrack;
    const shouldPlay = action.toolName === "play_item" || action.toolName === "recommend_next" || action.toolName === "open_video_window";

    if (nextTrack.id !== previousActiveTrackId) {
      setPlayerCurrentTime(0);
      setPlayerDuration(nextTrack.durationMs / 1000);
    }

    if (shouldPlay) {
      setIsPlayerPlaying(true);
    }

    setMusicQueue(nextQueueState);
    setVideoWindowOpen(result.state.videoWindowOpen);
  }
```

Remove the old `setPlayerQueue(nextQueue)` and `setPlayerTrackIndex(nextTrackIndex)` updates after this replacement.

Add this helper near `getActionMusicItem`:

```ts
function getActionClientMusicItem(action: RoomAgentAction): RoomClientAction["item"] | null {
  const value = action.input.clientItem;
  return isClientMusicItem(value) ? value : null;
}

function isClientMusicItem(value: unknown): value is RoomClientAction["item"] {
  if (!value || typeof value !== "object") {
    return false;
  }

  const candidate = value as Partial<RoomClientAction["item"]>;
  return (
    typeof candidate.id === "string" &&
    (candidate.source === "bilibili" || candidate.source === "netease") &&
    typeof candidate.title === "string" &&
    typeof candidate.creator === "string" &&
    typeof candidate.durationMs === "number" &&
    Array.isArray(candidate.tags) &&
    typeof candidate.canOpenVideo === "boolean"
  );
}
```

- [ ] **Step 5: Replace track navigation with queue helper calls**

Replace `handlePreviousTrack`, `handleNextTrack`, and `selectPlayerTrack` with:

```ts
  function handlePreviousTrack() {
    const nextIndex = (playerTrackIndex - 1 + playerQueue.length) % playerQueue.length;
    selectPlayerTrack(nextIndex);
  }

  function handleNextTrack() {
    const nextIndex = (playerTrackIndex + 1) % playerQueue.length;
    selectPlayerTrack(nextIndex);
  }

  function selectPlayerTrack(nextIndex: number) {
    const nextTrack = playerQueue[nextIndex] ?? playerQueue[0] ?? PLAYER_TRACKS[0];

    platformAudioRef.current?.pause();
    setMusicQueue((currentQueue) => playQueueItem(currentQueue, nextTrack.id));
    setPlayerCurrentTime(0);
    setPlayerDuration(nextTrack.durationMs / 1000);
    if (!nextTrack.canOpenVideo) {
      setVideoWindowOpen(false);
    }
  }
```

Add panel action handlers:

```ts
  function handleQueueEntryPlay(entryId: string) {
    const entry = musicQueue.entries.find((candidate) => candidate.id === entryId);
    if (!entry) return;

    platformAudioRef.current?.pause();
    setMusicQueue((currentQueue) => playQueueItem(currentQueue, entryId));
    setPlayerCurrentTime(0);
    setPlayerDuration(entry.item.durationMs / 1000);
    setIsPlayerPlaying(true);
    setVideoWindowOpen(entry.item.canOpenVideo && videoWindowOpen);
  }

  function handleQueueEntryRemove(entryId: string) {
    setMusicQueue((currentQueue) => removeQueueEntry(currentQueue, entryId));
  }

  function handleQueueEntrySave(entryId: string) {
    setMusicQueue((currentQueue) => toggleQueueEntrySaved(currentQueue, entryId));
  }

  function handleQueueEntryVideo(entry: MusicQueueEntry) {
    setMusicQueue((currentQueue) => playQueueItem(currentQueue, entry.id));
    setPlayerCurrentTime(0);
    setPlayerDuration(entry.item.durationMs / 1000);
    setIsPlayerPlaying(true);
    setVideoWindowOpen(true);
  }
```

- [ ] **Step 6: Run RoomShell behavior tests**

Run:

```bash
npm run test --workspace apps/web -- apps/web/tests/RoomShell.test.tsx
```

Expected: The tests can still fail on missing DOM rendering and CSS from Task 4. Type errors from the state replacement should be fixed before moving on.

- [ ] **Step 7: Commit Task 3**

```bash
git add apps/web/src/components/RoomShell.tsx apps/web/tests/RoomShell.test.tsx
git commit -m "feat: wire player to music queue records"
```

---

### Task 4: Render Queue Preview And Music Records Panel

**Files:**
- Modify: `apps/web/src/components/RoomShell.tsx`
- Modify: `apps/web/tests/RoomShell.test.tsx`

- [ ] **Step 1: Render the compact queue preview**

In the player card JSX, replace the old `.playlist` block with:

```tsx
            <div className="queue-preview" aria-label="播放队列预览">
              <button
                className="queue-preview-main"
                type="button"
                onClick={() => {
                  if (queuePreview.nextEntryId) {
                    handleQueueEntryPlay(queuePreview.nextEntryId);
                  } else {
                    setQueuePanelOpen(true);
                  }
                }}
              >
                <span className="queue-preview-label">队列</span>
                <span className="queue-preview-copy">
                  <strong>{queuePreview.nextTitle ?? "暂无下一首"}</strong>
                  <span>
                    {queuePreview.nextCreator
                      ? `${getMusicSourceLabel(queuePreview.nextSource ?? activeTrack.source)} · ${queuePreview.nextCreator}`
                      : "可以让久美子继续帮你找歌"}
                  </span>
                </span>
                {queuePreview.remainingCount > 1 ? (
                  <span className="queue-preview-count">+{queuePreview.remainingCount - 1}</span>
                ) : null}
              </button>
              <button
                className="queue-manage"
                type="button"
                aria-label="管理播放队列"
                onClick={() => setQueuePanelOpen(true)}
              >
                管理
              </button>
            </div>
```

- [ ] **Step 2: Render the management panel**

After `</aside>` and before the video mini-window, add:

```tsx
      {queuePanelOpen ? (
        <section className="music-queue-panel" role="dialog" aria-label="音乐记录">
          <div className="music-queue-panel-head">
            <div>
              <strong>音乐记录</strong>
              <span>队列、最近播放和收藏</span>
            </div>
            <button type="button" aria-label="关闭音乐记录" onClick={() => setQueuePanelOpen(false)}>
              ×
            </button>
          </div>
          <div className="music-queue-tabs" role="tablist" aria-label="音乐记录分类">
            {(["queue", "recent", "saved"] as const).map((tab) => (
              <button
                key={tab}
                type="button"
                role="tab"
                aria-selected={queuePanelTab === tab}
                onClick={() => setQueuePanelTab(tab)}
              >
                {tab === "queue" ? "队列" : tab === "recent" ? "最近" : "收藏"}
              </button>
            ))}
          </div>
          <div className="music-queue-list">
            {getVisibleQueuePanelEntries(queuePanelTab, playerQueueEntries, recentQueueEntries, savedQueueEntries).map((entry) => (
              <article
                className="music-queue-row"
                data-active={entry.id === activeTrack.id ? "true" : undefined}
                key={`${queuePanelTab}-${entry.id}`}
              >
                <div className="music-queue-row-copy">
                  <span className="source-badge" data-source={entry.item.source}>
                    {getMusicSourceLabel(entry.item.source)}
                  </span>
                  <div>
                    <strong>{entry.item.title}</strong>
                    <span>{entry.item.creator}</span>
                    {entry.sourceQuery ? <em>来自: {entry.sourceQuery}</em> : null}
                    {entry.selectedReason ? <em>{entry.selectedReason}</em> : null}
                  </div>
                </div>
                <div className="music-queue-row-actions">
                  <button type="button" onClick={() => handleQueueEntryPlay(entry.id)}>
                    播放
                  </button>
                  <button type="button" onClick={() => handleQueueEntrySave(entry.id)}>
                    {entry.saved ? "取消收藏" : "收藏"}
                  </button>
                  {entry.item.canOpenVideo ? (
                    <button type="button" onClick={() => handleQueueEntryVideo(entry)}>
                      小窗
                    </button>
                  ) : null}
                  <button type="button" onClick={() => handleQueueEntryRemove(entry.id)}>
                    移除
                  </button>
                </div>
              </article>
            ))}
            {getVisibleQueuePanelEntries(queuePanelTab, playerQueueEntries, recentQueueEntries, savedQueueEntries).length === 0 ? (
              <p className="music-queue-empty">这里还没有记录</p>
            ) : null}
          </div>
        </section>
      ) : null}
```

Add this helper near the bottom of `RoomShell.tsx`:

```ts
function getVisibleQueuePanelEntries(
  tab: "queue" | "recent" | "saved",
  queueEntries: MusicQueueEntry[],
  recentEntries: MusicQueueEntry[],
  savedEntries: MusicQueueEntry[]
): MusicQueueEntry[] {
  if (tab === "recent") return recentEntries;
  if (tab === "saved") return savedEntries;
  return queueEntries;
}
```

- [ ] **Step 3: Run RoomShell tests and verify panel behavior passes**

Run:

```bash
npm run test --workspace apps/web -- apps/web/tests/RoomShell.test.tsx
```

Expected: PASS or only CSS-token tests remain failing. Fix accessible labels if the failing message points to missing role/name.

- [ ] **Step 4: Commit Task 4**

```bash
git add apps/web/src/components/RoomShell.tsx apps/web/tests/RoomShell.test.tsx
git commit -m "feat: render music queue records panel"
```

---

### Task 5: Replace Playlist Styling And Verify Layout

**Files:**
- Modify: `apps/web/app/globals.css`
- Modify: `apps/web/tests/design-tokens.test.ts`

- [ ] **Step 1: Update CSS regression tests**

In `apps/web/tests/design-tokens.test.ts`, replace `.playlist` expectations in the right rail overflow test with:

```ts
    expectRuleToContain(css, ".queue-preview", [
      "display: grid;",
      "grid-template-columns: minmax(0, 1fr) auto;",
      "overflow: hidden;",
    ]);
    expectRuleToContain(css, ".queue-preview-main", [
      "min-width: 0;",
      "overflow: hidden;",
    ]);
    expectRuleToContain(css, ".music-queue-panel", [
      "position: fixed;",
      "max-width: calc(100vw - 32px);",
    ]);
```

Add:

```ts
    expect(css).not.toContain(".playlist {");
```

- [ ] **Step 2: Run CSS token test and verify it fails**

Run:

```bash
npm run test --workspace apps/web -- apps/web/tests/design-tokens.test.ts
```

Expected: FAIL because the new selectors are not styled yet and `.playlist` still exists.

- [ ] **Step 3: Replace `.playlist` CSS with queue preview and panel CSS**

In `apps/web/app/globals.css`, remove the `.playlist`, `.playlist::-webkit-scrollbar`, `.playlist button`, and `.playlist button[data-active="true"]` rules.

Add:

```css
.queue-preview {
  display: grid;
  grid-template-columns: minmax(0, 1fr) auto;
  align-items: stretch;
  gap: 8px;
  margin-top: 12px;
  max-width: 100%;
  overflow: hidden;
}

.queue-preview-main {
  min-width: 0;
  display: grid;
  grid-template-columns: auto minmax(0, 1fr) auto;
  align-items: center;
  gap: 8px;
  padding: 8px 10px;
  overflow: hidden;
  border: 1px solid rgba(195, 213, 211, 0.62);
  border-radius: 10px;
  background: rgba(247, 251, 247, 0.66);
  color: #687a7b;
  text-align: left;
}

.queue-preview-label {
  color: #2f7eba;
  font-size: 11px;
  font-weight: 900;
}

.queue-preview-copy {
  min-width: 0;
  display: grid;
  gap: 2px;
}

.queue-preview-copy strong,
.queue-preview-copy span {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.queue-preview-copy strong {
  color: #34484a;
  font-size: 12px;
}

.queue-preview-copy span {
  color: #8ea09f;
  font-size: 11px;
}

.queue-preview-count {
  min-width: 28px;
  height: 22px;
  display: inline-grid;
  place-items: center;
  border-radius: 999px;
  background: rgba(219, 239, 248, 0.72);
  color: #2f7eba;
  font-size: 11px;
  font-weight: 900;
}

.queue-manage {
  min-width: 52px;
  padding: 0 10px;
  border: 1px solid rgba(47, 126, 186, 0.26);
  border-radius: 10px;
  background: rgba(219, 239, 248, 0.72);
  color: #2f7eba;
  font-size: 12px;
  font-weight: 900;
}

.music-queue-panel {
  position: fixed;
  right: 24px;
  bottom: 24px;
  z-index: 34;
  width: min(360px, calc(100vw - 32px));
  max-width: calc(100vw - 32px);
  max-height: min(520px, calc(100vh - 48px));
  display: grid;
  grid-template-rows: auto auto minmax(0, 1fr);
  overflow: hidden;
  border: 1px solid rgba(216, 226, 221, 0.96);
  border-radius: 16px;
  background: rgba(255, 253, 247, 0.96);
  box-shadow: 0 18px 48px rgba(40, 68, 70, 0.18);
  backdrop-filter: blur(18px);
}

.music-queue-panel-head {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 12px;
  padding: 14px;
  border-bottom: 1px solid rgba(216, 226, 221, 0.74);
}

.music-queue-panel-head div {
  min-width: 0;
  display: grid;
  gap: 3px;
}

.music-queue-panel-head strong {
  color: #34484a;
  font-size: 14px;
}

.music-queue-panel-head span {
  color: #8ea09f;
  font-size: 12px;
}

.music-queue-panel-head button {
  width: 30px;
  height: 30px;
  border: 1px solid rgba(195, 213, 211, 0.7);
  border-radius: 999px;
  background: rgba(255, 255, 255, 0.7);
  color: #687a7b;
}

.music-queue-tabs {
  display: grid;
  grid-template-columns: repeat(3, minmax(0, 1fr));
  gap: 6px;
  padding: 10px 14px;
}

.music-queue-tabs button {
  min-width: 0;
  height: 30px;
  border: 1px solid rgba(195, 213, 211, 0.72);
  border-radius: 999px;
  background: rgba(255, 255, 255, 0.62);
  color: #687a7b;
  font-size: 12px;
  font-weight: 800;
}

.music-queue-tabs button[aria-selected="true"] {
  border-color: rgba(47, 126, 186, 0.3);
  background: rgba(219, 239, 248, 0.76);
  color: #2f7eba;
}

.music-queue-list {
  min-height: 0;
  overflow-y: auto;
  padding: 0 14px 14px;
}

.music-queue-row {
  display: grid;
  gap: 10px;
  padding: 10px 0;
  border-top: 1px solid rgba(216, 226, 221, 0.62);
}

.music-queue-row[data-active="true"] {
  margin: 0 -8px;
  padding: 10px 8px;
  border-radius: 12px;
  background: rgba(219, 239, 248, 0.45);
}

.music-queue-row-copy {
  min-width: 0;
  display: grid;
  grid-template-columns: auto minmax(0, 1fr);
  align-items: start;
  gap: 8px;
}

.music-queue-row-copy div {
  min-width: 0;
  display: grid;
  gap: 2px;
}

.music-queue-row-copy strong,
.music-queue-row-copy span,
.music-queue-row-copy em {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.music-queue-row-copy strong {
  color: #34484a;
  font-size: 13px;
}

.music-queue-row-copy span,
.music-queue-row-copy em {
  color: #8ea09f;
  font-size: 11px;
  font-style: normal;
}

.music-queue-row-actions {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
}

.music-queue-row-actions button {
  min-height: 28px;
  padding: 0 9px;
  border: 1px solid rgba(195, 213, 211, 0.72);
  border-radius: 999px;
  background: rgba(255, 255, 255, 0.66);
  color: #687a7b;
  font-size: 11px;
  font-weight: 800;
}

.music-queue-empty {
  margin: 12px 0 2px;
  color: #8ea09f;
  font-size: 12px;
  text-align: center;
}
```

If the app already has a mobile media query for the right player, add this block near nearby responsive rules:

```css
@media (max-width: 720px) {
  .music-queue-panel {
    right: 12px;
    left: 12px;
    bottom: 12px;
    width: auto;
    max-width: none;
  }
}
```

- [ ] **Step 4: Run CSS and RoomShell tests**

Run:

```bash
npm run test --workspace apps/web -- apps/web/tests/design-tokens.test.ts apps/web/tests/RoomShell.test.tsx
```

Expected: PASS.

- [ ] **Step 5: Commit Task 5**

```bash
git add apps/web/app/globals.css apps/web/tests/design-tokens.test.ts apps/web/src/components/RoomShell.tsx apps/web/tests/RoomShell.test.tsx
git commit -m "style: add music queue management panel"
```

---

### Task 6: Full Verification And Browser Smoke

**Files:**
- Verify working tree and all touched frontend/backend tests.

- [ ] **Step 1: Run full frontend test suite**

```bash
npm run test --workspace apps/web
```

Expected: PASS.

- [ ] **Step 2: Run full API test suite**

```bash
python -m pytest apps/api/tests -q
```

Expected: PASS.

- [ ] **Step 3: Run frontend build**

```bash
npm run build --workspace apps/web
```

Expected: PASS.

- [ ] **Step 4: Run whitespace diff check**

```bash
git diff --check
```

Expected: exit code 0. CRLF warnings from existing Windows line endings can appear, but no trailing whitespace or conflict marker errors should appear.

- [ ] **Step 5: Browser smoke at the current local room**

Open `http://127.0.0.1:3001/room` in the in-app browser. Verify:

- The right player shows the existing title/progress/control style.
- The bottom player area is a queue preview with one next item and a manage button.
- The manage button opens a music records panel.
- Queue/recent/saved tabs switch without layout overflow.
- Saving a track shows it in the saved tab.
- Bilibili tracks still expose the video mini-window action.

- [ ] **Step 6: Commit verification fixes if needed**

If verification requires code fixes, commit only the files changed by those fixes:

```bash
git add <fixed-files>
git commit -m "fix: stabilize music queue records"
```

If no fixes are needed, do not create an empty commit.

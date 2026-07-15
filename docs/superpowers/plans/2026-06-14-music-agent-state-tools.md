# Music Agent State And Management Tools Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give the room agent a complete player-state snapshot and explicit tools for play, queue, recent-state reading, and saved-track management.

**Architecture:** The browser builds an authoritative `MusicAgentState` snapshot for every chat request. The backend tool context reads that snapshot and emits typed client actions for mutations; the frontend applies those actions through pure queue-state helpers. This follows the locally inspected Codex tool-loop boundaries: visible specs, name-based dispatch, structured tool results, follow-up model turns, and explicit client-executed actions.

**Tech Stack:** Next.js 14, React 18, TypeScript, Vitest, Testing Library, FastAPI, Pydantic, pytest.

---

## File Structure

- Create `apps/web/src/lib/musicAgentState.ts`: build the read-only agent snapshot from browser queue/player state.
- Create `apps/web/tests/musicAgentState.test.ts`: focused snapshot tests.
- Modify `apps/web/src/lib/musicQueue.ts`: add explicit add/save/unsave/clear transitions and upcoming-only selector.
- Modify `apps/web/tests/musicQueue.test.ts`: cover new queue transitions.
- Modify `apps/web/src/api/types.ts`: add `MusicAgentState` request contract and typed action union.
- Modify `apps/web/src/api/client.ts`: serialize the snapshot and deserialize all action shapes.
- Modify `apps/web/tests/client.test.ts`: verify request/action mapping.
- Modify `apps/api/kumikoroom/schemas.py`: add music-state input models and typed action fields.
- Modify `apps/api/kumikoroom/agent_tools.py`: add state-aware read/mutation tools and action emission.
- Modify `apps/api/kumikoroom/conversation.py`: initialize tool context with request music state and add state prompt context.
- Modify `apps/api/tests/test_conversation.py`: test tool contracts and loop behavior.
- Modify `apps/web/src/components/RoomShell.tsx`: send music state, apply typed client actions, and separate current/upcoming UI.
- Modify `apps/web/tests/RoomShell.test.tsx`: integration tests for state requests, action execution, persistence, and UI semantics.
- Modify `apps/web/app/globals.css`: style the current/upcoming sections within the existing visual system.
- Modify `apps/web/tests/design-tokens.test.ts`: protect the adjusted panel layout.

### Task 1: Add Browser Music State Snapshot And Queue Transitions

**Files:**
- Create: `apps/web/src/lib/musicAgentState.ts`
- Create: `apps/web/tests/musicAgentState.test.ts`
- Modify: `apps/web/src/lib/musicQueue.ts`
- Modify: `apps/web/tests/musicQueue.test.ts`
- Modify: `apps/web/src/api/types.ts`

- [ ] **Step 1: Write failing snapshot and queue-transition tests**

Add tests that call the wished-for APIs:

```ts
const snapshot = buildMusicAgentState(queue, {
  isPlaying: false,
  currentTimeMs: 42000,
  durationMs: 180000,
});

expect(snapshot.current?.id).toBe("current");
expect(snapshot.previous?.id).toBe("recent");
expect(snapshot.next?.id).toBe("next");
expect(snapshot.upcoming.map((item) => item.id)).toEqual(["next", "later"]);
expect(snapshot.saved.map((item) => item.id)).toEqual(["saved"]);
expect(snapshot.isPlaying).toBe(false);
expect(snapshot.currentTimeMs).toBe(42000);
```

Add queue tests:

```ts
expect(getUpcomingQueueEntries(addQueueItem(state, item)).map((entry) => entry.id)).toContain(item.id);
expect(getCurrentQueueEntry(addQueueItem(state, item))?.id).toBe("current");
expect(getSavedQueueEntries(saveQueueItem(state, item)).map((entry) => entry.id)).toContain(item.id);
expect(getSavedQueueEntries(unsaveQueueItem(saved, item.id))).toEqual([]);
expect(getUpcomingQueueEntries(clearUpcomingQueue(state))).toEqual([]);
expect(getCurrentQueueEntry(clearUpcomingQueue(state))?.id).toBe("current");
```

- [ ] **Step 2: Run focused tests and verify expected failures**

Run:

```powershell
npm run test --workspace apps/web -- apps/web/tests/musicAgentState.test.ts apps/web/tests/musicQueue.test.ts
```

Expected: FAIL because the new snapshot builder and queue functions do not exist.

- [ ] **Step 3: Implement the snapshot and pure queue functions**

Add these public functions:

```ts
export function getUpcomingQueueEntries(state: MusicQueueState): MusicQueueEntry[];
export function addQueueItem(state: MusicQueueState, item: ClientMusicItem, now?: string): MusicQueueState;
export function saveQueueItem(state: MusicQueueState, item: ClientMusicItem, now?: string): MusicQueueState;
export function unsaveQueueItem(state: MusicQueueState, itemId: string): MusicQueueState;
export function clearUpcomingQueue(state: MusicQueueState): MusicQueueState;
```

Create `buildMusicAgentState` using queue selectors. Map entries into a compact `MusicAgentTrack`, preserving `platformAudioUrl` and cloned `tags`, with `previous` from the first recent entry and `next` from the first upcoming entry.

- [ ] **Step 4: Run focused tests**

Run the Step 2 command. Expected: PASS.

- [ ] **Step 5: Commit**

```powershell
git add apps/web/src/lib/musicAgentState.ts apps/web/tests/musicAgentState.test.ts apps/web/src/lib/musicQueue.ts apps/web/tests/musicQueue.test.ts apps/web/src/api/types.ts
git commit -m "feat: add browser music agent state"
```

### Task 2: Add API Contracts And State-Aware Agent Tools

**Files:**
- Modify: `apps/api/kumikoroom/schemas.py`
- Modify: `apps/api/kumikoroom/agent_tools.py`
- Modify: `apps/api/kumikoroom/conversation.py`
- Modify: `apps/api/tests/test_conversation.py`

**Codex source requirement:** Before editing, directly read the relevant entries in `D:\555\codex\codex-main.zip`: `tools/spec_plan.rs`, `tools/router.rs`, `tools/registry.rs`, `stream_events_utils.rs`, `session/turn.rs`, and `tools/handlers/dynamic.rs`. Record the concrete symbols used to guide the implementation in the task report.

- [ ] **Step 1: Write failing backend schema and tool tests**

Add tests that prove:

```py
payload = ChatIn(message="下一首是什么", music_state=music_state_fixture())
assert payload.music_state.next.title == "Next"

context = RoomAgentToolContext(music_state=payload.music_state)
result = dispatch_room_agent_tool(
    LLMToolCall(id="state", name="get_music_state", arguments={}),
    context,
)
assert '"next"' in result.content

result = dispatch_room_agent_tool(
    LLMToolCall(id="save", name="save_music_item", arguments={"item_id": "current"}),
    context,
)
assert context.client_actions[-1].type == "save_music_item"

result = dispatch_room_agent_tool(
    LLMToolCall(id="remove", name="remove_music_from_queue", arguments={"item_id": "next"}),
    context,
)
assert context.client_actions[-1].type == "remove_music_from_queue"
```

Also assert `add_music_to_queue`, `unsave_music_item`, and `clear_music_queue` specs and actions.

- [ ] **Step 2: Run focused backend tests and verify expected failures**

Run:

```powershell
python -m pytest apps/api/tests/test_conversation.py -q
```

Expected: FAIL on missing music-state schemas and tool names.

- [ ] **Step 3: Implement schema and tool contracts**

Add Pydantic models matching the design spec. Change `RoomClientActionOut` to optional shape-specific fields:

```py
class RoomClientActionOut(BaseModel):
    type: Literal[
        "play_music_item",
        "add_music_to_queue",
        "remove_music_from_queue",
        "save_music_item",
        "unsave_music_item",
        "clear_music_queue",
        "open_video_window",
    ]
    item: ClientMusicItemOut | None = None
    item_id: str | None = None
```

Extend `RoomAgentToolContext` with `music_state`. Add a resolver that finds an ID in search candidates or known snapshot tracks. Implement each tool as a small handler that validates the target and appends one action.

- [ ] **Step 4: Initialize tool context and expose state in conversation prompts**

Pass `payload.music_state` into `_run_agent_turn`. Add a compact state context to the system message so ordinary responses remain state-aware, while `get_music_state` returns the full structured snapshot.

- [ ] **Step 5: Run focused backend tests**

Run the Step 2 command. Expected: PASS.

- [ ] **Step 6: Commit**

```powershell
git add apps/api/kumikoroom/schemas.py apps/api/kumikoroom/agent_tools.py apps/api/kumikoroom/conversation.py apps/api/tests/test_conversation.py
git commit -m "feat: add music management agent tools"
```

### Task 3: Map Music State And Typed Client Actions Through The Web API

**Files:**
- Modify: `apps/web/src/api/types.ts`
- Modify: `apps/web/src/api/client.ts`
- Modify: `apps/web/tests/client.test.ts`

- [ ] **Step 1: Write failing request/action mapping tests**

Assert `postChat` serializes:

```ts
music_state: {
  is_playing: false,
  current_time_ms: 42000,
  duration_ms: 180000,
  current: { id: "current", /* snake_case fields */ },
  previous: null,
  next: null,
  upcoming: [],
  recent: [],
  saved: [],
}
```

Assert response mapping for item actions and ID-only actions:

```ts
expect(response.clientActions).toEqual([
  { type: "remove_music_from_queue", itemId: "next" },
  { type: "clear_music_queue" },
]);
```

- [ ] **Step 2: Run client tests and verify expected failures**

Run:

```powershell
npm run test --workspace apps/web -- apps/web/tests/client.test.ts
```

Expected: FAIL because `music_state` and new action shapes are not mapped.

- [ ] **Step 3: Implement request and response mapping**

Add `mapMusicAgentStateRequest`, `mapMusicAgentTrackRequest`, and a discriminated `mapRoomClientAction` that validates required fields by action type.

- [ ] **Step 4: Run client tests**

Run the Step 2 command. Expected: PASS.

- [ ] **Step 5: Commit**

```powershell
git add apps/web/src/api/types.ts apps/web/src/api/client.ts apps/web/tests/client.test.ts
git commit -m "feat: map music agent actions"
```

### Task 4: Execute Agent Actions And Clarify Queue UI

**Files:**
- Modify: `apps/web/src/components/RoomShell.tsx`
- Modify: `apps/web/tests/RoomShell.test.tsx`
- Modify: `apps/web/app/globals.css`
- Modify: `apps/web/tests/design-tokens.test.ts`

**Design decisions:**
- Keep the existing player palette, type, spacing, border radius, and panel placement.
- Rename the first panel tab to `接下来`.
- Show a compact `正在播放` block above upcoming rows.
- Keep `最近` and `收藏` tabs.

- [ ] **Step 1: Write failing RoomShell integration tests**

Add tests proving:

- every `postChat` call includes `musicState`;
- `add_music_to_queue` leaves the current audio source unchanged and adds an upcoming row;
- `play_music_item` changes current and preserves other upcoming items;
- `save_music_item` inserts/saves a known item;
- `unsave_music_item`, `remove_music_from_queue`, and `clear_music_queue` update and persist state;
- the first tab label is `接下来`, the active track is under `正在播放`, and upcoming rows exclude the active track.

- [ ] **Step 2: Run RoomShell tests and verify expected failures**

Run:

```powershell
npm run test --workspace apps/web -- apps/web/tests/RoomShell.test.tsx
```

Expected: FAIL on missing state payload, action handling, and queue-panel semantics.

- [ ] **Step 3: Build and send the snapshot**

Before `postChat`, build:

```ts
const musicState = buildMusicAgentState(musicQueue, {
  isPlaying: isPlayerPlaying,
  currentTimeMs: Math.round(playerCurrentTime * 1000),
  durationMs: Math.round(playerDurationSeconds * 1000),
});
```

Pass `musicState` in `ChatRequest`.

- [ ] **Step 4: Replace the action adapter with a typed executor**

Handle every discriminated action directly. Fold all response actions over one local `nextQueueState` in response order, then call `setMusicQueue` once so later actions cannot overwrite earlier actions through stale closures:

```ts
switch (action.type) {
  case "play_music_item":
    // applyClientMusicActionToQueue, reset progress, start playback
  case "add_music_to_queue":
    // addQueueItem, preserve current playback
  case "remove_music_from_queue":
    // removeQueueEntry
  case "save_music_item":
    // saveQueueItem
  case "unsave_music_item":
    // unsaveQueueItem
  case "clear_music_queue":
    // clearUpcomingQueue
  case "open_video_window":
    // play item and open mini-window
}
```

Keep existing runtime actions used by direct UI controls separate from backend client-action execution.

- [ ] **Step 5: Adjust queue panel markup and CSS**

Render the active entry once under `正在播放`. Render only `getUpcomingQueueEntries(musicQueue)` in the first tab list. Update accessible labels and empty copy. Keep all new styles within existing color/spacing tokens.

- [ ] **Step 6: Run focused frontend tests**

Run:

```powershell
npm run test --workspace apps/web -- apps/web/tests/RoomShell.test.tsx apps/web/tests/design-tokens.test.ts
npm exec --workspace apps/web tsc -- --noEmit
```

Expected: PASS.

- [ ] **Step 7: Commit**

```powershell
git add apps/web/src/components/RoomShell.tsx apps/web/tests/RoomShell.test.tsx apps/web/app/globals.css apps/web/tests/design-tokens.test.ts
git commit -m "feat: execute music management actions"
```

### Task 5: Full Verification And Browser Acceptance

**Files:**
- Verify all touched files and current local room.

- [ ] **Step 1: Run full automated verification**

```powershell
npm run test --workspace apps/web
npm exec --workspace apps/web tsc -- --noEmit
npm run build --workspace apps/web
python -m pytest apps/api/tests -q
git diff --check
```

Expected: all commands exit 0. Existing CRLF warnings are acceptable only when `git diff --check` still exits 0.

- [ ] **Step 2: Run browser acceptance at `http://127.0.0.1:3001/room`**

Verify:

- the first management tab is `接下来`;
- current and upcoming are visually separated;
- no right-rail overflow occurs at desktop and narrow viewport;
- chat requests still complete;
- playback controls and Bilibili mini-window remain functional;
- browser console contains no errors or warnings.

- [ ] **Step 3: Request final code review**

Review the complete diff against the design spec, with special attention to:

- client action validation;
- state snapshot truthfulness;
- action semantics preserving queue/current state;
- absence of user-text keyword triggers;
- agent tool loop consistency with the locally inspected Codex source.

- [ ] **Step 4: Commit verification fixes if required**

```powershell
git add <fixed-files>
git commit -m "fix: stabilize music agent management"
```

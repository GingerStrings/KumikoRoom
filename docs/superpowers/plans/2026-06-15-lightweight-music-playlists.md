# Lightweight Music Playlists Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a compact, persistent playlist layer to the existing music player, expose playlist management to the LLM agent as typed tools, and keep the existing player card visual style intact.

**Architecture:** Keep playback order in `MusicQueueState` and add a separate browser-owned `MusicLibraryState` for long-lived playlists. The browser sends a full `musicState` snapshot, including playlists, to the API; the API registers explicit playlist tools and emits typed `RoomClientAction` objects; `RoomShell` executes those actions locally and persists the library in `localStorage`.

**Tech Stack:** Next.js 14, React 18, TypeScript, Vitest, FastAPI, Pydantic, pytest.

---

## Source Basis

The agent/tool shape must follow the local Codex source, read from `D:/555/codex/.tmp/codex-main-src/codex-main`:

- `codex-rs/core/src/tools/spec_plan.rs`: tools are planned into model-visible specs and a registry.
- `codex-rs/core/src/tools/router.rs`: model output is converted into a typed `ToolCall` with a name, call id, and payload.
- `codex-rs/core/src/tools/registry.rs`: the registry validates the called tool and dispatches it through a handler.
- `codex-rs/core/src/tools/handlers/dynamic.rs`: dynamic tools parse arguments and return structured tool output.
- `codex-rs/core/src/session/turn.rs`: each turn builds tool specs for the prompt, runs tool calls, appends tool results, and lets the model continue.

Apply that pattern here:

- Playlist abilities must be registered in `room_agent_tool_specs()`.
- `dispatch_room_agent_tool()` must route each playlist tool by name.
- Tool handlers must validate arguments against `MusicAgentState` and emit typed `RoomClientActionOut`.
- Frontend code must not infer playlist intent from user text or chat replies.

## File Structure

- Create `apps/web/src/lib/musicLibrary.ts`: pure playlist state types and reducers.
- Create `apps/web/tests/musicLibrary.test.ts`: playlist reducer tests.
- Modify `apps/web/src/lib/musicQueue.ts`: add pure queue helpers for playing/enqueueing a list of music items.
- Modify `apps/web/tests/musicQueue.test.ts`: queue helper tests.
- Modify `apps/web/src/lib/musicAgentState.ts`: include playlist data in the browser-owned state snapshot.
- Modify `apps/web/tests/musicAgentState.test.ts`: playlist snapshot tests.
- Modify `apps/web/src/api/types.ts`: TypeScript API contracts for playlist state and client actions.
- Modify `apps/api/kumikoroom/schemas.py`: Pydantic contracts for playlist state and client actions.
- Modify `apps/api/kumikoroom/agent_tools.py`: playlist tool specs, dispatch, validation, and action emission.
- Modify `apps/api/kumikoroom/conversation.py`: system prompt summary for playlists.
- Modify `apps/api/tests/test_conversation.py`: backend tool and prompt tests.
- Modify `apps/web/src/components/RoomShell.tsx`: persisted library state, client action execution, and management panel UI.
- Modify `apps/web/app/globals.css`: compact panel styles for queue and playlist management.
- Modify `apps/web/tests/RoomShell.test.tsx`: UI action smoke tests where the existing test harness allows it.

## Task 1: Pure Music Library State

**Files:**
- Create: `apps/web/src/lib/musicLibrary.ts`
- Create: `apps/web/tests/musicLibrary.test.ts`

- [ ] **Step 1: Write the failing tests**

Create `apps/web/tests/musicLibrary.test.ts` with tests for creating, renaming, deleting, adding, deduplicating, removing, resolving, and summarizing playlists.

```ts
import type { MusicItem } from "../src/lib/musicItems";
import {
  addMusicItemToPlaylist,
  createInitialMusicLibrary,
  createMusicPlaylist,
  deleteMusicPlaylist,
  getMusicPlaylistByIdOrName,
  getMusicPlaylistSummaries,
  isMusicLibraryState,
  removeMusicItemFromPlaylist,
  renameMusicPlaylist,
} from "../src/lib/musicLibrary";

function makeItem(id: string, title: string): MusicItem {
  return {
    id,
    source: "netease",
    title,
    creator: `${title} creator`,
    durationMs: 180000,
    pageUrl: `https://example.test/${id}`,
    platformAudioUrl: `https://example.test/${id}.mp3`,
    tags: ["netease"],
    canOpenVideo: false,
  };
}

describe("musicLibrary", () => {
  it("creates an empty library", () => {
    expect(createInitialMusicLibrary()).toEqual({ playlists: [] });
  });

  it("creates, resolves, and summarizes playlists", () => {
    const library = createMusicPlaylist(
      createInitialMusicLibrary(),
      { name: "夜晚写作", description: "quiet songs" },
      "2026-06-15T00:00:00.000Z"
    );
    const playlist = library.playlists[0];

    expect(playlist.id).toBe("playlist-night-writing");
    expect(getMusicPlaylistByIdOrName(library, playlist.id)?.name).toBe("夜晚写作");
    expect(getMusicPlaylistByIdOrName(library, "夜晚写作")?.id).toBe(playlist.id);
    expect(getMusicPlaylistSummaries(library)).toEqual([
      {
        id: playlist.id,
        name: "夜晚写作",
        description: "quiet songs",
        itemCount: 0,
        updatedAt: "2026-06-15T00:00:00.000Z",
      },
    ]);
  });

  it("keeps duplicate playlist names addressable with stable ids", () => {
    const first = createMusicPlaylist(createInitialMusicLibrary(), { name: "歌单" }, "2026-06-15T00:00:00.000Z");
    const second = createMusicPlaylist(first, { name: "歌单" }, "2026-06-15T00:01:00.000Z");

    expect(second.playlists.map((playlist) => playlist.id)).toEqual(["playlist-playlist", "playlist-playlist-2"]);
    expect(second.playlists.map((playlist) => playlist.name)).toEqual(["歌单", "歌单"]);
  });

  it("renames and deletes playlists without touching other playlists", () => {
    const first = createMusicPlaylist(createInitialMusicLibrary(), { name: "A" }, "2026-06-15T00:00:00.000Z");
    const second = createMusicPlaylist(first, { name: "B" }, "2026-06-15T00:01:00.000Z");
    const renamed = renameMusicPlaylist(second, "playlist-a", "A2", "2026-06-15T00:02:00.000Z");
    const deleted = deleteMusicPlaylist(renamed, "playlist-b");

    expect(deleted.playlists.map((playlist) => playlist.name)).toEqual(["A2"]);
    expect(deleted.playlists[0].updatedAt).toBe("2026-06-15T00:02:00.000Z");
  });

  it("adds a music item, deduplicates by item id, and preserves first added time", () => {
    const library = createMusicPlaylist(createInitialMusicLibrary(), { name: "Queue seeds" }, "2026-06-15T00:00:00.000Z");
    const withSong = addMusicItemToPlaylist(library, "playlist-queue-seeds", makeItem("song", "Song"), "user", "2026-06-15T00:01:00.000Z");
    const updated = addMusicItemToPlaylist(withSong, "playlist-queue-seeds", { ...makeItem("song", "Song Updated"), tags: ["updated"] }, "agent", "2026-06-15T00:02:00.000Z");

    expect(updated.playlists[0].items).toHaveLength(1);
    expect(updated.playlists[0].items[0].item.title).toBe("Song Updated");
    expect(updated.playlists[0].items[0].addedAt).toBe("2026-06-15T00:01:00.000Z");
    expect(updated.playlists[0].items[0].addedBy).toBe("agent");
    expect(updated.playlists[0].updatedAt).toBe("2026-06-15T00:02:00.000Z");
  });

  it("removes one item from a playlist", () => {
    const library = createMusicPlaylist(createInitialMusicLibrary(), { name: "A" }, "2026-06-15T00:00:00.000Z");
    const withA = addMusicItemToPlaylist(library, "playlist-a", makeItem("a", "A"), "user", "2026-06-15T00:01:00.000Z");
    const withB = addMusicItemToPlaylist(withA, "playlist-a", makeItem("b", "B"), "user", "2026-06-15T00:02:00.000Z");
    const removed = removeMusicItemFromPlaylist(withB, "playlist-a", "a", "2026-06-15T00:03:00.000Z");

    expect(removed.playlists[0].items.map((entry) => entry.id)).toEqual(["b"]);
    expect(removed.playlists[0].updatedAt).toBe("2026-06-15T00:03:00.000Z");
  });

  it("validates stored library shape", () => {
    const library = createMusicPlaylist(createInitialMusicLibrary(), { name: "A" }, "2026-06-15T00:00:00.000Z");

    expect(isMusicLibraryState(library)).toBe(true);
    expect(isMusicLibraryState({ playlists: [{ id: "bad", name: "Bad", items: [{}] }] })).toBe(false);
  });
});
```

- [ ] **Step 2: Run the tests to verify RED**

Run: `npm run test --workspace apps/web -- musicLibrary.test.ts`

Expected: FAIL because `../src/lib/musicLibrary` does not exist.

- [ ] **Step 3: Implement the pure library reducer**

Create `apps/web/src/lib/musicLibrary.ts` with:

```ts
import type { MusicItem } from "./musicItems";
import type { MusicQueueAddedBy } from "./musicQueue";

export interface MusicPlaylistItem {
  id: string;
  item: MusicItem;
  addedAt: string;
  addedBy: MusicQueueAddedBy;
}

export interface MusicPlaylist {
  id: string;
  name: string;
  description?: string;
  items: MusicPlaylistItem[];
  createdAt: string;
  updatedAt: string;
}

export interface MusicLibraryState {
  playlists: MusicPlaylist[];
}

export interface MusicPlaylistSummary {
  id: string;
  name: string;
  description?: string;
  itemCount: number;
  updatedAt: string;
}
```

Required exported functions:

```ts
export function createInitialMusicLibrary(): MusicLibraryState;
export function createMusicPlaylist(
  state: MusicLibraryState,
  input: { name: string; description?: string },
  now?: string
): MusicLibraryState;
export function renameMusicPlaylist(
  state: MusicLibraryState,
  playlistIdOrName: string,
  name: string,
  now?: string
): MusicLibraryState;
export function deleteMusicPlaylist(state: MusicLibraryState, playlistIdOrName: string): MusicLibraryState;
export function addMusicItemToPlaylist(
  state: MusicLibraryState,
  playlistIdOrName: string,
  item: MusicItem,
  addedBy: MusicQueueAddedBy,
  now?: string
): MusicLibraryState;
export function removeMusicItemFromPlaylist(
  state: MusicLibraryState,
  playlistIdOrName: string,
  itemId: string,
  now?: string
): MusicLibraryState;
export function getMusicPlaylistByIdOrName(state: MusicLibraryState, playlistIdOrName: string): MusicPlaylist | null;
export function getMusicPlaylistSummaries(state: MusicLibraryState): MusicPlaylistSummary[];
export function isMusicLibraryState(value: unknown): value is MusicLibraryState;
```

Implementation details:

- Blank playlist names return the unchanged state.
- Playlist ids use `playlist-${slug}` with fallback slug `playlist`; duplicate ids append `-2`, `-3`, and so on.
- `slug` must transliterate ASCII words and use `playlist` for non-ASCII names. Include a small map for `夜晚写作` to `night-writing` so the test id is stable.
- Duplicate item add updates `item`, `addedBy`, and playlist `updatedAt`; it preserves the first `addedAt`.
- Every array returned must be cloned; do not mutate input state.
- `isMusicLibraryState()` must validate required fields and reuse a local `isMusicItemLike()` helper.

- [ ] **Step 4: Run the tests to verify GREEN**

Run: `npm run test --workspace apps/web -- musicLibrary.test.ts`

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/web/src/lib/musicLibrary.ts apps/web/tests/musicLibrary.test.ts
git commit -m "feat: add music playlist state"
```

## Task 2: Queue Helpers For Playlist Playback

**Files:**
- Modify: `apps/web/src/lib/musicQueue.ts`
- Modify: `apps/web/tests/musicQueue.test.ts`

- [ ] **Step 1: Write failing queue tests**

Append tests to `apps/web/tests/musicQueue.test.ts`:

```ts
it("plays a list of music items as the current queue", () => {
  const initial = createInitialMusicQueue([makeItem("old", "Old"), makeItem("stale", "Stale")], "2026-06-15T00:00:00.000Z");
  const state = playMusicItemsAsQueue(
    initial,
    [makeItem("a", "Alpha"), makeItem("b", "Beta"), makeItem("c", "Gamma")],
    "user",
    "2026-06-15T00:01:00.000Z"
  );

  expect(getCurrentQueueEntry(state)?.id).toBe("a");
  expect(getPlaybackQueueEntries(state).map((entry) => entry.id)).toEqual(["a", "b", "c"]);
  expect(getRecentQueueEntries(state).map((entry) => entry.id)).toEqual(["old"]);
  expect(getUpcomingQueueEntries(state).map((entry) => entry.addedBy)).toEqual(["user", "user"]);
});

it("appends a list of music items to upcoming without interrupting current", () => {
  const initial = createInitialMusicQueue([makeItem("current", "Current")], "2026-06-15T00:00:00.000Z");
  const state = appendMusicItemsToQueue(
    initial,
    [makeItem("a", "Alpha"), makeItem("b", "Beta")],
    "agent",
    "2026-06-15T00:01:00.000Z"
  );

  expect(getCurrentQueueEntry(state)?.id).toBe("current");
  expect(getUpcomingQueueEntries(state).map((entry) => entry.id)).toEqual(["a", "b"]);
  expect(getUpcomingQueueEntries(state).map((entry) => entry.addedBy)).toEqual(["agent", "agent"]);
});

it("returns the same queue when asked to play or append an empty list", () => {
  const state = createInitialMusicQueue([makeItem("current", "Current")], "2026-06-15T00:00:00.000Z");

  expect(playMusicItemsAsQueue(state, [], "user", "2026-06-15T00:01:00.000Z")).toBe(state);
  expect(appendMusicItemsToQueue(state, [], "user", "2026-06-15T00:01:00.000Z")).toBe(state);
});
```

Add imports for:

```ts
appendMusicItemsToQueue,
playMusicItemsAsQueue,
```

- [ ] **Step 2: Run the queue tests to verify RED**

Run: `npm run test --workspace apps/web -- musicQueue.test.ts`

Expected: FAIL because `playMusicItemsAsQueue` and `appendMusicItemsToQueue` are missing.

- [ ] **Step 3: Implement queue helpers**

In `apps/web/src/lib/musicQueue.ts`, export:

```ts
export function playMusicItemsAsQueue(
  state: MusicQueueState,
  items: MusicItem[],
  addedBy: MusicQueueAddedBy = "user",
  now = currentIsoTime()
): MusicQueueState

export function appendMusicItemsToQueue(
  state: MusicQueueState,
  items: MusicItem[],
  addedBy: MusicQueueAddedBy = "user",
  now = currentIsoTime()
): MusicQueueState
```

Implementation rules:

- `playMusicItemsAsQueue` clears existing upcoming through `clearUpcomingQueue`, upserts all incoming items, plays the first item, and leaves the remaining items as queued in incoming order.
- `appendMusicItemsToQueue` upserts each incoming item and keeps the current track unchanged.
- Use a private `musicItemToUpdate(item: MusicItem): MusicItemUpdate` helper that clones `tags` and preserves optional URLs.
- Both functions return the original state for an empty list.

- [ ] **Step 4: Run the queue tests to verify GREEN**

Run: `npm run test --workspace apps/web -- musicQueue.test.ts`

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/web/src/lib/musicQueue.ts apps/web/tests/musicQueue.test.ts
git commit -m "feat: support playlist queue playback"
```

## Task 3: Playlist Data In Agent State And API Contracts

**Files:**
- Modify: `apps/web/src/api/types.ts`
- Modify: `apps/web/src/lib/musicAgentState.ts`
- Modify: `apps/web/tests/musicAgentState.test.ts`
- Modify: `apps/api/kumikoroom/schemas.py`
- Modify: `apps/api/kumikoroom/conversation.py`
- Modify: `apps/api/tests/test_conversation.py`

- [ ] **Step 1: Write failing web agent-state tests**

In `apps/web/tests/musicAgentState.test.ts`, import `createInitialMusicLibrary`, `createMusicPlaylist`, and `addMusicItemToPlaylist`.

Add:

```ts
it("includes playlists in the music agent snapshot", () => {
  const queue: MusicQueueState = {
    currentId: null,
    recentLimit: 30,
    entries: [],
  };
  const library = addMusicItemToPlaylist(
    createMusicPlaylist(createInitialMusicLibrary(), { name: "夜晚写作", description: "quiet" }, "2026-06-15T00:00:00.000Z"),
    "playlist-night-writing",
    makeItem("song", "Song"),
    "user",
    "2026-06-15T00:01:00.000Z"
  );

  const snapshot = buildMusicAgentState(queue, {
    isPlaying: false,
    currentTimeMs: 0,
    durationMs: 0,
  }, library);

  expect(snapshot.playlists).toEqual([
    {
      id: "playlist-night-writing",
      name: "夜晚写作",
      description: "quiet",
      itemCount: 1,
      updatedAt: "2026-06-15T00:01:00.000Z",
      items: [
        {
          id: "song",
          source: "netease",
          title: "Song",
          creator: "Song creator",
          durationMs: 180000,
          pageUrl: undefined,
          platformAudioUrl: "https://example.test/song.mp3",
          tags: ["netease"],
          canOpenVideo: false,
          saved: false,
        },
      ],
    },
  ]);
});
```

- [ ] **Step 2: Write failing backend schema/prompt tests**

In `apps/api/tests/test_conversation.py`, update `music_state_fixture()` to include:

```py
"playlists": [
    {
        "id": "playlist-night-writing",
        "name": "Night Writing",
        "description": "quiet songs",
        "item_count": 1,
        "updated_at": "2026-06-15T00:01:00.000Z",
        "items": [music_track_fixture("saved", "Saved Song", saved=True)],
    }
],
```

Update `test_music_state_schema_preserves_snapshot_and_prompt()` with:

```py
assert payload.music_state.playlists[0].name == "Night Writing"
assert "Playlists: Night Writing (1 track, playlist-night-writing)" in system_text
```

- [ ] **Step 3: Run tests to verify RED**

Run:

```bash
npm run test --workspace apps/web -- musicAgentState.test.ts
cd apps/api && python -m pytest tests/test_conversation.py -k "music_state_schema"
```

Expected: both fail because playlist fields are missing.

- [ ] **Step 4: Implement TypeScript contracts and snapshot mapping**

In `apps/web/src/api/types.ts`, add:

```ts
export interface MusicAgentPlaylist {
  id: string;
  name: string;
  description?: string | null;
  itemCount: number;
  updatedAt: string;
  items: MusicAgentTrack[];
}
```

Add `playlists: MusicAgentPlaylist[];` to `MusicAgentState`.

Extend `RoomClientAction` later in Task 4; do not add unused action types in this task.

In `apps/web/src/lib/musicAgentState.ts`, change:

```ts
export function buildMusicAgentState(
  queue: MusicQueueState,
  playback: MusicPlaybackState,
  library: MusicLibraryState = createInitialMusicLibrary()
): MusicAgentState
```

Map playlists by `library.playlists.map(...)`, with:

- `itemCount: playlist.items.length`
- `items: playlist.items.map((entry) => mapMusicItemToAgentTrack(entry.item, false))`
- clone tags for every track.

- [ ] **Step 5: Implement backend contracts and prompt summary**

In `apps/api/kumikoroom/schemas.py`, add:

```py
class MusicAgentPlaylist(BaseModel):
    id: str
    name: str
    description: str | None = None
    item_count: int
    updated_at: str
    items: list[MusicAgentTrack] = Field(default_factory=list)
```

Add `playlists: list[MusicAgentPlaylist] = Field(default_factory=list)` to `MusicAgentState`.

In `apps/api/kumikoroom/conversation.py`, update the music-state prompt formatting so non-empty playlists append:

```text
Playlists: {name} ({item_count} track, {id}); ...
```

Use `tracks` for counts other than 1. Include id so the model can call tools by stable id.

- [ ] **Step 6: Run tests to verify GREEN**

Run:

```bash
npm run test --workspace apps/web -- musicAgentState.test.ts
cd apps/api && python -m pytest tests/test_conversation.py -k "music_state_schema"
```

Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add apps/web/src/api/types.ts apps/web/src/lib/musicAgentState.ts apps/web/tests/musicAgentState.test.ts apps/api/kumikoroom/schemas.py apps/api/kumikoroom/conversation.py apps/api/tests/test_conversation.py
git commit -m "feat: expose playlists in music agent state"
```

## Task 4: Playlist Agent Tools

**Files:**
- Modify: `apps/api/kumikoroom/schemas.py`
- Modify: `apps/api/kumikoroom/agent_tools.py`
- Modify: `apps/api/tests/test_conversation.py`
- Modify: `apps/web/src/api/types.ts`

- [ ] **Step 1: Write failing backend tool tests**

Add tests to `apps/api/tests/test_conversation.py`:

```py
def test_playlist_tool_specs_and_state_lookup() -> None:
    payload = ChatIn(message="playlist", music_state=music_state_fixture())
    context = RoomAgentToolContext(music_state=payload.music_state)

    specs = {spec["function"]["name"] for spec in room_agent_tool_specs()}
    assert {
        "list_music_playlists",
        "get_music_playlist",
        "create_music_playlist",
        "rename_music_playlist",
        "delete_music_playlist",
        "add_music_to_playlist",
        "remove_music_from_playlist",
        "play_music_playlist",
        "add_playlist_to_queue",
    }.issubset(specs)

    list_result = dispatch_room_agent_tool(LLMToolCall(id="list", name="list_music_playlists", arguments={}), context)
    assert list_result.ok is True
    assert '"playlist-night-writing"' in list_result.content

    get_result = dispatch_room_agent_tool(
        LLMToolCall(id="get", name="get_music_playlist", arguments={"playlist_id_or_name": "Night Writing"}),
        context,
    )
    assert get_result.ok is True
    assert '"Saved Song"' in get_result.content


def test_playlist_mutation_tools_emit_client_actions() -> None:
    payload = ChatIn(message="playlist", music_state=music_state_fixture())
    context = RoomAgentToolContext(music_state=payload.music_state)

    create_result = dispatch_room_agent_tool(
        LLMToolCall(id="create", name="create_music_playlist", arguments={"name": "New List", "description": "fresh"}),
        context,
    )
    assert create_result.ok is True
    assert context.client_actions[-1].type == "create_music_playlist"
    assert context.client_actions[-1].playlist_name == "New List"
    assert context.client_actions[-1].description == "fresh"

    rename_result = dispatch_room_agent_tool(
        LLMToolCall(id="rename", name="rename_music_playlist", arguments={"playlist_id_or_name": "playlist-night-writing", "name": "Later"}),
        context,
    )
    assert rename_result.ok is True
    assert context.client_actions[-1].type == "rename_music_playlist"
    assert context.client_actions[-1].playlist_id == "playlist-night-writing"
    assert context.client_actions[-1].playlist_name == "Later"

    add_result = dispatch_room_agent_tool(
        LLMToolCall(id="add", name="add_music_to_playlist", arguments={"playlist_id_or_name": "playlist-night-writing", "item_id": "current"}),
        context,
    )
    assert add_result.ok is True
    assert context.client_actions[-1].type == "add_music_to_playlist"
    assert context.client_actions[-1].playlist_id == "playlist-night-writing"
    assert context.client_actions[-1].item.id == "current"

    remove_result = dispatch_room_agent_tool(
        LLMToolCall(id="remove", name="remove_music_from_playlist", arguments={"playlist_id_or_name": "playlist-night-writing", "item_id": "saved"}),
        context,
    )
    assert remove_result.ok is True
    assert context.client_actions[-1].type == "remove_music_from_playlist"
    assert context.client_actions[-1].item_id == "saved"

    play_result = dispatch_room_agent_tool(
        LLMToolCall(id="play", name="play_music_playlist", arguments={"playlist_id_or_name": "playlist-night-writing"}),
        context,
    )
    assert play_result.ok is True
    assert context.client_actions[-1].type == "play_music_playlist"
    assert context.client_actions[-1].playlist_id == "playlist-night-writing"

    enqueue_result = dispatch_room_agent_tool(
        LLMToolCall(id="enqueue", name="add_playlist_to_queue", arguments={"playlist_id_or_name": "playlist-night-writing"}),
        context,
    )
    assert enqueue_result.ok is True
    assert context.client_actions[-1].type == "add_playlist_to_queue"
    assert context.client_actions[-1].playlist_id == "playlist-night-writing"

    delete_result = dispatch_room_agent_tool(
        LLMToolCall(id="delete", name="delete_music_playlist", arguments={"playlist_id_or_name": "playlist-night-writing"}),
        context,
    )
    assert delete_result.ok is True
    assert context.client_actions[-1].type == "delete_music_playlist"
    assert context.client_actions[-1].playlist_id == "playlist-night-writing"


def test_playlist_tools_reject_missing_playlist_and_empty_playlist() -> None:
    payload = ChatIn(message="playlist", music_state={**music_state_fixture(), "playlists": []})
    context = RoomAgentToolContext(music_state=payload.music_state)

    missing = dispatch_room_agent_tool(
        LLMToolCall(id="missing", name="play_music_playlist", arguments={"playlist_id_or_name": "missing"}),
        context,
    )
    assert missing.ok is False
    assert "Playlist was not found" in json.loads(missing.content)["error"]
    assert context.client_actions == []
```

- [ ] **Step 2: Run backend tests to verify RED**

Run: `cd apps/api && python -m pytest tests/test_conversation.py -k "playlist"`

Expected: FAIL because playlist tools and action fields are missing.

- [ ] **Step 3: Extend API action schemas**

In `apps/api/kumikoroom/schemas.py`, extend `RoomClientActionOut.type` with:

```py
"create_music_playlist",
"rename_music_playlist",
"delete_music_playlist",
"add_music_to_playlist",
"remove_music_from_playlist",
"play_music_playlist",
"add_playlist_to_queue",
```

Add optional fields:

```py
playlist_id: str | None = None
playlist_name: str | None = None
description: str | None = None
```

In `apps/web/src/api/types.ts`, extend `RoomClientAction` with matching discriminated union members:

```ts
| { type: "create_music_playlist"; playlistName: string; description?: string | null }
| { type: "rename_music_playlist"; playlistId: string; playlistName: string }
| { type: "delete_music_playlist"; playlistId: string }
| { type: "add_music_to_playlist"; playlistId: string; item: ClientMusicItem }
| { type: "remove_music_from_playlist"; playlistId: string; itemId: string }
| { type: "play_music_playlist"; playlistId: string }
| { type: "add_playlist_to_queue"; playlistId: string };
```

- [ ] **Step 4: Implement playlist tool specs and dispatch**

In `apps/api/kumikoroom/agent_tools.py`, add specs for:

- `list_music_playlists()`
- `get_music_playlist(playlist_id_or_name)`
- `create_music_playlist(name, description?)`
- `rename_music_playlist(playlist_id_or_name, name)`
- `delete_music_playlist(playlist_id_or_name)`
- `add_music_to_playlist(playlist_id_or_name, item_id)`
- `remove_music_from_playlist(playlist_id_or_name, item_id)`
- `play_music_playlist(playlist_id_or_name)`
- `add_playlist_to_queue(playlist_id_or_name)`

Add dispatch branches before the unknown-tool fallback.

Add helpers:

```py
def _playlist_id_or_name_from_arguments(arguments: dict[str, Any]) -> str
def _playlist_name_from_arguments(arguments: dict[str, Any]) -> str
def _find_playlist(identifier: str, state: MusicAgentState | None)
def _playlist_summary_payload(playlist)
def _playlist_payload(playlist)
def _playlist_required_result()
def _emit_playlist_action(action: RoomClientActionOut, payload: dict[str, Any], context: RoomAgentToolContext)
```

Rules:

- `list_music_playlists` returns summaries only.
- `get_music_playlist` returns full `items`.
- `create_music_playlist` requires a non-blank `name`.
- `rename_music_playlist` requires existing playlist and non-blank `name`.
- `delete_music_playlist` requires existing playlist.
- `add_music_to_playlist` resolves the playlist and item. The item may come from `context.candidates` or from `music_state` current/previous/next/upcoming/recent/saved/playlists.
- `remove_music_from_playlist` requires item membership in that playlist.
- `play_music_playlist` and `add_playlist_to_queue` require at least one playlist item.
- All mutation tools append exactly one `RoomClientActionOut`.

- [ ] **Step 5: Run backend tests to verify GREEN**

Run: `cd apps/api && python -m pytest tests/test_conversation.py -k "playlist or music_state_schema"`

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add apps/api/kumikoroom/schemas.py apps/api/kumikoroom/agent_tools.py apps/api/tests/test_conversation.py apps/web/src/api/types.ts
git commit -m "feat: add music playlist agent tools"
```

## Task 5: RoomShell Library Persistence, Actions, And Panel UI

**Files:**
- Modify: `apps/web/src/components/RoomShell.tsx`
- Modify: `apps/web/app/globals.css`
- Modify: `apps/web/tests/RoomShell.test.tsx`

- [ ] **Step 1: Write failing RoomShell UI tests**

If the existing `RoomShell.test.tsx` has enough harness support, add tests that:

```ts
it("shows the playlist tab in the music management panel", async () => {
  renderRoomShell();
  await userEvent.click(screen.getByRole("button", { name: "管理播放队列" }));
  expect(screen.getByRole("tab", { name: "我的歌单" })).toBeInTheDocument();
});

it("persists a manually created playlist", async () => {
  renderRoomShell();
  await userEvent.click(screen.getByRole("button", { name: "管理播放队列" }));
  await userEvent.click(screen.getByRole("tab", { name: "我的歌单" }));
  await userEvent.type(screen.getByLabelText("歌单名称"), "夜晚写作");
  await userEvent.click(screen.getByRole("button", { name: "新建歌单" }));

  expect(window.localStorage.getItem("kumikoroom.musicLibrary")).toContain("夜晚写作");
});
```

If the current harness cannot render the management panel reliably, add a smaller test around exported pure helpers from Task 1 and document that UI is covered by browser smoke in Task 6.

- [ ] **Step 2: Run UI tests to verify RED**

Run: `npm run test --workspace apps/web -- RoomShell.test.tsx`

Expected: FAIL because the playlist tab and persistence do not exist.

- [ ] **Step 3: Add library state and persistence**

In `RoomShell.tsx`:

- Import `MusicLibraryState` and Task 1 helpers.
- Add `const MUSIC_LIBRARY_STORAGE_KEY = "kumikoroom.musicLibrary";`
- Add state:

```ts
const [musicLibrary, setMusicLibrary] = useState<MusicLibraryState>(() => createInitialMusicLibrary());
const [musicLibraryHydrated, setMusicLibraryHydrated] = useState(false);
const musicLibraryRef = useRef(musicLibrary);
musicLibraryRef.current = musicLibrary;
```

- Add `readStoredMusicLibrary(storage: Storage): MusicLibraryState | null` using `isMusicLibraryState()`.
- Hydrate and persist with `localStorage`.
- Pass `musicLibrary` to `buildMusicAgentState(...)` when sending chat.

- [ ] **Step 4: Execute playlist client actions**

In `applyRoomClientActions()`:

- Track `nextLibraryState = musicLibraryRef.current`.
- Handle:

```ts
create_music_playlist -> createMusicPlaylist(nextLibraryState, { name: action.playlistName, description: action.description ?? undefined })
rename_music_playlist -> renameMusicPlaylist(nextLibraryState, action.playlistId, action.playlistName)
delete_music_playlist -> deleteMusicPlaylist(nextLibraryState, action.playlistId)
add_music_to_playlist -> addMusicItemToPlaylist(nextLibraryState, action.playlistId, makeMusicItemFromClientActionItem(action.item), "agent")
remove_music_from_playlist -> removeMusicItemFromPlaylist(nextLibraryState, action.playlistId, action.itemId)
play_music_playlist -> find playlist in nextLibraryState and call playMusicItemsAsQueue(nextQueueState, playlist.items.map((entry) => entry.item), "agent")
add_playlist_to_queue -> find playlist in nextLibraryState and call appendMusicItemsToQueue(nextQueueState, playlist.items.map((entry) => entry.item), "agent")
```

Commit library state after the loop when changed.

- [ ] **Step 5: Add manual playlist management UI**

Replace the management panel tabs with:

```ts
type MusicPanelTab = "queue" | "playlists" | "recent" | "saved";
```

Use labels:

- `当前队列`
- `我的歌单`
- `最近`
- `收藏`

Keep the existing player card unchanged.

The `当前队列` tab must show:

- `正在播放` row when there is an active track.
- `接下来` rows for queued entries.
- Empty text `接下来还没有歌曲`.

The `我的歌单` tab must show:

- Compact create form with input label `歌单名称` and button `新建歌单`.
- Playlist list rows with name, item count, `播放`, `加到接下来`, `重命名`, `删除`.
- Selected playlist detail showing its songs and row actions `播放`, `移除`, `收藏`, `小窗` when supported.
- Empty text `还没有歌单` and `这个歌单还没有歌曲`.

The `最近` and `收藏` tabs must keep existing row actions and add an `加入歌单` compact control that adds the row to the selected playlist. If no playlist exists, show text `先新建歌单`.

- [ ] **Step 6: Update compact panel CSS**

In `globals.css`, keep the existing colors and density. Update:

- `.music-queue-tabs` from 3 columns to 4 columns.
- Add `.music-library-create`, `.music-playlist-list`, `.music-playlist-row`, `.music-playlist-detail`, `.music-add-to-playlist`.
- Avoid text overflow with `min-width: 0`, `text-overflow: ellipsis`, and wrapping for action rows.
- Keep panel width near current size: `width: min(380px, calc(100vw - 32px));`.

- [ ] **Step 7: Run UI tests to verify GREEN**

Run: `npm run test --workspace apps/web -- RoomShell.test.tsx`

Expected: PASS, or a documented harness limitation plus passing pure helper tests if `RoomShell.test.tsx` cannot support the UI interactions.

- [ ] **Step 8: Commit**

```bash
git add apps/web/src/components/RoomShell.tsx apps/web/app/globals.css apps/web/tests/RoomShell.test.tsx
git commit -m "feat: add music playlist management ui"
```

## Task 6: Integration Verification

**Files:**
- Modify only if fixes are required.

- [ ] **Step 1: Run focused web tests**

Run:

```bash
npm run test --workspace apps/web -- musicLibrary.test.ts musicQueue.test.ts musicAgentState.test.ts RoomShell.test.tsx
```

Expected: PASS.

- [ ] **Step 2: Run focused backend tests**

Run:

```bash
cd apps/api && python -m pytest tests/test_conversation.py -k "music_state_schema or playlist or music_tool_loop"
```

Expected: PASS.

- [ ] **Step 3: Run full test suites**

Run:

```bash
npm run test --workspace apps/web
cd apps/api && python -m pytest
```

Expected: PASS.

- [ ] **Step 4: Build web app**

Run:

```bash
npm run build --workspace apps/web
```

Expected: PASS.

- [ ] **Step 5: Browser smoke**

Open `http://127.0.0.1:3001/room` in the in-app browser and verify:

- Player card still looks like the current compact music player.
- `管理` opens the panel.
- Tabs show `当前队列 / 我的歌单 / 最近 / 收藏`.
- Create playlist, add current song to it, refresh, playlist remains.
- Play playlist changes current track and fills `接下来`.
- Add playlist to queue appends without interrupting current playback.
- Long track titles and action buttons do not overflow the right player area.

- [ ] **Step 6: Final commit if fixes were needed**

If Task 6 changed files:

```bash
git add <changed-files>
git commit -m "fix: polish music playlist integration"
```

If no files changed, do not create an empty commit.

## Acceptance Criteria

- The default player UI card remains visually unchanged except for queue/library management affordances.
- Music library state persists in `localStorage` under `kumikoroom.musicLibrary`.
- Queue and playlists are separate concepts: queue controls playback order, playlists are reusable collections.
- Agent can list, inspect, create, rename, delete, add to, remove from, play, and enqueue playlists through explicit tools.
- Agent playlist tools validate against current `musicState` and emit typed client actions.
- Frontend does not parse chat text or replies to infer playlist intent.
- Tests cover pure playlist reducers, queue playback helpers, agent state, backend tools, and at least one UI path.
- Web tests, API tests, and web build pass before completion.

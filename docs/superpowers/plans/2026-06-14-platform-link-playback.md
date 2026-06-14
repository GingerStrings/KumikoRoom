# Platform Link Playback Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let the room player accept arbitrary Bilibili video links/BV ids and Netease song links/song ids from chat, then route follow-up confirmations such as "可以" into real playback instead of letting the model claim fake playback.

**Architecture:** Keep the existing chat UI and player surface. Add focused music-item helpers for platform-link parsing and dynamic queue insertion, extend the room-agent router to accept the current queue and last recommended playable item, and add a persona constraint so model replies only claim playback after a tool result or visible player state confirms it.

**Tech Stack:** Next.js/React, TypeScript, Vitest, FastAPI/Python, pytest.

---

### Task 1: Dynamic Platform Items

**Files:**
- Modify: `apps/web/src/lib/musicItems.ts`
- Test: `apps/web/tests/musicItems.test.ts`

- [ ] **Step 1: Write failing tests**
  - Add tests for `createPlatformMusicItemFromInput`:
    - `https://music.163.com/song?id=12345` returns a Netease item with `platformAudioUrl`.
    - `BV1xx411c7mD` returns a Bilibili item with `embedUrl` and `canOpenVideo: true`.
    - a plain unsupported song title returns `null`.

- [ ] **Step 2: Run red test**
  - Run: `npm run test --workspace apps/web -- musicItems.test.ts`
  - Expected: fail because `createPlatformMusicItemFromInput` is missing.

- [ ] **Step 3: Implement helper**
  - Export `createPlatformMusicItemFromInput(input: string): MusicItem | null`.
  - Use existing `parseNeteaseSongUrl`, `parseBilibiliVideoUrl`, `makeNeteaseMusicItem`, and `makeBilibiliMusicItem`.
  - Use fallback titles like `网易云歌曲 12345` and `B站视频 BV1xx411c7mD`.

- [ ] **Step 4: Run green test**
  - Run: `npm run test --workspace apps/web -- musicItems.test.ts`
  - Expected: pass.

### Task 2: Chat Tool Routing

**Files:**
- Modify: `apps/web/src/lib/roomAgent.ts`
- Modify: `apps/web/src/components/RoomShell.tsx`
- Test: `apps/web/tests/roomAgent.test.ts`
- Test: `apps/web/tests/RoomShell.test.tsx`

- [ ] **Step 1: Write failing tests**
  - `routeRoomAgentIntent("放 https://music.163.com/song?id=12345", queue, null)` returns a `play_item` action for a dynamic Netease item.
  - `routeRoomAgentIntent("打开 BV1xx411c7mD", queue, null)` returns `open_video_window` for a dynamic Bilibili item.
  - `routeRoomAgentIntent("可以", queue, lastPlayableItem)` returns `play_item` for the last playable item.
  - RoomShell tests confirm dynamic Netease links are added to the playlist, played, acknowledged, and not posted to chat API.

- [ ] **Step 2: Run red tests**
  - Run: `npm run test --workspace apps/web -- roomAgent.test.ts RoomShell.test.tsx`
  - Expected: fail because the router does not support dynamic items or follow-up confirmation.

- [ ] **Step 3: Implement routing**
  - Let `routeRoomAgentIntent` accept an options object containing `queue` and `lastPlayableItem`.
  - Return dynamic platform items in action input where needed.
  - Keep existing explicit title matching.

- [ ] **Step 4: Implement RoomShell queue state**
  - Add `playerQueue` state initialized from `PLAYER_TRACKS`.
  - Add `lastPlayableSuggestion` state.
  - When a normal chat reply mentions a known queue title, store it as the pending playable suggestion.
  - When a dynamic tool action succeeds, append the dynamic item to `playerQueue` if missing, set it active, and show the existing player UI.

- [ ] **Step 5: Run green tests**
  - Run: `npm run test --workspace apps/web -- roomAgent.test.ts RoomShell.test.tsx`
  - Expected: pass.

### Task 3: Truthful Playback Prompt

**Files:**
- Modify: `apps/api/kumikoroom/persona.py`
- Test: `apps/api/tests/test_persona.py`

- [ ] **Step 1: Write failing test**
  - Add a test that the persona prompt tells the model not to claim playback unless the player/tool state confirms it, and to offer a playable link when a requested song is outside the current player.

- [ ] **Step 2: Run red test**
  - Run: `python -m pytest apps/api/tests/test_persona.py -q`
  - Expected: fail because the new constraint is missing.

- [ ] **Step 3: Implement prompt text**
  - Add concise Chinese prompt lines to the core persona prompt.
  - Keep the prompt under the existing size limit.

- [ ] **Step 4: Run green test**
  - Run: `python -m pytest apps/api/tests/test_persona.py -q`
  - Expected: pass.

### Task 4: Verification

**Files:**
- No production files.

- [ ] **Step 1: Run focused tests**
  - `npm run test --workspace apps/web -- musicItems.test.ts roomAgent.test.ts RoomShell.test.tsx`
  - `python -m pytest apps/api/tests/test_persona.py -q`

- [ ] **Step 2: Run full verification**
  - `npm run test --workspace apps/web`
  - `python -m pytest apps/api/tests -q`
  - `npm run build --workspace apps/web`
  - `git diff --check`

- [ ] **Step 3: Browser QA**
  - Open `http://127.0.0.1:3000/room`.
  - Send a Netease link, confirm it appears in the playlist and starts as the active track.
  - Send a Bilibili BV id, confirm the Bilibili mini-window opens.
  - Confirm the chat timeline shows tool-result acknowledgements rather than raw command echo.

# Music Queue And Records Design

Date: 2026-06-14

## Purpose

The right-side player already has the correct role: it should feel like the same compact music player inside the chat room, with the current track, transport controls, progress, and optional video mini-window. The weak part is the bottom song list. It currently reads like a row of tags, competes with the controls, and cannot scale once agent-selected songs, played songs, and user-managed queue items all exist.

This slice turns that bottom region into a compact queue preview and moves full list management into a small management panel. The player style should stay visually consistent with the current UI.

## Goals

- Preserve the current player identity: compact card, calm colors, existing controls, and no large layout rewrite.
- Replace the chip-like bottom playlist with a readable queue preview.
- Add a place to manage music records: queued songs, recently played songs, and saved/favorited songs.
- Make agent-selected playback leave useful records: original query, chosen source, selection evidence, and selected reason when available.
- Keep the first implementation lightweight enough to ship on top of the current agentic music work.
- Keep local audio out of scope.

## Non-Goals

- Personalized recommendation is deferred.
- FL project or local audio file management is deferred.
- Cross-device persistence is deferred unless a later API/database slice explicitly adds it.
- The current player controls, progress bar behavior, and optional Bilibili video mini-window should not be redesigned in this slice.

## Recommended Approach

Use a two-layer interaction:

1. The player card shows only the current track and a compact queue preview.
2. A management panel opens from a small "manage" control in the player and contains the full queue/history UI.

This keeps the player from becoming crowded while still making song records feel like a real feature.

## UI Design

### Player Card

The existing top area remains:

- Current track title.
- Creator.
- Source badge.
- Progress.
- Previous/play-next/replay controls.
- Video mini-window button only when the active item supports video.

The bottom playlist chips become a `QueuePreview`:

- Left side: a short label such as `队列`.
- Main text: next track title if any, otherwise a calm empty state such as `暂无下一首`.
- Secondary text: source badge and creator, kept to one line with ellipsis.
- Right side: a compact manage button using an icon plus short text or tooltip.

The preview should show at most one next item in the card. If there are more queued items, show a small count such as `+3`.

### Management Panel

The panel opens from the right player area. On narrow screens it can behave like a bottom sheet; on desktop it can be a small drawer/popup aligned with the player. It should not cover the main chat more than needed.

Tabs:

- `队列`: current item and upcoming items.
- `最近`: played records from this session.
- `收藏`: saved/favorited items, initially session-local.

Rows show:

- Title.
- Creator.
- Source badge.
- Duration if known.
- Small status text for agent-selected items, for example `来自: 想听三日月`.

Row actions:

- Play.
- Remove from queue or recent list.
- Save/unsave.
- Open video mini-window when `canOpenVideo` is true.
- Open platform page can remain a secondary action if the item has `pageUrl`.

Active row styling should be stronger than the current chip state: source badge, selected background, and a playing indicator.

## Data Model

Add a browser-side queue record model around the existing `MusicItem`.

```ts
type MusicQueueStatus = "current" | "queued" | "played";

type MusicQueueEntry = {
  id: string;
  item: MusicItem;
  status: MusicQueueStatus;
  addedBy: "agent" | "user" | "default";
  addedAt: string;
  lastPlayedAt?: string;
  playCount: number;
  sourceQuery?: string;
  selectedReason?: string;
  selectionEvidence?: string[];
  saved?: boolean;
};
```

The first slice can store these records inside `RoomShell` state or a small `musicQueue` helper. A later persistence slice can move the same shape to the API without forcing a UI rewrite.

## Agent Integration

When the backend returns a `play_music_item` client action:

1. Convert the payload into `MusicItem`.
2. Upsert a `MusicQueueEntry`.
3. Mark it as current and mark the previous current item as played.
4. Copy agent metadata when present:
   - original query.
   - source.
   - score/evidence.
   - selected reason.
5. Append or update a recent record.

The chat reply remains natural language. The queue/records UI carries the operational details.

Later, recent records can be sent back as room context so the agent can avoid repeating failed picks or understand the user's listening history.

## State Rules

- Selecting an item from the queue makes it current.
- Playing a new agent-selected item inserts it if missing, then makes it current.
- Removing the current item should move to the next queued item if one exists; otherwise stop playback cleanly.
- Saved items should remain visible in `收藏` even after they leave the queue.
- Recent records should be capped in the first slice, for example 30 items, to keep browser state small.

## Testing

Frontend tests:

- `RoomShell` renders a compact queue preview instead of the old chip row.
- Queue preview shows next item metadata and count without overflowing the player.
- Manage button opens and closes the panel.
- `play_music_item` client action creates or updates a queue entry with agent metadata.
- Playing a second agent-selected item moves the previous item to recent records.
- Saved item appears in the saved tab.
- Video-capable item exposes the mini-window action.
- Layout regression keeps the player within its right column at desktop and narrower widths.

Helper tests:

- Queue helper upserts by item id.
- Queue helper handles remove-current behavior.
- Queue helper caps recent records.

Verification commands:

- `npm run test --workspace apps/web`
- `npm run build --workspace apps/web`
- Browser smoke test at `http://127.0.0.1:3001/room`

## Acceptance Criteria

- The bottom part of the player no longer looks like a loose tag list.
- The player card still feels visually unchanged at a glance.
- Users can open a real management UI for queue/history/saved records.
- Agent-selected songs create records with query and evidence metadata.
- The UI remains usable without local audio support.
- The player does not horizontally overflow in the right panel.

# NetEase Playlist Import Design

Date: 2026-06-20

## Purpose

KumikoRoom already stores user playlists in browser localStorage and can play NetEase songs through canonical song ids and outer audio URLs. This feature lets a user paste a public NetEase playlist id, direct playlist URL, or share text containing a direct playlist URL, review the resolved playlist, and import it into the existing local music library.

The backend resolves external playlist data. The browser remains the owner of playlist persistence and merge decisions.

## Goals

- Import one public NetEase playlist from a numeric id, direct playlist URL, or share text containing that URL.
- Preserve the remote track order and every remote track id.
- Store imported tracks as regular KumikoRoom `MusicItem` values so existing playlist and queue behavior continues to work.
- Let the user choose between updating a previously linked playlist and creating a detached copy.
- Preserve locally added songs when a linked playlist is updated.
- Keep imported VIP, grey, and region-restricted songs in the playlist.
- Skip a track automatically when the audio element reports a media loading error.
- Keep the backend stateless and the browser music library in localStorage.

## Non-Goals

- NetEase account login, cookies, QR login, or private playlist access.
- Importing every playlist for a NetEase user id.
- Background synchronization or scheduled refresh.
- Two-way synchronization from KumikoRoom back to NetEase.
- Importing albums, artists, daily recommendations, liked-song accounts, or individual song links through this endpoint.
- Replacing the current compact music management panel.
- Mobile-specific visual verification for this slice.

## Chosen Architecture

Use a backend-resolve and frontend-persist flow:

```text
paste id/link/share text
  -> POST /api/room/music/playlists/resolve
  -> backend validates and fetches public NetEase data
  -> frontend shows a playlist preview
  -> user imports, updates, or creates a copy
  -> frontend writes MusicLibraryState to localStorage
```

This follows the existing ownership boundary:

- FastAPI owns external music requests, normalization, and upstream error mapping.
- React owns the local music library, user confirmation, merge behavior, and persistence.
- The resolve endpoint performs no server-side mutation.

The current `scripts/fetch_netease_playlist.py` file is useful prototype evidence for the public endpoints and missing-track recovery flow. Production behavior belongs in the application module and its tests; the script is not a runtime dependency.

## Backend Components

Add a focused NetEase playlist module rather than expanding `music_search.py`. The module has four responsibilities:

1. Parse a playlist id from supported user input.
2. Fetch the public playlist detail payload.
3. Fill missing song metadata in bounded batches.
4. Convert the result into the API response model in `trackIds` order.

Suggested boundary:

```py
resolve_netease_playlist(user_input: str) -> NeteasePlaylistResolveResult
parse_netease_playlist_id(user_input: str) -> str
fetch_netease_playlist(playlist_id: str) -> dict[str, Any]
parse_netease_playlist(payload: dict[str, Any]) -> NeteasePlaylistResolveResult
```

The implementation may use smaller private helpers for HTTP calls and detail batching. HTTP access should remain injectable or mockable in tests.

### Supported Input

The parser accepts:

- a positive numeric playlist id;
- a direct `music.163.com` playlist URL with `id` in the query string;
- a hash-route URL such as `#/playlist?id=...`;
- surrounding share text that contains one of those direct URLs.

The parser rejects:

- song, album, artist, and user links;
- non-NetEase hosts;
- missing, empty, negative, or non-numeric ids;
- arbitrary URLs that would require the server to fetch a user-controlled host.

Short-link expansion is outside the first slice. The input field should tell the user to paste the playlist id or full playlist link when a short link cannot be parsed.

### Fetching and Ordering

The resolver requests the public playlist detail endpoint and reads both `tracks` and `trackIds`.

- Full track records from `tracks` are indexed by song id.
- Song ids absent from `tracks` are requested through the song-detail endpoint in batches of at most 100 ids.
- The final output is rebuilt strictly in `trackIds` order.
- Remote duplicate ids remain in remote order only when NetEase supplies them as distinct `trackIds` entries. The frontend playlist layer still deduplicates by canonical item id because that is its existing identity rule.
- There is no small product-level track limit. Detail batching keeps large playlists within reasonable request sizes.

If a song id still has no metadata after the detail pass, the resolver emits a placeholder at the same position:

- `id`: `netease-song-{song_id}`
- `song_id`: the remote id
- `title`: `网易云歌曲 {song_id}`
- `creator`: `网易云`
- `duration_ms`: `0`
- canonical page and outer audio URLs
- tag `metadata-incomplete`
- `metadata_complete`: `false`

This preserves every remote id and its order. The response also contains a warning count so the UI can explain the incomplete metadata.

## API Contract

Add:

```text
POST /api/room/music/playlists/resolve
```

Request:

```json
{
  "input": "https://music.163.com/#/playlist?id=123456"
}
```

Response shape:

```json
{
  "source": "netease",
  "playlist_id": "123456",
  "name": "111",
  "creator": "zutomama",
  "description": null,
  "cover_url": null,
  "source_url": "https://music.163.com/#/playlist?id=123456",
  "track_count": 16,
  "metadata_incomplete_count": 0,
  "tracks": [
    {
      "id": "netease-song-123",
      "song_id": "123",
      "title": "Song",
      "creator": "Artist",
      "duration_ms": 180000,
      "page_url": "https://music.163.com/#/song?id=123",
      "platform_audio_url": "https://music.163.com/song/media/outer/url?id=123.mp3",
      "tags": ["netease", "playlist-import"],
      "metadata_complete": true
    }
  ]
}
```

`track_count` is the number of remote `trackIds`. `tracks` has the same length because unresolved metadata is represented by placeholders.

## Backend Error Semantics

- `400`: input cannot be parsed as a supported NetEase playlist id or URL.
- `404`: the public playlist does not exist, was deleted, or is not publicly accessible.
- `502`: NetEase times out, returns an unusable response, or omits data required to identify the playlist and its track ids.

Individual missing track metadata does not fail the whole playlist. It produces placeholders and increments `metadata_incomplete_count`.

Outbound requests use fixed NetEase endpoint origins and validated numeric ids. The backend never fetches an arbitrary URL copied from the input.

## Frontend API Types

Add a client function and mapped camelCase types:

```ts
interface NeteasePlaylistPreview {
  source: "netease";
  playlistId: string;
  name: string;
  creator: string;
  description: string | null;
  coverUrl: string | null;
  sourceUrl: string;
  trackCount: number;
  metadataIncompleteCount: number;
  tracks: NeteasePlaylistPreviewTrack[];
}

function resolveNeteasePlaylist(input: string): Promise<NeteasePlaylistPreview>;
```

Each preview track maps deterministically to a NetEase `MusicItem`. Import does not run keyword search and does not involve an LLM.

## Browser Data Model

Extend the local playlist model with optional import provenance. Optional fields preserve compatibility with existing localStorage values.

```ts
interface MusicPlaylistImportSource {
  provider: "netease";
  playlistId: string;
  sourceUrl: string;
  remoteName: string;
  creatorName: string;
  coverUrl?: string;
  linked: boolean;
  importedAt: string;
  syncedAt: string;
}

interface MusicPlaylistItemImportSource {
  provider: "netease";
  playlistId: string;
  trackId: string;
}

type MusicPlaylistAddedBy = MusicQueueAddedBy | "import";

interface MusicPlaylistItem {
  id: string;
  item: MusicItem;
  addedAt: string;
  addedBy: MusicPlaylistAddedBy;
  importSource?: MusicPlaylistItemImportSource;
}

interface MusicPlaylist {
  // existing fields
  importSource?: MusicPlaylistImportSource;
}
```

Hydration validation accepts legacy playlists with no import fields and validates every supplied import field. A malformed imported record makes `isMusicLibraryState` return `false`, after which the existing caller falls back to an empty library.

### Linked Playlist

The first import creates a linked playlist:

- local name and description start from the remote values;
- `importSource.linked` is `true`;
- imported items use `addedBy: "import"` and carry item-level provenance;
- the playlist receives a normal unique local id.

Only a playlist with `linked: true` is considered an update target for the same provider and playlist id.

### Detached Copy

Choosing `创建副本` creates a new local playlist with a unique id and `linked: false`.

- It receives the current remote snapshot.
- Its display name is `{remoteName}（副本）`; duplicate display names remain allowed, and its local id is made unique by the existing id helper.
- A later resolve of the same NetEase playlist offers updates for the linked playlist only.
- The copy keeps provenance for display and diagnostics while behaving as an ordinary local snapshot.

## Update Merge Algorithm

Updating a linked playlist is deterministic:

1. Rebuild the imported block from the latest preview in remote order.
2. Refresh imported item metadata from the latest response.
3. Remove imported items that no longer exist remotely.
4. Treat an existing item as locally added when it has no import provenance matching this NetEase playlist, and preserve those items in their current relative order.
5. Drop a preserved local item when its canonical `item.id` already exists in the new imported block.
6. Append the remaining local items after the imported block.
7. Preserve the local playlist name, description, id, and `createdAt`.
8. Refresh remote provenance, `syncedAt`, and playlist `updatedAt`.

A remote item manually removed by the user appears again on the next update while it remains in the NetEase playlist. This is the defined meaning of updating a linked playlist.

The merge helper is a pure function in the music-library module so it can be unit tested without rendering React.

## User Interface

Add a compact import area at the top of the existing `我的歌单` tab. It contains one input and a `读取歌单` command. The input accepts an id, direct link, or surrounding share text.

States:

- **Idle**: input and `读取歌单` are available.
- **Loading**: disable repeat submission and show a small progress label.
- **Preview, new**: show remote name, creator, track count, `导入`, and `取消`.
- **Preview, linked playlist found**: show `更新`, `创建副本`, and `取消`.
- **Success**: select the created or updated playlist and show a short message such as `已导入 16 首` or `已更新 16 首`.
- **Warning**: add `有 2 首歌曲信息不完整，仍已保留` when placeholders exist.
- **Error**: show the mapped error in the import area and leave the current library unchanged.

Linked playlist rows show a restrained `网易云` source label and last synchronized time. Detached copies use the ordinary local playlist presentation.

Import confirmation and conflict choices stay inline within the panel. No large modal is required.

## Playback Failure Handling

Imported restricted songs remain in playlists and queues. Availability is decided by the browser media element at playback time.

Add an `onError` handler to the platform `<audio>` element:

- When another queue item exists, show `《歌曲名》暂时无法播放，已跳过` and advance once.
- At the end of the queue, stop playback and show `《歌曲名》暂时无法播放`.
- Guard by active item id so repeated media error events for the same source cannot advance more than once.
- Reset the guard when the active item changes.
- Consecutive unavailable tracks advance one by one and terminate at a playable item or the queue end.

The existing `audio.play()` promise rejection path remains separate. Browser autoplay denial pauses the player and does not advance the queue.

## State Integrity

- A resolve request never mutates the library.
- Import, update, and copy each compute one complete next `MusicLibraryState` before committing it.
- Failed resolve and failed mapping leave localStorage unchanged.
- The selected playlist changes only after a successful commit.
- Queue, recent, saved, and recommendation profile state are not rewritten during import.
- Imported songs become visible to the existing agent music-state snapshot through the normal playlist mapping.

## Testing

### Backend Unit Tests

- Parse a numeric playlist id.
- Parse query-string and hash-route playlist URLs.
- Extract a direct playlist URL from surrounding share text.
- Reject blank input, non-NetEase hosts, and song or album links.
- Parse complete playlist payloads.
- Fetch missing song details in batches of at most 100.
- Rebuild tracks in `trackIds` order.
- Emit placeholders and the correct incomplete count when details remain missing.
- Preserve canonical ids, URLs, durations, creators, and tags.

### Backend Route Tests

- Map a successful resolver result to the API schema.
- Return `400` for invalid input.
- Return `404` for missing or inaccessible public playlists.
- Return `502` for upstream timeout or unusable playlist payloads.
- Mock all HTTP calls; automated tests never depend on live NetEase availability.

### Frontend Helper Tests

- Map the resolve response from snake_case to camelCase.
- Create a linked playlist from a preview.
- Update imported items in remote order.
- Remove remote deletions.
- Preserve local additions and their relative order.
- Deduplicate local additions against remote canonical ids.
- Preserve local name, description, id, and creation time.
- Create a detached copy with a unique id.
- Find only linked playlists as update targets.
- Hydrate legacy playlists and reject malformed import provenance.

### Frontend Component Tests

- Render idle, loading, preview, conflict, success, warning, and error states.
- Disable repeat resolve while loading.
- Import a new playlist and persist it.
- Update the linked playlist when selected.
- Create and persist a detached copy when selected.
- Leave the library unchanged after API failure.
- Select the successfully created or updated playlist.

### Player Tests

- A media error advances once when a next item exists.
- Repeated error events for one active item do not skip multiple tracks.
- Consecutive media errors advance through consecutive unavailable items.
- A media error at queue end stops playback.
- A rejected `play()` promise pauses playback without advancing.

### Manual Verification

- Use the existing public sample playlist represented by `playlist_111.txt` or another public playlist id.
- Resolve from raw id, full link, and surrounding share text.
- Import it and verify remote order, names, creators, and localStorage persistence.
- Add a local song, change the remote fixture, update, and verify the local song remains at the end.
- Create a detached copy and verify a later import targets only the linked playlist.
- Simulate an audio media error and verify the player advances once.
- Perform desktop verification only for this slice.

## Acceptance Criteria

- A user can paste a public NetEase playlist id, direct URL, or compatible share text and preview its metadata.
- Import creates a playback-ready local playlist with canonical song URLs, the remote track order, and every remote track id represented.
- Resolving the same playlist offers update, create-copy, and cancel choices.
- Update reflects current remote tracks while preserving non-duplicate local additions after the imported block.
- A detached copy is excluded from future update-target matching.
- Existing local playlists continue to hydrate and behave normally.
- Restricted tracks remain visible and media errors advance safely through the queue.
- Invalid input and upstream failures do not mutate the music library.
- No LLM or keyword-search fallback participates in playlist import.
- Automated tests use mocked NetEase responses and desktop verification covers the visible workflow.

# NetEase Playlist Import Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let users resolve a public NetEase playlist, import or synchronize it into the browser-owned music library, and safely skip unavailable audio tracks.

**Architecture:** A focused FastAPI module resolves and normalizes NetEase playlist data through fixed upstream endpoints. The React client previews that data and applies pure create/update/copy mutations to `MusicLibraryState`; a small dedicated import component owns request UI state while `RoomShell` keeps persistence and playback ownership.

**Tech Stack:** Python 3.11, FastAPI, Pydantic v2, httpx, pytest, TypeScript, React 18, Next.js 14, Vitest, Testing Library.

---

## File Map

- Create `apps/api/kumikoroom/netease_playlist.py`: input parsing, fixed-origin HTTP requests, detail batching, ordering, placeholders, domain errors.
- Create `apps/api/tests/test_netease_playlist.py`: parser and resolver unit tests using `httpx.MockTransport`.
- Modify `apps/api/kumikoroom/schemas.py`: resolve request/response schemas.
- Modify `apps/api/kumikoroom/routers/room.py`: stateless resolve endpoint and status mapping.
- Modify `apps/api/tests/test_room_api.py`: route contract and error mapping tests.
- Modify `apps/web/src/api/types.ts`: playlist preview types.
- Modify `apps/web/src/api/client.ts`: resolve request and response mapper.
- Modify `apps/web/tests/client.test.ts`: request and mapping test.
- Modify `apps/web/src/lib/musicItems.ts`: preview-track to `MusicItem` conversion.
- Modify `apps/web/src/lib/musicLibrary.ts`: import provenance, hydration, linked lookup, create/copy/update helpers.
- Modify `apps/web/tests/musicItems.test.ts`: imported-track conversion test.
- Modify `apps/web/tests/musicLibrary.test.ts`: creation, copy, merge, dedupe, and legacy hydration tests.
- Create `apps/web/src/components/NeteasePlaylistImport.tsx`: inline resolve/preview/conflict/success/error workflow.
- Create `apps/web/tests/NeteasePlaylistImport.test.tsx`: component state tests.
- Modify `apps/web/src/components/RoomShell.tsx`: mount import component, commit results, handle media errors.
- Modify `apps/web/tests/RoomShell.test.tsx`: persistence integration and audio-error tests.
- Modify `apps/web/app/globals.css`: compact import UI and player notice styles.

## Task 1: NetEase Playlist Resolver

**Files:**
- Create: `apps/api/tests/test_netease_playlist.py`
- Create: `apps/api/kumikoroom/netease_playlist.py`

- [ ] **Step 1: Write parser and resolver tests**

Create `apps/api/tests/test_netease_playlist.py` with these cases:

```python
import json

import httpx
import pytest

from kumikoroom.netease_playlist import (
    NeteasePlaylistInputError,
    parse_netease_playlist_id,
    resolve_netease_playlist,
)


@pytest.mark.parametrize(
    ("value", "expected"),
    [
        ("14320948412", "14320948412"),
        ("https://music.163.com/playlist?id=14320948412", "14320948412"),
        ("https://music.163.com/#/playlist?id=14320948412", "14320948412"),
        (
            "分享歌单 https://music.163.com/playlist?id=14320948412&userid=1 欢迎收听",
            "14320948412",
        ),
    ],
)
def test_parse_netease_playlist_id(value: str, expected: str) -> None:
    assert parse_netease_playlist_id(value) == expected


@pytest.mark.parametrize(
    "value",
    [
        "",
        "-1",
        "https://example.com/playlist?id=1",
        "https://music.163.com/song?id=1",
        "https://music.163.com/album?id=1",
    ],
)
def test_parse_netease_playlist_id_rejects_unsupported_input(value: str) -> None:
    with pytest.raises(NeteasePlaylistInputError):
        parse_netease_playlist_id(value)


def test_resolve_netease_playlist_backfills_and_restores_track_order() -> None:
    requests: list[httpx.Request] = []

    def handler(request: httpx.Request) -> httpx.Response:
        requests.append(request)
        if request.url.path == "/api/v6/playlist/detail":
            return httpx.Response(
                200,
                json={
                    "playlist": {
                        "name": "111",
                        "description": "sample",
                        "coverImgUrl": "https://p1.music.126.net/cover.jpg",
                        "creator": {"nickname": "zutomama"},
                        "trackIds": [{"id": 2}, {"id": 1}],
                        "tracks": [
                            {
                                "id": 1,
                                "name": "First",
                                "ar": [{"name": "Artist A"}],
                                "dt": 180000,
                            }
                        ],
                    }
                },
            )
        if request.url.path == "/api/song/detail":
            return httpx.Response(
                200,
                json={
                    "songs": [
                        {
                            "id": 2,
                            "name": "Second",
                            "artists": [{"name": "Artist B"}],
                            "duration": 210000,
                        }
                    ]
                },
            )
        raise AssertionError(request.url)

    with httpx.Client(transport=httpx.MockTransport(handler)) as client:
        result = resolve_netease_playlist("14320948412", client=client)

    assert result.playlist_id == "14320948412"
    assert result.name == "111"
    assert [track.song_id for track in result.tracks] == ["2", "1"]
    assert result.tracks[0].title == "Second"
    assert result.tracks[0].creator == "Artist B"
    assert result.metadata_incomplete_count == 0
    assert [request.url.path for request in requests] == [
        "/api/v6/playlist/detail",
        "/api/song/detail",
    ]


def test_resolve_netease_playlist_emits_placeholder_for_missing_metadata() -> None:
    def handler(request: httpx.Request) -> httpx.Response:
        if request.url.path == "/api/v6/playlist/detail":
            return httpx.Response(
                200,
                json={
                    "playlist": {
                        "name": "Missing",
                        "creator": {"nickname": "Owner"},
                        "trackIds": [{"id": 99}],
                        "tracks": [],
                    }
                },
            )
        return httpx.Response(200, json={"songs": []})

    with httpx.Client(transport=httpx.MockTransport(handler)) as client:
        result = resolve_netease_playlist("99", client=client)

    assert result.metadata_incomplete_count == 1
    assert result.tracks[0].title == "网易云歌曲 99"
    assert result.tracks[0].duration_ms == 0
    assert result.tracks[0].metadata_complete is False
    assert result.tracks[0].tags == [
        "netease",
        "playlist-import",
        "metadata-incomplete",
    ]


def test_resolve_netease_playlist_batches_song_detail_requests() -> None:
    detail_batches: list[list[int]] = []

    def handler(request: httpx.Request) -> httpx.Response:
        if request.url.path == "/api/v6/playlist/detail":
            return httpx.Response(
                200,
                json={
                    "playlist": {
                        "name": "Large",
                        "creator": {"nickname": "Owner"},
                        "trackIds": [{"id": value} for value in range(1, 102)],
                        "tracks": [],
                    }
                },
            )
        ids = json.loads(request.url.params["ids"])
        detail_batches.append(ids)
        return httpx.Response(200, json={"songs": []})

    with httpx.Client(transport=httpx.MockTransport(handler)) as client:
        resolve_netease_playlist("101", client=client)

    assert [len(batch) for batch in detail_batches] == [100, 1]
```

- [ ] **Step 2: Run the resolver tests and confirm the red state**

Run from `apps/api`:

```powershell
python -m pytest tests/test_netease_playlist.py -q --basetemp=.pytest-runtime-np-resolver-red -p no:cacheprovider
```

Expected: collection fails with `ModuleNotFoundError: No module named 'kumikoroom.netease_playlist'`.

- [ ] **Step 3: Implement the resolver module**

Create `apps/api/kumikoroom/netease_playlist.py` with:

```python
from __future__ import annotations

from dataclasses import dataclass
import re
from typing import Any, Iterator
from urllib.parse import parse_qs, urlsplit

import httpx


PLAYLIST_DETAIL_URL = "https://music.163.com/api/v6/playlist/detail"
SONG_DETAIL_URL = "https://music.163.com/api/song/detail"
HEADERS = {"User-Agent": "Mozilla/5.0", "Referer": "https://music.163.com/"}
URL_PATTERN = re.compile(r"https?://[^\s<>\"']+")
NUMERIC_ID_PATTERN = re.compile(r"^[0-9]+$")
DETAIL_BATCH_SIZE = 100


class NeteasePlaylistInputError(ValueError):
    pass


class NeteasePlaylistNotFoundError(RuntimeError):
    pass


class NeteasePlaylistUpstreamError(RuntimeError):
    pass


@dataclass(frozen=True)
class NeteasePlaylistTrack:
    id: str
    song_id: str
    title: str
    creator: str
    duration_ms: int
    page_url: str
    platform_audio_url: str
    tags: list[str]
    metadata_complete: bool


@dataclass(frozen=True)
class NeteasePlaylistResolveResult:
    source: str
    playlist_id: str
    name: str
    creator: str
    description: str | None
    cover_url: str | None
    source_url: str
    track_count: int
    metadata_incomplete_count: int
    tracks: list[NeteasePlaylistTrack]


def parse_netease_playlist_id(user_input: str) -> str:
    value = user_input.strip()
    if NUMERIC_ID_PATTERN.fullmatch(value) and int(value) > 0:
        return value

    for raw_url in URL_PATTERN.findall(value):
        candidate = raw_url.rstrip("。，,;；)）]】")
        parsed = urlsplit(candidate)
        host = (parsed.hostname or "").lower()
        if host != "music.163.com" and not host.endswith(".music.163.com"):
            continue

        route = parsed.path
        query = parsed.query
        fragment_path, separator, fragment_query = parsed.fragment.partition("?")
        if "/playlist" not in route and "/playlist" not in fragment_path:
            continue
        if not query and separator:
            query = fragment_query
        playlist_id = (parse_qs(query).get("id") or [""])[0].strip()
        if NUMERIC_ID_PATTERN.fullmatch(playlist_id) and int(playlist_id) > 0:
            return playlist_id

    raise NeteasePlaylistInputError("请输入网易云歌单 ID 或完整歌单链接")


def resolve_netease_playlist(
    user_input: str,
    *,
    client: httpx.Client | None = None,
) -> NeteasePlaylistResolveResult:
    playlist_id = parse_netease_playlist_id(user_input)
    owned_client = client is None
    active_client = client or httpx.Client(headers=HEADERS, timeout=15.0)
    try:
        playlist_payload = _fetch_playlist_payload(active_client, playlist_id)
        playlist = playlist_payload.get("playlist")
        if not isinstance(playlist, dict):
            raise NeteasePlaylistNotFoundError("找不到可公开访问的网易云歌单")
        if "trackIds" not in playlist or not isinstance(playlist["trackIds"], list):
            raise NeteasePlaylistUpstreamError("网易云歌单响应缺少曲目顺序")

        ordered_ids = [
            str(entry["id"])
            for entry in playlist["trackIds"]
            if isinstance(entry, dict) and entry.get("id") is not None
        ]
        indexed = _index_tracks(playlist.get("tracks"))
        missing_ids = [song_id for song_id in ordered_ids if song_id not in indexed]
        indexed.update(_fetch_missing_tracks(active_client, missing_ids))
        tracks = [_materialize_track(song_id, indexed.get(song_id)) for song_id in ordered_ids]
        return NeteasePlaylistResolveResult(
            source="netease",
            playlist_id=playlist_id,
            name=str(playlist.get("name") or f"网易云歌单 {playlist_id}").strip(),
            creator=str((playlist.get("creator") or {}).get("nickname") or "网易云").strip(),
            description=_optional_string(playlist.get("description")),
            cover_url=_optional_string(playlist.get("coverImgUrl")),
            source_url=f"https://music.163.com/#/playlist?id={playlist_id}",
            track_count=len(tracks),
            metadata_incomplete_count=sum(not track.metadata_complete for track in tracks),
            tracks=tracks,
        )
    finally:
        if owned_client:
            active_client.close()


def _fetch_playlist_payload(client: httpx.Client, playlist_id: str) -> dict[str, Any]:
    try:
        response = client.get(PLAYLIST_DETAIL_URL, params={"id": playlist_id}, headers=HEADERS)
        if response.status_code == 404:
            raise NeteasePlaylistNotFoundError("找不到可公开访问的网易云歌单")
        response.raise_for_status()
        payload = response.json()
    except NeteasePlaylistNotFoundError:
        raise
    except (httpx.HTTPError, ValueError) as error:
        raise NeteasePlaylistUpstreamError("网易云歌单读取失败，请稍后重试") from error
    if not isinstance(payload, dict):
        raise NeteasePlaylistUpstreamError("网易云歌单返回了无效数据")
    return payload


def _fetch_missing_tracks(
    client: httpx.Client,
    song_ids: list[str],
) -> dict[str, dict[str, Any]]:
    indexed: dict[str, dict[str, Any]] = {}
    for batch in _batches(song_ids, DETAIL_BATCH_SIZE):
        try:
            response = client.get(
                SONG_DETAIL_URL,
                params={"ids": "[" + ",".join(batch) + "]"},
                headers=HEADERS,
            )
            response.raise_for_status()
            indexed.update(_index_tracks(response.json().get("songs")))
        except (httpx.HTTPError, ValueError, AttributeError):
            continue
    return indexed


def _index_tracks(value: Any) -> dict[str, dict[str, Any]]:
    if not isinstance(value, list):
        return {}
    return {
        str(track["id"]): track
        for track in value
        if isinstance(track, dict) and track.get("id") is not None
    }


def _materialize_track(song_id: str, raw: dict[str, Any] | None) -> NeteasePlaylistTrack:
    complete = raw is not None
    raw = raw or {}
    artists = raw.get("ar") or raw.get("artists") or []
    creator = ", ".join(
        str(artist.get("name") or "").strip()
        for artist in artists
        if isinstance(artist, dict) and str(artist.get("name") or "").strip()
    )
    tags = ["netease", "playlist-import"]
    if not complete:
        tags.append("metadata-incomplete")
    return NeteasePlaylistTrack(
        id=f"netease-song-{song_id}",
        song_id=song_id,
        title=str(raw.get("name") or f"网易云歌曲 {song_id}").strip(),
        creator=creator or "网易云",
        duration_ms=_safe_int(raw.get("dt", raw.get("duration"))),
        page_url=f"https://music.163.com/#/song?id={song_id}",
        platform_audio_url=f"https://music.163.com/song/media/outer/url?id={song_id}.mp3",
        tags=tags,
        metadata_complete=complete,
    )


def _batches(values: list[str], size: int) -> Iterator[list[str]]:
    for start in range(0, len(values), size):
        yield values[start : start + size]


def _optional_string(value: Any) -> str | None:
    text = str(value or "").strip()
    return text or None


def _safe_int(value: Any) -> int:
    try:
        return int(value or 0)
    except (TypeError, ValueError):
        return 0
```

- [ ] **Step 4: Run resolver tests**

Run:

```powershell
python -m pytest tests/test_netease_playlist.py -q --basetemp=.pytest-runtime-np-resolver-green -p no:cacheprovider
```

Expected: all resolver tests pass.

- [ ] **Step 5: Commit the resolver**

```powershell
git add -- apps/api/kumikoroom/netease_playlist.py apps/api/tests/test_netease_playlist.py
git commit -m "feat: resolve public NetEase playlists"
```

## Task 2: Resolve API Contract

**Files:**
- Modify: `apps/api/kumikoroom/schemas.py`
- Modify: `apps/api/kumikoroom/routers/room.py`
- Modify: `apps/api/tests/test_room_api.py`

- [ ] **Step 1: Add failing route tests**

Add imports for the resolver dataclasses and exceptions, then append these tests:

```python
from kumikoroom.netease_playlist import (
    NeteasePlaylistInputError,
    NeteasePlaylistNotFoundError,
    NeteasePlaylistResolveResult,
    NeteasePlaylistTrack,
    NeteasePlaylistUpstreamError,
)


def test_netease_playlist_resolve_maps_result(
    client: TestClient,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    result = NeteasePlaylistResolveResult(
        source="netease",
        playlist_id="123",
        name="111",
        creator="zutomama",
        description="sample",
        cover_url="https://p1.music.126.net/cover.jpg",
        source_url="https://music.163.com/#/playlist?id=123",
        track_count=1,
        metadata_incomplete_count=0,
        tracks=[
            NeteasePlaylistTrack(
                id="netease-song-9",
                song_id="9",
                title="Song",
                creator="Artist",
                duration_ms=180000,
                page_url="https://music.163.com/#/song?id=9",
                platform_audio_url="https://music.163.com/song/media/outer/url?id=9.mp3",
                tags=["netease", "playlist-import"],
                metadata_complete=True,
            )
        ],
    )
    monkeypatch.setattr(
        "kumikoroom.routers.room.resolve_netease_playlist",
        lambda value: result,
    )

    response = client.post(
        "/api/room/music/playlists/resolve",
        json={"input": "123"},
    )

    assert response.status_code == 200
    assert response.json() == {
        "source": "netease",
        "playlist_id": "123",
        "name": "111",
        "creator": "zutomama",
        "description": "sample",
        "cover_url": "https://p1.music.126.net/cover.jpg",
        "source_url": "https://music.163.com/#/playlist?id=123",
        "track_count": 1,
        "metadata_incomplete_count": 0,
        "tracks": [
            {
                "id": "netease-song-9",
                "song_id": "9",
                "title": "Song",
                "creator": "Artist",
                "duration_ms": 180000,
                "page_url": "https://music.163.com/#/song?id=9",
                "platform_audio_url": "https://music.163.com/song/media/outer/url?id=9.mp3",
                "tags": ["netease", "playlist-import"],
                "metadata_complete": True,
            }
        ],
    }


@pytest.mark.parametrize(
    ("error", "status_code"),
    [
        (NeteasePlaylistInputError("bad input"), 400),
        (NeteasePlaylistNotFoundError("missing"), 404),
        (NeteasePlaylistUpstreamError("upstream"), 502),
    ],
)
def test_netease_playlist_resolve_maps_domain_errors(
    client: TestClient,
    monkeypatch: pytest.MonkeyPatch,
    error: Exception,
    status_code: int,
) -> None:
    def fail(_: str):
        raise error

    monkeypatch.setattr("kumikoroom.routers.room.resolve_netease_playlist", fail)
    response = client.post("/api/room/music/playlists/resolve", json={"input": "x"})
    assert response.status_code == status_code
```

- [ ] **Step 2: Run route tests and confirm failure**

```powershell
python -m pytest tests/test_room_api.py -k "netease_playlist_resolve" -q --basetemp=.pytest-runtime-np-route-red -p no:cacheprovider
```

Expected: `404 Not Found` for the new route or import failures for missing schemas.

- [ ] **Step 3: Add Pydantic schemas**

Add after `MusicSearchResultOut` in `schemas.py`:

```python
class NeteasePlaylistResolveIn(BaseModel):
    input: str = Field(min_length=1)


class NeteasePlaylistTrackOut(BaseModel):
    id: str
    song_id: str
    title: str
    creator: str
    duration_ms: int
    page_url: str
    platform_audio_url: str
    tags: list[str] = Field(default_factory=list)
    metadata_complete: bool


class NeteasePlaylistResolveOut(BaseModel):
    source: Literal["netease"]
    playlist_id: str
    name: str
    creator: str
    description: str | None = None
    cover_url: str | None = None
    source_url: str
    track_count: int
    metadata_incomplete_count: int
    tracks: list[NeteasePlaylistTrackOut] = Field(default_factory=list)
```

- [ ] **Step 4: Add the stateless route**

Import the resolver, errors, and schemas. Add before the Auto DJ endpoint:

```python
@router.post(
    "/music/playlists/resolve",
    response_model=NeteasePlaylistResolveOut,
)
def resolve_music_playlist(
    payload: NeteasePlaylistResolveIn,
) -> NeteasePlaylistResolveOut:
    try:
        result = resolve_netease_playlist(payload.input)
    except NeteasePlaylistInputError as error:
        raise HTTPException(status_code=400, detail=str(error)) from error
    except NeteasePlaylistNotFoundError as error:
        raise HTTPException(status_code=404, detail=str(error)) from error
    except NeteasePlaylistUpstreamError as error:
        raise HTTPException(status_code=502, detail=str(error)) from error
    return NeteasePlaylistResolveOut.model_validate(asdict(result))
```

- [ ] **Step 5: Run backend focused tests**

```powershell
python -m pytest tests/test_netease_playlist.py tests/test_room_api.py -q --basetemp=.pytest-runtime-np-api-green -p no:cacheprovider
```

Expected: all tests in both files pass.

- [ ] **Step 6: Commit the API contract**

```powershell
git add -- apps/api/kumikoroom/schemas.py apps/api/kumikoroom/routers/room.py apps/api/tests/test_room_api.py
git commit -m "feat: expose NetEase playlist resolve API"
```

## Task 3: Frontend API Mapping

**Files:**
- Modify: `apps/web/src/api/types.ts`
- Modify: `apps/web/src/api/client.ts`
- Modify: `apps/web/tests/client.test.ts`

- [ ] **Step 1: Add a failing client test**

Add this test:

```ts
it("resolves and maps a NetEase playlist preview", async () => {
  const fetchMock = vi.fn(async () => ({
    ok: true,
    status: 200,
    statusText: "OK",
    text: async () => JSON.stringify({
      source: "netease",
      playlist_id: "14320948412",
      name: "111",
      creator: "zutomama",
      description: null,
      cover_url: null,
      source_url: "https://music.163.com/#/playlist?id=14320948412",
      track_count: 1,
      metadata_incomplete_count: 0,
      tracks: [{
        id: "netease-song-9",
        song_id: "9",
        title: "Song",
        creator: "Artist",
        duration_ms: 180000,
        page_url: "https://music.163.com/#/song?id=9",
        platform_audio_url: "https://music.163.com/song/media/outer/url?id=9.mp3",
        tags: ["netease", "playlist-import"],
        metadata_complete: true
      }]
    })
  }));
  vi.stubGlobal("fetch", fetchMock);

  await expect(roomApi.resolveNeteasePlaylist("14320948412")).resolves.toEqual({
    source: "netease",
    playlistId: "14320948412",
    name: "111",
    creator: "zutomama",
    description: null,
    coverUrl: null,
    sourceUrl: "https://music.163.com/#/playlist?id=14320948412",
    trackCount: 1,
    metadataIncompleteCount: 0,
    tracks: [{
      id: "netease-song-9",
      songId: "9",
      title: "Song",
      creator: "Artist",
      durationMs: 180000,
      pageUrl: "https://music.163.com/#/song?id=9",
      platformAudioUrl: "https://music.163.com/song/media/outer/url?id=9.mp3",
      tags: ["netease", "playlist-import"],
      metadataComplete: true
    }]
  });
expect(fetchMock).toHaveBeenCalledWith(
  "/api/room/music/playlists/resolve",
  expect.objectContaining({ method: "POST" })
);
expect(requestBody(fetchMock)).toEqual({ input: "14320948412" });
});
```

- [ ] **Step 2: Run the client test and confirm failure**

From `apps/web`:

```powershell
npm test -- tests/client.test.ts
```

Expected: failure because `resolveNeteasePlaylist` is missing.

- [ ] **Step 3: Add public frontend types**

Add to `api/types.ts`:

```ts
export interface NeteasePlaylistPreviewTrack {
  id: string;
  songId: string;
  title: string;
  creator: string;
  durationMs: number;
  pageUrl: string;
  platformAudioUrl: string;
  tags: string[];
  metadataComplete: boolean;
}

export interface NeteasePlaylistPreview {
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
```

- [ ] **Step 4: Add request and mapper code**

Import the two types in `client.ts`, then add:

```ts
export function resolveNeteasePlaylist(input: string): Promise<NeteasePlaylistPreview> {
  return request<NeteasePlaylistPreviewApi>("/api/room/music/playlists/resolve", {
    method: "POST",
    body: JSON.stringify({ input })
  }).then(mapNeteasePlaylistPreview);
}

interface NeteasePlaylistPreviewTrackApi {
  id: string;
  song_id: string;
  title: string;
  creator: string;
  duration_ms: number;
  page_url: string;
  platform_audio_url: string;
  tags: string[];
  metadata_complete: boolean;
}

interface NeteasePlaylistPreviewApi {
  source: "netease";
  playlist_id: string;
  name: string;
  creator: string;
  description: string | null;
  cover_url: string | null;
  source_url: string;
  track_count: number;
  metadata_incomplete_count: number;
  tracks: NeteasePlaylistPreviewTrackApi[];
}

function mapNeteasePlaylistPreview(value: NeteasePlaylistPreviewApi): NeteasePlaylistPreview {
  return {
    source: value.source,
    playlistId: value.playlist_id,
    name: value.name,
    creator: value.creator,
    description: value.description,
    coverUrl: value.cover_url,
    sourceUrl: value.source_url,
    trackCount: value.track_count,
    metadataIncompleteCount: value.metadata_incomplete_count,
    tracks: value.tracks.map((track) => ({
      id: track.id,
      songId: track.song_id,
      title: track.title,
      creator: track.creator,
      durationMs: track.duration_ms,
      pageUrl: track.page_url,
      platformAudioUrl: track.platform_audio_url,
      tags: [...track.tags],
      metadataComplete: track.metadata_complete
    }))
  };
}
```

- [ ] **Step 5: Run and commit frontend API changes**

```powershell
npm test -- tests/client.test.ts
git add -- apps/web/src/api/types.ts apps/web/src/api/client.ts apps/web/tests/client.test.ts
git commit -m "feat: map NetEase playlist previews"
```

Expected: `client.test.ts` passes before the commit.

## Task 4: Music Library Import and Synchronization

**Files:**
- Modify: `apps/web/src/lib/musicItems.ts`
- Modify: `apps/web/src/lib/musicLibrary.ts`
- Modify: `apps/web/tests/musicItems.test.ts`
- Modify: `apps/web/tests/musicLibrary.test.ts`

- [ ] **Step 1: Add failing conversion and library tests**

Import the new helpers and add a fixed preview fixture:

```ts
function makePreview(): NeteasePlaylistPreview {
  return {
    source: "netease",
    playlistId: "123",
    name: "Remote List",
    creator: "Owner",
    description: "remote description",
    coverUrl: "https://p1.music.126.net/cover.jpg",
    sourceUrl: "https://music.163.com/#/playlist?id=123",
    trackCount: 2,
    metadataIncompleteCount: 0,
    tracks: [
      {
        id: "netease-song-1",
        songId: "1",
        title: "One",
        creator: "Artist One",
        durationMs: 180000,
        pageUrl: "https://music.163.com/#/song?id=1",
        platformAudioUrl: "https://music.163.com/song/media/outer/url?id=1.mp3",
        tags: ["netease", "playlist-import"],
        metadataComplete: true
      },
      {
        id: "netease-song-2",
        songId: "2",
        title: "Two",
        creator: "Artist Two",
        durationMs: 210000,
        pageUrl: "https://music.163.com/#/song?id=2",
        platformAudioUrl: "https://music.163.com/song/media/outer/url?id=2.mp3",
        tags: ["netease", "playlist-import"],
        metadataComplete: true
      }
    ]
  };
}
```

Add complete create/copy and merge tests:

```ts
it("creates linked imports and detached copies", () => {
  const linked = createNeteasePlaylistImport(
    createInitialMusicLibrary(),
    makePreview(),
    true,
    "2026-06-20T00:00:00.000Z"
  );
  const copy = createNeteasePlaylistImport(
    linked.library,
    makePreview(),
    false,
    "2026-06-20T00:01:00.000Z"
  );

  expect(linked.playlistId).toBe("playlist-netease-123");
  expect(linked.library.playlists[0].items.map((entry) => entry.id)).toEqual([
    "netease-song-1",
    "netease-song-2"
  ]);
  expect(linked.library.playlists[0].items[0]).toMatchObject({
    addedBy: "import",
    importSource: { provider: "netease", playlistId: "123", trackId: "1" }
  });
  expect(linked.library.playlists[0].importSource).toMatchObject({
    linked: true,
    importedAt: "2026-06-20T00:00:00.000Z",
    syncedAt: "2026-06-20T00:00:00.000Z"
  });
  expect(copy.library.playlists[1].name).toBe("Remote List（副本）");
  expect(copy.library.playlists[1].importSource?.linked).toBe(false);
  expect(findLinkedNeteasePlaylist(copy.library, "123")?.id).toBe(linked.playlistId);
});

it("updates the remote block and preserves local additions", () => {
  const imported = createNeteasePlaylistImport(
    createInitialMusicLibrary(),
    makePreview(),
    true,
    "2026-06-20T00:00:00.000Z"
  );
  const renamed = renameMusicPlaylist(
    imported.library,
    imported.playlistId,
    "My Local Name",
    "2026-06-20T00:01:00.000Z"
  );
  const withLocal = addMusicItemToPlaylist(
    renamed,
    imported.playlistId,
    makeItem("local", "Local"),
    "user",
    "2026-06-20T00:02:00.000Z"
  );
  const nextPreview = makePreview();
  nextPreview.tracks = [
    { ...nextPreview.tracks[1], title: "Two Updated" },
    {
      ...nextPreview.tracks[0],
      id: "local",
      songId: "3",
      title: "Remote Wins"
    }
  ];
  const result = updateLinkedNeteasePlaylist(
    withLocal,
    imported.playlistId,
    nextPreview,
    "2026-06-20T00:03:00.000Z"
  );

  expect(result).not.toBeNull();
  const playlist = result!.library.playlists[0];
  expect(playlist.name).toBe("My Local Name");
  expect(playlist.createdAt).toBe("2026-06-20T00:00:00.000Z");
  expect(playlist.items.map((entry) => entry.id)).toEqual(["netease-song-2", "local"]);
  expect(playlist.items[0].item.title).toBe("Two Updated");
  expect(playlist.items[1].item.title).toBe("Remote Wins");
  expect(playlist.importSource?.syncedAt).toBe("2026-06-20T00:03:00.000Z");
});
```

Also add small focused tests for these outcomes:

- preview tracks become NetEase `MusicItem` values with canonical URLs and `canOpenVideo: false`;
- old stored playlists still validate;
- malformed playlist or item import provenance fails validation.

- [ ] **Step 2: Run helper tests and confirm failure**

```powershell
npm test -- tests/musicItems.test.ts tests/musicLibrary.test.ts
```

Expected: missing exported types and functions.

- [ ] **Step 3: Add imported-track conversion**

Import `NeteasePlaylistPreviewTrack` in `musicItems.ts` and add:

```ts
export function makeMusicItemFromNeteasePlaylistTrack(
  track: NeteasePlaylistPreviewTrack
): MusicItem {
  const parsedSong = parseNeteaseSongUrl(track.pageUrl);
  return {
    id: track.id,
    source: "netease",
    title: track.title,
    creator: track.creator,
    durationMs: track.durationMs,
    pageUrl: track.pageUrl,
    embedUrl: parsedSong?.embedUrl,
    platformAudioUrl: track.platformAudioUrl,
    tags: [...track.tags],
    canOpenVideo: false
  };
}
```

- [ ] **Step 4: Add provenance types and pure mutations**

In `musicLibrary.ts`, import `NeteasePlaylistPreview` and the new converter. Add these exported types and signatures:

```ts
export type MusicPlaylistAddedBy = MusicQueueAddedBy | "import";

export interface MusicPlaylistImportSource {
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

export interface MusicPlaylistItemImportSource {
  provider: "netease";
  playlistId: string;
  trackId: string;
}

export interface MusicLibraryMutationResult {
  library: MusicLibraryState;
  playlistId: string;
}
```

Change `MusicPlaylistItem.addedBy` to `MusicPlaylistAddedBy`, add optional item provenance, and add optional playlist provenance. Implement:

```ts
export function findLinkedNeteasePlaylist(
  state: MusicLibraryState,
  playlistId: string
): MusicPlaylist | null {
  const playlist = state.playlists.find(
    (candidate) =>
      candidate.importSource?.provider === "netease" &&
      candidate.importSource.playlistId === playlistId &&
      candidate.importSource.linked
  );
  return playlist ? clonePlaylist(playlist) : null;
}

export function createNeteasePlaylistImport(
  state: MusicLibraryState,
  preview: NeteasePlaylistPreview,
  linked: boolean,
  now = currentIsoTime()
): MusicLibraryMutationResult {
  const name = linked ? preview.name : `${preview.name}（副本）`;
  const baseId = linked
    ? `playlist-netease-${preview.playlistId}`
    : `playlist-netease-${preview.playlistId}-copy`;
  const playlistId = getAvailableMusicPlaylistId(state, baseId);
  const playlist: MusicPlaylist = {
    id: playlistId,
    name,
    items: makeImportedPlaylistItems(preview, now),
    createdAt: now,
    updatedAt: now,
    importSource: makePlaylistImportSource(preview, linked, now, now)
  };
  if (preview.description) playlist.description = preview.description;
  return {
    library: { playlists: [...state.playlists.map(clonePlaylist), playlist] },
    playlistId
  };
}

export function updateLinkedNeteasePlaylist(
  state: MusicLibraryState,
  localPlaylistId: string,
  preview: NeteasePlaylistPreview,
  now = currentIsoTime()
): MusicLibraryMutationResult | null {
  const target = state.playlists.find((playlist) => playlist.id === localPlaylistId);
  if (
    !target ||
    target.importSource?.provider !== "netease" ||
    target.importSource.playlistId !== preview.playlistId ||
    !target.importSource.linked
  ) {
    return null;
  }

  const existingImported = new Map(
    target.items
      .filter((entry) => matchesImport(entry, preview.playlistId))
      .map((entry) => [entry.id, entry])
  );
  const imported = makeImportedPlaylistItems(preview, now, existingImported);
  const importedIds = new Set(imported.map((entry) => entry.id));
  const localItems = target.items
    .filter((entry) => !matchesImport(entry, preview.playlistId))
    .filter((entry) => !importedIds.has(entry.id))
    .map(clonePlaylistItem);
  const updated: MusicPlaylist = {
    ...clonePlaylist(target),
    items: [...imported, ...localItems],
    updatedAt: now,
    importSource: makePlaylistImportSource(
      preview,
      true,
      target.importSource.importedAt,
      now
    )
  };
  return {
    library: {
      playlists: state.playlists.map((playlist) =>
        playlist.id === target.id ? updated : clonePlaylist(playlist)
      )
    },
    playlistId: target.id
  };
}
```

Add these private helpers:

```ts
function matchesImport(entry: MusicPlaylistItem, playlistId: string): boolean {
  return (
    entry.importSource?.provider === "netease" &&
    entry.importSource.playlistId === playlistId
  );
}

function makeImportedPlaylistItems(
  preview: NeteasePlaylistPreview,
  now: string,
  existing = new Map<string, MusicPlaylistItem>()
): MusicPlaylistItem[] {
  const seen = new Set<string>();
  return preview.tracks.flatMap((track) => {
    if (seen.has(track.id)) return [];
    seen.add(track.id);
    const prior = existing.get(track.id);
    return [{
      id: track.id,
      item: makeMusicItemFromNeteasePlaylistTrack(track),
      addedAt: prior?.addedAt ?? now,
      addedBy: "import" as const,
      importSource: {
        provider: "netease" as const,
        playlistId: preview.playlistId,
        trackId: track.songId
      }
    }];
  });
}

function makePlaylistImportSource(
  preview: NeteasePlaylistPreview,
  linked: boolean,
  importedAt: string,
  syncedAt: string
): MusicPlaylistImportSource {
  const source: MusicPlaylistImportSource = {
    provider: "netease",
    playlistId: preview.playlistId,
    sourceUrl: preview.sourceUrl,
    remoteName: preview.name,
    creatorName: preview.creator,
    linked,
    importedAt,
    syncedAt
  };
  if (preview.coverUrl) source.coverUrl = preview.coverUrl;
  return source;
}
```

- [ ] **Step 5: Extend cloning and hydration validation**

Clone both provenance objects with object spread:

```ts
if (playlist.importSource !== undefined) {
  cloned.importSource = { ...playlist.importSource };
}

if (entry.importSource !== undefined) {
  cloned.importSource = { ...entry.importSource };
}
```

Validate all fields exactly:

```ts
function isMusicPlaylistAddedBy(value: unknown): value is MusicPlaylistAddedBy {
  return value === "agent" || value === "user" || value === "default" || value === "import";
}

function isPlaylistImportSource(value: unknown): value is MusicPlaylistImportSource {
  return isRecord(value) &&
    value.provider === "netease" &&
    typeof value.playlistId === "string" &&
    typeof value.sourceUrl === "string" &&
    typeof value.remoteName === "string" &&
    typeof value.creatorName === "string" &&
    isOptionalString(value.coverUrl) &&
    typeof value.linked === "boolean" &&
    typeof value.importedAt === "string" &&
    typeof value.syncedAt === "string";
}

function isPlaylistItemImportSource(value: unknown): value is MusicPlaylistItemImportSource {
  return isRecord(value) &&
    value.provider === "netease" &&
    typeof value.playlistId === "string" &&
    typeof value.trackId === "string";
}
```

Add `(value.importSource === undefined || isPlaylistImportSource(value.importSource))` to `isMusicPlaylistLike`, add `(value.importSource === undefined || isPlaylistItemImportSource(value.importSource))` to `isMusicPlaylistItemLike`, and replace its `isMusicQueueAddedBy(value.addedBy)` call with `isMusicPlaylistAddedBy(value.addedBy)`.

- [ ] **Step 6: Run and commit library changes**

```powershell
npm test -- tests/musicItems.test.ts tests/musicLibrary.test.ts
git add -- apps/web/src/lib/musicItems.ts apps/web/src/lib/musicLibrary.ts apps/web/tests/musicItems.test.ts apps/web/tests/musicLibrary.test.ts
git commit -m "feat: merge imported NetEase playlists"
```

Expected: both test files pass.

## Task 5: Inline Playlist Import Component

**Files:**
- Create: `apps/web/src/components/NeteasePlaylistImport.tsx`
- Create: `apps/web/tests/NeteasePlaylistImport.test.tsx`
- Modify: `apps/web/src/components/RoomShell.tsx`
- Modify: `apps/web/tests/RoomShell.test.tsx`
- Modify: `apps/web/app/globals.css`

- [ ] **Step 1: Add failing component tests**

Set up the API mock and a complete local fixture:

```tsx
const apiMocks = vi.hoisted(() => ({
  resolveNeteasePlaylist: vi.fn()
}));

vi.mock("../src/api/client", () => ({
  resolveNeteasePlaylist: apiMocks.resolveNeteasePlaylist
}));

function makePreview(): NeteasePlaylistPreview {
  const tracks = ["1", "2"].map((songId, index) => ({
    id: `netease-song-${songId}`,
    songId,
    title: index === 0 ? "One" : "Two",
    creator: `Artist ${songId}`,
    durationMs: 180000,
    pageUrl: `https://music.163.com/#/song?id=${songId}`,
    platformAudioUrl: `https://music.163.com/song/media/outer/url?id=${songId}.mp3`,
    tags: ["netease", "playlist-import"],
    metadataComplete: true
  }));
  return {
    source: "netease",
    playlistId: "123",
    name: "Remote List",
    creator: "Owner",
    description: null,
    coverUrl: null,
    sourceUrl: "https://music.163.com/#/playlist?id=123",
    trackCount: tracks.length,
    metadataIncompleteCount: 0,
    tracks
  };
}
```

Begin with this end-to-end component test:

```tsx
it("resolves and commits a new linked playlist", async () => {
  apiMocks.resolveNeteasePlaylist.mockResolvedValue(makePreview());
  const onCommit = vi.fn();
  render(
    <NeteasePlaylistImport
      library={createInitialMusicLibrary()}
      onCommit={onCommit}
    />
  );

  fireEvent.change(screen.getByLabelText("网易云歌单链接或 ID"), {
    target: { value: "123" }
  });
  fireEvent.click(screen.getByRole("button", { name: "读取歌单" }));

  expect(await screen.findByText("Remote List")).toBeTruthy();
  expect(screen.getByText("Owner · 2 首")).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "导入" }));

  expect(onCommit).toHaveBeenCalledTimes(1);
  expect(onCommit.mock.calls[0][0].library.playlists[0].importSource.linked).toBe(true);
  expect(screen.getByText("已导入 2 首")).toBeTruthy();
});
```

Add focused tests for:

- submit disables `读取歌单` while a deferred request is pending;
- a new preview shows name, creator, count, `导入`, and `取消`;
- clicking `导入` returns a linked mutation through `onCommit`;
- a linked match shows `更新`, `创建副本`, and `取消`;
- update preserves the local id and copy creates a detached playlist;
- incomplete metadata renders `有 N 首歌曲信息不完整，仍已保留`;
- rejected requests render the error and never call `onCommit`.

Add this `RoomShell` integration flow using its local `makeNeteasePreview` fixture:

```tsx
apiMocks.resolveNeteasePlaylist.mockResolvedValue(makeNeteasePreview());
render(<RoomShell initialState={DEFAULT_ROOM_STATE} connectionStatus={connectionStatus} />);
expect(await screen.findByRole("button", { name: defaultSession.title })).toBeTruthy();
fireEvent.click(getQueueManageButton());
const panel = getMusicQueuePanel();
fireEvent.click(within(panel).getByRole("tab", { name: "我的歌单" }));
fireEvent.change(within(panel).getByLabelText("网易云歌单链接或 ID"), {
  target: { value: "123" }
});
fireEvent.click(within(panel).getByRole("button", { name: "读取歌单" }));
expect(await within(panel).findByText("Remote List")).toBeTruthy();
fireEvent.click(within(panel).getByRole("button", { name: "导入" }));
expect(localStorage.getItem("kumikoroom.musicLibrary")).toContain("playlist-netease-123");
expect(within(panel).getByText("Remote List")).toBeTruthy();
```

Define the fixture in `RoomShell.test.tsx`:

```ts
function makeNeteasePreview(): NeteasePlaylistPreview {
  return {
    source: "netease",
    playlistId: "123",
    name: "Remote List",
    creator: "Owner",
    description: null,
    coverUrl: null,
    sourceUrl: "https://music.163.com/#/playlist?id=123",
    trackCount: 1,
    metadataIncompleteCount: 0,
    tracks: [{
      id: "netease-song-1",
      songId: "1",
      title: "One",
      creator: "Artist",
      durationMs: 180000,
      pageUrl: "https://music.163.com/#/song?id=1",
      platformAudioUrl: "https://music.163.com/song/media/outer/url?id=1.mp3",
      tags: ["netease", "playlist-import"],
      metadataComplete: true
    }]
  };
}
```

- [ ] **Step 2: Run component tests and confirm failure**

```powershell
npm test -- tests/NeteasePlaylistImport.test.tsx tests/RoomShell.test.tsx
```

Expected: missing component and missing API mock export.

- [ ] **Step 3: Implement the dedicated component**

Create `NeteasePlaylistImport.tsx`:

```tsx
"use client";

import { FormEvent, useState } from "react";
import { resolveNeteasePlaylist } from "../api/client";
import type { NeteasePlaylistPreview } from "../api/types";
import {
  createNeteasePlaylistImport,
  findLinkedNeteasePlaylist,
  updateLinkedNeteasePlaylist,
  type MusicLibraryMutationResult,
  type MusicLibraryState
} from "../lib/musicLibrary";

interface NeteasePlaylistImportProps {
  library: MusicLibraryState;
  onCommit: (result: MusicLibraryMutationResult) => void;
}

export function NeteasePlaylistImport({
  library,
  onCommit
}: NeteasePlaylistImportProps) {
  const [input, setInput] = useState("");
  const [preview, setPreview] = useState<NeteasePlaylistPreview | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [warningCount, setWarningCount] = useState(0);
  const linkedPlaylist = preview
    ? findLinkedNeteasePlaylist(library, preview.playlistId)
    : null;

  async function handleResolve(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const value = input.trim();
    if (!value || loading) return;
    setLoading(true);
    setError(null);
    setNotice(null);
    setWarningCount(0);
    try {
      setPreview(await resolveNeteasePlaylist(value));
    } catch (caught) {
      setPreview(null);
      setError(caught instanceof Error ? caught.message : "歌单读取失败");
    } finally {
      setLoading(false);
    }
  }

  function finish(verb: string) {
    if (!preview) return;
    setNotice(`${verb} ${preview.trackCount} 首`);
    setWarningCount(preview.metadataIncompleteCount);
    setError(null);
    setPreview(null);
  }

  function commitNew(linked: boolean) {
    if (!preview) return;
    const result = createNeteasePlaylistImport(library, preview, linked);
    onCommit(result);
    finish(linked ? "已导入" : "已创建副本");
  }

  function commitUpdate() {
    if (!preview || !linkedPlaylist) return;
    const result = updateLinkedNeteasePlaylist(library, linkedPlaylist.id, preview);
    if (!result) {
      setError("关联歌单已发生变化，请重新读取");
      return;
    }
    onCommit(result);
    finish("已更新");
  }

  function cancelPreview() {
    setPreview(null);
    setError(null);
  }

  return (
    <section className="netease-playlist-import" aria-label="导入网易云歌单">
      <form onSubmit={handleResolve}>
        <label>
          <span>网易云歌单链接或 ID</span>
          <input
            value={input}
            onChange={(event) => setInput(event.currentTarget.value)}
          />
        </label>
        <button type="submit" disabled={loading || !input.trim()}>
          {loading ? "读取中…" : "读取歌单"}
        </button>
      </form>

      {preview ? (
        <div className="netease-playlist-import__preview">
          <strong>{preview.name}</strong>
          <span>{preview.creator} · {preview.trackCount} 首</span>
          <div className="netease-playlist-import__actions">
            {linkedPlaylist ? (
              <>
                <button type="button" onClick={commitUpdate}>更新</button>
                <button type="button" onClick={() => commitNew(false)}>创建副本</button>
              </>
            ) : (
              <button type="button" onClick={() => commitNew(true)}>导入</button>
            )}
            <button type="button" onClick={cancelPreview}>取消</button>
          </div>
        </div>
      ) : null}

      {notice ? <p role="status">{notice}</p> : null}
      {warningCount > 0 ? (
        <p role="status">有 {warningCount} 首歌曲信息不完整，仍已保留</p>
      ) : null}
      {error ? <p className="netease-playlist-import__error" role="alert">{error}</p> : null}
    </section>
  );
}
```

- [ ] **Step 4: Mount it in RoomShell**

Import the component and add this callback beside the existing playlist handlers:

```ts
function handleNeteasePlaylistCommit(result: MusicLibraryMutationResult) {
  commitMusicLibrary(result.library);
  const playlist = getMusicPlaylistByIdOrName(result.library, result.playlistId);
  setSelectedPlaylistId(result.playlistId);
  setPlaylistRenameName(playlist?.name ?? "");
}
```

Add `type MusicLibraryMutationResult` and `type MusicPlaylist` to the existing `musicLibrary` import list in `RoomShell.tsx`.

Render `NeteasePlaylistImport` at the top of `.music-playlist-panel`, before the manual creation form. Add `resolveNeteasePlaylist` to the hoisted API mock in `RoomShell.test.tsx` and provide a default resolved preview in `beforeEach`.

Show linked source and synchronization date in each linked playlist row:

```ts
function getPlaylistImportLabel(playlist: MusicPlaylist): string | null {
  const source = playlist.importSource;
  if (source?.provider !== "netease" || !source.linked) return null;
  return `网易云 · ${source.syncedAt.slice(0, 10)} 同步`;
}
```

In each playlist row compute `const importLabel = getPlaylistImportLabel(playlist)` and render:

```tsx
<span>
  {getPlaylistItemCountLabel(playlist.items.length)}
  {importLabel ? ` · ${importLabel}` : ""}
</span>
```

Detached copies have `linked: false`, so they keep the ordinary local row text. Assert `网易云 · 2026-06-20 同步` in the RoomShell integration test.

- [ ] **Step 5: Add compact desktop styles**

Add styles for `.netease-playlist-import`, its form, preview, actions, status, and error. Use the existing music-panel colors, a maximum `8px` radius, stable `30px` input/button heights, wrapping action rows, and no nested card treatment. Add the new selectors to existing playlist input/button groups where values match.

Use this concrete block:

```css
.netease-playlist-import {
  display: grid;
  gap: 8px;
  padding-bottom: 12px;
  border-bottom: 1px solid rgba(216, 226, 221, 0.72);
}

.netease-playlist-import form {
  display: grid;
  grid-template-columns: minmax(0, 1fr) auto;
  gap: 8px;
  align-items: end;
}

.netease-playlist-import label,
.netease-playlist-import__preview {
  min-width: 0;
  display: grid;
  gap: 4px;
}

.netease-playlist-import label > span,
.netease-playlist-import__preview > span,
.netease-playlist-import p {
  margin: 0;
  color: #8ea09f;
  font-size: 11px;
  font-weight: 700;
}

.netease-playlist-import input,
.netease-playlist-import button {
  min-width: 0;
  height: 30px;
  border: 1px solid rgba(195, 213, 211, 0.72);
  border-radius: 6px;
  background: rgba(255, 255, 255, 0.72);
  color: #34484a;
  font-size: 12px;
  font-weight: 700;
}

.netease-playlist-import input { padding: 0 10px; }
.netease-playlist-import button { padding: 0 9px; }
.netease-playlist-import button:disabled { opacity: 0.55; }

.netease-playlist-import__actions {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
}

.netease-playlist-import .netease-playlist-import__error {
  color: #a64f4f;
}
```

- [ ] **Step 6: Run and commit import UI changes**

```powershell
npm test -- tests/NeteasePlaylistImport.test.tsx tests/RoomShell.test.tsx
git add -- apps/web/src/components/NeteasePlaylistImport.tsx apps/web/tests/NeteasePlaylistImport.test.tsx apps/web/src/components/RoomShell.tsx apps/web/tests/RoomShell.test.tsx apps/web/app/globals.css
git commit -m "feat: add NetEase playlist import workflow"
```

Expected: both component files pass.

## Task 6: Media Error Auto-Skip

**Files:**
- Modify: `apps/web/src/components/RoomShell.tsx`
- Modify: `apps/web/tests/RoomShell.test.tsx`
- Modify: `apps/web/app/globals.css`

- [ ] **Step 1: Add failing player tests**

Add a helper that stores a two-track playlist, then add the primary behavior test:

```tsx
function seedImportedPlaylist() {
  localStorage.setItem("kumikoroom.musicLibrary", JSON.stringify({
    playlists: [{
      id: "playlist-imported",
      name: "Imported",
      items: [
        {
          id: "netease-song-1",
          item: {
            id: "netease-song-1",
            source: "netease",
            title: "First",
            creator: "Artist",
            durationMs: 180000,
            pageUrl: "https://music.163.com/#/song?id=1",
            platformAudioUrl: "https://music.163.com/song/media/outer/url?id=1.mp3",
            tags: ["netease", "playlist-import"],
            canOpenVideo: false
          },
          addedAt: "2026-06-20T00:00:00.000Z",
          addedBy: "import"
        },
        {
          id: "netease-song-2",
          item: {
            id: "netease-song-2",
            source: "netease",
            title: "Second",
            creator: "Artist",
            durationMs: 180000,
            pageUrl: "https://music.163.com/#/song?id=2",
            platformAudioUrl: "https://music.163.com/song/media/outer/url?id=2.mp3",
            tags: ["netease", "playlist-import"],
            canOpenVideo: false
          },
          addedAt: "2026-06-20T00:00:00.000Z",
          addedBy: "import"
        }
      ],
      createdAt: "2026-06-20T00:00:00.000Z",
      updatedAt: "2026-06-20T00:00:00.000Z"
    }]
  }));
}

it("skips one unavailable queue track and shows a notice", async () => {
  seedImportedPlaylist();
  render(<RoomShell initialState={DEFAULT_ROOM_STATE} connectionStatus={connectionStatus} />);
  expect(await screen.findByRole("button", { name: defaultSession.title })).toBeTruthy();
  fireEvent.click(getQueueManageButton());
  const panel = getMusicQueuePanel();
  fireEvent.click(within(panel).getByRole("tab", { name: "我的歌单" }));
  fireEvent.click(within(panel).getAllByRole("button", { name: "播放" })[0]);

  const audio = getPlatformAudio();
  act(() => {
    audio.dispatchEvent(new Event("error"));
    audio.dispatchEvent(new Event("error"));
  });

  await waitFor(() => expect(document.querySelector(".track-title strong")?.textContent).toBe("Second"));
  expect(screen.getByRole("status").textContent).toContain("《First》暂时无法播放，已跳过");
});
```

Add separate tests for the remaining assertions:

Assert:

- the second title becomes active;
- `《First》暂时无法播放，已跳过` appears;
- firing error twice on the same element does not skip two entries;
- consecutive errors stop at queue end with `《Second》暂时无法播放`;
- a rejected `HTMLMediaElement.play()` promise pauses without changing the current title.

- [ ] **Step 2: Run player tests and confirm failure**

```powershell
npm test -- tests/RoomShell.test.tsx -t "media error|play rejection"
```

Expected: no media-error notice and no automatic queue change.

- [ ] **Step 3: Implement guarded media error handling**

Add:

```ts
const failedAudioItemIdRef = useRef<string | null>(null);
const [playerNotice, setPlayerNotice] = useState<string | null>(null);

useEffect(() => {
  failedAudioItemIdRef.current = null;
}, [activeTrack.id]);
```

Add the handler:

```ts
function handlePlatformAudioError() {
  const failedItem = activeTrack;
  if (failedAudioItemIdRef.current === failedItem.id) return;
  failedAudioItemIdRef.current = failedItem.id;

  const failedEntry = musicQueueRef.current.entries.find(
    (entry) => entry.id === failedItem.id && entry.status === "current"
  );

  if (!failedEntry) {
    setIsPlayerPlaying(false);
    setPlayerNotice(`《${failedItem.title}》暂时无法播放`);
    return;
  }

  const nextState = removeQueueEntry(musicQueueRef.current, failedEntry.id);
  const nextEntry = getCurrentQueueEntry(nextState);
  commitMusicQueue(nextState);
  setPlayerCurrentTime(0);

  if (!nextEntry) {
    setIsPlayerPlaying(false);
    setPlayerNotice(`《${failedItem.title}》暂时无法播放`);
    return;
  }

  setPlayerDuration(nextEntry.item.durationMs / 1000);
  setIsPlayerPlaying(Boolean(nextEntry.item.platformAudioUrl));
  setPlayerNotice(`《${failedItem.title}》暂时无法播放，已跳过`);
  if (!nextEntry.item.canOpenVideo) commitVideoWindowOpen(false);
}
```

Attach `onError={handlePlatformAudioError}` to `<audio>`. Render `playerNotice` as a compact `role="status"` line near the track metadata. Keep the existing `playPlatformAudio()` catch branch unchanged so autoplay denial only pauses.

Add:

```css
.player-notice {
  margin: 4px 0 0;
  color: #8a6262;
  font-size: 11px;
  line-height: 1.35;
}
```

- [ ] **Step 4: Run player and full frontend tests**

```powershell
npm test -- tests/RoomShell.test.tsx
npm test
```

Expected: `RoomShell.test.tsx` and the complete Vitest suite pass.

- [ ] **Step 5: Commit player behavior**

```powershell
git add -- apps/web/src/components/RoomShell.tsx apps/web/tests/RoomShell.test.tsx apps/web/app/globals.css
git commit -m "fix: skip unavailable playlist tracks"
```

## Task 7: Full Verification and Desktop Smoke Test

**Files:**
- Verify all changed files; no new implementation file is expected in this task.

- [ ] **Step 1: Run the complete backend suite**

From `apps/api`:

```powershell
python -m pytest -q --basetemp=.pytest-runtime-np-full -p no:cacheprovider
```

Expected: all backend tests pass with zero failures.

- [ ] **Step 2: Run frontend tests and production build**

From `apps/web`:

```powershell
npm test
npm run build
```

Expected: all Vitest tests pass and Next.js exits with a successful production build.

- [ ] **Step 3: Inspect repository scope**

From the repository root:

```powershell
git status --short
git diff --check
```

Expected: only intentional implementation files are changed or committed. Leave `playlist_111.txt`, `scripts/`, and the unrelated untracked conversation-manager plan untouched.

- [ ] **Step 4: Perform desktop-only manual verification**

Start the API from `apps/api`:

```powershell
python -m uvicorn kumikoroom.main:app --host 127.0.0.1 --port 8000
```

Start the web app from `apps/web` in a second terminal:

```powershell
$env:NEXT_PUBLIC_KUMIKOROOM_API_BASE_URL='http://127.0.0.1:8000'
npm run dev -- --hostname 127.0.0.1 --port 3001
```

If either port is already occupied, select the next free port and keep the frontend API base URL aligned. In the desktop browser:

1. Open the room and `管理 > 我的歌单`.
2. Resolve the id represented by `playlist_111.txt`, its full URL, and share text containing that URL.
3. Import and verify name, creator, count, order, persistence after reload, and the `网易云` linked label.
4. Add one local song, resolve again, choose `更新`, and verify the local song remains at the end.
5. Choose `创建副本` and verify later imports still target only the linked playlist.
6. Use DevTools or a controlled invalid audio URL to trigger a media error and verify one-step skip plus the visible notice.
7. Confirm invalid input and a mocked upstream failure leave existing localStorage unchanged.

- [ ] **Step 5: Record final evidence**

Report exact backend test count, frontend test count, build result, desktop smoke result, and any remaining upstream fragility. Do not claim live NetEase stability from mocked automated tests.

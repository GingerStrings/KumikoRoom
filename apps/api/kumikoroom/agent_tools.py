from __future__ import annotations

from dataclasses import dataclass, field
from datetime import datetime, timezone
import json
import re
import unicodedata
from typing import Any, Callable

from kumikoroom.llm import LLMToolCall
from kumikoroom.music_search import (
    BilibiliVideoSearchResult,
    MusicSearchCandidate,
    MusicSearchError,
    NeteaseSongSearchResult,
    search_bilibili_videos,
    search_netease_songs,
)
from kumikoroom.schemas import (
    ClientMusicItemOut,
    MusicAgentPlaylist,
    MusicAgentState,
    MusicAgentTrack,
    RoomClientActionOut,
)


@dataclass
class RoomAgentToolContext:
    music_state: MusicAgentState | None = None
    candidates: dict[str, MusicSearchCandidate] = field(default_factory=dict)
    candidate_queries: dict[str, str] = field(default_factory=dict)
    client_actions: list[RoomClientActionOut] = field(default_factory=list)


@dataclass(frozen=True)
class ResolvedMusicItem:
    item: ClientMusicItemOut
    origin: str
    candidate: MusicSearchCandidate | None = None
    track: MusicAgentTrack | None = None


@dataclass(frozen=True)
class RoomAgentToolResult:
    ok: bool
    content: str


RoomAgentToolHandler = Callable[
    [dict[str, Any], RoomAgentToolContext],
    RoomAgentToolResult,
]

_KNOWN_PLAYLIST_SLUGS = {
    "夜晚写作": "night-writing",
}


def room_agent_tool_specs() -> list[dict[str, Any]]:
    return [
        {
            "type": "function",
            "function": {
                "name": "search_music",
                "description": (
                    "Search Netease and Bilibili for playable music candidates and "
                    "return ranked evidence including popularity, comment count, "
                    "hot-comment likes, duration, and playability."
                ),
                "parameters": {
                    "type": "object",
                    "properties": {
                        "query": {
                            "type": "string",
                            "description": "Song name, artist, or other music query.",
                        },
                        "source": {
                            "type": "string",
                            "enum": ["all", "netease", "bilibili"],
                            "description": "Music source to search. Defaults to all.",
                        },
                        "limit": {
                            "type": "integer",
                            "minimum": 1,
                            "maximum": 10,
                            "description": "Maximum number of ranked candidates.",
                        },
                    },
                    "required": ["query"],
                    "additionalProperties": False,
                },
            },
        },
        {
            "type": "function",
            "function": {
                "name": "get_music_state",
                "description": (
                    "Return the complete browser-owned music state snapshot, "
                    "including current, previous, next, upcoming, recent, saved, "
                    "playlists, playback progress, and play/pause state."
                ),
                "parameters": {
                    "type": "object",
                    "properties": {},
                    "additionalProperties": False,
                },
            },
        },
        {
            "type": "function",
            "function": {
                "name": "list_music_playlists",
                "description": "List browser-owned music playlist summaries without item arrays.",
                "parameters": {
                    "type": "object",
                    "properties": {},
                    "additionalProperties": False,
                },
            },
        },
        _playlist_id_tool_spec(
            "get_music_playlist",
            "Return one complete browser-owned music playlist, including its items.",
        ),
        {
            "type": "function",
            "function": {
                "name": "create_music_playlist",
                "description": "Create a music playlist. The playlist name must be non-empty.",
                "parameters": {
                    "type": "object",
                    "properties": {
                        "name": {
                            "type": "string",
                            "description": "New playlist name.",
                        },
                        "description": {
                            "type": "string",
                            "description": "Optional playlist description.",
                        },
                    },
                    "required": ["name"],
                    "additionalProperties": False,
                },
            },
        },
        _playlist_name_tool_spec(
            "rename_music_playlist",
            "Rename an existing music playlist. The new name must be non-empty.",
        ),
        _playlist_id_tool_spec(
            "delete_music_playlist",
            "Delete an existing music playlist.",
        ),
        _playlist_item_tool_spec(
            "add_music_to_playlist",
            (
                "Add a search candidate or known music-state item from current, "
                "previous, next, upcoming, recent, saved, or playlists to an existing playlist."
            ),
        ),
        _playlist_item_tool_spec(
            "remove_music_from_playlist",
            "Remove an item that is already in an existing playlist.",
        ),
        _playlist_id_tool_spec(
            "play_music_playlist",
            "Play an existing non-empty playlist now.",
        ),
        _playlist_id_tool_spec(
            "add_playlist_to_queue",
            "Add an existing non-empty playlist to the queue.",
        ),
        {
            "type": "function",
            "function": {
                "name": "play_music_item",
                "description": (
                    "Play one item now. Use a search_music candidate id, or an id "
                    "from current, upcoming, recent, or saved music state."
                ),
                "parameters": {
                    "type": "object",
                    "properties": {
                        "item_id": {
                            "type": "string",
                            "description": "Candidate id such as netease-song-2668397359 or bilibili-BVxxxx.",
                        }
                    },
                    "required": ["item_id"],
                    "additionalProperties": False,
                },
            },
        },
        _item_id_tool_spec(
            "add_music_to_queue",
            (
                "Add a search candidate or known music-state item to the end of "
                "upcoming without interrupting the current track."
            ),
        ),
        _item_id_tool_spec(
            "remove_music_from_queue",
            "Remove one item from upcoming. This cannot remove current, recent, or saved-only items.",
        ),
        _item_id_tool_spec(
            "save_music_item",
            "Save a search candidate or known music-state item.",
        ),
        _item_id_tool_spec(
            "unsave_music_item",
            "Unsave one item that is already present in saved music state.",
        ),
        {
            "type": "function",
            "function": {
                "name": "clear_music_queue",
                "description": "Clear upcoming tracks while keeping current, recent, and saved tracks.",
                "parameters": {
                    "type": "object",
                    "properties": {},
                    "additionalProperties": False,
                },
            },
        },
    ]


def dispatch_room_agent_tool(
    tool_call: LLMToolCall,
    context: RoomAgentToolContext,
) -> RoomAgentToolResult:
    handler = _ROOM_AGENT_TOOL_HANDLERS.get(tool_call.name)
    if handler is not None:
        return handler(tool_call.arguments, context)

    return _json_result(
        ok=False,
        payload={
            "ok": False,
            "error": f"Unknown tool: {tool_call.name}",
            "tool": tool_call.name,
        },
    )


def _get_music_state(
    arguments: dict[str, Any],
    context: RoomAgentToolContext,
) -> RoomAgentToolResult:
    del arguments
    return _json_result(
        ok=True,
        payload={
            "ok": True,
            "music_state": (
                context.music_state.model_dump()
                if context.music_state is not None
                else None
            ),
        },
    )


def _list_music_playlists(
    arguments: dict[str, Any],
    context: RoomAgentToolContext,
) -> RoomAgentToolResult:
    del arguments
    playlists = context.music_state.playlists if context.music_state is not None else []
    return _json_result(
        ok=True,
        payload={
            "ok": True,
            "playlists": [_playlist_summary_payload(playlist) for playlist in playlists],
        },
    )


def _get_music_playlist(
    arguments: dict[str, Any],
    context: RoomAgentToolContext,
) -> RoomAgentToolResult:
    playlist, error = _require_existing_playlist(arguments, context)
    if error is not None:
        return error
    return _json_result(
        ok=True,
        payload={
            "ok": True,
            "playlist": playlist.model_dump(),
        },
    )


def _search_music(
    arguments: dict[str, Any],
    context: RoomAgentToolContext,
) -> RoomAgentToolResult:
    query = str(arguments.get("query") or "").strip()
    source = str(arguments.get("source") or "all").strip() or "all"
    limit = _clamp_int(arguments.get("limit"), default=8, minimum=1, maximum=10)

    if not query:
        return _json_result(
            ok=False,
            payload={"ok": False, "error": "query is required", "candidates": []},
        )
    if source not in {"all", "netease", "bilibili"}:
        return _json_result(
            ok=False,
            payload={
                "ok": False,
                "error": f"Unsupported music source: {source}",
                "source": source,
                "candidates": [],
            },
        )

    results: list[MusicSearchCandidate] = []
    errors: list[str] = []

    if source in {"all", "netease"}:
        try:
            results.extend(search_netease_songs(query, limit=limit))
        except MusicSearchError as error:
            errors.append(str(error))

    if source in {"all", "bilibili"}:
        try:
            results.extend(search_bilibili_videos(query, limit=limit))
        except MusicSearchError as error:
            errors.append(str(error))

    if not results and errors:
        return _json_result(
            ok=False,
            payload={
                "ok": False,
                "query": query,
                "source": source,
                "error": "; ".join(errors),
                "candidates": [],
            },
        )

    results = sorted(results, key=lambda result: result.score, reverse=True)[:limit]
    for result in results:
        context.candidates[result.id] = result
        context.candidate_queries[result.id] = query

    candidates = [_candidate_payload(result) for result in results]
    return _json_result(
        ok=True,
        payload={
            "ok": True,
            "query": query,
            "source": source,
            "selected_id": results[0].id if results else None,
            "candidates": candidates,
            "errors": errors,
        },
    )


def _play_music_item(
    arguments: dict[str, Any],
    context: RoomAgentToolContext,
) -> RoomAgentToolResult:
    resolved, error = _resolve_music_item(
        arguments,
        context,
        require_playable_candidate=True,
    )
    if error is not None:
        return error
    return _emit_item_action("play_music_item", resolved, context)


def _add_music_to_queue(
    arguments: dict[str, Any],
    context: RoomAgentToolContext,
) -> RoomAgentToolResult:
    resolved, error = _resolve_music_item(
        arguments,
        context,
        require_playable_candidate=True,
    )
    if error is not None:
        return error
    return _emit_item_action("add_music_to_queue", resolved, context)


def _create_music_playlist(
    arguments: dict[str, Any],
    context: RoomAgentToolContext,
) -> RoomAgentToolResult:
    name = _playlist_name_from_arguments(arguments)
    if not name:
        return _json_result(
            ok=False,
            payload={"ok": False, "error": "playlist name is required"},
        )

    description = _playlist_description_from_arguments(arguments)
    playlist = _append_new_playlist_to_music_state(context, name, description)
    action = RoomClientActionOut(
        type="create_music_playlist",
        playlist_id=playlist.id,
        playlist_name=name,
        description=description,
    )
    context.client_actions.append(action)
    return _json_result(
        ok=True,
        payload={
            "ok": True,
            "client_action": action.model_dump(),
            "playlist": _playlist_summary_payload(playlist),
            "playlist_name": name,
            "description": description,
        },
    )


def _rename_music_playlist(
    arguments: dict[str, Any],
    context: RoomAgentToolContext,
) -> RoomAgentToolResult:
    playlist, error = _require_existing_playlist(arguments, context)
    if error is not None:
        return error

    name = _playlist_name_from_arguments(arguments)
    if not name:
        return _json_result(
            ok=False,
            payload={"ok": False, "error": "playlist name is required"},
        )

    action = RoomClientActionOut(
        type="rename_music_playlist",
        playlist_id=playlist.id,
        playlist_name=name,
    )
    context.client_actions.append(action)
    updated_playlist = playlist.model_copy(
        update={"name": name, "updated_at": _current_iso_time()}
    )
    _replace_music_state_playlist(context, updated_playlist)
    return _json_result(
        ok=True,
        payload={
            "ok": True,
            "client_action": action.model_dump(),
            "playlist": _playlist_summary_payload(updated_playlist),
            "playlist_name": name,
        },
    )


def _delete_music_playlist(
    arguments: dict[str, Any],
    context: RoomAgentToolContext,
) -> RoomAgentToolResult:
    playlist, error = _require_existing_playlist(arguments, context)
    if error is not None:
        return error

    action = RoomClientActionOut(
        type="delete_music_playlist",
        playlist_id=playlist.id,
        playlist_name=playlist.name,
    )
    context.client_actions.append(action)
    _remove_music_state_playlist(context, playlist.id)
    return _json_result(
        ok=True,
        payload={
            "ok": True,
            "client_action": action.model_dump(),
            "playlist": _playlist_summary_payload(playlist),
        },
    )


def _add_music_to_playlist(
    arguments: dict[str, Any],
    context: RoomAgentToolContext,
) -> RoomAgentToolResult:
    playlist, error = _require_existing_playlist(arguments, context)
    if error is not None:
        return error

    resolved, error = _resolve_music_item(
        arguments,
        context,
        require_playable_candidate=True,
    )
    if error is not None:
        return error

    action = RoomClientActionOut(
        type="add_music_to_playlist",
        playlist_id=playlist.id,
        playlist_name=playlist.name,
        item=resolved.item,
    )
    context.client_actions.append(action)
    updated_playlist = _playlist_with_added_track(
        playlist,
        _music_agent_track_from_resolved_item(resolved),
        updated_at=_current_iso_time(),
    )
    _replace_music_state_playlist(context, updated_playlist)
    payload: dict[str, Any] = {
        "ok": True,
        "client_action": action.model_dump(),
        "playlist": _playlist_summary_payload(updated_playlist),
        "item": resolved.item.model_dump(),
        "origin": resolved.origin,
    }
    if resolved.candidate is not None:
        payload["candidate"] = _candidate_payload(resolved.candidate)
        payload["evidence"] = resolved.candidate.evidence
    if resolved.track is not None:
        payload["music_state_item"] = resolved.track.model_dump()
    return _json_result(ok=True, payload=payload)


def _remove_music_from_playlist(
    arguments: dict[str, Any],
    context: RoomAgentToolContext,
) -> RoomAgentToolResult:
    playlist, error = _require_existing_playlist(arguments, context)
    if error is not None:
        return error

    item_id = _item_id_from_arguments(arguments)
    if not item_id:
        return _item_id_required_result()

    track = _find_track_in_list(item_id, playlist.items)
    if track is None:
        return _json_result(
            ok=False,
            payload={
                "ok": False,
                "error": "remove_music_from_playlist can only remove items from that playlist",
                "playlist_id": playlist.id,
                "item_id": item_id,
            },
        )

    action = RoomClientActionOut(
        type="remove_music_from_playlist",
        playlist_id=playlist.id,
        playlist_name=playlist.name,
        item_id=item_id,
    )
    context.client_actions.append(action)
    updated_playlist = _playlist_without_track(
        playlist,
        item_id,
        updated_at=_current_iso_time(),
    )
    _replace_music_state_playlist(context, updated_playlist)
    return _json_result(
        ok=True,
        payload={
            "ok": True,
            "client_action": action.model_dump(),
            "playlist": _playlist_summary_payload(updated_playlist),
            "item_id": item_id,
            "item": track.model_dump(),
        },
    )


def _play_music_playlist(
    arguments: dict[str, Any],
    context: RoomAgentToolContext,
) -> RoomAgentToolResult:
    return _emit_non_empty_playlist_action(
        "play_music_playlist",
        arguments,
        context,
    )


def _add_playlist_to_queue(
    arguments: dict[str, Any],
    context: RoomAgentToolContext,
) -> RoomAgentToolResult:
    return _emit_non_empty_playlist_action(
        "add_playlist_to_queue",
        arguments,
        context,
    )


def _remove_music_from_queue(
    arguments: dict[str, Any],
    context: RoomAgentToolContext,
) -> RoomAgentToolResult:
    item_id = _item_id_from_arguments(arguments)
    if not item_id:
        return _item_id_required_result()

    track = _find_upcoming_track(item_id, context.music_state)
    if track is None:
        return _json_result(
            ok=False,
            payload={
                "ok": False,
                "error": "remove_music_from_queue can only remove items from upcoming",
                "item_id": item_id,
            },
        )

    action = RoomClientActionOut(type="remove_music_from_queue", item_id=item_id)
    context.client_actions.append(action)
    return _json_result(
        ok=True,
        payload={
            "ok": True,
            "client_action": action.model_dump(),
            "item_id": item_id,
            "item": track.model_dump(),
        },
    )


def _save_music_item(
    arguments: dict[str, Any],
    context: RoomAgentToolContext,
) -> RoomAgentToolResult:
    resolved, error = _resolve_music_item(
        arguments,
        context,
        require_playable_candidate=False,
    )
    if error is not None:
        return error
    return _emit_item_action("save_music_item", resolved, context)


def _unsave_music_item(
    arguments: dict[str, Any],
    context: RoomAgentToolContext,
) -> RoomAgentToolResult:
    item_id = _item_id_from_arguments(arguments)
    if not item_id:
        return _item_id_required_result()

    track = _find_saved_track(item_id, context.music_state)
    if track is None:
        return _json_result(
            ok=False,
            payload={
                "ok": False,
                "error": "unsave_music_item can only unsave items from saved",
                "item_id": item_id,
            },
        )

    action = RoomClientActionOut(type="unsave_music_item", item_id=item_id)
    context.client_actions.append(action)
    return _json_result(
        ok=True,
        payload={
            "ok": True,
            "client_action": action.model_dump(),
            "item_id": item_id,
            "item": track.model_dump(),
        },
    )


def _clear_music_queue(
    arguments: dict[str, Any],
    context: RoomAgentToolContext,
) -> RoomAgentToolResult:
    del arguments
    removed_count = (
        len(context.music_state.upcoming) if context.music_state is not None else None
    )
    action = RoomClientActionOut(type="clear_music_queue")
    context.client_actions.append(action)
    return _json_result(
        ok=True,
        payload={
            "ok": True,
            "client_action": action.model_dump(),
            "removed_count": removed_count,
        },
    )


def _emit_item_action(
    action_type: str,
    resolved: ResolvedMusicItem,
    context: RoomAgentToolContext,
) -> RoomAgentToolResult:
    action = RoomClientActionOut(type=action_type, item=resolved.item)
    context.client_actions.append(action)

    payload: dict[str, Any] = {
        "ok": True,
        "client_action": action.model_dump(),
        "item": resolved.item.model_dump(),
        "origin": resolved.origin,
    }
    if resolved.candidate is not None:
        payload["candidate"] = _candidate_payload(resolved.candidate)
        payload["evidence"] = resolved.candidate.evidence
    if resolved.track is not None:
        payload["music_state_item"] = resolved.track.model_dump()

    return _json_result(ok=True, payload=payload)


def _emit_non_empty_playlist_action(
    action_type: str,
    arguments: dict[str, Any],
    context: RoomAgentToolContext,
) -> RoomAgentToolResult:
    playlist, error = _require_existing_playlist(arguments, context)
    if error is not None:
        return error

    if not _playlist_has_items(playlist):
        return _json_result(
            ok=False,
            payload={
                "ok": False,
                "error": "playlist must contain at least one item",
                "playlist_id": playlist.id,
            },
        )

    action = RoomClientActionOut(
        type=action_type,
        playlist_id=playlist.id,
        playlist_name=playlist.name,
    )
    context.client_actions.append(action)
    return _json_result(
        ok=True,
        payload={
            "ok": True,
            "client_action": action.model_dump(),
            "playlist": playlist.model_dump(),
        },
    )


def _require_existing_playlist(
    arguments: dict[str, Any],
    context: RoomAgentToolContext,
) -> tuple[MusicAgentPlaylist | None, RoomAgentToolResult | None]:
    playlist_id_or_name = _playlist_id_or_name_from_arguments(arguments)
    if not playlist_id_or_name:
        return None, _json_result(
            ok=False,
            payload={"ok": False, "error": "playlist_id_or_name is required"},
        )

    playlist = _find_playlist(playlist_id_or_name, context.music_state)
    if playlist is None:
        return None, _json_result(
            ok=False,
            payload={
                "ok": False,
                "error": f"playlist was not found in current music state: {playlist_id_or_name}",
                "playlist_id_or_name": playlist_id_or_name,
            },
        )

    return playlist, None


def _playlist_has_items(playlist: MusicAgentPlaylist) -> bool:
    return bool(playlist.items)


def _resolve_music_item(
    arguments: dict[str, Any],
    context: RoomAgentToolContext,
    *,
    require_playable_candidate: bool,
) -> tuple[ResolvedMusicItem | None, RoomAgentToolResult | None]:
    item_id = _item_id_from_arguments(arguments)
    if not item_id:
        return None, _item_id_required_result()

    candidate = context.candidates.get(item_id)
    if candidate is not None:
        if require_playable_candidate and not candidate.playable:
            return None, _json_result(
                ok=False,
                payload={
                    "ok": False,
                    "error": "Selected music item is not playable",
                    "item": _candidate_payload(candidate),
                },
            )
        item = music_result_to_client_item(
            candidate,
            source_query=context.candidate_queries.get(candidate.id),
        )
        return (
            ResolvedMusicItem(
                item=item,
                origin="search_candidate",
                candidate=candidate,
            ),
            None,
        )

    track, origin = _find_music_state_track(item_id, context.music_state)
    if track is not None:
        return (
            ResolvedMusicItem(
                item=music_track_to_client_item(track, origin),
                origin=f"music_state.{origin}",
                track=track,
            ),
            None,
        )

    return None, _json_result(
        ok=False,
        payload={
            "ok": False,
            "error": f"Music item was not found in current tool context: {item_id}",
            "item_id": item_id,
        },
    )


def music_track_to_client_item(
    track: MusicAgentTrack,
    origin: str,
) -> ClientMusicItemOut:
    return ClientMusicItemOut(
        id=track.id,
        source=track.source,
        title=track.title,
        creator=track.creator,
        duration_ms=track.duration_ms,
        page_url=track.page_url,
        platform_audio_url=track.platform_audio_url,
        tags=list(track.tags),
        can_open_video=track.can_open_video,
        selected_reason=f"known from music state: {origin}",
        selection_evidence=[f"music_state.{origin}"],
    )


def _find_music_state_track(
    item_id: str,
    state: MusicAgentState | None,
) -> tuple[MusicAgentTrack | None, str]:
    if state is None:
        return None, ""

    singleton_tracks = [
        ("current", state.current),
        ("previous", state.previous),
        ("next", state.next),
    ]
    for origin, track in singleton_tracks:
        if track is not None and track.id == item_id:
            return track, origin

    for origin, tracks in [
        ("upcoming", state.upcoming),
        ("recent", state.recent),
        ("saved", state.saved),
    ]:
        track = _find_track_in_list(item_id, tracks)
        if track is not None:
            return track, origin

    for playlist in state.playlists:
        track = _find_track_in_list(item_id, playlist.items)
        if track is not None:
            return track, f"playlists.{playlist.id}.items"

    return None, ""


def _find_playlist(
    playlist_id_or_name: str,
    state: MusicAgentState | None,
) -> MusicAgentPlaylist | None:
    if state is None:
        return None
    for playlist in state.playlists:
        if playlist.id == playlist_id_or_name or playlist.name == playlist_id_or_name:
            return playlist
    return None


def _find_upcoming_track(
    item_id: str,
    state: MusicAgentState | None,
) -> MusicAgentTrack | None:
    if state is None:
        return None
    return _find_track_in_list(item_id, state.upcoming)


def _find_saved_track(
    item_id: str,
    state: MusicAgentState | None,
) -> MusicAgentTrack | None:
    if state is None:
        return None
    return _find_track_in_list(item_id, state.saved)


def _find_track_in_list(
    item_id: str,
    tracks: list[MusicAgentTrack],
) -> MusicAgentTrack | None:
    for track in tracks:
        if track.id == item_id:
            return track
    return None


def music_result_to_client_item(
    result: MusicSearchCandidate,
    source_query: str | None = None,
) -> ClientMusicItemOut:
    selected_reason = selection_reason_for_result(result)
    selection_evidence = list(result.evidence)

    if isinstance(result, BilibiliVideoSearchResult):
        return ClientMusicItemOut(
            id=result.id,
            source="bilibili",
            title=result.title,
            creator=result.creator,
            duration_ms=result.duration_ms,
            page_url=result.page_url,
            platform_audio_url=None,
            tags=["bilibili", "search", "agent-selected"],
            can_open_video=True,
            source_query=source_query,
            selected_reason=selected_reason,
            selection_evidence=selection_evidence,
            selection_score=result.score,
        )

    return ClientMusicItemOut(
        id=result.id,
        source="netease",
        title=result.title,
        creator=result.creator,
        duration_ms=result.duration_ms,
        page_url=result.page_url,
        platform_audio_url=result.platform_audio_url,
        tags=["netease", "search", "agent-selected"],
        can_open_video=False,
        source_query=source_query,
        selected_reason=selected_reason,
        selection_evidence=selection_evidence,
        selection_score=result.score,
    )


def selection_reason_for_result(result: MusicSearchCandidate) -> str:
    evidence = "; ".join(result.evidence[:2])
    rounded_score = round(result.score, 1)
    if evidence:
        return f"ranked score {rounded_score}: {evidence}"
    return f"ranked score {rounded_score}"


def _item_id_tool_spec(name: str, description: str) -> dict[str, Any]:
    return {
        "type": "function",
        "function": {
            "name": name,
            "description": description,
            "parameters": {
                "type": "object",
                "properties": {
                    "item_id": {
                        "type": "string",
                        "description": "Music item id from search results or music state.",
                    }
                },
                "required": ["item_id"],
                "additionalProperties": False,
            },
        },
    }


def _playlist_id_tool_spec(name: str, description: str) -> dict[str, Any]:
    return {
        "type": "function",
        "function": {
            "name": name,
            "description": description,
            "parameters": {
                "type": "object",
                "properties": {
                    "playlist_id_or_name": {
                        "type": "string",
                        "description": "Music playlist id or exact playlist name from music state.",
                    }
                },
                "required": ["playlist_id_or_name"],
                "additionalProperties": False,
            },
        },
    }


def _playlist_name_tool_spec(name: str, description: str) -> dict[str, Any]:
    return {
        "type": "function",
        "function": {
            "name": name,
            "description": description,
            "parameters": {
                "type": "object",
                "properties": {
                    "playlist_id_or_name": {
                        "type": "string",
                        "description": "Music playlist id or exact playlist name from music state.",
                    },
                    "name": {
                        "type": "string",
                        "description": "New playlist name.",
                    },
                },
                "required": ["playlist_id_or_name", "name"],
                "additionalProperties": False,
            },
        },
    }


def _playlist_item_tool_spec(name: str, description: str) -> dict[str, Any]:
    return {
        "type": "function",
        "function": {
            "name": name,
            "description": description,
            "parameters": {
                "type": "object",
                "properties": {
                    "playlist_id_or_name": {
                        "type": "string",
                        "description": "Music playlist id or exact playlist name from music state.",
                    },
                    "item_id": {
                        "type": "string",
                        "description": "Music item id from search results or music state.",
                    },
                },
                "required": ["playlist_id_or_name", "item_id"],
                "additionalProperties": False,
            },
        },
    }


def _item_id_from_arguments(arguments: dict[str, Any]) -> str:
    return str(arguments.get("item_id") or "").strip()


def _playlist_id_or_name_from_arguments(arguments: dict[str, Any]) -> str:
    return str(
        arguments.get("playlist_id_or_name")
        or arguments.get("playlist_id")
        or ""
    ).strip()


def _playlist_name_from_arguments(arguments: dict[str, Any]) -> str:
    return str(arguments.get("name") or "").strip()


def _playlist_description_from_arguments(arguments: dict[str, Any]) -> str | None:
    description = arguments.get("description")
    if description is None:
        return None
    description_text = str(description).strip()
    return description_text or None


def _append_new_playlist_to_music_state(
    context: RoomAgentToolContext,
    name: str,
    description: str | None,
) -> MusicAgentPlaylist:
    state = context.music_state or MusicAgentState()
    playlist = MusicAgentPlaylist(
        id=_create_unique_playlist_id(name, [candidate.id for candidate in state.playlists]),
        name=name,
        description=description,
        item_count=0,
        updated_at=_current_iso_time(),
        items=[],
    )
    _set_music_state_playlists(context, [*state.playlists, playlist])
    return playlist


def _replace_music_state_playlist(
    context: RoomAgentToolContext,
    playlist: MusicAgentPlaylist,
) -> None:
    state = context.music_state
    if state is None:
        return
    _set_music_state_playlists(
        context,
        [
            playlist if candidate.id == playlist.id else candidate
            for candidate in state.playlists
        ],
    )


def _remove_music_state_playlist(
    context: RoomAgentToolContext,
    playlist_id: str,
) -> None:
    state = context.music_state
    if state is None:
        return
    _set_music_state_playlists(
        context,
        [playlist for playlist in state.playlists if playlist.id != playlist_id],
    )


def _set_music_state_playlists(
    context: RoomAgentToolContext,
    playlists: list[MusicAgentPlaylist],
) -> None:
    state = context.music_state or MusicAgentState()
    context.music_state = state.model_copy(update={"playlists": playlists})


def _playlist_with_added_track(
    playlist: MusicAgentPlaylist,
    track: MusicAgentTrack,
    *,
    updated_at: str,
) -> MusicAgentPlaylist:
    replaced = False
    items: list[MusicAgentTrack] = []
    for item in playlist.items:
        if item.id == track.id:
            items.append(track)
            replaced = True
        else:
            items.append(item)
    if not replaced:
        items.append(track)
    return playlist.model_copy(
        update={"items": items, "item_count": len(items), "updated_at": updated_at}
    )


def _playlist_without_track(
    playlist: MusicAgentPlaylist,
    item_id: str,
    *,
    updated_at: str,
) -> MusicAgentPlaylist:
    items = [item for item in playlist.items if item.id != item_id]
    return playlist.model_copy(
        update={"items": items, "item_count": len(items), "updated_at": updated_at}
    )


def _music_agent_track_from_resolved_item(
    resolved: ResolvedMusicItem,
) -> MusicAgentTrack:
    if resolved.track is not None:
        return resolved.track

    item = resolved.item
    return MusicAgentTrack(
        id=item.id,
        source=item.source,
        title=item.title,
        creator=item.creator,
        duration_ms=item.duration_ms,
        page_url=item.page_url,
        platform_audio_url=item.platform_audio_url,
        tags=list(item.tags),
        can_open_video=item.can_open_video,
    )


def _create_unique_playlist_id(name: str, existing_ids: list[str]) -> str:
    existing = set(existing_ids)
    base_id = f"playlist-{_slug_playlist_name(name)}"
    if base_id not in existing:
        return base_id

    suffix = 2
    while f"{base_id}-{suffix}" in existing:
        suffix += 1
    return f"{base_id}-{suffix}"


def _slug_playlist_name(name: str) -> str:
    trimmed_name = name.strip()
    known_slug = _KNOWN_PLAYLIST_SLUGS.get(trimmed_name)
    if known_slug:
        return known_slug

    normalized_name = unicodedata.normalize("NFKD", trimmed_name)
    without_marks = "".join(
        character
        for character in normalized_name
        if not unicodedata.combining(character)
    )
    words = re.findall(r"[a-z0-9]+", without_marks.lower())
    return "-".join(words) if words else "playlist"


def _current_iso_time() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="milliseconds").replace("+00:00", "Z")


def _item_id_required_result() -> RoomAgentToolResult:
    return _json_result(
        ok=False,
        payload={"ok": False, "error": "item_id is required"},
    )


def _playlist_summary_payload(playlist: MusicAgentPlaylist) -> dict[str, Any]:
    return {
        "id": playlist.id,
        "name": playlist.name,
        "description": playlist.description,
        "item_count": playlist.item_count,
        "updated_at": playlist.updated_at,
    }


def _candidate_payload(result: MusicSearchCandidate) -> dict[str, Any]:
    payload: dict[str, Any] = {
        "id": result.id,
        "source": result.source,
        "title": result.title,
        "creator": result.creator,
        "duration_ms": result.duration_ms,
        "page_url": result.page_url,
        "platform_audio_url": result.platform_audio_url,
        "playable": result.playable,
        "popularity": result.popularity,
        "comment_count": result.comment_count,
        "hot_comment_liked_count": result.hot_comment_liked_count,
        "score": result.score,
        "evidence": result.evidence,
    }
    if isinstance(result, NeteaseSongSearchResult):
        payload["song_id"] = result.song_id
    if isinstance(result, BilibiliVideoSearchResult):
        payload["bvid"] = result.bvid
        payload["embed_url"] = result.embed_url
    return payload


def _json_result(ok: bool, payload: dict[str, Any]) -> RoomAgentToolResult:
    return RoomAgentToolResult(
        ok=ok,
        content=json.dumps(payload, ensure_ascii=False, separators=(",", ":")),
    )


def _clamp_int(value: Any, default: int, minimum: int, maximum: int) -> int:
    if isinstance(value, bool):
        return default
    try:
        parsed = int(value)
    except (TypeError, ValueError):
        return default
    return max(minimum, min(maximum, parsed))


_ROOM_AGENT_TOOL_HANDLERS: dict[str, RoomAgentToolHandler] = {
    "get_music_state": _get_music_state,
    "list_music_playlists": _list_music_playlists,
    "get_music_playlist": _get_music_playlist,
    "create_music_playlist": _create_music_playlist,
    "rename_music_playlist": _rename_music_playlist,
    "delete_music_playlist": _delete_music_playlist,
    "add_music_to_playlist": _add_music_to_playlist,
    "remove_music_from_playlist": _remove_music_from_playlist,
    "play_music_playlist": _play_music_playlist,
    "add_playlist_to_queue": _add_playlist_to_queue,
    "search_music": _search_music,
    "play_music_item": _play_music_item,
    "add_music_to_queue": _add_music_to_queue,
    "remove_music_from_queue": _remove_music_from_queue,
    "save_music_item": _save_music_item,
    "unsave_music_item": _unsave_music_item,
    "clear_music_queue": _clear_music_queue,
}

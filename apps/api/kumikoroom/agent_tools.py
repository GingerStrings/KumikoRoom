from __future__ import annotations

from dataclasses import dataclass, field
import json
from typing import Any

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
                    "playback progress, and play/pause state."
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
    if tool_call.name == "get_music_state":
        return _get_music_state(tool_call.arguments, context)
    if tool_call.name == "search_music":
        return _search_music(tool_call.arguments, context)
    if tool_call.name == "play_music_item":
        return _play_music_item(tool_call.arguments, context)
    if tool_call.name == "add_music_to_queue":
        return _add_music_to_queue(tool_call.arguments, context)
    if tool_call.name == "remove_music_from_queue":
        return _remove_music_from_queue(tool_call.arguments, context)
    if tool_call.name == "save_music_item":
        return _save_music_item(tool_call.arguments, context)
    if tool_call.name == "unsave_music_item":
        return _unsave_music_item(tool_call.arguments, context)
    if tool_call.name == "clear_music_queue":
        return _clear_music_queue(tool_call.arguments, context)

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

    return None, ""


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


def _item_id_from_arguments(arguments: dict[str, Any]) -> str:
    return str(arguments.get("item_id") or "").strip()


def _item_id_required_result() -> RoomAgentToolResult:
    return _json_result(
        ok=False,
        payload={"ok": False, "error": "item_id is required"},
    )


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

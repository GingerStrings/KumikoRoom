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
from kumikoroom.schemas import ClientMusicItemOut, RoomClientActionOut


@dataclass
class RoomAgentToolContext:
    candidates: dict[str, MusicSearchCandidate] = field(default_factory=dict)
    candidate_queries: dict[str, str] = field(default_factory=dict)
    client_actions: list[RoomClientActionOut] = field(default_factory=list)


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
                "name": "play_music_item",
                "description": (
                    "Queue and play one candidate returned by search_music. Use the "
                    "candidate id from the ranked search results."
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
    ]


def dispatch_room_agent_tool(
    tool_call: LLMToolCall,
    context: RoomAgentToolContext,
) -> RoomAgentToolResult:
    if tool_call.name == "search_music":
        return _search_music(tool_call.arguments, context)
    if tool_call.name == "play_music_item":
        return _play_music_item(tool_call.arguments, context)

    return _json_result(
        ok=False,
        payload={
            "ok": False,
            "error": f"Unknown tool: {tool_call.name}",
            "tool": tool_call.name,
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
    item_id = str(arguments.get("item_id") or "").strip()
    candidate = context.candidates.get(item_id)
    if candidate is None:
        return _json_result(
            ok=False,
            payload={
                "ok": False,
                "error": f"Music item was not found in current tool context: {item_id}",
                "item_id": item_id,
            },
        )
    if not candidate.playable:
        return _json_result(
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
    action = RoomClientActionOut(type="play_music_item", item=item)
    context.client_actions.append(action)
    return _json_result(
        ok=True,
        payload={
            "ok": True,
            "client_action": action.model_dump(),
            "item": item.model_dump(),
            "candidate": _candidate_payload(candidate),
            "evidence": candidate.evidence,
        },
    )


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

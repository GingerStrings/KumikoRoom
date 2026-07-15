from __future__ import annotations

from dataclasses import dataclass
from html import unescape
import math
import re
from typing import Any, Literal, TypeAlias

import httpx


class MusicSearchError(RuntimeError):
    pass


@dataclass(frozen=True)
class NeteaseSongSearchResult:
    id: str
    song_id: str
    title: str
    creator: str
    duration_ms: int
    playable: bool
    popularity: float | None
    comment_count: int | None
    hot_comment_liked_count: int | None
    score: float
    evidence: list[str]
    source: Literal["netease"] = "netease"

    @property
    def page_url(self) -> str:
        return f"https://music.163.com/#/song?id={self.song_id}"

    @property
    def platform_audio_url(self) -> str:
        return f"https://music.163.com/song/media/outer/url?id={self.song_id}.mp3"


@dataclass(frozen=True)
class BilibiliVideoSearchResult:
    id: str
    bvid: str
    title: str
    creator: str
    duration_ms: int
    playable: bool
    popularity: int | None
    comment_count: int | None
    hot_comment_liked_count: int | None
    score: float
    evidence: list[str]
    source: Literal["bilibili"] = "bilibili"

    @property
    def page_url(self) -> str:
        return f"https://www.bilibili.com/video/{self.bvid}"

    @property
    def embed_url(self) -> str:
        return f"https://player.bilibili.com/player.html?bvid={self.bvid}"

    @property
    def platform_audio_url(self) -> None:
        return None


MusicSearchCandidate: TypeAlias = NeteaseSongSearchResult | BilibiliVideoSearchResult


def search_netease_songs(query: str, limit: int = 5) -> list[NeteaseSongSearchResult]:
    query = query.strip()
    if not query:
        return []

    try:
        response = httpx.get(
            "https://music.163.com/api/search/get",
            params={
                "s": query,
                "type": 1,
                "limit": max(limit * 3, limit),
                "offset": 0,
            },
            headers={"User-Agent": "Mozilla/5.0"},
            timeout=8.0,
        )
        response.raise_for_status()
    except httpx.HTTPError as error:
        raise MusicSearchError(f"NetEase search failed: {error}") from error

    return parse_netease_song_results(response.json(), query=query, limit=limit)


def parse_netease_song_results(
    payload: dict[str, Any],
    query: str,
    limit: int = 5,
) -> list[NeteaseSongSearchResult]:
    songs = ((payload.get("result") or {}).get("songs") or [])[: max(limit * 3, limit)]
    song_ids = [str(song.get("id")) for song in songs if song.get("id") is not None]
    details = fetch_netease_song_details(song_ids) if song_ids else {}
    results: list[NeteaseSongSearchResult] = []

    for raw_rank, song in enumerate(songs, start=1):
        song_id = str(song.get("id") or "").strip()
        if not song_id:
            continue

        title = str(song.get("name") or "").strip()
        artists = song.get("artists") or song.get("ar") or []
        creator = " / ".join(
            str(artist.get("name") or "").strip()
            for artist in artists
            if isinstance(artist, dict) and str(artist.get("name") or "").strip()
        )
        duration_ms = _safe_int(song.get("duration") or song.get("dt"), default=0)
        detail = details.get(song_id, {})
        metrics = fetch_netease_comment_metrics(song_id)
        playable = check_netease_outer_audio_playable(song_id)
        score, evidence = score_netease_candidate(
            query=query,
            title=title,
            creator=creator,
            duration_ms=duration_ms,
            detail=detail,
            metrics=metrics,
            playable=playable,
            raw_rank=raw_rank,
        )

        popularity = _safe_optional_float(
            detail.get("popularity", detail.get("score"))
        )
        comment_count = _safe_optional_int(metrics.get("comment_count"))
        hot_comment_liked_count = _safe_optional_int(
            metrics.get("hot_comment_liked_count")
        )
        results.append(
            NeteaseSongSearchResult(
                id=f"netease-song-{song_id}",
                song_id=song_id,
                title=title,
                creator=creator,
                duration_ms=duration_ms,
                playable=playable,
                popularity=popularity,
                comment_count=comment_count,
                hot_comment_liked_count=hot_comment_liked_count,
                score=round(score, 3),
                evidence=evidence,
            )
        )

    return sorted(results, key=lambda result: result.score, reverse=True)[:limit]


def fetch_netease_song_details(song_ids: list[str]) -> dict[str, dict[str, Any]]:
    if not song_ids:
        return {}

    try:
        response = httpx.get(
            "https://music.163.com/api/song/detail",
            params={"ids": "[" + ",".join(song_ids) + "]"},
            headers={"User-Agent": "Mozilla/5.0"},
            timeout=8.0,
        )
        response.raise_for_status()
    except httpx.HTTPError:
        return {}

    details: dict[str, dict[str, Any]] = {}
    for song in response.json().get("songs", []):
        if not isinstance(song, dict) or song.get("id") is None:
            continue
        song_id = str(song["id"])
        details[song_id] = {
            "popularity": song.get("popularity", song.get("score")),
            "score": song.get("score"),
            "commentThreadId": song.get("commentThreadId"),
        }
    return details


def fetch_netease_comment_metrics(song_id: str) -> dict[str, int | None]:
    try:
        response = httpx.get(
            f"https://music.163.com/api/v1/resource/comments/R_SO_4_{song_id}",
            params={"limit": 20, "offset": 0},
            headers={"User-Agent": "Mozilla/5.0"},
            timeout=8.0,
        )
        response.raise_for_status()
    except httpx.HTTPError:
        return {"comment_count": None, "hot_comment_liked_count": None}

    payload = response.json()
    hot_comments = payload.get("hotComments") or []
    hot_likes = [
        _safe_int(comment.get("likedCount"), default=0)
        for comment in hot_comments
        if isinstance(comment, dict)
    ]
    return {
        "comment_count": _safe_optional_int(payload.get("total")),
        "hot_comment_liked_count": max(hot_likes) if hot_likes else None,
    }


def check_netease_outer_audio_playable(song_id: str) -> bool:
    try:
        response = httpx.head(
            f"https://music.163.com/song/media/outer/url?id={song_id}.mp3",
            follow_redirects=False,
            timeout=5.0,
            headers={"User-Agent": "Mozilla/5.0"},
        )
    except httpx.HTTPError:
        return False

    location = response.headers.get("location", "")
    return response.status_code < 400 and "/404" not in location


def score_netease_candidate(
    *,
    query: str,
    title: str,
    creator: str,
    duration_ms: int,
    detail: dict[str, Any],
    metrics: dict[str, int | None],
    playable: bool,
    raw_rank: int,
) -> tuple[float, list[str]]:
    score = max(0.0, 12.0 - raw_rank)
    evidence = [f"raw_rank={raw_rank}"]
    query_norm = _normalize_text(query)
    title_norm = _normalize_text(title)
    creator_norm = _normalize_text(creator)

    for token in _query_tokens(query_norm):
        if token in title_norm:
            score += 24.0
            evidence.append(f"title contains {token}")
        if token in creator_norm:
            score += 12.0
            evidence.append(f"creator contains {token}")

    if playable:
        score += 25.0
        evidence.append("candidate is playable through NetEase outer audio URL")
    else:
        score -= 40.0
        evidence.append("candidate is not playable through NetEase outer audio URL")

    duration_score, duration_evidence = _duration_score(duration_ms)
    score += duration_score
    evidence.extend(duration_evidence)

    for penalty_word in ("dj", "cover", "live", "remix", "instrumental"):
        if penalty_word in title_norm and penalty_word not in query_norm:
            score -= 8.0
            evidence.append(f"variant penalty: {penalty_word}")
    for penalty_word in ("伴奏", "翻自", "片段", "女声版", "钢琴版"):
        if penalty_word in title and penalty_word not in query:
            score -= 8.0
            evidence.append(f"variant penalty: {penalty_word}")

    popularity = _safe_optional_float(detail.get("popularity", detail.get("score")))
    if popularity is not None:
        score += min(24.0, popularity / 5.0)
        evidence.append(f"popularity={popularity:g}")
    else:
        evidence.append("popularity unavailable")

    comment_count = _safe_optional_int(metrics.get("comment_count"))
    if comment_count is not None:
        score += min(32.0, math.log10(max(comment_count, 1)) * 8.0)
        evidence.append(f"comment_count={comment_count}")
    else:
        evidence.append("comment_count unavailable")

    hot_comment_liked_count = _safe_optional_int(metrics.get("hot_comment_liked_count"))
    if hot_comment_liked_count is not None:
        score += min(28.0, math.log10(max(hot_comment_liked_count, 1)) * 7.0)
        evidence.append(f"hot_comment_liked_count={hot_comment_liked_count}")
    else:
        evidence.append("hot_comment_liked_count unavailable")

    return score, evidence


def search_bilibili_videos(
    query: str,
    limit: int = 5,
) -> list[BilibiliVideoSearchResult]:
    query = query.strip()
    if not query:
        return []

    try:
        response = httpx.get(
            "https://api.bilibili.com/x/web-interface/search/type",
            params={
                "search_type": "video",
                "keyword": query,
                "page": 1,
                "order": "totalrank",
            },
            headers={"User-Agent": "Mozilla/5.0"},
            timeout=8.0,
        )
        response.raise_for_status()
    except httpx.HTTPError as error:
        raise MusicSearchError(f"Bilibili search failed: {error}") from error

    return parse_bilibili_video_results(response.json(), query=query, limit=limit)


def parse_bilibili_video_results(
    payload: dict[str, Any],
    query: str,
    limit: int = 5,
) -> list[BilibiliVideoSearchResult]:
    raw_results = ((payload.get("data") or {}).get("result") or [])[: max(limit * 3, limit)]
    results: list[BilibiliVideoSearchResult] = []

    for raw_rank, raw in enumerate(raw_results, start=1):
        if not isinstance(raw, dict):
            continue
        bvid = str(raw.get("bvid") or "").strip()
        if not bvid:
            continue

        title = _strip_html(str(raw.get("title") or "")).strip()
        creator = str(raw.get("author") or raw.get("mid") or "Bilibili").strip()
        duration_ms = _parse_bilibili_duration(raw.get("duration"))
        view_count = _safe_optional_int(raw.get("play") or raw.get("view"))
        comment_count = _safe_optional_int(
            raw.get("video_review") or raw.get("review") or raw.get("reply")
        )
        liked_count = _safe_optional_int(raw.get("like"))
        score, evidence = score_bilibili_candidate(
            query=query,
            title=title,
            creator=creator,
            duration_ms=duration_ms,
            view_count=view_count,
            comment_count=comment_count,
            hot_comment_liked_count=liked_count,
            raw_rank=raw_rank,
        )
        results.append(
            BilibiliVideoSearchResult(
                id=f"bilibili-{bvid}",
                bvid=bvid,
                title=title,
                creator=creator,
                duration_ms=duration_ms,
                playable=True,
                popularity=view_count,
                comment_count=comment_count,
                hot_comment_liked_count=liked_count,
                score=round(score, 3),
                evidence=evidence,
            )
        )

    return sorted(results, key=lambda result: result.score, reverse=True)[:limit]


def score_bilibili_candidate(
    *,
    query: str,
    title: str,
    creator: str,
    duration_ms: int,
    view_count: int | None,
    comment_count: int | None,
    hot_comment_liked_count: int | None,
    raw_rank: int,
) -> tuple[float, list[str]]:
    score = max(0.0, 10.0 - raw_rank)
    evidence = [f"raw_rank={raw_rank}", "candidate is playable through Bilibili video window"]
    query_norm = _normalize_text(query)
    title_norm = _normalize_text(title)
    creator_norm = _normalize_text(creator)

    for token in _query_tokens(query_norm):
        if token in title_norm:
            score += 22.0
            evidence.append(f"title contains {token}")
        if token in creator_norm:
            score += 12.0
            evidence.append(f"creator contains {token}")

    duration_score, duration_evidence = _duration_score(duration_ms)
    score += duration_score
    evidence.extend(duration_evidence)

    for penalty_word in ("片段", "副歌", "short", "clip"):
        if penalty_word in title_norm and penalty_word not in query_norm:
            score -= 18.0
            evidence.append(f"short clip penalty: {penalty_word}")

    if view_count is not None:
        score += min(34.0, math.log10(max(view_count, 1)) * 6.0)
        evidence.append(f"view_count={view_count}")
    else:
        evidence.append("view_count unavailable")

    if comment_count is not None:
        score += min(28.0, math.log10(max(comment_count, 1)) * 6.0)
        evidence.append(f"comment_count={comment_count}")
    else:
        evidence.append("comment_count unavailable")

    if hot_comment_liked_count is not None:
        score += min(30.0, math.log10(max(hot_comment_liked_count, 1)) * 6.0)
        evidence.append(f"hot_comment_liked_count={hot_comment_liked_count}")
    else:
        evidence.append("hot_comment_liked_count unavailable")

    return score, evidence


def _duration_score(duration_ms: int) -> tuple[float, list[str]]:
    if duration_ms <= 0:
        return 0.0, ["duration unavailable"]
    if duration_ms < 45_000:
        return -18.0, ["duration looks like a short clip"]
    if 90_000 <= duration_ms <= 8 * 60_000:
        return 18.0, ["duration looks like a full song or complete performance"]
    return 4.0, [f"duration_ms={duration_ms}"]


def _strip_html(value: str) -> str:
    return unescape(re.sub(r"<[^>]+>", "", value))


def _normalize_text(value: str) -> str:
    return re.sub(r"\s+", "", _strip_html(value).lower())


def _query_tokens(query_norm: str) -> list[str]:
    if not query_norm:
        return []
    tokens = re.split(r"[/,，。;；、\-\s]+", query_norm)
    compact_tokens = [token for token in tokens if len(token) >= 2]
    return compact_tokens or [query_norm]


def _parse_bilibili_duration(value: Any) -> int:
    if isinstance(value, (int, float)):
        return int(value * 1000)
    if not isinstance(value, str):
        return 0
    parts = value.strip().split(":")
    if not all(part.isdigit() for part in parts):
        return 0
    seconds = 0
    for part in parts:
        seconds = seconds * 60 + int(part)
    return seconds * 1000


def _safe_int(value: Any, default: int) -> int:
    try:
        return int(value)
    except (TypeError, ValueError):
        return default


def _safe_optional_int(value: Any) -> int | None:
    if value is None:
        return None
    try:
        return int(value)
    except (TypeError, ValueError):
        return None


def _safe_optional_float(value: Any) -> float | None:
    if value is None:
        return None
    try:
        return float(value)
    except (TypeError, ValueError):
        return None

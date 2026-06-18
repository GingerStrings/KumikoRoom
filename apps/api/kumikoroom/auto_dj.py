from __future__ import annotations

from datetime import datetime, timezone

from kumikoroom.schemas import (
    AutoDjRecommendIn,
    AutoDjRecommendOut,
    MusicRecommendationProfileIn,
    RecommendationProfilePatchOut,
)


def recommend_auto_dj(payload: AutoDjRecommendIn) -> AutoDjRecommendOut:
    if not _has_recommendation_context(
        payload.music_state, payload.recommendation_profile
    ):
        return AutoDjRecommendOut(
            ok=False,
            refill_id=None,
            notice="Auto DJ needs a current track or listening profile before it can recommend.",
            client_actions=[],
            recommendations=[],
            profile_patch=RecommendationProfilePatchOut(),
            error="needs_more_context",
        )

    return AutoDjRecommendOut(
        ok=True,
        refill_id=f"auto-dj-{_utc_compact_timestamp()}",
        notice="Auto DJ did not find enough recommendations this time.",
        client_actions=[],
        recommendations=[],
        profile_patch=RecommendationProfilePatchOut(),
    )


def _has_recommendation_context(
    music_state,
    profile: MusicRecommendationProfileIn | None,
) -> bool:
    if music_state is not None:
        if music_state.current is not None:
            return True
        if music_state.recent or music_state.saved or music_state.playlists:
            return True

    if profile is None:
        return False

    return bool(
        profile.artist_weights
        or profile.tag_weights
        or profile.query_weights
        or profile.recent_themes
    )


def _utc_compact_timestamp() -> str:
    return datetime.now(timezone.utc).strftime("%Y%m%d%H%M%S%f")

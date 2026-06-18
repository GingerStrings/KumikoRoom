# Auto DJ Recommendation System Design

Date: 2026-06-18

## Purpose

KumikoRoom already has agentic music search, playback client actions, a browser-owned queue, recent records, saved tracks, and lightweight playlists. The next music slice should make the room feel more like it can keep listening with the user.

This feature adds an Auto DJ mode. When enabled, the player watches the remaining queue and asks the backend for recommendations before the queue runs dry. The first version combines a traditional recommendation core with agent orchestration:

- the recommendation core handles profile signals, recall, scoring, diversity, cooldowns, and evidence;
- the agent layer interprets the current listening and conversation context, chooses search directions, and explains the result briefly.

The feature should search for fresh tracks first. Existing recent records, saved tracks, playlists, and current queue items are taste signals and duplicate controls, not the main source of recommended tracks.

## Goals

- Add an `Auto DJ` switch to the existing player surface.
- When Auto DJ is enabled and playable queue depth falls to 2 tracks, request 3 recommendations.
- Prefer new candidates from NetEase and Bilibili search.
- Use current track, recent records, saved tracks, playlists, and chat context as recommendation signals.
- Maintain a lightweight local recommendation profile with short-term and long-term preference signals.
- Support implicit feedback from playback behavior and explicit negative feedback through `dislike this track`.
- Append recommended tracks to the queue with structured recommendation reasons.
- Add one short system-style chat notice after an automatic refill succeeds.
- Keep the implementation testable through deterministic scoring, evidence fields, and bounded agent behavior.

## Non-Goals

- Account-based collaborative filtering.
- Cloud sync for recommendation profiles.
- Full music catalog indexing.
- User-facing tuning sliders or an editable preference panel in the first version.
- Long-form chat messages for every automatic refill.
- Replacing the existing `search_music` ranking system.
- A full recommendation ML model or embedding store.

## Recommended Approach

Build a search-first Auto DJ pipeline:

1. The browser owns the Auto DJ switch and queue-depth trigger.
2. The browser sends the current `musicState`, local recommendation profile, recent messages, and refill settings to the backend.
3. The backend agent creates recommendation intents such as `similar_theme`, `similar_mood`, and `light_exploration`.
4. The recommendation core converts those intents into several search queries.
5. Existing NetEase and Bilibili search functions recall candidates.
6. The recommendation core scores, deduplicates, applies cooldowns, and selects 3 tracks.
7. The backend returns typed client actions to append tracks to the queue, plus a compact notice.
8. The browser applies the queue actions, records recommendation events, and updates the local profile.

Default mix:

- 2 tracks close to the current listening context;
- 1 track with light exploration.

If two consecutive Auto DJ refills are too similar, the next refill changes to:

- 1 close track;
- 2 exploratory tracks.

## Existing System Fit

The design builds on existing boundaries:

- `MusicItem` remains the canonical frontend track payload.
- `MusicQueueState` remains the browser-owned playback queue and history.
- `MusicLibraryState` remains the browser-owned playlist library.
- `MusicAgentState` remains the backend-visible snapshot of current playback, recent, saved, and playlists.
- `search_music` keeps using current NetEase and Bilibili search and candidate ranking.
- `RoomClientActionOut` continues to carry browser mutations requested by the backend.

The frontend should not infer recommendation intent from reply text. Recommendation effects must flow through explicit API responses and typed client actions.

## Product Behavior

### Auto DJ Switch

The player adds an `Auto DJ` switch near existing playback or management controls.

Rules:

- Off by default.
- Persisted locally.
- When enabled, the browser monitors playable queue depth.
- When current plus upcoming playable tracks reaches 2 or fewer, the browser starts one refill request.
- A refill request appends 3 tracks if enough candidates pass scoring thresholds.
- In-flight refill requests are deduplicated so the browser cannot start multiple refills for the same queue state.

### Refill Notice

After a successful automatic refill, the chat timeline gets one short system-style notice, for example:

`Auto DJ added 3 tracks and kept the mood close to what is playing.`

The notice should not be sent through the normal chat completion path. It is a lightweight UI event attached to the recommendation response.

### Track-Level Reasons

Recommended queue entries should carry a concise reason. Example reason fields:

- `similar artist and brass-band tags`
- `same quiet OST mood, fresh Bilibili candidate`
- `light exploration from recent soundtrack preference`

The queue UI can show reasons in compact text or a tooltip depending on available space.

### Dislike Feedback

Recommended tracks expose a `dislike this track` action.

Disliking a recommended track:

- immediately hides or marks the recommendation as disliked;
- adds the track id to a short-term cooldown;
- lightly lowers related author, tag, source, and query weights in the long-term profile;
- does not remove normal saved tracks or playlist items by itself.

The cooldown should be stronger than the long-term update. One disliked track should not permanently suppress a whole style.

## Recommendation Profile

The first version stores a lightweight profile in browser localStorage.

Suggested key:

`kumikoroom.musicRecommendationProfile`

Shape:

```ts
interface MusicRecommendationProfile {
  version: 1;
  updatedAt: string;
  artistWeights: Record<string, number>;
  tagWeights: Record<string, number>;
  sourceWeights: Partial<Record<MusicSourceKind, number>>;
  queryWeights: Record<string, number>;
  recentThemes: RecommendationThemeSignal[];
  cooldowns: RecommendationCooldown[];
  recommendedItems: RecommendationHistoryEntry[];
  refillHistory: RecommendationRefillHistoryEntry[];
}

interface RecommendationThemeSignal {
  key: string;
  weight: number;
  lastSeenAt: string;
}

interface RecommendationCooldown {
  key: string;
  kind: "item" | "artist" | "tag" | "query";
  weight: number;
  expiresAt: string;
  reason: "dislike" | "recently_played" | "recently_recommended";
}

interface RecommendationHistoryEntry {
  itemId: string;
  title: string;
  creator: string;
  source: MusicSourceKind;
  recommendedAt: string;
  played: boolean;
  disliked: boolean;
  reason: string;
}

interface RecommendationRefillHistoryEntry {
  refillId: string;
  createdAt: string;
  selectedItemIds: string[];
  dominantThemes: string[];
  explorationCount: number;
}
```

Profile updates come from:

- playing a recommended track;
- listening long enough to count as accepted;
- skipping early;
- saving a recommended track;
- adding a recommended track to a playlist;
- disliking a recommendation;
- normal recent, saved, and playlist state snapshots.

The exact listening threshold can start simple:

- accepted if listened for at least 60 seconds or at least 35 percent of duration;
- skipped if user moves away within 20 seconds.

## Backend API

Add an Auto DJ endpoint rather than routing automatic refills through normal chat:

`POST /api/room/music/auto-dj/recommend`

Input:

```json
{
  "music_state": {},
  "recommendation_profile": {},
  "recent_messages": [],
  "settings": {
    "count": 3,
    "queue_depth_trigger": 2,
    "similar_count": 2,
    "exploration_count": 1
  }
}
```

Output:

```json
{
  "ok": true,
  "refill_id": "auto-dj-20260618-001",
  "notice": "Auto DJ added 3 tracks and kept the mood close to what is playing.",
  "client_actions": [
    {
      "type": "add_music_to_queue",
      "item": {}
    }
  ],
  "recommendations": [
    {
      "item": {},
      "score": 127.4,
      "intent": "similar_theme",
      "reason": "similar artist and brass-band tags",
      "evidence": [
        "current tag overlap: brass",
        "not in recent queue",
        "playable candidate",
        "comment_count=5918"
      ]
    }
  ],
  "profile_patch": {}
}
```

The endpoint should support partial success. If only 1 or 2 candidates pass quality thresholds, it may return fewer actions and a notice that matches the selected count.

## Agent Orchestration

The agent layer should be bounded and inspectable.

Responsibilities:

- summarize the current listening context;
- derive a small set of recommendation intents;
- propose search query seeds;
- avoid overusing one exact keyword set;
- produce a short notice from selected recommendations.

The agent should not directly mutate browser state. It returns intents and query seeds to the recommendation core, which performs search, scoring, deduplication, and selection.

Suggested internal tool/function shape:

```python
class AutoDjIntent(BaseModel):
    name: Literal["similar_theme", "similar_mood", "same_creator_or_work", "light_exploration"]
    query_seeds: list[str]
    target_count: int
    rationale: str
```

The backend can begin with deterministic intent generation for tests and use the LLM when a real provider is configured.

## Recommendation Core

### Candidate Recall

Recall should be search-first:

- generate multiple query variants from the current track, profile, and agent intents;
- call existing NetEase and Bilibili search helpers;
- keep more candidates than needed for scoring, such as 8 to 12 per query;
- deduplicate by stable item id, normalized title plus creator, and platform URLs.

Query variants should include:

- close title or work theme;
- related artist or creator;
- mood and tag language;
- one light exploration query from recent profile themes.

### Scoring

Candidate score combines existing search evidence with profile and diversity terms.

Suggested weighted components:

- existing search score;
- playable candidate bonus;
- title, creator, and tag affinity;
- current-track similarity;
- long-term profile affinity;
- source preference;
- normal song duration bonus;
- popularity and engagement evidence;
- duplicate penalty for current queue, recent, saved, playlists, and recent recommendations;
- cooldown penalty for disliked item, artist, tag, or query;
- diversity bonus for the exploratory slot.

Each recommendation must return evidence strings for the strongest positive and negative factors.

### Diversity Control

Default selection:

- fill 2 similar slots first;
- fill 1 exploration slot next.

Similarity can be approximated with overlap among:

- normalized creator;
- tags;
- source;
- query seed;
- title tokens.

If the last two refill history entries have high overlap with the current selected set, increase exploration for this refill.

### Quality Gates

Reject candidates when:

- not playable;
- duration looks like a very short clip unless the intent allows short clips;
- same item is already current or upcoming;
- candidate is in strong active cooldown;
- title/creator are empty after normalization;
- recommendation evidence is too weak.

If quality gates reject most candidates, return fewer tracks rather than filling the queue with low-confidence picks.

## Frontend Changes

### Types

Add frontend types for:

- `AutoDjSettings`
- `MusicRecommendationProfile`
- `AutoDjRecommendation`
- `AutoDjRecommendResponse`
- recommendation metadata on queue entries or music items

### State

Add local state for:

- Auto DJ enabled flag;
- profile hydration and persistence;
- in-flight refill id or queue signature;
- latest refill result;
- dislike/cooldown updates.

### Triggering

The trigger should consider playable queue depth:

- current track counts as 1 if present;
- upcoming tracks count if playable;
- played history does not count;
- saved-only records do not count.

The browser computes a queue signature from current item id, upcoming item ids, and Auto DJ settings. It should avoid requesting another refill for the same signature.

### Applying Results

For each returned `add_music_to_queue` action:

- validate the item payload;
- append to the queue without interrupting current playback;
- store recommendation metadata such as `refillId`, `score`, `intent`, `reason`, and `evidence`;
- record recommendation history in the profile.

After actions apply, append the response notice to the chat timeline as a local system-style message.

### Feedback

Add `dislike this track` for recommended tracks in the queue or player surface.

The action should:

- update local profile cooldowns;
- mark the recommendation history entry as disliked;
- optionally remove the track from upcoming if it has not started yet;
- send a lightweight feedback event to the backend only if a feedback endpoint is included in this slice.

The first implementation can keep feedback local and include it in later recommendation requests through the profile payload.

## Backend Changes

Add schemas for:

- `AutoDjRecommendIn`
- `AutoDjRecommendOut`
- `AutoDjSettingsIn`
- `MusicRecommendationProfileIn`
- `AutoDjRecommendationOut`
- `RecommendationProfilePatchOut`

Add service functions for:

- context extraction from `MusicAgentState`;
- intent generation;
- query generation;
- candidate recall through existing search helpers;
- recommendation scoring;
- diversity selection;
- output mapping to `ClientMusicItemOut`;
- profile patch generation.

Add a router endpoint under the room music router area or `routers/room.py`, following existing API style.

## Error Handling

- If Auto DJ is disabled, the frontend must not call the endpoint.
- If there is no current track and no useful profile, return `ok: false` with a calm `needs_more_context` error.
- If external search fails for one source, keep using the other source and include source errors in debug evidence.
- If all candidate quality gates fail, return `ok: true` with zero recommendations and a short notice.
- If the profile payload is malformed, ignore invalid profile fields and continue from `music_state`.
- If a refill request is already in flight, the frontend should keep the existing request and avoid starting another one.

## Privacy And Storage

The profile is local-first and stays in browser storage in the first version. It should not include raw chat transcripts. Recent chat context sent to the Auto DJ endpoint should be bounded to the same compact message structure already used by chat requests.

The profile should be easy to reset later, even if the first slice does not expose a reset button.

## Testing

Backend unit tests:

- endpoint rejects empty context with a structured `needs_more_context` error;
- intent generation creates similar and exploration intents;
- scoring boosts profile matches and penalizes queue duplicates;
- cooldowns from disliked feedback lower item, artist, tag, and query scores;
- diversity logic changes from 2+1 to 1+2 after repeated high-overlap refills;
- partial source failure still returns candidates from the working source;
- output client actions are valid `add_music_to_queue` actions.

Frontend helper tests:

- profile hydration accepts valid profile and rejects malformed profile;
- profile updates on accepted, skipped, saved, playlist-added, and disliked events;
- queue-depth trigger fires at 2 playable tracks;
- trigger deduplication prevents duplicate refill requests for the same queue signature;
- applying recommendation response appends tracks and stores metadata;
- dislike action adds cooldown and marks history.

Frontend component tests:

- Auto DJ switch renders and persists;
- enabling Auto DJ triggers a refill when queue depth reaches 2;
- successful refill appends a short chat notice;
- recommended queue rows expose recommendation reasons;
- dislike action updates UI state without breaking normal playback controls.

Verification:

- `npm run test --workspace apps/web`
- `python -m pytest apps/api/tests -q`
- `npm run build --workspace apps/web`
- browser smoke test at `/room` with Auto DJ enabled, queue shortened to 2 tracks, and mocked recommendation response.

## Acceptance Criteria

- Auto DJ can be enabled from the player.
- When enabled, the browser requests a refill at queue depth 2.
- A refill searches for fresh NetEase and Bilibili candidates and appends up to 3 tracks.
- Recommendations use current listening context, local profile, and search evidence.
- Existing queue, recent, saved, and playlist tracks are penalized as duplicates.
- Every recommended track includes a score, intent, reason, and evidence.
- Each default refill balances 2 similar tracks with 1 exploratory track.
- Repeatedly similar refills increase exploration.
- `dislike this track` creates short-term cooldown and lightly adjusts long-term profile weights.
- Automatic refill adds one compact notice to chat and does not run the normal chat completion flow.
- The feature remains local-first and does not require account or cloud storage.

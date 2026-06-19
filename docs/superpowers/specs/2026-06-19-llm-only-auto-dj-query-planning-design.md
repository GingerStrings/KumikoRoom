# LLM-Only Auto DJ Query Planning Design

Date: 2026-06-19

## 1. Purpose

This document defines the next Auto DJ change from the current KumikoRoom codebase.

The core rule is strict: every query sent to NetEase or Bilibili by Auto DJ must come from a successful LLM query plan. Local heuristics may validate, score, filter, deduplicate, and select candidates. They must never create, complete, rewrite, or replace a search query.

If query planning cannot produce a valid plan, Auto DJ stops that refill. It returns no queue actions and performs no music search.

## 2. Current Code Baseline

The current implementation has these relevant boundaries:

- `apps/api/kumikoroom/auto_dj.py` owns context checks, query construction, platform recall, scoring, selection, response mapping, and profile patches.
- `_similar_query_seeds` builds queries from the current title, creator, profile artists, profile queries, and themes.
- `_exploration_query_seeds` appends words such as `explore` and `ost`, with `music explore` as its final fallback.
- `_candidate_score` gives an extra title bonus when an exploration result contains `explore`.
- `apps/api/kumikoroom/routers/room.py` calls `recommend_auto_dj(payload)` directly.
- `ConversationManager` already resolves frontend LLM configuration, falls back to server LLM configuration, builds a provider, and runs provider calls for chat.
- `ConversationManager.chat()` writes sessions and memories, so Auto DJ query planning cannot call that method.
- `AutoDjRecommendIn` currently has no `llm_config` field.
- The frontend has `llmConfig`, but `recommendAutoDj` does not send it.
- `RoomShell` silently ignores an `ok: false` Auto DJ response after applying any profile patch.
- The frontend stores the last request signature before completion, so the same queue state will not retry until its signature changes.

These facts are the starting point for this design.

## 3. Goals

- Route every Auto DJ platform search through an LLM-produced query plan.
- Reuse `ConversationManager` for provider selection and LLM execution.
- Keep query planning free of session, message, and memory writes.
- Preserve traditional recommendation behavior after candidate recall.
- Stop cleanly when the LLM is unavailable, times out, returns invalid JSON, or returns weak generic queries.
- Give the user a quiet, visible Auto DJ status without changing the queue on failure.
- Keep the path bounded with a three-second planner timeout, strict output limits, and a small success-only cache.
- Make the no-fallback rule enforceable through tests.

## 4. Non-Goals

- Replacing existing NetEase or Bilibili search implementations.
- Building collaborative filtering, embeddings, a vector database, or a catalog index.
- Asking the LLM to rank every recalled track.
- Writing Auto DJ planning turns into chat sessions or memory.
- Persisting query-plan cache entries across API process restarts.
- Adding recommendation tuning controls to the UI.
- Mobile browser verification in this change.

## 5. Architecture

The refill path has four stages:

1. The frontend sends the current music state, recommendation profile, recent messages, settings, and optional frontend LLM configuration.
2. The endpoint creates a `ConversationManager` and asks it for a structured Auto DJ query plan.
3. `auto_dj.py` receives the validated plan, searches both platforms with only those queries, then applies deterministic recommendation scoring and selection.
4. The frontend appends successful actions or displays a low-key failure status.

Recommended dependency flow:

```text
RoomShell
  -> POST /api/room/music/auto-dj/recommend
      -> ConversationManager.plan_auto_dj_queries(...)
          -> configured LLM provider
      -> validate query plan
      -> NetEase/Bilibili search
      -> deterministic scoring, cooldowns, dedupe, diversity
  <- AutoDjRecommendOut
```

The endpoint remains synchronous to match the current search and provider code.

Focused file boundaries:

- `conversation.py` owns provider selection, the Auto DJ prompt, and the single provider call.
- A small `auto_dj_planning.py` module owns planning context types, strict parsing, validation errors, cache keys, and the bounded LRU cache.
- `auto_dj.py` owns recall, deterministic scoring, selection, and response mapping.
- `routers/room.py` wires the request, `ConversationManager`, cache, and recommender together.

## 6. ConversationManager Query Planning

Add a side-effect-free method to `ConversationManager`:

```python
def plan_auto_dj_queries(
    self,
    context: AutoDjQueryPlanningContext,
) -> AutoDjQueryPlan:
    ...
```

This method may:

- use `self.runtime_config` and `self.provider`;
- build an Auto DJ-specific system prompt;
- call the provider once;
- parse and validate a strict JSON response;
- return a typed query plan or raise a typed planning error.

This method must not:

- call `ConversationManager.chat()`;
- resolve or create a chat session;
- append user or assistant messages;
- read or write memory records;
- dispatch room agent tools;
- perform music search;
- synthesize a fallback query after any failure.

The Auto DJ endpoint creates the manager with a three-second provider timeout. The provider timeout should become an injected constructor setting with the existing 45-second chat behavior kept as the default. Test providers remain injectable through the existing `provider` argument.

At present, constructing `ConversationManager` also constructs `MemoryStore` and `SessionStore`, and both constructors initialize SQLite schemas. Change these stores to lazy initialization inside the chat path. Injected test stores keep working as they do now. `plan_auto_dj_queries` never initializes or accesses either store, which guarantees that an Auto DJ planning request does not touch the session or memory database.

The runtime provider rules are:

- A valid frontend `llm_config` takes priority.
- Without frontend configuration, current server LLM settings may be used.
- The `mock` runtime is unavailable for real Auto DJ planning.
- Missing credentials, invalid runtime configuration, provider errors, and timeout all fail the refill.

The manager performs the mock/configuration preflight before calling `provider.generate`. This makes unavailable local configuration a zero-provider-call failure.

## 7. Planning Context

The LLM receives bounded structured context from data already present in the request:

- current track;
- queued and recently played tracks available in `music_state`;
- saved tracks and lightweight playlists;
- artist, tag, source, and prior-query weights;
- active cooldowns;
- recent recommendation and refill history;
- up to the last eight chat messages;
- requested recommendation count;
- requested similar and exploration counts.

The prompt asks the model to reason across these signals. It should produce a mixture of direct music-platform searches covering creator/work relationships, mood or theme relationships, and light exploration. It must avoid copying a single token from the context into every query.

Raw API keys, internal paths, and unrelated chat or memory data are excluded from the prompt.

## 8. LLM Output Contract

The provider must return JSON only:

```json
{
  "queries": [
    {
      "query": "Hibike Euphonium wind orchestra soundtrack",
      "intent": "same_creator_or_work",
      "themes": ["wind orchestra", "soundtrack"]
    },
    {
      "query": "gentle Japanese brass band anime ost",
      "intent": "similar_mood",
      "themes": ["gentle", "brass band", "anime ost"]
    },
    {
      "query": "modern concert band cinematic music",
      "intent": "light_exploration",
      "themes": ["concert band", "cinematic"]
    }
  ]
}
```

Allowed intents use the existing `RecommendationIntentKind` values:

- `similar_theme`
- `similar_mood`
- `same_creator_or_work`
- `light_exploration`

Validation rules:

- The entire provider response must parse as one JSON object. Markdown fences and surrounding prose are rejected.
- `queries` must contain one to six entries.
- Every query is trimmed, non-empty, between 2 and 120 characters, and unique after normalization.
- Every intent must be one of the allowed values.
- Every themes array contains at most four trimmed, non-empty strings.
- Generic searches such as `music`, `songs`, `new music`, and `music explore` are rejected.
- When settings request both similar and exploration results, the accepted plan must contain at least one query in each requested group.
- Invalid entries may be removed. If the remaining plan violates count or intent coverage, the whole plan fails.

Validation only accepts or rejects LLM output. It never edits a query into a new search phrase and never adds replacement entries.

The parser and validator live in `auto_dj_planning.py`. `ConversationManager.plan_auto_dj_queries` returns only an `AutoDjQueryPlan` that has passed this shared validator. Cache insertion accepts the same validated type, so orchestration cannot accidentally cache raw provider text.

## 9. Query Plan Cache

Use a process-local LRU cache with at most 128 successful plans.

The cache key is a stable digest of:

- normalized provider, base URL, and model;
- a one-way API-key identity digest when a key exists;
- bounded planning context;
- recommendation settings.

The bounded context digest includes the current track identity, music-state inputs, `profile.updated_at`, relevant profile signals, and the last eight message roles and contents. Raw API keys and raw cache inputs must not appear in logs.

Cache behavior:

- Cache only plans that passed full validation.
- A hit may skip the provider call and proceed directly to search.
- Provider, model, key identity, current track, profile, recent messages, or settings changes produce a different key.
- Planning failures and empty plans are never cached.
- Search failures and candidate-selection failures do not invalidate a valid query plan.

The cache belongs to the Auto DJ orchestration layer because `ConversationManager` instances are currently created per request. It must be injectable or clearable in tests.

## 10. Auto DJ Orchestration Changes

`recommend_auto_dj` receives a query planner dependency implemented by `ConversationManager`. The router constructs the real manager and passes it into the recommendation function. Unit tests pass a fake planner.

The orchestration order is mandatory:

1. Validate that some recommendation context exists.
2. Resolve a validated cached plan or call the LLM planner, which parses and validates its result.
3. Confirm the returned object is the validated plan type.
4. Call NetEase and Bilibili searches for each accepted query.
5. Score, deduplicate, apply cooldowns, and select candidates.
6. Build queue actions and profile patches only for selected candidates.

No platform search function may run before step 3 succeeds.

Delete all local query construction from the active path, including:

- `_similar_query_seeds`;
- `_exploration_query_seeds`;
- `music explore` fallback behavior;
- any future title, artist, tag, profile, or fixed-string fallback that bypasses the LLM.

## 11. Traditional Recommendation Layer

The LLM controls recall directions. Deterministic code keeps control of candidate quality.

After search, retain the useful current signals:

- platform search score and evidence;
- playability gate;
- current creator relationship;
- artist preference weights;
- semantic theme matches from the validated LLM plan;
- source preference weights;
- item, artist, tag, and query cooldowns;
- current queue, recent, saved, playlist, and recommendation-history duplicate blocking;
- slot-based similar and exploration selection;
- repeated-refill diversity adjustment.

Map `similar_theme`, `similar_mood`, and `same_creator_or_work` to the similar selection group. Keep `light_exploration` in the exploration group.

Intent labels guide slot selection and explanation metadata. Remove the score rule that rewards a candidate merely because its title contains `explore`. The selector may fill an unoccupied slot with another candidate only when that candidate came from a validated LLM query.

Play, skip, save, playlist-add, and dislike feedback continue updating the browser-owned recommendation profile. Those profile weights influence later LLM context and deterministic candidate scores.

## 12. API Contract

Extend `AutoDjRecommendIn` with:

```python
llm_config: LLMConfigIn | None = None
```

The frontend request type receives the matching optional `llmConfig` field and serializes it with the same mapping already used by chat.

Success keeps the current `AutoDjRecommendOut` shape. Partial success is allowed when one or more qualified candidates remain. The response notice must match the actual selected count.

Planning failure response:

```json
{
  "ok": false,
  "refill_id": null,
  "notice": "Auto DJ 暂时没找到合适的歌",
  "client_actions": [],
  "recommendations": [],
  "profile_patch": {
    "recommended_items": [],
    "cooldowns": [],
    "refill_history": []
  },
  "error": "query_planning_failed",
  "source_errors": []
}
```

When valid LLM queries produce no qualified candidates, return the same empty action and patch fields with `error: "no_qualified_candidates"`.

`needs_more_context` remains valid when the request has no usable listening or profile context. This branch also performs zero LLM calls and zero music searches.

Provider and parsing details go to server logs without API keys or raw secrets. The public response stays calm and compact.

## 13. Frontend Behavior

`RoomShell` sends `llmConfig` with every Auto DJ refill request when the user has one configured. Server configuration remains available when the frontend field is absent.

Add a small Auto DJ status near the existing switch. It supports these states:

- idle: no extra text;
- loading: a subtle in-progress indicator;
- unavailable: `暂时没找到合适的歌`;
- success: clear the temporary status after actions apply.

Failure behavior:

- Do not append queue entries.
- Do not apply a non-empty recommendation history patch.
- Do not append a chat timeline notice.
- Do not route planner failure through the general chat send error.
- Keep existing playback uninterrupted.

Use an explicit Auto DJ toggle handler. Turning Auto DJ off clears transient status. Turning it on clears `autoDjLastRequestedSignature`, allowing the user to retry the same queue state. A failed request does not loop automatically while the switch remains on.

## 14. Error Handling Matrix

| Condition | Provider `generate` calls | Search calls | Queue change | Public error |
| --- | ---: | ---: | --- | --- |
| No recommendation context | 0 | 0 | None | `needs_more_context` |
| Valid cached plan | 0 | One or more | Qualified items only | Success or `no_qualified_candidates` |
| Mock or unconfigured LLM | 0 | 0 | None | `query_planning_failed` |
| Planner timeout | 1 | 0 | None | `query_planning_failed` |
| Provider/network error | 1 | 0 | None | `query_planning_failed` |
| Invalid JSON or schema | 1 | 0 | None | `query_planning_failed` |
| Empty or generic plan | 1 | 0 | None | `query_planning_failed` |
| One music source fails after a fresh plan | 1 | Planned searches continue | Qualified items only | Success when candidates remain |
| Valid fresh plan, no candidates | 1 | Planned searches complete | None | `no_qualified_candidates` |

## 15. Testing Strategy

### Backend planner tests

- `ConversationManager.plan_auto_dj_queries` uses the selected runtime provider and returns typed plans from valid JSON.
- The planning method performs no session-store or memory-store writes.
- Frontend LLM configuration takes priority over server configuration.
- Server configuration works when frontend configuration is absent.
- Mock, unconfigured, timeout, provider failure, invalid JSON, generic output, and missing intent coverage all raise a planning failure.
- Strict parsing rejects Markdown fences and surrounding prose.

### Backend orchestration tests

- Every captured platform search query appears exactly in a successful LLM plan or cache hit.
- Planner failure causes zero NetEase and zero Bilibili calls.
- Query construction, search calls, and response data contain no `music explore` fallback. The literal may remain only in rejection tests or a generic-query denylist.
- Cache hits avoid a second provider call.
- Provider/model, current track, profile, recent message, and settings changes invalidate the cache.
- Failed plans are not cached.
- Valid plans preserve source failure handling, duplicate filtering, cooldown filtering, partial success, and recommendation evidence.
- Candidate titles containing `explore` receive no title-specific score bonus.
- Play, skip, save, playlist-add, and dislike feedback continue changing profile signals.

### Frontend tests

- `recommendAutoDj` serializes `llmConfig` as `llm_config`.
- Enabling Auto DJ sends the current LLM configuration.
- `ok: false` and request rejection leave the queue unchanged and show the inline status.
- Failed refills add no chat notice.
- Turning Auto DJ off and on permits a retry for the same queue signature.
- Successful refills still append recommendation metadata and clear temporary status.

### Verification commands

```text
python -m pytest apps/api/tests/test_auto_dj.py -q
python -m pytest apps/api/tests -q
npm run test --workspace apps/web
npm run build --workspace apps/web
```

Desktop browser verification covers the Auto DJ switch, successful refill, LLM failure status, retry, and unchanged queue behavior. Mobile verification is outside this change.

## 16. Acceptance Criteria

- Auto DJ performs no NetEase or Bilibili search without a validated LLM plan or a cache entry created from one.
- Current title, artist, tags, profile data, or fixed strings never become locally generated fallback queries.
- `music explore` is never constructed, searched, or returned. A denylist or test may contain the literal solely to reject it.
- `ConversationManager` supplies the real provider path without writing chat sessions or memories.
- LLM planning completes within three seconds or fails the refill.
- Planner failures return `ok: false`, empty actions, empty recommendations, and an empty profile patch.
- The frontend shows a quiet failure status and leaves playback and queue state unchanged.
- Toggling Auto DJ off and on can retry the same queue state.
- Valid LLM queries still feed deterministic scoring, cooldown, feedback, duplicate, and diversity logic.
- Existing successful Auto DJ queue metadata and feedback flows continue to work.

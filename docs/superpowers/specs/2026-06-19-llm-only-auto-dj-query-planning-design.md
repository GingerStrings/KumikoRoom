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
- `_dominant_themes` filters `_METADATA_TAGS`, including `agent-selected`, `search`, `netease`, and `bilibili`, but `_exploration_query_seeds` reads `profile.recent_themes` without that filter, leaking metadata tags into search queries.
- The browser-owned profile pipeline (`getNormalizedTagKeys` in `apps/web/src/lib/musicRecommendationProfile.ts`) writes raw track tags into `tagWeights` and dislike cooldowns, including the same metadata tokens. The pollution feeds back into Auto DJ context on every refill.

These facts are the starting point for this design.

## 3. Goals

- Route every Auto DJ platform search through an LLM-produced query plan.
- Reuse `ConversationManager` for provider selection and LLM execution.
- Keep query planning free of session, message, and memory writes.
- Preserve traditional recommendation behavior after candidate recall.
- Stop cleanly when the LLM is unavailable, times out, returns invalid JSON, or returns weak generic queries.
- Give the user a quiet, visible Auto DJ status without changing the queue on failure.
- Keep the path bounded with a three-second planner timeout and strict output limits.
- Make the no-fallback rule enforceable through tests.

## 4. Non-Goals

- Replacing existing NetEase or Bilibili search implementations.
- Building collaborative filtering, embeddings, a vector database, or a catalog index.
- Asking the LLM to rank every recalled track.
- Writing Auto DJ planning turns into chat sessions or memory.
- Adding a process-local query-plan cache. Per-request planning is acceptable at Auto DJ's call frequency (see §9).
- Adding recommendation tuning controls to the UI.
- Mobile browser verification in this change.
- Adopting any part of the upstream Codex framework (`ContextManager`, `for_prompt`, `compact.rs`, rollout, memory extension). Codex is a Rust long-conversation agent runtime; KumikoRoom uses single-shot LLM calls. The two are not compatible in scope. Codex remains a reference for design philosophy only.
- Reworking how the browser-owned profile is updated from accept/skip/dislike feedback. The existing automatic learning pipeline keeps writing raw track tags into `tagWeights` and cooldowns. This change defends against that data downstream (see §7.1) but does not redesign the source.

## 4.1 Known Defects Out of Scope

These bugs surfaced during cross-review and stay open for follow-up. They are listed so that completing this spec does not appear to fix them:

- Disliking a track that is currently playing only updates the profile; the track is not removed from playback.
- `_cooldown_matches(kind="tag")` and `_cooldown_penalty` test against `candidate.title` instead of the candidate tag list. Tag cooldowns therefore behave as title-substring matches.
- `_cooldown_penalty` lumps `kind in {"tag", "query"}` and matches against `title_norm`, while `_cooldown_matches` for `query` matches against `recalled.query`. Query cooldown hard blocking and soft penalties therefore evaluate different fields.
- A failed Auto DJ refill still writes `autoDjLastRequestedSignature`, so retries for the same queue state require a queue mutation. §13 introduces a manual reset path through the toggle, but the underlying signature handling remains unchanged.

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
- A small `auto_dj_planning.py` module owns planning context types, strict parsing, and validation errors.
- `auto_dj.py` owns profile sanitization (§7.1), recall, deterministic scoring, selection, and response mapping.
- `routers/room.py` wires the request, `ConversationManager`, and recommender together.

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

At present, constructing `ConversationManager` also constructs `MemoryStore` and `SessionStore`, and both constructors initialize SQLite schemas. Add an explicit planning construction mode that skips both stores. `plan_auto_dj_queries` never initializes or accesses either store, which guarantees that an Auto DJ planning request does not touch the session or memory database.

## 6.1 Planning-Only Construction

Extend `ConversationManager` with an explicit constructor option such as `initialize_stores: bool = True`:

- The default remains `True`, so existing chat routes and injected test stores keep their current behavior.
- The Auto DJ route passes `initialize_stores=False` and the three-second provider timeout.
- In planning mode, `memory_store` and `session_store` remain absent and no SQLite path or schema is touched.
- `plan_auto_dj_queries` is available in both modes and never reads either store.
- Calling `chat()` on a planning-only manager raises a clear internal error so this restricted mode cannot be used accidentally for a chat request.

This keeps the change local to manager construction and avoids introducing shared lazy-initialization state or concurrency coordination into the existing chat path.

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
- artist, tag, source, and prior-query weights (after sanitization, see §7.1);
- active cooldowns (after sanitization, see §7.1);
- recent recommendation and refill history;
- up to the last 200 chat messages from the active session;
- requested recommendation count;
- requested similar and exploration counts.

The chat-message limit rises from the chat path's 8 to 200 because Auto DJ benefits from longer-range expressed preferences ("today I want quieter music") that a short window forgets. Modern LLM context windows (128k–1M tokens) absorb 200 short chat messages without strain. The frontend caps the slice at 200, but actual messages-per-session is typically far smaller. No token-budget truncation is added in this change; if a future deployment uses a small-context model, that constraint becomes a follow-up.

The prompt asks the model to reason across these signals. It should produce a mixture of direct music-platform searches covering creator/work relationships, mood or theme relationships, and light exploration. It must avoid copying a single token from the context into every query.

Raw API keys, internal paths, and unrelated chat or memory data are excluded from the prompt.

## 7.1 Profile Sanitization Before Prompting

The browser-owned feedback pipeline writes raw track tags into `tagWeights` and dislike cooldowns (see §2). An incoming persisted profile may also contain `recentThemes`. Without filtering, those entries reach the LLM as if they were musical signals, biasing query planning toward internal tokens like `agent-selected`, `search`, `netease`, `bilibili`.

Before building the planning context, the orchestration layer sanitizes the incoming profile:

- Drop entries from `tag_weights` whose normalized key is in `_METADATA_TAGS`.
- Drop entries from `recent_themes` whose normalized key is in `_METADATA_TAGS`.
- Drop cooldowns whose `kind == "tag"` and whose normalized `key` is in `_METADATA_TAGS`.
- Drop entries from `query_weights` whose normalized key is rejected by the generic-query validator, including historical values such as `music explore`.
- Drop cooldowns whose `kind == "query"` and whose normalized key is rejected by the same generic-query validator.
- Source-weight `bilibili` and `netease` keys remain valid and are not stripped.

`_METADATA_TAGS` stays defined in `auto_dj.py`. Sanitization happens once per request, on a deep copy, before the profile is serialized into prompt context and before deterministic scoring reads it. The original profile object stored in the request is not mutated.

`_METADATA_TAGS` remains the single source for metadata-tag filtering. The generic-query validator is shared between profile sanitization and query-plan validation so those two paths cannot drift apart. This addresses §2's profile pollution defect at the consumer side without redesigning the producer (see §4 Non-Goals).

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
- When `similar_count` is greater than zero, the accepted plan must contain at least one `similar_theme`, `similar_mood`, or `same_creator_or_work` entry.
- When `exploration_count` is greater than zero, the accepted plan must contain at least one `light_exploration` entry.
- Invalid entries may be removed. If the remaining entries do not cover every requested non-zero intent group, the whole plan fails.

The prompt asks the model to cover every requested non-zero intent group, and the validator enforces that contract. If the model omits a required group, the refill fails before search. Search may still return fewer qualified candidates than requested; that later stage keeps its existing partial-success behavior.

Validation only accepts or rejects LLM output. It never edits a query into a new search phrase and never adds replacement entries.

The parser and validator live in `auto_dj_planning.py`. `ConversationManager.plan_auto_dj_queries` returns only an `AutoDjQueryPlan` that has passed this shared validator. The orchestration layer never sees raw provider text.

## 9. No Query Plan Cache

This change does not add a query-plan cache. Reasons:

- Auto DJ refills are infrequent (queue-depth triggered, typically minutes apart), so per-request LLM calls are not a hot path.
- A meaningful cache key would have to include the chat-message slice (now 200 messages, see §7), the profile snapshot, and `music_state`. Any of these change between most refills, so cache hit rate would be near zero.
- Modern LLM provider APIs (Anthropic, OpenAI) include automatic prompt-prefix caching at the API layer. Stable prefixes such as the system prompt benefit from that mechanism without application-level state.
- Avoiding a cache removes one layer of state, simplifies the failure matrix, and ensures the LLM always sees the freshest context.

Every accepted refill calls the planner. Every successful refill performs platform searches. Failures behave per the matrix in §14 with `provider.generate` count adjusted to "1" wherever a previous version of this spec listed a cache-hit row.

Future revisions may revisit caching if measurement shows the planner becomes a bottleneck. That measurement is out of scope here.

## 10. Auto DJ Orchestration Changes

`recommend_auto_dj` receives a query planner dependency implemented by `ConversationManager`. The router constructs the real manager and passes it into the recommendation function. Unit tests pass a fake planner.

The orchestration order is mandatory:

1. Validate that some recommendation context exists.
2. Sanitize the incoming profile per §7.1.
3. Call the LLM planner, which parses and validates its result.
4. Confirm the returned object is the validated plan type.
5. Call NetEase and Bilibili searches for each accepted query.
6. Score, deduplicate, apply cooldowns, and select candidates.
7. Build queue actions and profile patches only for selected candidates.

No platform search function may run before step 4 succeeds.

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
| Mock or unconfigured LLM | 0 | 0 | None | `query_planning_failed` |
| Planner timeout | 1 | 0 | None | `query_planning_failed` |
| Provider/network error | 1 | 0 | None | `query_planning_failed` |
| Invalid JSON or schema | 1 | 0 | None | `query_planning_failed` |
| Empty or generic plan | 1 | 0 | None | `query_planning_failed` |
| Plan missing a requested intent group | 1 | 0 | None | `query_planning_failed` |
| One music source fails after a fresh plan | 1 | Planned searches continue | Qualified items only | Success when candidates remain |
| Valid fresh plan, no candidates | 1 | Planned searches complete | None | `no_qualified_candidates` |
| Valid fresh plan with candidates | 1 | Planned searches complete | Qualified items only | Success |

## 15. Testing Strategy

### Backend planner tests

- `ConversationManager.plan_auto_dj_queries` uses the selected runtime provider and returns typed plans from valid JSON.
- The planning method performs no session-store or memory-store writes.
- Planning-only construction does not instantiate `MemoryStore` or `SessionStore`, while the default chat construction path still initializes both stores normally.
- Frontend LLM configuration takes priority over server configuration.
- Server configuration works when frontend configuration is absent.
- Mock, unconfigured, timeout, provider failure, invalid JSON, entirely-empty plans, and plans missing a requested intent group all raise a planning failure.
- A plan containing only similar intents fails when `exploration_count` is non-zero, and an exploration-only plan fails when `similar_count` is non-zero.
- Strict parsing rejects Markdown fences and surrounding prose.

### Backend orchestration tests

- Every captured platform search query appears exactly in a successful LLM plan.
- Planner failure causes zero NetEase and zero Bilibili calls.
- Query construction, search calls, and response data contain no `music explore` fallback. The literal may remain only in rejection tests or a generic-query denylist.
- Profile sanitization (§7.1) drops `agent-selected`, `search`, and other `_METADATA_TAGS` from `tag_weights`, `recent_themes`, and `kind == "tag"` cooldowns. It also removes generic historical searches from `query_weights` and `kind == "query"` cooldowns. The planning context and deterministic scoring receive the sanitized copy, while the original request object remains unchanged.
- Valid plans preserve source failure handling, duplicate filtering, cooldown filtering, partial success, and recommendation evidence.
- Candidate titles containing `explore` receive no title-specific score bonus.
- Play, skip, save, playlist-add, and dislike feedback continue changing profile signals.

### Frontend tests

- `recommendAutoDj` serializes `llmConfig` as `llm_config`.
- Enabling Auto DJ sends the current LLM configuration.
- The request includes up to the last 200 chat messages (verified with a fixture longer than 200 to confirm the slice boundary).
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

- Auto DJ performs no NetEase or Bilibili search without a validated LLM plan from the current request.
- Current title, artist, tags, profile data, or fixed strings never become locally generated fallback queries.
- `music explore` is never constructed, searched, or returned. A denylist or test may contain the literal solely to reject it.
- Every requested non-zero intent group appears in the validated plan before platform search begins.
- `ConversationManager` supplies the real provider path without writing chat sessions or memories. Its planning-only construction mode skips `MemoryStore` and `SessionStore` entirely, while default chat construction remains unchanged.
- The planning context honors the §7 message limit (200) and the §7.1 profile sanitization rules.
- LLM planning completes within three seconds or fails the refill.
- Planner failures return `ok: false`, empty actions, empty recommendations, and an empty profile patch.
- The frontend shows a quiet failure status and leaves playback and queue state unchanged.
- Toggling Auto DJ off and on can retry the same queue state.
- Valid LLM queries still feed deterministic scoring, cooldown, feedback, duplicate, and diversity logic.
- Existing successful Auto DJ queue metadata and feedback flows continue to work.

# Auto DJ Agent Loop Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a bounded Auto DJ loop that keeps searching when candidates are insufficient and lets the LLM choose final recommendations from real candidates.

**Architecture:** `recommend_auto_dj` becomes a small loop: plan queries, run NetEase search, score/filter real candidates, feed search feedback back to the planner when the pool is short, then ask the LLM selector to choose final candidate ids. Code validates selected ids and falls back to deterministic score order for any missing slots.

**Tech Stack:** FastAPI/Pydantic backend, existing LLM provider wrapper, pytest, existing React trace UI.

---

### Task 1: Add Planning Feedback And Selection Contracts

**Files:**
- Modify: `apps/api/kumikoroom/auto_dj_planning.py`
- Modify: `apps/api/kumikoroom/conversation.py`
- Test: `apps/api/tests/test_conversation_planning.py`

- [ ] Write failing tests for feedback-aware replanning prompt and selector JSON parsing.
- [ ] Add dataclasses for search feedback, selection candidates, and selection context.
- [ ] Add prompt builders and parser for final LLM selection.
- [ ] Implement `ConversationManager.select_auto_dj_recommendations`.

### Task 2: Convert Auto DJ To A Bounded Loop

**Files:**
- Modify: `apps/api/kumikoroom/auto_dj.py`
- Test: `apps/api/tests/test_auto_dj.py`

- [ ] Write a failing test where the first plan returns zero results and the second plan returns three playable songs.
- [ ] Write a failing test where LLM selection order controls the final recommendations.
- [ ] Loop up to three planning/search attempts, passing feedback after failed attempts.
- [ ] Ask selector for final ids once enough qualified candidates exist.
- [ ] Validate selected ids and fill missing slots from score order.

### Task 3: Keep Trace Useful

**Files:**
- Modify: `apps/api/kumikoroom/auto_dj.py`
- Modify if needed: `apps/web/src/components/RoomShell.tsx`
- Test: `apps/api/tests/test_auto_dj.py`

- [ ] Ensure `trace.planner_queries` contains queries from every attempt.
- [ ] Ensure `trace.candidates` marks LLM-selected tracks.
- [ ] Keep existing queue panel rendering compatible with the enriched trace.

### Task 4: Verify End To End

**Files:**
- No new production files.

- [ ] Run targeted backend tests for Auto DJ and planning.
- [ ] Run full API test suite.
- [ ] Run web tests and build because trace schema touches client types.
- [ ] Restart local API and frontend dev server.

# Agentic Music Playback Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Rebuild KumikoRoom music playback so named-song requests go through a model-led tool-call loop, rank real search candidates by evidence, and return browser client actions to play the selected track.

**Architecture:** Move music search and playback decision-making into the API agent loop. Keep the browser as the executor of local player state via `client_actions`. Preserve the existing visual UI while replacing frontend regex command interception with backend tool calls.

**Tech Stack:** FastAPI/Pydantic/Python `httpx`, DeepSeek OpenAI-compatible chat completions, Next.js/React/Vitest, pytest.

---

## File Structure

- Modify `apps/api/kumikoroom/llm.py`: add provider protocol support for `tools`, `tool_choice`, `tool_calls`, assistant/tool messages, and DeepSeek parsing.
- Create `apps/api/kumikoroom/agent_tools.py`: typed tool specs, tool registry, search/play tool handlers, compact trace models.
- Modify `apps/api/kumikoroom/music_search.py`: enrich NetEase and Bilibili candidate data, fetch available engagement signals, rank candidates with score/evidence.
- Modify `apps/api/kumikoroom/schemas.py`: add enriched music search fields, client action models, agent trace models, and `ChatOut.client_actions`.
- Modify `apps/api/kumikoroom/conversation.py`: run the Codex-style agent loop and append client actions to chat output.
- Modify `apps/api/kumikoroom/routers/room.py`: return enriched ranked search results.
- Modify `apps/web/src/api/types.ts`: add client action, enriched search result, and trace types.
- Modify `apps/web/src/api/client.ts`: map new fields.
- Modify `apps/web/src/lib/musicItems.ts`: convert API client-action items into `MusicItem`.
- Modify `apps/web/src/lib/roomAgent.ts`: remove natural-language routing from the production path; keep registry/dispatch tests only for local execution primitives or retire unused pieces.
- Modify `apps/web/src/components/RoomShell.tsx`: call `postChat` for natural playback requests and apply returned client actions.
- Modify tests in `apps/api/tests` and `apps/web/tests` to lock the new architecture.

## Task 1: Provider Tool-Call Protocol

**Files:**
- Modify: `apps/api/kumikoroom/llm.py`
- Test: `apps/api/tests/test_llm.py`

- [ ] **Step 1: Write failing provider tests**

Add tests that create a DeepSeek provider with `httpx.MockTransport`, pass a `tools` list, and assert:

```python
result = provider.generate(
    [{"role": "user", "content": "播放 晴天"}],
    tools=[{
        "type": "function",
        "function": {
            "name": "search_music",
            "description": "Search playable music candidates.",
            "parameters": {
                "type": "object",
                "properties": {"query": {"type": "string"}},
                "required": ["query"],
            },
        },
    }],
    tool_choice="auto",
)
```

Expected assertions:

```python
assert payload["tools"][0]["function"]["name"] == "search_music"
assert payload["tool_choice"] == "auto"
assert result.tool_calls[0].name == "search_music"
assert result.tool_calls[0].arguments == {"query": "晴天"}
```

- [ ] **Step 2: Run red test**

Run:

```powershell
cd apps/api
python -m pytest tests/test_llm.py -q
```

Expected: fails because `generate()` has no `tools` parameter and `LLMResult` has no `tool_calls`.

- [ ] **Step 3: Implement provider protocol**

Add dataclasses:

```python
@dataclass(frozen=True)
class LLMToolCall:
    id: str
    name: str
    arguments: dict[str, Any]

@dataclass(frozen=True)
class LLMResult:
    content: str
    provider_status: ProviderStatus
    tool_calls: list[LLMToolCall] = field(default_factory=list)
```

Change `LLMMessage` to allow `role: system/user/assistant/tool` and optional fields. Update `DeepSeekLLMProvider.generate()` to include `tools` and `tool_choice` only when provided, parse `message.tool_calls`, decode JSON arguments, and keep malformed tool arguments as `ProviderUnavailable`.

- [ ] **Step 4: Run green test**

Run:

```powershell
cd apps/api
python -m pytest tests/test_llm.py -q
```

Expected: all `test_llm.py` tests pass.

## Task 2: Enriched Music Search And Ranking

**Files:**
- Modify: `apps/api/kumikoroom/music_search.py`
- Modify: `apps/api/kumikoroom/schemas.py`
- Modify: `apps/api/kumikoroom/routers/room.py`
- Test: `apps/api/tests/test_room_api.py`

- [ ] **Step 1: Write failing ranking tests**

Add tests using raw payloads and monkeypatched HTTP helpers:

```python
def test_rank_netease_candidates_prefers_engaged_playable_match(monkeypatch):
    raw = {
        "result": {
            "songs": [
                {"id": 1, "name": "晴天", "artists": [{"name": "周杰伦-"}], "duration": 120000, "fee": 8},
                {"id": 2, "name": "晴天 (原唱 周杰伦)", "artists": [{"name": "RyaVocal"}], "duration": 270000, "fee": 8},
            ]
        }
    }
    monkeypatch.setattr("kumikoroom.music_search.fetch_netease_song_details", lambda ids: {
        "1": {"popularity": 20.0, "score": 20, "commentThreadId": "R_SO_4_1"},
        "2": {"popularity": 70.0, "score": 70, "commentThreadId": "R_SO_4_2"},
    })
    monkeypatch.setattr("kumikoroom.music_search.fetch_netease_comment_metrics", lambda song_id: {
        "1": {"comment_count": 205, "hot_comment_liked_count": 248},
        "2": {"comment_count": 5918, "hot_comment_liked_count": 14314},
    }[song_id])
    monkeypatch.setattr("kumikoroom.music_search.check_netease_outer_audio_playable", lambda song_id: True)

    results = parse_netease_song_results(raw, query="晴天 周杰伦", limit=2)

    assert results[0].song_id == "2"
    assert results[0].comment_count == 5918
    assert any("comment_count=5918" in evidence for evidence in results[0].evidence)
```

Also add an API test asserting `/api/room/music/search` returns `score`, `comment_count`, `hot_comment_liked_count`, `playable`, and `evidence`.

- [ ] **Step 2: Run red tests**

Run:

```powershell
cd apps/api
python -m pytest tests/test_room_api.py -q
```

Expected: fails because fields and helpers do not exist.

- [ ] **Step 3: Implement enriched candidate model**

Extend `NeteaseSongSearchResult` with:

```python
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
```

Implement:

- `fetch_netease_song_details(song_ids: list[str])`
- `fetch_netease_comment_metrics(song_id: str)`
- `check_netease_outer_audio_playable(song_id: str)`
- `score_netease_candidate(query, candidate, detail, metrics, playable, raw_rank)`
- `search_bilibili_music(query: str, limit: int)`
- `score_bilibili_candidate(query, candidate, metrics, raw_rank)`

Use `httpx` for requests. Metrics failures should return null fields and evidence strings.

- [ ] **Step 4: Update schema and route**

Add fields to `MusicSearchResultOut` and map them in `search_music()`. Keep the public route compatible with existing NetEase callers while the agent tool can request `source: "all"`.

- [ ] **Step 5: Run green tests**

Run:

```powershell
cd apps/api
python -m pytest tests/test_room_api.py -q
```

Expected: room API tests pass.

## Task 3: Backend Agent Tool Registry And Loop

**Files:**
- Create: `apps/api/kumikoroom/agent_tools.py`
- Modify: `apps/api/kumikoroom/conversation.py`
- Modify: `apps/api/kumikoroom/schemas.py`
- Test: `apps/api/tests/test_conversation.py`

- [ ] **Step 1: Write failing agent-loop tests**

Add a `ToolCallingProvider` fake:

```python
class ToolCallingProvider:
    def __init__(self):
        self.calls = []

    def generate(self, messages, tools=None, tool_choice=None):
        self.calls.append({"messages": messages, "tools": tools, "tool_choice": tool_choice})
        if len(self.calls) == 1:
            return LLMResult("", status, [LLMToolCall("call-search", "search_music", {"query": "晴天 周杰伦", "source": "all", "limit": 8})])
        if len(self.calls) == 2:
            return LLMResult("", status, [LLMToolCall("call-play", "play_music_item", {"item_id": "netease-song-2"})])
        return LLMResult("我找了一下，选了证据最稳的《晴天》。", status)
```

Monkeypatch search helpers to return ranked NetEase and Bilibili results. Assert:

```python
response = manager.chat(ChatIn(message="播放 晴天 周杰伦", memory_enabled=False))

assert provider.calls[0]["tools"][0]["function"]["name"] == "search_music"
assert provider.calls[0]["tool_choice"] == "auto"
assert any(message["role"] == "tool" and message["tool_call_id"] == "call-search" for message in provider.calls[1]["messages"])
assert response.client_actions[0].type == "play_music_item"
assert response.client_actions[0].item.title.startswith("晴天")
assert response.reply.content == "我找了一下，选了证据最稳的《晴天》。"
```

Add tests for unknown tool and max iteration cap.

- [ ] **Step 2: Run red tests**

Run:

```powershell
cd apps/api
python -m pytest tests/test_conversation.py -q
```

Expected: fails because tool loop and `client_actions` do not exist.

- [ ] **Step 3: Implement `agent_tools.py`**

Define:

- `room_agent_tool_specs()`
- `RoomAgentToolContext`
- `RoomAgentToolResult`
- `dispatch_room_agent_tool(name, arguments, context)`
- `search_music` handler stores candidates in context.
- `play_music_item` handler resolves a candidate and appends a `ClientActionOut`.

- [ ] **Step 4: Implement conversation tool loop**

In `ConversationManager.chat()`:

1. Build normal messages.
2. Call provider with tools and `tool_choice="auto"`.
3. If `tool_calls` exist, append assistant tool-call message.
4. Dispatch each tool call.
5. Append `role="tool"` result messages.
6. Repeat until final text reply or max 5 model calls.
7. Save only user and final Kumiko reply to the session store.
8. Return `ChatOut` with `client_actions` and `agent_trace`.

- [ ] **Step 5: Run green tests**

Run:

```powershell
cd apps/api
python -m pytest tests/test_conversation.py -q
```

Expected: conversation tests pass.

## Task 4: Frontend API Mapping And Client Actions

**Files:**
- Modify: `apps/web/src/api/types.ts`
- Modify: `apps/web/src/api/client.ts`
- Modify: `apps/web/src/lib/musicItems.ts`
- Test: `apps/web/tests/client.test.ts`
- Test: `apps/web/tests/musicItems.test.ts`

- [ ] **Step 1: Write failing web API tests**

Add tests asserting `postChat()` maps:

```ts
client_actions: [{
  type: "play_music_item",
  item: {
    id: "netease-song-2",
    source: "netease",
    title: "晴天 (原唱 周杰伦)",
    creator: "RyaVocal",
    duration_ms: 270738,
    page_url: "https://music.163.com/#/song?id=2",
    platform_audio_url: "https://music.163.com/song/media/outer/url?id=2.mp3",
    tags: ["netease", "agent-selected"],
    can_open_video: false
  }
}]
```

to:

```ts
clientActions[0].type === "play_music_item"
clientActions[0].item.title === "晴天 (原唱 周杰伦)"
```

Add `musicItems` test converting an API music item to `MusicItem`.

- [ ] **Step 2: Run red tests**

Run:

```powershell
npm run test --workspace apps/web -- client.test.ts musicItems.test.ts
```

Expected: fails because fields are unmapped.

- [ ] **Step 3: Implement type and mapping changes**

Add `RoomClientAction`, `ClientMusicItem`, `AgentTrace` to `types.ts`; map snake_case fields in `client.ts`; add `makeMusicItemFromClientActionItem()` in `musicItems.ts`.

- [ ] **Step 4: Run green tests**

Run:

```powershell
npm run test --workspace apps/web -- client.test.ts musicItems.test.ts
```

Expected: focused web mapping tests pass.

## Task 5: RoomShell Uses Agent Actions From Chat

**Files:**
- Modify: `apps/web/src/components/RoomShell.tsx`
- Modify: `apps/web/src/lib/roomAgent.ts`
- Test: `apps/web/tests/RoomShell.test.tsx`
- Test: `apps/web/tests/roomAgent.test.ts`

- [ ] **Step 1: Rewrite failing architecture tests**

Replace tests that assert natural play commands skip `postChat`. New tests:

```ts
it("sends named play requests through chat and applies the returned music action", async () => {
  apiMocks.postChat.mockResolvedValueOnce(makeChatResponse({
    reply: { id: "reply-agent", role: "kumiko", content: "我找了一下，选了《晴天》。" },
    clientActions: [{
      type: "play_music_item",
      item: {
        id: "netease-song-2668397359",
        source: "netease",
        title: "晴天 (原唱 周杰伦)",
        creator: "RyaVocal",
        durationMs: 270738,
        pageUrl: "https://music.163.com/#/song?id=2668397359",
        platformAudioUrl: "https://music.163.com/song/media/outer/url?id=2668397359.mp3",
        tags: ["netease", "agent-selected"],
        canOpenVideo: false
      }
    }]
  }));

  fireEvent.change(getComposerInput(), { target: { value: "播放 晴天 周杰伦" } });
  fireEvent.click(getComposerSubmit());

  await waitFor(() => expect(apiMocks.postChat).toHaveBeenCalledTimes(1));
  expect(within(getTimeline()).getByText("播放 晴天 周杰伦")).toBeTruthy();
  expect(await within(getTimeline()).findByText("我找了一下，选了《晴天》。")).toBeTruthy();
  expect(getPlatformAudio().getAttribute("src")).toBe("https://music.163.com/song/media/outer/url?id=2668397359.mp3");
});
```

In `roomAgent.test.ts`, remove tests for natural-language regex route decisions and keep tests for registry dispatch or delete the unused router.

- [ ] **Step 2: Run red tests**

Run:

```powershell
npm run test --workspace apps/web -- RoomShell.test.tsx roomAgent.test.ts
```

Expected: fails because `RoomShell` still intercepts before chat.

- [ ] **Step 3: Implement client action application**

Remove `executeRoomAgentIntent()` from `sendChatMessage()` for natural chat. Add:

```ts
function applyRoomClientActions(actions: RoomClientAction[]) {
  for (const action of actions) {
    if (action.type === "play_music_item") {
      const item = makeMusicItemFromClientActionItem(action.item);
      setPlayerQueue((current) => upsertMusicItem(current, item));
      setPlayerTrackIndex(nextIndex);
      setVideoWindowOpen(false);
      setIsPlayerPlaying(true);
    }
  }
}
```

Keep direct player controls unchanged.

- [ ] **Step 4: Run green tests**

Run:

```powershell
npm run test --workspace apps/web -- RoomShell.test.tsx roomAgent.test.ts
```

Expected: focused tests pass.

## Task 6: Full Verification And Browser QA

**Files:**
- No new source files expected.

- [ ] **Step 1: Run full API tests**

Run:

```powershell
cd apps/api
python -m pytest tests -q
```

Expected: all API tests pass.

- [ ] **Step 2: Run full web tests**

Run:

```powershell
npm run test --workspace apps/web
```

Expected: all web tests pass.

- [ ] **Step 3: Build web**

Run:

```powershell
npm run build --workspace apps/web
```

Expected: build succeeds.

- [ ] **Step 4: Diff hygiene**

Run:

```powershell
git diff --check
```

Expected: no whitespace errors. Existing CRLF warnings may be noted if unchanged.

- [ ] **Step 5: Browser QA**

Restart API and web dev servers. In the in-app browser at `/room`, send `播放 晴天 周杰伦`.

Verify:

- the user message appears in the timeline.
- the reply is model/backend-provided text.
- the player title is the selected candidate title.
- the source badge matches the selected platform.
- NetEase selections set the audio element `src`; Bilibili selections set video mini-window metadata.
- the old template text path is absent for natural play requests.
- browser console has no errors.

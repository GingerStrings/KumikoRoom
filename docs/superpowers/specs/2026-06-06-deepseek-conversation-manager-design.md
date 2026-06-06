# DeepSeek Conversation Manager Design

## 1. Goal

Build the first real LLM loop for KumikoRoom using DeepSeek, while adding a lightweight conversation management layer that can later grow into a fuller agent runtime.

This phase should turn `/room` from a mock chat into a real local-first chat experience with:

- DeepSeek-backed replies.
- Configurable persona strength: `medium` and `strong`.
- Automatic memory extraction with medium sensitivity.
- A visible connection and memory status in the web UI.
- Provider and manager boundaries that leave room for future tools, streaming, retrieval, and multi-step agents.

## 2. DeepSeek Provider Requirement

DeepSeek is the required model provider for this phase.

Official docs checked on 2026-06-06:

- First API call: `https://api-docs.deepseek.com/`
- Models and pricing: `https://api-docs.deepseek.com/quick_start/pricing`
- Change log: `https://api-docs.deepseek.com/updates/`
- Model list API: `https://api-docs.deepseek.com/api/list-models`

Implementation implications:

- Use the OpenAI-compatible Chat Completions format.
- Use `https://api.deepseek.com` as the OpenAI-format base URL.
- Default model should be `deepseek-v4-flash`.
- Allow `deepseek-v4-pro` through configuration.
- Avoid `deepseek-chat` and `deepseek-reasoner` because DeepSeek docs mark them for deprecation on 2026-07-24.
- Store the API key only in local environment variables such as `DEEPSEEK_API_KEY`.
- Never commit API keys, `.env`, `.env.local`, or runtime credential files.

## 3. Architecture

The chat endpoint should stop owning prompt assembly directly. It should delegate to a focused conversation layer:

```text
POST /api/room/chat
  -> ConversationManager
      -> PersonaProfile
      -> MemoryStore
      -> PromptBuilder
      -> LLMProvider
      -> MemoryExtractor
  -> ChatOut
```

### Components

`LLMProvider`

- Defines a narrow interface for chat completion.
- Has `mock` and `deepseek` implementations.
- Reads provider choice from environment.
- Returns reply text and optional structured metadata.

`ConversationManager`

- Receives user message, room state, recent conversation, persona strength, and memory settings.
- Loads relevant memory.
- Builds the model input.
- Calls the provider.
- Runs automatic memory extraction after a successful reply.
- Produces the existing `ChatOut` shape plus provider and memory metadata where the frontend needs it.

`PersonaProfile`

- Encodes shared Kumiko behavior and two public strengths:
  - `medium`: default, natural, music-centered, restrained character flavor.
  - `strong`: more explicitly speaks as 黄前久美子 / 久美子, with stronger rhythm, hesitation, light teasing, music-club context, and relationship feeling.
- Keeps an internal `light` value available for future fallback, but the first UI only needs `medium` and `strong`.

`MemoryStore`

- Stores local memories outside source control.
- First implementation can use SQLite or a JSONL-backed repository; SQLite is preferred if the current Python dependency setup makes it simple.
- Supports list, create, delete, clear, and disabled-state behavior.

`MemoryExtractor`

- Runs automatically after model replies.
- Uses medium sensitivity.
- Records useful long-term information while filtering casual one-off text, uncertain facts, sensitive content, and persona-generated roleplay content.

## 4. Persona Rules

The default persona strength should be `medium`.

### Medium

- Speak with Kumiko-inspired warmth, hesitation, observational detail, and music context.
- Keep replies natural and useful.
- Avoid over-explaining character lore.
- Keep tool and workspace language clear.

### Strong

- Clearly use the 黄前久美子 / 久美子 identity.
- Make the voice more recognizable: careful, lightly self-conscious, occasionally dry or teasing, and tied to music practice or listening.
- Do not repeatedly self-introduce.
- Do not frequently explain setting or background.
- Do not turn workspace operations into dramatic roleplay.
- Do not claim official authorization.
- Keep practical tasks clear even when the voice is stronger.

## 5. Automatic Memory

The first memory mode is automatic with medium sensitivity.

Memory categories:

- `preference`: music taste, disliked styles, preferred reply style, workflow preferences.
- `diary`: listening diary, current mood, meaningful song moments.
- `creative_note`: lyrics, demo ideas, FLP/project plans, next steps.
- `profile_fact`: stable user or project background that helps future conversations.

Extraction rules:

- Save facts that seem useful after today.
- Prefer concise normalized memories over raw transcript snippets.
- Include a confidence score.
- Include source message ids or a source excerpt for later audit.
- Do not save secrets, credentials, private identifiers, or ambiguous claims.
- Do not save content created by the persona as if it were a user fact.
- Let the user pause memory, delete individual memories, and clear all memories.

## 6. API Shape

Keep the existing frontend flow small, but add the minimum fields needed for settings and status.

`ChatIn`

- `message: string`
- `room_state?: RoomState`
- `recent_messages?: ChatMessage[]`
- `persona_strength?: "medium" | "strong"`
- `memory_enabled?: boolean`

`ChatOut`

- Existing fields:
  - `reply`
  - `expression`
  - `suggested_actions`
- New fields:
  - `provider_status`
  - `memory_events`

`provider_status`

- `provider: "mock" | "deepseek"`
- `model: string | null`
- `configured: boolean`
- `label: string`

`memory_events`

- Array of newly saved memories.
- Each item includes id, category, text, confidence, and created timestamp.
- Empty when memory is disabled or nothing should be saved.

## 7. Frontend Behavior

The `/room` right side should add a compact AI settings/status area.

Visible controls:

- Model connection status.
- Persona strength segmented control: `中` / `强`.
- Memory toggle.
- Recently saved memory count or last saved memory summary.

First version behavior:

- Persona setting persists locally in the browser.
- Memory toggle persists locally in the browser.
- Sending a chat request includes the current persona strength and memory toggle.
- If the backend is using mock mode, the status should say so clearly.
- If DeepSeek is configured, the status should show the active model.

## 8. Error Handling

Provider errors:

- If DeepSeek is selected but no key is configured, return a structured unavailable status and a friendly local reply explaining configuration is missing.
- If DeepSeek request fails, keep the UI usable and show a concise error state.
- Do not expose API keys or raw provider error payloads to the frontend.

Memory errors:

- Chat should still succeed if memory saving fails.
- Backend should return a memory warning only when useful.
- Local logs may include the exception class and safe message, but no secrets.

## 9. Future Agent Runtime Path

This phase should be a foundation for a later full agent system.

Future expansion points:

- `ConversationManager` can become an agent loop.
- `LLMProvider` can support streaming, tool calls, and model routing.
- `MemoryStore` can add embedding retrieval, summaries, importance scoring, and decay.
- `suggested_actions` can become executable tools after user-visible safeguards are in place.
- Studio and music context can become tools that the manager calls instead of static prompt context.

The first implementation should avoid multi-step autonomous tool execution. It should keep actions as suggestions and keep memory writes local and inspectable.

## 10. Acceptance Criteria

- `/room` can send a message and receive a DeepSeek-backed reply when `DEEPSEEK_API_KEY` is configured.
- `/room` still works in mock mode when no key is configured.
- User can switch persona strength between `medium` and `strong`.
- Strong persona clearly uses the Kumiko identity with restraint.
- Automatic memory saves useful memories at medium sensitivity.
- Memory can be paused, listed, deleted, and cleared.
- No API key or credential is committed.
- Tests cover provider selection, prompt building, persona strength, memory extraction filtering, and chat endpoint fallback behavior.


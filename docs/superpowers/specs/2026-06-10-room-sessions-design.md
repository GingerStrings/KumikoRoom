# Room Sessions Design

## Purpose

KumikoRoom needs a durable conversation system so the room behaves like a real local AI companion rather than a single in-memory chat panel. The next build slice adds manual chat sessions, saved messages, and a collapsible session sidebar.

This design supersedes the smaller localStorage-only recovery idea. Browser storage may still hold transient UI preferences, but conversation history belongs in the API's local SQLite data.

## User Experience

The room uses a three-area layout:

- Left: collapsible sessions sidebar.
- Center: current chat timeline and composer.
- Right: room context, local music status, AI settings, and memory controls.

The sessions sidebar follows familiar AI chat app behavior. It is expanded by default, shows a new-session control, lists recent sessions, and can collapse to a narrow rail with an expand button. Collapsing the sidebar gives the chat area more room without hiding the current conversation.

Each session row shows:

- Title.
- Last updated time.
- Short latest-message preview.
- Active state.
- Compact actions for rename and delete.

The center chat panel shows the selected session's messages. If the selected session has no messages, it shows the existing idle Kumiko line as an empty-state prompt, but that idle line is not saved as a real chat message.

## MVP Scope

The first implementation includes:

- Create a session.
- List sessions.
- Select a session.
- Rename a session.
- Delete a session.
- Persist user and Kumiko messages for the active session.
- Load messages when switching sessions or reopening `/room`.
- Remember the last selected session on the client.
- Auto-create a default session when no sessions exist.
- Keep memory management independent from sessions for now.

The first implementation excludes:

- Search.
- Pinning.
- Archiving.
- Date grouping.
- Export.
- Multi-select bulk operations.
- Cross-device sync.
- Per-session memory scoping.

## Data Model

SQLite stores sessions and messages beside the existing memory database.

`chat_sessions`:

- `id TEXT PRIMARY KEY`
- `title TEXT NOT NULL`
- `created_at TEXT NOT NULL`
- `updated_at TEXT NOT NULL`

`chat_messages`:

- `id TEXT PRIMARY KEY`
- `session_id TEXT NOT NULL`
- `role TEXT NOT NULL`
- `content TEXT NOT NULL`
- `created_at TEXT NOT NULL`
- `provider TEXT`
- `provider_model TEXT`
- `provider_configured INTEGER`
- `provider_label TEXT`

Messages are ordered by `created_at`, then insertion order. Session `updated_at` changes when messages are added or the title changes.

The default title for a new session is `New conversation`. When the first user message is saved to a session that still has the default title, the API renames the session from that message by trimming whitespace and limiting the title length. Manual renames override this automatic title.

## API Design

Existing `/api/room/chat` gains optional `session_id`. If omitted, the API uses the most recently updated session. If no sessions exist, the API creates a default session before saving messages.

New endpoints:

- `GET /api/room/sessions`
  - Returns recent sessions ordered by `updated_at DESC`.

- `POST /api/room/sessions`
  - Creates an empty session and returns it.

- `GET /api/room/sessions/{session_id}/messages`
  - Returns messages for one session in timeline order.

- `PATCH /api/room/sessions/{session_id}`
  - Accepts `{ "title": "..." }`, trims title, rejects blank titles, returns the updated session.

- `DELETE /api/room/sessions/{session_id}`
  - Deletes the session and its messages.

Chat response includes the saved `session` summary so the UI can update the sidebar after a send.

## Frontend Design

`RoomShell` receives or loads session data through the room API client. It owns:

- Sidebar expanded/collapsed state.
- Current session id.
- Session list.
- Current session messages.
- Loading and error states.

Client state stored in `localStorage`:

- Sidebar collapsed preference.
- Last selected session id.
- Persona strength.
- Memory enabled.

The chat timeline renders saved messages only. The idle line is a view-level empty state for empty sessions.

The new sidebar should use the existing restrained room design language:

- 8px radii.
- Existing rose/fog palette.
- Compact rows.
- Clear active state.
- No large marketing-style hero treatment.

## Error Handling

If session list loading fails, the sidebar shows a calm inline error and a retry button. The chat panel keeps the current visible state if available.

If switching sessions fails, the current session remains selected and the UI shows an inline error.

If sending a message succeeds at the provider layer but persistence fails, the API returns an error rather than presenting unsaved chat as successful.

If deleting the active session succeeds, the UI selects the most recent remaining session. If none remain, it creates or loads a new default session.

## Testing

Backend tests cover:

- Session CRUD.
- Message persistence.
- Cascade delete behavior.
- Chat saves user and Kumiko messages.
- Chat returns the saved session summary.
- First-message automatic title behavior.

Frontend client tests cover:

- Mapping session list and message APIs.
- Sending chat with `sessionId`.
- Mapping chat response session fields.

RoomShell tests cover:

- Sidebar renders sessions and can collapse/expand.
- Selecting a session loads its messages.
- New session creates and selects an empty conversation.
- Sending a message updates the timeline and sidebar.
- Rename and delete flows.
- Loading and failure states.

## Migration and Compatibility

Existing memory tables remain unchanged. The session tables are created lazily on API startup or first use by the session store.

Existing chat requests without `session_id` remain valid. This keeps older frontends and tests compatible while the web app migrates to explicit sessions.

## Open Product Decisions Resolved

- Session navigation belongs in a left sidebar.
- The sidebar must be collapsible.
- Conversation records are persisted in SQLite, not only browser storage.
- Manual sessions are in scope for the first durable chat milestone.

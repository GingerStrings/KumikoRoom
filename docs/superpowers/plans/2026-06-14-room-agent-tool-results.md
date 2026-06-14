# Room Agent Tool Results

Date: 2026-06-14

## Context

The room music controls can execute local actions such as opening the Bilibili mini window or switching tracks. Before this change, those commands also continued through the normal chat path, so the chat model could answer without seeing the tool result.

The user's own chat avatar also shared the Kumiko avatar styling.

## Codex Source Reference

Use the checked-out Codex source under `.runtime/codex-main/codex-main` as the reference for tool-call behavior:

- `codex-rs/core/src/tools/router.rs`
- `codex-rs/core/src/tools/registry.rs`
- `codex-rs/core/src/tools/context.rs`
- `codex-rs/core/src/session/turn.rs`
- `codex-rs/core/src/tasks/regular.rs`

The important pattern is: function call, tool dispatch, function-call output, then continue the model turn with that output.

## Tasks

1. Add a room-agent model output object for local tool results.
2. Route recognized room music commands through that result path so they do not become normal user chat messages.
3. Keep the existing chat UI style while showing a real tool-result acknowledgement in the timeline.
4. Give the user avatar a distinct class and CSS treatment.
5. Verify with focused tests, full web tests, build, API tests, diff check, browser QA, and subagent review.

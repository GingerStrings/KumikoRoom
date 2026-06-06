# KumikoRoom Navigation Page Refresh

> Implementation mode: superpowers `subagent-driven-development`, with focused review after each task.

## Goal

Build a polished navigation-first entry for KumikoRoom, apply the approved warm rose fog palette, remove the unsettling character placeholder, reduce repeated room wording, and surface the current API connection state.

## Approved Direction

- Background: warm white `#fafaf8`
- Glass surfaces: `rgba(255, 255, 255, 0.74)` and `rgba(255, 255, 255, 0.9)`
- Primary text: warm graphite `#3f3a3d`
- Muted text: `#756f73`
- Primary accent: rose gray `#a95568`
- Soft accent: `#f5e4e8`
- Information layer: fog blue `#eef4f7`
- Radius: `8px` for cards and controls
- Tone: clean, quiet, navigation-first

## Scope

This phase covers the web app only. The existing FastAPI mock backend stays in place and is shown as `本地 Mock API`. This phase does not add a real LLM provider, account system, music indexing, or desktop shell integration.

## Tasks

- [x] Add a shared connection status helper and tests.
- [x] Replace muddy legacy palette values with the approved Palette C tokens.
- [x] Convert `/` from redirect behavior into a navigation page.
- [x] Simplify `/room` into a chat-first workspace and remove the character placeholder.
- [x] Align `/studio` copy and shared surfaces with the new navigation language.
- [x] Run full tests, build, and browser acceptance checks.

## Files Changed

- `apps/web/src/lib/connectionStatus.ts`
- `apps/web/tests/connectionStatus.test.ts`
- `apps/web/tests/design-tokens.test.ts`
- `apps/web/src/components/HomeNavigation.tsx`
- `apps/web/tests/HomeNavigation.test.tsx`
- `apps/web/app/page.tsx`
- `apps/web/app/room/page.tsx`
- `apps/web/src/components/RoomShell.tsx`
- `apps/web/tests/RoomShell.test.tsx`
- `apps/web/src/components/StudioEntry.tsx`
- `apps/web/tests/StudioEntry.test.tsx`
- `apps/web/app/globals.css`

## Verification

- `npm --prefix apps/web test`
- `npm --prefix apps/web run build`
- Playwright acceptance for `/` and `/room` at `1280x720` and `390x844`

Browser acceptance confirmed:

- `/` returns `200`, shows `KumikoRoom`, shows `今天从哪里开始？`, shows `本地 Mock API`, and has no horizontal overflow.
- `/room` returns `200`, shows `对话工作区`, shows summary and local music panels, shows `本地 Mock API`, and has no horizontal overflow.
- The previous character placeholder and repeated `陪伴房间` wording are absent from the checked screens.
- Chat send flow reaches the mock API and receives a reply in the acceptance run.

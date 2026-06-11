# Liz Blue Bird Room Refresh Design

## Purpose

KumikoRoom's current room UI feels flat and low-fidelity because too many surfaces share the same translucent white panel, rose accent, 8px radius, and soft gray shadow. The next design slice refreshes the chat room around a Liz and the Blue Bird inspired palette, while keeping the product focused on conversation.

This design covers the room visual system, a low-profile model and preference popover, and the chat composer keyboard behavior.

## References

- Liz and the Blue Bird official site: `https://liz-bluebird.com/`
- Sound! Euphonium final chapter official site: `https://anime-eupho.com/`
- Sound! Euphonium TV3 official site: `https://tv3rd.anime-eupho.com/`
- Keihan x Sound! Euphonium collaboration page: `https://www.keihan.co.jp/euphonium/`
- Momotalk public pages: `https://www.momotalk.top/` and `https://www.momotalk.top/chat`

Useful reference signals:

- Liz site CSS uses airy blue, white, pale pink, and pale green: `#d3f4f8`, `#9ce9ff`, `#ffebf9`, `#dffbea`, `#0b73d4`.
- Sound! Euphonium sites add stronger blue and yellow accents: `#01acc6`, `#2076df`, `#fff100`.
- Kumiko artwork sampling suggests warm brown, ivory, and muted green support colors.
- Momotalk's useful lesson is layered material quality: different surface opacities, stronger hover feedback, and clearer hierarchy.

## Product Direction

The room should feel like a quiet, translucent chat space: light, watery, and paper-like. The chat area stays primary. Low-frequency controls move into a small top-right entry.

The default view includes:

- Left session sidebar.
- Center chat timeline and composer.
- Top-right model and preference popover trigger.

The default view excludes:

- Today summary.
- Mood logging.
- Local music status.
- Frontend memory item management.

Memory remains an API-side behavior for this slice. The frontend may keep a small automatic memory toggle if the existing product behavior needs it, but it should not show recent memory event lists or memory editing controls.

## Visual System

### Palette

Use a Liz and the Blue Bird inspired light palette:

- `--color-bg`: `#fdfff8`
- `--color-bg-mist`: `#d3f4f8`
- `--color-bg-pink`: `#ffebf9`
- `--color-bg-green`: `#dffbea`
- `--color-accent-blue`: `#0b73d4`
- `--color-accent-sky`: `#9ce9ff`
- `--color-accent-reed`: `#95ad92`
- `--color-accent-kumiko`: `#b87b68`
- `--color-text`: deep blue-gray, around `#263a40`
- `--color-muted`: muted green-gray, around `#6b7d80`

Primary functional actions use blue. Pink becomes a soft emotional tint, mostly for user bubbles and subtle background warmth. Green is a quiet support color for secondary state.

### Background

The room background uses a soft watercolor-like gradient:

- A pale blue to pale pink base.
- Subtle radial washes in pale blue, pink, and green.
- No large decorative blobs or loud gradients.
- No dark full-room theme in this slice.

### Surfaces

Replace the current uniform card treatment with tiered surfaces:

- Page background: watercolor wash.
- Primary panels: translucent paper, high white opacity, slight blur.
- Timeline well: lower white opacity so bubbles sit forward.
- Popover: highest surface opacity and strongest border.
- Active session: blue-tinted translucent fill.

Surface radius can increase from 8px to 14-18px for large panels and bubbles. Small icon buttons may stay compact with 10-12px radius.

### Shadows And Borders

Shadows should carry a faint cyan tone rather than gray:

- Large panels: soft blue-green shadow, low opacity.
- Bubbles: smaller, tighter cyan shadow.
- Hover states: slight lift, brighter border, no heavy scale.

Borders should be visible enough to separate translucent layers:

- Default panel border: white with high transparency.
- Functional focus border: blue.
- User bubble border: pale pink.

### Typography

Keep the existing Chinese-friendly stack, but tune weight and hierarchy:

- Body: `Microsoft YaHei UI`, `Microsoft YaHei`, `Segoe UI`, sans-serif.
- Optional headings and labels may use the existing stack with slightly stronger weight.
- Avoid oversized hero typography inside the room. The room is a tool surface, not a landing page.

## Room Layout

### Sidebar

The session sidebar remains left aligned and collapsible. It should feel lighter:

- Paper surface.
- Active row uses pale sky fill and blue text.
- Session previews are muted.
- Create action is compact and icon-like if an icon system is available; otherwise a small text button is acceptable.

### Chat Header

The chat header becomes simpler:

- Left: `KumikoRoom` and the current conversation context if needed.
- Right: a compact status chip and `Model & Preferences` trigger.

The header should not show summary cards or diary-like content.

### Timeline

The timeline becomes a translucent well:

- Kumiko messages: paper-white bubble.
- User messages: pale pink bubble.
- Bubbles use more generous radius and cleaner spacing.
- Labels stay small and muted.

### Composer

The composer should feel like one integrated input bar:

- Paper surface.
- Textarea visually merged with the composer shell.
- Send button uses blue.
- Helper text can mention `Enter to send` and `Shift+Enter for newline` in a compact way.

## Model And Preferences Popover

Use a top-right popover, not a full settings page or visible side panel.

Popover contents:

- Provider label.
- Current model label.
- API key configured state without revealing the key.
- Test connection action if the backend already supports or can safely add it in this slice.
- Persona strength control.
- Reply style control if it can be represented without adding new backend behavior.
- Automatic memory toggle if preserving the existing UI behavior is required.

Popover exclusions:

- Memory event list.
- Memory editing.
- Today summary.
- Mood logging.
- Music status.

Errors should be inline and calm: missing API key, connection failure, or unknown provider state.

## Keyboard Behavior

The current textarea submits only through the button. Browser default Enter behavior inserts a newline. This slice changes it to common chat behavior:

- `Enter`: submit the message.
- `Shift+Enter`: insert newline.
- During IME composition: Enter should not submit.
- Empty or whitespace-only messages still do not submit.
- Disabled composer state still blocks keyboard submit.

## Data Flow

No backend schema changes are required for the visual refresh.

RoomShell continues owning:

- Draft message.
- Session state.
- Provider status.
- Persona strength.
- Memory enabled preference if kept.

The model popover reads existing provider status from the chat response and connection status. If a test connection endpoint is added later, it should be handled as a separate API call with loading, success, and error states.

## Error Handling

Composer errors remain near the composer.

Session errors remain in the session sidebar.

Model popover errors remain inside the popover and should not block the main chat timeline unless sending is actually unavailable.

## Testing

Frontend tests should cover:

- Room renders without the old right-side summary modules.
- Model and preferences popover opens and closes.
- Existing persona and memory preferences still persist if kept.
- Enter submits a non-empty draft.
- Shift+Enter keeps a newline in the draft.
- Enter during IME composition does not submit.
- Disabled composer does not submit via keyboard.
- Visual token test updated for the Liz-inspired palette.

Existing API tests should not need changes unless a model connection test endpoint is added.

## Migration

This is a UI-focused migration:

- Replace old global rose/fog tokens with Liz-inspired tokens.
- Keep compatibility aliases only where shared tests or older components need them.
- Remove or hide the right-side summary, utility, and memory event panels from the room.
- Keep the session persistence and chat API behavior unchanged.

## Open Decisions Resolved

- The visual direction uses Liz and the Blue Bird as the primary palette reference.
- The model settings live in a low-profile top-right popover.
- Frontend memory item management is out of scope.
- Today summary, mood recording, and local music status are out of scope for this slice.
- Enter sends messages; Shift+Enter inserts a newline.

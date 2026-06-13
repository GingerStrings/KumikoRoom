# KumikoRoom Product Design

## 1. Product Direction

KumikoRoom is a local-first music companionship application centered on Oumae Kumiko.

The main product experience is the companion room: chat, listening, diary, inspiration, voice, images, and music memories. The existing FL Studio project manager is only a built-in feature area inside KumikoRoom, named "创作资料室".

The MuseFlow name is deprecated. It can remain only as historical context during migration. User-facing names, app title, documentation, launcher text, and package identity should move to KumikoRoom naming over time.

## 2. Core Experience

The first version prioritizes chat, with a room-style interface.

- Main entry: 陪伴房间.
- Primary character: 黄前久美子.
- Main interaction: text chat with optional TTS playback.
- Visual focus: Kumiko portrait, expression state, current mood, and current music context.
- Music focus: listening diary, inspiration notes, local audio, and unfinished creative projects.
- Built-in tool area: 创作资料室, powered by the current project-management capabilities.

The desktop pet is a required later phase. It should share the same character state, memory, TTS, and music context as the main room.

## 3. First-Version Layout

Route: `/room`

Left area:

- Kumiko portrait.
- Current expression or state.
- Current music status.
- Short idle line or reminder.

Center area:

- Chat message timeline.
- User input.
- TTS playback action.
- Save selected message to diary, inspiration, or project todo.

Right area:

- Today mood.
- Listening diary summary.
- Recent inspiration notes.
- Unfinished creative projects from 创作资料室.

Bottom area:

- Local music player.
- Current track.
- Playback controls.
- Shortcut to 创作资料室.

## 4. Built-In Creative Archive

The current project-management app becomes a feature module inside KumikoRoom.

User-facing names:

- Module: 创作资料室.
- Project list: 工程架.
- Project detail: 工程档案.
- Notes: 创作笔记.
- Demo audio: Demo 音频.

Core abilities retained:

- Scan local music project folders.
- Identify `.flp`, audio, text, image, and related files.
- Store project metadata in local SQLite.
- Choose main FLP.
- Show FLP metadata where available.
- Play related demo audio.
- Edit notes and project status.

Future integration:

- Kumiko can reference unfinished projects during chat.
- Kumiko can suggest next steps for a project.
- Diary and inspiration entries can link to a project.
- Desktop pet can remind the user about a project.

## 5. Local Assets

KumikoRoom should support local character assets without committing sensitive media to source control.

Suggested local structure:

```text
user-data/
  characters/
    kumiko/
      character.json
      images/
      audio/
      tts/
      memory/
```

`character.json` stores:

- Display name.
- User nickname.
- Speaking style.
- Boundaries.
- TTS settings.
- Expression mapping.
- Music preferences.

The repository can include placeholders and documentation. User-provided fan assets stay outside tracked source files.

## 6. AI and TTS Flow

1. User sends a message in the room.
2. Frontend sends current room state, current music, recent diary, and relevant project context.
3. Backend builds the Kumiko character prompt and memory context.
4. AI returns reply text, emotion label, and optional suggested actions.
5. UI updates expression state from the emotion label.
6. TTS generates or plays voice if enabled.
7. User can save the interaction to diary, inspiration, or project notes.

The AI provider and TTS engine should be replaceable. First version can use mock responses or a local adapter while the UI and data flow are built.

## 7. Desktop Pet Phase

The desktop pet is planned after the main room works.

Shared state:

- Current expression.
- Current line.
- Current music.
- TTS playback status.
- Unread chat.
- Recent reminder.

Desktop pet responsibilities:

- Stay on desktop as a small companion.
- Surface short lines and reminders.
- Open the main room.
- React to music playback.
- Mention unfinished projects lightly.

## 8. Migration From Current Code

The new project lives at `D:\555\codex\KumikoRoom`.

Migration order:

1. Create KumikoRoom app shell and design documents.
2. Define new naming and route structure.
3. Bring the existing project-management capability in as 创作资料室.
4. Remove MuseFlow from user-facing UI and docs.
5. Connect chat room context to creative archive data.
6. Add local character assets, TTS, and memory.
7. Add desktop pet.

## 9. Non-Commercial Fan Project Boundary

The first target is local personal use.

For source control and future sharing:

- Keep official or fan-provided character media out of the public repository.
- Avoid bundling voice samples or trained voice models in source control.
- Mark the project as unofficial fan-made if it is ever shared.
- Keep code and local asset packs separate.


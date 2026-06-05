# KumikoRoom Foundation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the independent KumikoRoom project foundation: a chat-first room shell, Kumiko-centered room state, a Creative Archive entry point, and a desktop shell that can load the new app.

**Architecture:** Use a small monorepo with separate `apps/web`, `apps/api`, and `apps/desktop` folders. The web app owns the room interface and Creative Archive entry route; the API exposes room-state and chat endpoints with mock responses for the first vertical slice; the desktop app loads the web app and keeps the KumikoRoom product identity. Existing MuseFlow project-management code will be migrated later into the `studio` feature area.

**Tech Stack:** Next.js 14, React 18, TypeScript, Vitest, FastAPI, Pydantic, pytest, Electron 31.

---

## Scope

This plan implements the first foundation slice only:

- Independent `D:\555\codex\KumikoRoom` project structure.
- KumikoRoom naming throughout the new project.
- `/room` as the main companion room route.
- `/studio` as the Creative Archive entry route.
- Mock chat and room-state API.
- Desktop shell loading the room app.
- Tests that lock down naming, routing, room state, and mock API behavior.

Separate future plans should cover:

- Migrating the existing FL Studio project manager into `apps/api/kumikoroom/studio` and `apps/web/app/studio`.
- Real AI provider integration.
- Local TTS engine integration.
- Local character asset pack loading.
- Desktop pet.

## File Structure

Create these files:

```text
D:\555\codex\KumikoRoom\
  .gitignore
  README.md
  package.json
  apps\
    web\
      package.json
      next.config.js
      tsconfig.json
      vitest.config.ts
      app\
        globals.css
        layout.tsx
        page.tsx
        room\
          page.tsx
        studio\
          page.tsx
      src\
        api\
          client.ts
          types.ts
        components\
          RoomShell.tsx
          StudioEntry.tsx
        lib\
          roomState.ts
      tests\
        naming.test.ts
        room-state.test.ts
        RoomShell.test.tsx
        StudioEntry.test.tsx
    api\
      pyproject.toml
      kumikoroom\
        __init__.py
        main.py
        schemas.py
        routers\
          __init__.py
          room.py
      tests\
        conftest.py
        test_room_api.py
    desktop\
      package.json
      tsconfig.json
      src\
        config.ts
        main.ts
      tests\
        config.test.ts
```

Responsibilities:

- `apps/web/app/room/page.tsx`: main companion room page.
- `apps/web/src/components/RoomShell.tsx`: chat-first room layout.
- `apps/web/src/components/StudioEntry.tsx`: Creative Archive entry panel.
- `apps/web/src/lib/roomState.ts`: default Kumiko room state and labels.
- `apps/web/src/api/client.ts`: typed client for room-state and mock chat.
- `apps/api/kumikoroom/routers/room.py`: room state and mock chat endpoints.
- `apps/desktop/src/main.ts`: Electron shell with KumikoRoom app title.

---

### Task 1: Root Project Skeleton

**Files:**
- Create: `D:\555\codex\KumikoRoom\.gitignore`
- Create: `D:\555\codex\KumikoRoom\README.md`
- Create: `D:\555\codex\KumikoRoom\package.json`

- [ ] **Step 1: Create root metadata**

Create `package.json`:

```json
{
  "name": "kumikoroom",
  "version": "0.1.0",
  "private": true,
  "scripts": {
    "test": "npm run test --workspace apps/web && npm run test --workspace apps/desktop",
    "dev:web": "npm run dev --workspace apps/web",
    "dev:desktop": "npm run start --workspace apps/desktop"
  },
  "workspaces": [
    "apps/web",
    "apps/desktop"
  ]
}
```

Create `.gitignore`:

```gitignore
node_modules/
.next/
dist/
__pycache__/
.pytest_cache/
.venv/
*.sqlite3
user-data/
.env
.env.local
```

Create `README.md`:

```markdown
# KumikoRoom

KumikoRoom is a local-first music companionship app centered on Kumiko Oumae.

The main entry is the companion room. The Creative Archive is an internal feature area for local music projects, demo audio, notes, and FL Studio project metadata.

## Development

Web app:

```powershell
cd apps\web
npm install
npm run dev
```

API:

```powershell
cd apps\api
python -m venv .venv
.venv\Scripts\activate
pip install -e ".[dev]"
uvicorn kumikoroom.main:app --reload --port 8000
```

Desktop shell:

```powershell
cd apps\desktop
npm install
npm start
```

## Fan Project Boundary

Do not commit character images, voice samples, trained voice models, or other fan-provided media. Local assets belong under `user-data/`, which is ignored by git.
```

- [ ] **Step 2: Verify root metadata exists**

Run:

```powershell
Get-ChildItem -Force D:\555\codex\KumikoRoom
```

Expected: output includes `.gitignore`, `README.md`, `package.json`, and `docs`.

- [ ] **Step 3: Commit**

```powershell
git add .gitignore README.md package.json
git commit -m "chore: scaffold KumikoRoom root"
```

Expected: commit succeeds if this directory has a git repository. If no repository exists, initialize it before committing:

```powershell
git init
git add .gitignore README.md package.json
git commit -m "chore: scaffold KumikoRoom root"
```

---

### Task 2: Web App Test Harness

**Files:**
- Create: `D:\555\codex\KumikoRoom\apps\web\package.json`
- Create: `D:\555\codex\KumikoRoom\apps\web\next.config.js`
- Create: `D:\555\codex\KumikoRoom\apps\web\tsconfig.json`
- Create: `D:\555\codex\KumikoRoom\apps\web\vitest.config.ts`
- Create: `D:\555\codex\KumikoRoom\apps\web\tests\naming.test.ts`

- [ ] **Step 1: Write the naming test first**

Create `apps/web/tests/naming.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";

const projectRoot = path.resolve(__dirname, "..");

function readTextFiles(folder: string): string[] {
  const entries = fs.readdirSync(folder, { withFileTypes: true });
  return entries.flatMap((entry) => {
    const fullPath = path.join(folder, entry.name);
    if (entry.isDirectory()) {
      if (["node_modules", ".next", "dist"].includes(entry.name)) return [];
      return readTextFiles(fullPath);
    }
    if (/\.(ts|tsx|js|jsx|css|md|json)$/.test(entry.name)) {
      return [fs.readFileSync(fullPath, "utf8")];
    }
    return [];
  });
}

describe("KumikoRoom naming", () => {
  it("does not expose the old MuseFlow name in the new web app", () => {
    const allText = readTextFiles(projectRoot).join("\n");
    expect(allText).not.toMatch(/MuseFlow/);
  });
});
```

- [ ] **Step 2: Add web package and config**

Create `apps/web/package.json`:

```json
{
  "name": "@kumikoroom/web",
  "version": "0.1.0",
  "private": true,
  "scripts": {
    "dev": "next dev",
    "build": "next build",
    "test": "vitest run"
  },
  "dependencies": {
    "next": "^14.2.0",
    "react": "^18.2.0",
    "react-dom": "^18.2.0"
  },
  "devDependencies": {
    "@testing-library/react": "^15.0.0",
    "@types/node": "^20.12.0",
    "@types/react": "^18.2.0",
    "@types/react-dom": "^18.2.0",
    "@vitejs/plugin-react": "^4.2.0",
    "jsdom": "^24.0.0",
    "typescript": "^5.4.0",
    "vitest": "^1.5.0"
  }
}
```

Create `apps/web/next.config.js`:

```js
const apiUrl = process.env.KUMIKOROOM_API_URL ?? "http://127.0.0.1:8000";

/** @type {import('next').NextConfig} */
const nextConfig = {
  async rewrites() {
    return [
      {
        source: "/api/:path*",
        destination: `${apiUrl}/api/:path*`
      }
    ];
  }
};

module.exports = nextConfig;
```

Create `apps/web/tsconfig.json`:

```json
{
  "compilerOptions": {
    "target": "ES2020",
    "lib": ["dom", "dom.iterable", "es2020"],
    "allowJs": false,
    "skipLibCheck": true,
    "strict": true,
    "noEmit": true,
    "esModuleInterop": true,
    "module": "esnext",
    "moduleResolution": "bundler",
    "resolveJsonModule": true,
    "isolatedModules": true,
    "jsx": "preserve",
    "incremental": true
  },
  "include": ["next-env.d.ts", "**/*.ts", "**/*.tsx"],
  "exclude": ["node_modules"]
}
```

Create `apps/web/vitest.config.ts`:

```ts
import react from "@vitejs/plugin-react";
import { defineConfig } from "vitest/config";

export default defineConfig({
  plugins: [react()],
  test: {
    environment: "jsdom",
    globals: true
  }
});
```

- [ ] **Step 3: Install web dependencies**

Run:

```powershell
npm install --workspace apps/web
```

Expected: `apps/web/node_modules` exists or npm workspace dependencies install at the root.

- [ ] **Step 4: Run the naming test**

Run:

```powershell
npm run test --workspace apps/web -- tests/naming.test.ts
```

Expected: PASS.

- [ ] **Step 5: Commit**

```powershell
git add apps/web package-lock.json package.json
git commit -m "chore: add web test harness"
```

---

### Task 3: Room State Model

**Files:**
- Create: `D:\555\codex\KumikoRoom\apps\web\src\api\types.ts`
- Create: `D:\555\codex\KumikoRoom\apps\web\src\lib\roomState.ts`
- Create: `D:\555\codex\KumikoRoom\apps\web\tests\room-state.test.ts`

- [ ] **Step 1: Write the room-state tests**

Create `apps/web/tests/room-state.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { DEFAULT_ROOM_STATE, getIdleLine } from "../src/lib/roomState";

describe("default Kumiko room state", () => {
  it("uses KumikoRoom as the app identity", () => {
    expect(DEFAULT_ROOM_STATE.appName).toBe("KumikoRoom");
    expect(DEFAULT_ROOM_STATE.character.displayName).toBe("黄前久美子");
  });

  it("keeps Creative Archive as an internal room feature", () => {
    expect(DEFAULT_ROOM_STATE.studio.label).toBe("创作资料室");
    expect(DEFAULT_ROOM_STATE.studio.route).toBe("/studio");
  });

  it("returns a stable idle line", () => {
    expect(getIdleLine(DEFAULT_ROOM_STATE)).toContain("今天");
  });
});
```

- [ ] **Step 2: Run test to verify missing implementation**

Run:

```powershell
npm run test --workspace apps/web -- tests/room-state.test.ts
```

Expected: FAIL with an import error for `../src/lib/roomState`.

- [ ] **Step 3: Add types and room-state implementation**

Create `apps/web/src/api/types.ts`:

```ts
export interface CharacterState {
  displayName: string;
  romanizedName: string;
  expression: "neutral" | "listening" | "thinking" | "encouraging";
  statusText: string;
}

export interface MusicContext {
  currentTrackTitle: string | null;
  currentArtist: string | null;
  listeningMood: string | null;
}

export interface StudioSummary {
  label: string;
  route: string;
  unfinishedCount: number;
}

export interface RoomState {
  appName: string;
  roomName: string;
  character: CharacterState;
  music: MusicContext;
  diarySummary: string;
  inspirationCount: number;
  studio: StudioSummary;
}

export interface ChatMessage {
  id: string;
  role: "user" | "kumiko";
  content: string;
}

export interface ChatRequest {
  message: string;
  roomState: RoomState;
}

export interface ChatResponse {
  reply: ChatMessage;
  expression: CharacterState["expression"];
  suggestedActions: Array<"save_diary" | "save_inspiration" | "open_studio">;
}
```

Create `apps/web/src/lib/roomState.ts`:

```ts
import type { RoomState } from "../api/types";

export const DEFAULT_ROOM_STATE: RoomState = {
  appName: "KumikoRoom",
  roomName: "陪伴房间",
  character: {
    displayName: "黄前久美子",
    romanizedName: "Kumiko Oumae",
    expression: "listening",
    statusText: "在听你今天想说的音乐"
  },
  music: {
    currentTrackTitle: null,
    currentArtist: null,
    listeningMood: "还没记录"
  },
  diarySummary: "今天还没有写听歌日记。",
  inspirationCount: 0,
  studio: {
    label: "创作资料室",
    route: "/studio",
    unfinishedCount: 0
  }
};

export function getIdleLine(state: RoomState): string {
  const track = state.music.currentTrackTitle;
  if (track) {
    return `今天在听《${track}》吗？我可以陪你记下来。`;
  }
  return "今天想从哪首歌开始聊？";
}
```

- [ ] **Step 4: Run room-state tests**

Run:

```powershell
npm run test --workspace apps/web -- tests/room-state.test.ts
```

Expected: PASS.

- [ ] **Step 5: Commit**

```powershell
git add apps/web/src apps/web/tests/room-state.test.ts
git commit -m "feat: add Kumiko room state model"
```

---

### Task 4: Chat-First Room Shell

**Files:**
- Create: `D:\555\codex\KumikoRoom\apps\web\src\components\RoomShell.tsx`
- Create: `D:\555\codex\KumikoRoom\apps\web\app\globals.css`
- Create: `D:\555\codex\KumikoRoom\apps\web\app\layout.tsx`
- Create: `D:\555\codex\KumikoRoom\apps\web\app\page.tsx`
- Create: `D:\555\codex\KumikoRoom\apps\web\app\room\page.tsx`
- Create: `D:\555\codex\KumikoRoom\apps\web\tests\RoomShell.test.tsx`

- [ ] **Step 1: Write room shell test**

Create `apps/web/tests/RoomShell.test.tsx`:

```tsx
import React from "react";
import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { RoomShell } from "../src/components/RoomShell";
import { DEFAULT_ROOM_STATE } from "../src/lib/roomState";

describe("RoomShell", () => {
  it("renders KumikoRoom as a chat-first companion room", () => {
    render(<RoomShell initialState={DEFAULT_ROOM_STATE} />);

    expect(screen.getByRole("heading", { name: "KumikoRoom" })).toBeTruthy();
    expect(screen.getByLabelText("久美子状态")).toHaveTextContent("黄前久美子");
    expect(screen.getByLabelText("聊天时间线")).toHaveTextContent("今天想从哪首歌开始聊");
    expect(screen.getByRole("textbox", { name: "给久美子发消息" })).toBeTruthy();
    expect(screen.getByRole("link", { name: "打开创作资料室" })).toHaveAttribute("href", "/studio");
  });
});
```

- [ ] **Step 2: Run test to verify missing component**

Run:

```powershell
npm run test --workspace apps/web -- tests/RoomShell.test.tsx
```

Expected: FAIL with an import error for `RoomShell`.

- [ ] **Step 3: Create layout and room shell**

Create `apps/web/app/layout.tsx`:

```tsx
import type { ReactNode } from "react";
import "./globals.css";

export const metadata = {
  title: "KumikoRoom",
  description: "A local-first music companion room."
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="zh-CN">
      <body>{children}</body>
    </html>
  );
}
```

Create `apps/web/app/page.tsx`:

```tsx
import { redirect } from "next/navigation";

export default function HomePage() {
  redirect("/room");
}
```

Create `apps/web/app/room/page.tsx`:

```tsx
import { RoomShell } from "../../src/components/RoomShell";
import { DEFAULT_ROOM_STATE } from "../../src/lib/roomState";

export default function RoomPage() {
  return <RoomShell initialState={DEFAULT_ROOM_STATE} />;
}
```

Create `apps/web/src/components/RoomShell.tsx`:

```tsx
"use client";

import React, { useState } from "react";
import type { ChatMessage, RoomState } from "../api/types";
import { getIdleLine } from "../lib/roomState";

export function RoomShell({ initialState }: { initialState: RoomState }) {
  const [messages] = useState<ChatMessage[]>([
    {
      id: "idle-line",
      role: "kumiko",
      content: getIdleLine(initialState)
    }
  ]);

  return (
    <main className="room-shell">
      <section className="room-hero" aria-label="久美子状态">
        <p className="room-kicker">陪伴房间</p>
        <h1>KumikoRoom</h1>
        <div className="portrait-placeholder" aria-label="久美子立绘占位">
          <span>{initialState.character.displayName}</span>
          <small>{initialState.character.statusText}</small>
        </div>
      </section>

      <section className="chat-panel" aria-label="聊天区域">
        <div className="chat-timeline" aria-label="聊天时间线">
          {messages.map((message) => (
            <article className={`chat-message chat-message--${message.role}`} key={message.id}>
              <span>{message.role === "kumiko" ? "久美子" : "你"}</span>
              <p>{message.content}</p>
            </article>
          ))}
        </div>
        <label className="chat-input">
          给久美子发消息
          <textarea aria-label="给久美子发消息" placeholder="今天想听什么，或者想聊哪首歌？" rows={3} />
        </label>
      </section>

      <aside className="room-sidebar" aria-label="房间侧栏">
        <section>
          <h2>今日音乐</h2>
          <p>{initialState.music.currentTrackTitle ?? "还没有选择歌曲"}</p>
        </section>
        <section>
          <h2>听歌日记</h2>
          <p>{initialState.diarySummary}</p>
        </section>
        <section>
          <h2>灵感便签</h2>
          <p>{initialState.inspirationCount} 条灵感</p>
        </section>
        <a className="studio-link" href={initialState.studio.route}>
          打开{initialState.studio.label}
        </a>
      </aside>
    </main>
  );
}
```

Create `apps/web/app/globals.css`:

```css
:root {
  color: #2b2f33;
  background: #f7f3ee;
  font-family: "Microsoft YaHei", "Segoe UI", sans-serif;
}

body {
  margin: 0;
  min-height: 100vh;
}

a {
  color: inherit;
}

.room-shell {
  min-height: 100vh;
  display: grid;
  grid-template-columns: minmax(220px, 300px) minmax(360px, 1fr) minmax(240px, 320px);
  gap: 20px;
  padding: 24px;
  box-sizing: border-box;
}

.room-hero,
.chat-panel,
.room-sidebar {
  background: rgba(255, 255, 255, 0.78);
  border: 1px solid #e2d8ce;
  border-radius: 8px;
  padding: 20px;
}

.room-kicker {
  margin: 0 0 8px;
  color: #8a5a44;
  font-size: 14px;
}

h1,
h2,
p {
  margin-top: 0;
}

.portrait-placeholder {
  min-height: 420px;
  display: grid;
  place-items: center;
  align-content: center;
  gap: 10px;
  border: 1px dashed #c9b9aa;
  border-radius: 8px;
  background: #fbf8f3;
  text-align: center;
}

.portrait-placeholder span {
  font-size: 24px;
  font-weight: 700;
}

.portrait-placeholder small {
  color: #6f7579;
}

.chat-panel {
  display: grid;
  grid-template-rows: 1fr auto;
  gap: 16px;
}

.chat-timeline {
  display: flex;
  flex-direction: column;
  gap: 12px;
}

.chat-message {
  max-width: 72%;
  padding: 12px 14px;
  border-radius: 8px;
  background: #fff7ef;
}

.chat-message span {
  display: block;
  margin-bottom: 6px;
  color: #8a5a44;
  font-size: 13px;
  font-weight: 700;
}

.chat-message p {
  margin: 0;
  line-height: 1.6;
}

.chat-input {
  display: grid;
  gap: 8px;
  color: #555f67;
  font-size: 14px;
}

.chat-input textarea {
  width: 100%;
  box-sizing: border-box;
  resize: vertical;
  border: 1px solid #d8ccc0;
  border-radius: 8px;
  padding: 12px;
  font: inherit;
}

.room-sidebar {
  display: flex;
  flex-direction: column;
  gap: 16px;
}

.studio-link {
  margin-top: auto;
  display: inline-flex;
  justify-content: center;
  padding: 12px 14px;
  border-radius: 8px;
  background: #2f4b4c;
  color: #fff;
  text-decoration: none;
}

@media (max-width: 960px) {
  .room-shell {
    grid-template-columns: 1fr;
  }

  .portrait-placeholder {
    min-height: 220px;
  }
}
```

- [ ] **Step 4: Run room shell test**

Run:

```powershell
npm run test --workspace apps/web -- tests/RoomShell.test.tsx
```

Expected: PASS.

- [ ] **Step 5: Run web build**

Run:

```powershell
npm run build --workspace apps/web
```

Expected: Next.js build completes with exit code 0.

- [ ] **Step 6: Commit**

```powershell
git add apps/web/app apps/web/src/components apps/web/tests/RoomShell.test.tsx
git commit -m "feat: add chat-first Kumiko room shell"
```

---

### Task 5: Creative Archive Entry Route

**Files:**
- Create: `D:\555\codex\KumikoRoom\apps\web\src\components\StudioEntry.tsx`
- Create: `D:\555\codex\KumikoRoom\apps\web\app\studio\page.tsx`
- Create: `D:\555\codex\KumikoRoom\apps\web\tests\StudioEntry.test.tsx`

- [ ] **Step 1: Write Creative Archive test**

Create `apps/web/tests/StudioEntry.test.tsx`:

```tsx
import React from "react";
import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { StudioEntry } from "../src/components/StudioEntry";

describe("StudioEntry", () => {
  it("presents project management as KumikoRoom's internal Creative Archive", () => {
    render(<StudioEntry />);

    expect(screen.getByRole("heading", { name: "创作资料室" })).toBeTruthy();
    expect(screen.getByText("工程架")).toBeTruthy();
    expect(screen.getByText("工程档案")).toBeTruthy();
    expect(screen.getByRole("link", { name: "回到陪伴房间" })).toHaveAttribute("href", "/room");
  });
});
```

- [ ] **Step 2: Run test to verify missing component**

Run:

```powershell
npm run test --workspace apps/web -- tests/StudioEntry.test.tsx
```

Expected: FAIL with an import error for `StudioEntry`.

- [ ] **Step 3: Create StudioEntry component and route**

Create `apps/web/src/components/StudioEntry.tsx`:

```tsx
import React from "react";

const capabilities = [
  "扫描本地音乐工程",
  "整理 FLP、音频、歌词和图片",
  "查看 Demo 音频",
  "记录创作笔记"
];

export function StudioEntry() {
  return (
    <main className="studio-page">
      <a className="back-link" href="/room">
        回到陪伴房间
      </a>
      <section className="studio-header">
        <p className="room-kicker">KumikoRoom 内置功能</p>
        <h1>创作资料室</h1>
        <p>这里会承接本地工程项目、Demo 音频、歌词和创作笔记。</p>
      </section>
      <section className="studio-grid" aria-label="创作资料室入口">
        <article>
          <h2>工程架</h2>
          <p>浏览所有本地创作工程，查看状态、标签和最近修改。</p>
        </article>
        <article>
          <h2>工程档案</h2>
          <p>进入单个工程，查看主 FLP、音频 Demo、歌词和笔记。</p>
        </article>
        <article>
          <h2>下一步</h2>
          <ul>
            {capabilities.map((item) => (
              <li key={item}>{item}</li>
            ))}
          </ul>
        </article>
      </section>
    </main>
  );
}
```

Create `apps/web/app/studio/page.tsx`:

```tsx
import { StudioEntry } from "../../src/components/StudioEntry";

export default function StudioPage() {
  return <StudioEntry />;
}
```

Append this CSS to `apps/web/app/globals.css`:

```css
.studio-page {
  min-height: 100vh;
  padding: 24px;
  box-sizing: border-box;
}

.back-link {
  display: inline-flex;
  margin-bottom: 18px;
  color: #2f4b4c;
  text-decoration: none;
}

.studio-header {
  max-width: 760px;
  margin-bottom: 24px;
}

.studio-grid {
  display: grid;
  grid-template-columns: repeat(3, minmax(0, 1fr));
  gap: 16px;
}

.studio-grid article {
  min-height: 160px;
  padding: 18px;
  border: 1px solid #e2d8ce;
  border-radius: 8px;
  background: rgba(255, 255, 255, 0.78);
}

.studio-grid ul {
  margin: 0;
  padding-left: 20px;
  line-height: 1.8;
}

@media (max-width: 820px) {
  .studio-grid {
    grid-template-columns: 1fr;
  }
}
```

- [ ] **Step 4: Run Creative Archive test**

Run:

```powershell
npm run test --workspace apps/web -- tests/StudioEntry.test.tsx
```

Expected: PASS.

- [ ] **Step 5: Run all web tests**

Run:

```powershell
npm run test --workspace apps/web
```

Expected: all web tests pass.

- [ ] **Step 6: Commit**

```powershell
git add apps/web/app apps/web/src/components/StudioEntry.tsx apps/web/tests/StudioEntry.test.tsx
git commit -m "feat: add Creative Archive entry"
```

---

### Task 6: API Room Endpoints

**Files:**
- Create: `D:\555\codex\KumikoRoom\apps\api\pyproject.toml`
- Create: `D:\555\codex\KumikoRoom\apps\api\kumikoroom\__init__.py`
- Create: `D:\555\codex\KumikoRoom\apps\api\kumikoroom\main.py`
- Create: `D:\555\codex\KumikoRoom\apps\api\kumikoroom\schemas.py`
- Create: `D:\555\codex\KumikoRoom\apps\api\kumikoroom\routers\__init__.py`
- Create: `D:\555\codex\KumikoRoom\apps\api\kumikoroom\routers\room.py`
- Create: `D:\555\codex\KumikoRoom\apps\api\tests\conftest.py`
- Create: `D:\555\codex\KumikoRoom\apps\api\tests\test_room_api.py`

- [ ] **Step 1: Write API tests**

Create `apps/api/tests/test_room_api.py`:

```py
from fastapi.testclient import TestClient


def test_get_room_state(client: TestClient):
    response = client.get("/api/room/state")

    assert response.status_code == 200
    body = response.json()
    assert body["app_name"] == "KumikoRoom"
    assert body["character"]["display_name"] == "黄前久美子"
    assert body["studio"]["label"] == "创作资料室"
    assert body["studio"]["route"] == "/studio"


def test_mock_chat_reply_references_message(client: TestClient):
    response = client.post(
        "/api/room/chat",
        json={"message": "今天想听一首安静的歌"},
    )

    assert response.status_code == 200
    body = response.json()
    assert body["reply"]["role"] == "kumiko"
    assert "安静的歌" in body["reply"]["content"]
    assert body["expression"] == "listening"
```

Create `apps/api/tests/conftest.py`:

```py
from collections.abc import Generator

import pytest
from fastapi.testclient import TestClient

from kumikoroom.main import app


@pytest.fixture
def client() -> Generator[TestClient, None, None]:
    with TestClient(app) as test_client:
        yield test_client
```

- [ ] **Step 2: Run API tests to verify missing package**

Run:

```powershell
cd D:\555\codex\KumikoRoom\apps\api
python -m pytest --basetemp ..\..\..\.pytest-tmp\kumikoroom-api
```

Expected: FAIL with `ModuleNotFoundError: No module named 'kumikoroom'`.

- [ ] **Step 3: Create API package**

Create `apps/api/pyproject.toml`:

```toml
[project]
name = "kumikoroom-api"
version = "0.1.0"
requires-python = ">=3.11"
dependencies = [
  "fastapi>=0.115.0",
  "uvicorn[standard]>=0.30.0",
  "pydantic>=2.8.0"
]

[project.optional-dependencies]
dev = [
  "pytest>=8.2.0",
  "httpx>=0.27.0"
]

[tool.pytest.ini_options]
testpaths = ["tests"]
pythonpath = ["."]
```

Create `apps/api/kumikoroom/__init__.py`:

```py
__all__ = ["main"]
```

Create `apps/api/kumikoroom/schemas.py`:

```py
from pydantic import BaseModel


class CharacterStateOut(BaseModel):
    display_name: str
    romanized_name: str
    expression: str
    status_text: str


class MusicContextOut(BaseModel):
    current_track_title: str | None = None
    current_artist: str | None = None
    listening_mood: str | None = None


class StudioSummaryOut(BaseModel):
    label: str
    route: str
    unfinished_count: int


class RoomStateOut(BaseModel):
    app_name: str
    room_name: str
    character: CharacterStateOut
    music: MusicContextOut
    diary_summary: str
    inspiration_count: int
    studio: StudioSummaryOut


class ChatIn(BaseModel):
    message: str


class ChatMessageOut(BaseModel):
    id: str
    role: str
    content: str


class ChatOut(BaseModel):
    reply: ChatMessageOut
    expression: str
    suggested_actions: list[str]
```

Create `apps/api/kumikoroom/routers/__init__.py`:

```py
__all__ = ["room"]
```

Create `apps/api/kumikoroom/routers/room.py`:

```py
from fastapi import APIRouter

from kumikoroom.schemas import ChatIn, ChatMessageOut, ChatOut, RoomStateOut

router = APIRouter(prefix="/api/room", tags=["room"])


def default_room_state() -> RoomStateOut:
    return RoomStateOut(
        app_name="KumikoRoom",
        room_name="陪伴房间",
        character={
            "display_name": "黄前久美子",
            "romanized_name": "Kumiko Oumae",
            "expression": "listening",
            "status_text": "在听你今天想说的音乐",
        },
        music={
            "current_track_title": None,
            "current_artist": None,
            "listening_mood": "还没记录",
        },
        diary_summary="今天还没有写听歌日记。",
        inspiration_count=0,
        studio={
            "label": "创作资料室",
            "route": "/studio",
            "unfinished_count": 0,
        },
    )


@router.get("/state", response_model=RoomStateOut)
def get_room_state() -> RoomStateOut:
    return default_room_state()


@router.post("/chat", response_model=ChatOut)
def post_chat(payload: ChatIn) -> ChatOut:
    message = payload.message.strip()
    quoted = message if message else "今天的音乐"
    return ChatOut(
        reply=ChatMessageOut(
            id="mock-kumiko-reply",
            role="kumiko",
            content=f"嗯，我听到了。你说的是「{quoted}」。先把这句记下来也不错。",
        ),
        expression="listening",
        suggested_actions=["save_diary", "save_inspiration"],
    )
```

Create `apps/api/kumikoroom/main.py`:

```py
from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

from kumikoroom.routers import room

app = FastAPI(title="KumikoRoom API")

app.add_middleware(
    CORSMiddleware,
    allow_origins=["http://localhost:3000", "http://127.0.0.1:3000"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

app.include_router(room.router)
```

- [ ] **Step 4: Install API dependencies**

Run:

```powershell
cd D:\555\codex\KumikoRoom\apps\api
python -m venv .venv
.venv\Scripts\activate
pip install -e ".[dev]"
```

Expected: pip installs FastAPI, uvicorn, pytest, and httpx.

- [ ] **Step 5: Run API tests**

Run:

```powershell
cd D:\555\codex\KumikoRoom\apps\api
python -m pytest --basetemp ..\..\..\.pytest-tmp\kumikoroom-api
```

Expected: 2 tests pass.

- [ ] **Step 6: Commit**

```powershell
git add apps/api
git commit -m "feat: add KumikoRoom room API"
```

---

### Task 7: Web API Client

**Files:**
- Create: `D:\555\codex\KumikoRoom\apps\web\src\api\client.ts`
- Modify: `D:\555\codex\KumikoRoom\apps\web\src\components\RoomShell.tsx`
- Create: `D:\555\codex\KumikoRoom\apps\web\tests\client.test.ts`

- [ ] **Step 1: Write client tests**

Create `apps/web/tests/client.test.ts`:

```ts
import { afterEach, describe, expect, it, vi } from "vitest";
import { getRoomState, postChat } from "../src/api/client";
import { DEFAULT_ROOM_STATE } from "../src/lib/roomState";

afterEach(() => {
  vi.restoreAllMocks();
});

describe("room API client", () => {
  it("loads room state", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({
        ok: true,
        text: async () =>
          JSON.stringify({
            app_name: "KumikoRoom",
            room_name: "陪伴房间",
            character: {
              display_name: "黄前久美子",
              romanized_name: "Kumiko Oumae",
              expression: "listening",
              status_text: "在听你今天想说的音乐"
            },
            music: {
              current_track_title: null,
              current_artist: null,
              listening_mood: "还没记录"
            },
            diary_summary: "今天还没有写听歌日记。",
            inspiration_count: 0,
            studio: {
              label: "创作资料室",
              route: "/studio",
              unfinished_count: 0
            }
          })
      }))
    );

    await expect(getRoomState()).resolves.toEqual(DEFAULT_ROOM_STATE);
  });

  it("posts chat messages", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({
        ok: true,
        text: async () =>
          JSON.stringify({
            reply: { id: "1", role: "kumiko", content: "嗯，我在听。" },
            expression: "listening",
            suggested_actions: ["save_diary"]
          })
      }))
    );

    await expect(postChat({ message: "晚上好", roomState: DEFAULT_ROOM_STATE })).resolves.toMatchObject({
      reply: { role: "kumiko" },
      expression: "listening"
    });
  });
});
```

- [ ] **Step 2: Run client tests to verify missing client**

Run:

```powershell
npm run test --workspace apps/web -- tests/client.test.ts
```

Expected: FAIL with an import error for `../src/api/client`.

- [ ] **Step 3: Create API client**

Create `apps/web/src/api/client.ts`:

```ts
import type { ChatRequest, ChatResponse, RoomState } from "./types";

const API_BASE_URL = process.env.NEXT_PUBLIC_KUMIKOROOM_API_BASE_URL ?? "";

export class ApiError extends Error {
  constructor(
    message: string,
    public readonly status: number,
    public readonly body: unknown
  ) {
    super(message);
    this.name = "ApiError";
  }
}

export async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
  const headers = new Headers(init.headers);
  if (init.body !== undefined && !headers.has("Content-Type")) {
    headers.set("Content-Type", "application/json");
  }

  const response = await fetch(`${API_BASE_URL}${path}`, {
    ...init,
    headers
  });
  const body = await parseResponseBody(response);

  if (!response.ok) {
    throw new ApiError(getErrorMessage(body, response.statusText), response.status, body);
  }

  return body as T;
}

export function getRoomState(): Promise<RoomState> {
  return request<RoomStateApi>("/api/room/state").then(mapRoomState);
}

export function postChat(payload: ChatRequest): Promise<ChatResponse> {
  return request<ChatResponseApi>("/api/room/chat", {
    method: "POST",
    body: JSON.stringify({ message: payload.message })
  }).then(mapChatResponse);
}

async function parseResponseBody(response: Response): Promise<unknown> {
  const text = await response.text();
  if (!text) return undefined;

  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

function getErrorMessage(body: unknown, fallback: string): string {
  if (body && typeof body === "object" && "detail" in body) {
    const detail = (body as { detail: unknown }).detail;
    if (typeof detail === "string") return detail;
  }
  return fallback || "请求失败";
}

interface RoomStateApi {
  app_name: string;
  room_name: string;
  character: {
    display_name: string;
    romanized_name: string;
    expression: RoomState["character"]["expression"];
    status_text: string;
  };
  music: {
    current_track_title: string | null;
    current_artist: string | null;
    listening_mood: string | null;
  };
  diary_summary: string;
  inspiration_count: number;
  studio: {
    label: string;
    route: string;
    unfinished_count: number;
  };
}

interface ChatResponseApi {
  reply: ChatResponse["reply"];
  expression: ChatResponse["expression"];
  suggested_actions: ChatResponse["suggestedActions"];
}

function mapRoomState(value: RoomStateApi): RoomState {
  return {
    appName: value.app_name,
    roomName: value.room_name,
    character: {
      displayName: value.character.display_name,
      romanizedName: value.character.romanized_name,
      expression: value.character.expression,
      statusText: value.character.status_text
    },
    music: {
      currentTrackTitle: value.music.current_track_title,
      currentArtist: value.music.current_artist,
      listeningMood: value.music.listening_mood
    },
    diarySummary: value.diary_summary,
    inspirationCount: value.inspiration_count,
    studio: {
      label: value.studio.label,
      route: value.studio.route,
      unfinishedCount: value.studio.unfinished_count
    }
  };
}

function mapChatResponse(value: ChatResponseApi): ChatResponse {
  return {
    reply: value.reply,
    expression: value.expression,
    suggestedActions: value.suggested_actions
  };
}
```

- [ ] **Step 4: Run client tests**

Run:

```powershell
npm run test --workspace apps/web -- tests/client.test.ts
```

Expected: PASS.

- [ ] **Step 5: Run all web tests**

Run:

```powershell
npm run test --workspace apps/web
```

Expected: all web tests pass.

- [ ] **Step 6: Commit**

```powershell
git add apps/web/src/api apps/web/tests/client.test.ts
git commit -m "feat: add KumikoRoom web API client"
```

---

### Task 8: Desktop Shell

**Files:**
- Create: `D:\555\codex\KumikoRoom\apps\desktop\package.json`
- Create: `D:\555\codex\KumikoRoom\apps\desktop\tsconfig.json`
- Create: `D:\555\codex\KumikoRoom\apps\desktop\src\config.ts`
- Create: `D:\555\codex\KumikoRoom\apps\desktop\src\main.ts`
- Create: `D:\555\codex\KumikoRoom\apps\desktop\tests\config.test.ts`

- [ ] **Step 1: Write desktop config tests**

Create `apps/desktop/tests/config.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { DEFAULT_WEB_URL, getWebUrl, windowOptions } from "../src/config";

describe("desktop config", () => {
  it("uses the KumikoRoom default web URL", () => {
    expect(DEFAULT_WEB_URL).toBe("http://127.0.0.1:3000/room");
  });

  it("allows a custom web URL", () => {
    expect(getWebUrl({ KUMIKOROOM_WEB_URL: "http://127.0.0.1:3010/room" })).toBe("http://127.0.0.1:3010/room");
  });

  it("uses KumikoRoom as window title", () => {
    expect(windowOptions.title).toBe("KumikoRoom");
  });
});
```

- [ ] **Step 2: Create desktop package and config**

Create `apps/desktop/package.json`:

```json
{
  "name": "@kumikoroom/desktop",
  "version": "0.1.0",
  "private": true,
  "main": "dist/src/main.js",
  "scripts": {
    "build": "tsc -p tsconfig.json",
    "start": "npm run build && electron .",
    "test": "vitest run"
  },
  "dependencies": {
    "electron": "^31.0.0"
  },
  "devDependencies": {
    "@types/node": "^20.12.0",
    "typescript": "^5.4.0",
    "vitest": "^1.5.0"
  }
}
```

Create `apps/desktop/tsconfig.json`:

```json
{
  "compilerOptions": {
    "target": "ES2020",
    "module": "CommonJS",
    "moduleResolution": "Node",
    "strict": true,
    "esModuleInterop": true,
    "outDir": "dist",
    "rootDir": ".",
    "types": ["node"]
  },
  "include": ["src/**/*.ts", "tests/**/*.ts"]
}
```

Create `apps/desktop/src/config.ts`:

```ts
import type { BrowserWindowConstructorOptions } from "electron";

export const DEFAULT_WEB_URL = "http://127.0.0.1:3000/room";

export function getWebUrl(env: NodeJS.ProcessEnv): string {
  const configured = env.KUMIKOROOM_WEB_URL?.trim();
  return configured && configured.length > 0 ? configured : DEFAULT_WEB_URL;
}

export const windowOptions = {
  width: 1280,
  height: 820,
  minWidth: 1024,
  minHeight: 680,
  backgroundColor: "#f7f3ee",
  title: "KumikoRoom",
  show: false
} satisfies BrowserWindowConstructorOptions;
```

Create `apps/desktop/src/main.ts`:

```ts
import { app, BrowserWindow, Menu, shell } from "electron";
import { getWebUrl, windowOptions } from "./config";

let mainWindow: BrowserWindow | null = null;

function fallbackHtml(webUrl: string): string {
  return `
    <!doctype html>
    <html lang="zh-CN">
      <head>
        <meta charset="UTF-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1.0" />
        <title>KumikoRoom 启动失败</title>
      </head>
      <body>
        <main style="font-family: Microsoft YaHei, Segoe UI, sans-serif; padding: 32px;">
          <h1>KumikoRoom 还没有连上陪伴房间</h1>
          <p>请先启动 web 服务，然后重新打开桌面端。</p>
          <p>当前连接地址：<code>${webUrl}</code></p>
        </main>
      </body>
    </html>
  `;
}

function installMenu(): void {
  Menu.setApplicationMenu(
    Menu.buildFromTemplate([
      {
        label: "KumikoRoom",
        submenu: [
          { label: "刷新", accelerator: "CmdOrCtrl+R", role: "reload" },
          { label: "开发者工具", accelerator: "F12", role: "toggleDevTools" },
          { type: "separator" },
          { label: "退出", accelerator: "CmdOrCtrl+Q", role: "quit" }
        ]
      }
    ])
  );
}

async function createWindow(): Promise<void> {
  const webUrl = getWebUrl(process.env);
  mainWindow = new BrowserWindow(windowOptions);

  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    void shell.openExternal(url);
    return { action: "deny" };
  });

  mainWindow.once("ready-to-show", () => {
    mainWindow?.show();
  });

  try {
    await mainWindow.loadURL(webUrl);
  } catch {
    await mainWindow.loadURL(`data:text/html;charset=UTF-8,${encodeURIComponent(fallbackHtml(webUrl))}`);
  }
}

app.whenReady().then(async () => {
  installMenu();
  await createWindow();

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      void createWindow();
    }
  });
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") {
    app.quit();
  }
});
```

- [ ] **Step 3: Install desktop dependencies**

Run:

```powershell
npm install --workspace apps/desktop
```

Expected: Electron, TypeScript, and Vitest are installed for the workspace.

- [ ] **Step 4: Run desktop tests**

Run:

```powershell
npm run test --workspace apps/desktop
```

Expected: desktop config tests pass.

- [ ] **Step 5: Build desktop shell**

Run:

```powershell
npm run build --workspace apps/desktop
```

Expected: TypeScript build completes with exit code 0.

- [ ] **Step 6: Commit**

```powershell
git add apps/desktop package-lock.json package.json
git commit -m "feat: add KumikoRoom desktop shell"
```

---

### Task 9: End-to-End Verification Pass

**Files:**
- Modify only if verification reveals a concrete failure in files created by earlier tasks.

- [ ] **Step 1: Run web tests**

Run:

```powershell
cd D:\555\codex\KumikoRoom
npm run test --workspace apps/web
```

Expected: all web tests pass.

- [ ] **Step 2: Run API tests**

Run:

```powershell
cd D:\555\codex\KumikoRoom\apps\api
python -m pytest --basetemp ..\..\..\.pytest-tmp\kumikoroom-api
```

Expected: all API tests pass.

- [ ] **Step 3: Run desktop tests**

Run:

```powershell
cd D:\555\codex\KumikoRoom
npm run test --workspace apps/desktop
```

Expected: all desktop tests pass.

- [ ] **Step 4: Run builds**

Run:

```powershell
cd D:\555\codex\KumikoRoom
npm run build --workspace apps/web
npm run build --workspace apps/desktop
```

Expected: both builds complete with exit code 0.

- [ ] **Step 5: Manual smoke check**

Run the API:

```powershell
cd D:\555\codex\KumikoRoom\apps\api
.venv\Scripts\activate
uvicorn kumikoroom.main:app --host 127.0.0.1 --port 8000
```

In another PowerShell, run the web app:

```powershell
cd D:\555\codex\KumikoRoom
npm run dev:web -- --hostname 127.0.0.1 --port 3000
```

Open:

```text
http://127.0.0.1:3000/room
```

Expected:

- Page title shows KumikoRoom.
- The room shell renders.
- The Studio link opens `/studio`.
- `/studio` shows 创作资料室 and a link back to `/room`.

- [ ] **Step 6: Commit verification fixes**

If Step 1-5 required any corrections:

```powershell
git add .
git commit -m "fix: stabilize KumikoRoom foundation"
```

If no files changed, skip this commit.

---

## Self-Review

Spec coverage:

- KumikoRoom as top-level app: covered by Tasks 1, 2, 4, and 8.
- Chat-first room shell: covered by Tasks 3 and 4.
- Room-style visual structure: covered by Task 4 CSS and component layout.
- Creative Archive as internal module: covered by Tasks 3 and 5.
- MuseFlow name deprecation in the new project: covered by Task 2 naming test.
- Mock AI flow foundation: covered by Tasks 6 and 7.
- Desktop shell foundation: covered by Task 8.
- Desktop pet: intentionally deferred into a later plan with shared state preserved by Tasks 3 and 8.
- TTS and local assets: intentionally deferred into later plans; current plan leaves room state and API boundaries for those integrations.

Placeholder scan:

- No `TBD`, `TODO`, or open-ended implementation instructions remain.
- Commands include expected outcomes.
- Code-bearing steps include concrete code blocks.

Type consistency:

- Web `RoomState`, `ChatRequest`, and `ChatResponse` types match the client and component usage.
- API field names use snake_case for JSON responses, and `apps/web/src/api/client.ts` maps them into the web camelCase model.

Integration note:

- This plan builds the first independent KumikoRoom foundation. Migrate the existing project-management app after this foundation is verified.

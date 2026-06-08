# Live2D Room Character Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a local-asset-backed Live2D character area to `/room`, wired to the existing Kumiko expression state, with graceful fallback when no model is available.

**Architecture:** Keep Live2D behind a small client-only `Live2DViewer` boundary. Add typed local model config, a guarded local-asset route for `user-data`, and a `CharacterStage` component that owns fallback UI, expression labels, and future desktop pet state handoff.

**Tech Stack:** Next.js 14 App Router, React 18, TypeScript, Vitest, Testing Library, `pixi-live2d-display@0.4.0`, Pixi v6 packages, local files under ignored `user-data/`.

---

## Context

Read these before executing:

- Spec: `docs/superpowers/specs/2026-06-08-live2d-room-character-design.md`
- Current room component: `apps/web/src/components/RoomShell.tsx`
- Current room types: `apps/web/src/api/types.ts`
- Current room state: `apps/web/src/lib/roomState.ts`
- Current global styles: `apps/web/app/globals.css`
- Current room tests: `apps/web/tests/RoomShell.test.tsx`

External references checked on 2026-06-08:

- Live2D Cubism SDK for Web manual: https://docs.live2d.com/en/cubism-sdk-manual/cubism-sdk-for-web/
- Live2D Web model loading manual: https://docs.live2d.com/4.2/en/cubism-sdk-manual/model-web/
- `pixi-live2d-display` package docs: https://www.npmjs.com/package/pixi-live2d-display

Important runtime note: `pixi-live2d-display` needs Cubism Core for Cubism 3/4 models. The user should place `live2dcubismcore.min.js` locally under `user-data/characters/kumiko/live2d/`; do not commit it.

## File Structure

Create or modify these files:

- Modify: `apps/web/tests/design-tokens.test.ts`
  - Normalize CSS line endings so existing tests are stable on Windows.
- Modify: `apps/web/src/api/types.ts`
  - Add Live2D config and character visual state types.
- Create: `apps/web/src/lib/live2dConfig.ts`
  - Parse and validate local Live2D config values.
- Test: `apps/web/tests/live2dConfig.test.ts`
  - Cover valid config, unsafe URLs, and missing expression entries.
- Create: `apps/web/src/lib/localAssets.ts`
  - Resolve guarded file paths under `user-data`.
- Create: `apps/web/app/api/local-assets/[...path]/route.ts`
  - Serve local model JSON, textures, motions, and Cubism Core files through a safe route.
- Test: `apps/web/tests/local-assets-route.test.ts`
  - Cover serving allowed files, rejecting traversal, and missing files.
- Create: `apps/web/src/lib/characterVisualState.ts`
  - Derive visual state from room state and latest Kumiko line.
- Create: `apps/web/src/components/Live2DViewer.tsx`
  - Provide the client-only runtime boundary.
- Create: `apps/web/src/components/CharacterStage.tsx`
  - Render the character area, fallback UI, load state, and expression labels.
- Test: `apps/web/tests/CharacterStage.test.tsx`
  - Cover fallback, viewer props, expression updates, and load failure.
- Modify: `apps/web/src/components/RoomShell.tsx`
  - Add `CharacterStage`, current Kumiko line tracking, and three-zone layout.
- Modify: `apps/web/tests/RoomShell.test.tsx`
  - Update expectations for the new character area while preserving chat behavior.
- Modify: `apps/web/app/globals.css`
  - Add character area layout and responsive behavior.
- Modify: `apps/web/package.json`
  - Add compatible Live2D/Pixi runtime dependencies.
- Modify: `package-lock.json`
  - Record dependency versions.
- Create: `docs/live2d-local-assets.md`
  - Document local asset setup.
- Modify: `README.md`
  - Link the local asset setup guide.

---

### Task 1: Stabilize The Existing CSS Test

**Files:**
- Modify: `apps/web/tests/design-tokens.test.ts`

- [ ] **Step 1: Run the currently brittle test**

Run:

```powershell
npm run test --workspace apps/web -- tests/design-tokens.test.ts
```

Expected: FAIL on Windows when the assertion looks for `\n` while `globals.css` is read with `\r\n`.

- [ ] **Step 2: Normalize CSS line endings inside the test**

Replace `apps/web/tests/design-tokens.test.ts` with:

```ts
import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const cssPath = path.resolve(__dirname, "../app/globals.css");

function readCss(): string {
  return fs.readFileSync(cssPath, "utf8").replace(/\r\n/g, "\n");
}

describe("approved Palette C tokens", () => {
  it("uses the warm rose fog palette tokens", () => {
    const css = readCss();

    expect(css).toContain("--color-bg: #fafaf8");
    expect(css).toContain("--color-text: #3f3a3d");
    expect(css).toContain("--color-muted: #756f73");
    expect(css).toContain("--color-rose: #a95568");
    expect(css).toContain("--color-rose-soft: #f5e4e8");
    expect(css).toContain("--color-fog-soft: #eef4f7");
  });

  it("keeps legacy room variable aliases mapped to Palette C values", () => {
    const css = readCss();

    expect(css).toContain("--paper: var(--color-surface-strong);");
    expect(css).toContain("--paper-soft: var(--color-surface);");
    expect(css).toContain("--ink: var(--color-text);");
    expect(css).toContain("--muted: var(--color-muted);");
    expect(css).toContain("--line: var(--color-line);");
    expect(css).toContain("--green: #587080;");
    expect(css).toContain("--red: var(--color-rose);");
    expect(css).toContain("--gold: var(--color-rose-mid);");
    expect(css).toContain("--blue: #587080;");
  });

  it("covers all dynamic connection tone selectors", () => {
    const css = readCss();

    [
      "connection-chip--muted",
      "connection-chip--ready",
      "connection-chip--warning",
      "connection-pill--muted",
      "connection-pill--ready",
      "connection-pill--warning"
    ].forEach((selector) => {
      expect(css).toContain(`.${selector}`);
    });
  });

  it("keeps the room composer visible in the first viewport", () => {
    const css = readCss();

    expect(css).toContain(".dialogue-card {\n  height: calc(100vh - 64px);");
    expect(css).toContain("overflow: hidden;");
    expect(css).toContain(".chat-timeline {\n  min-height: 0;");
    expect(css).toContain(".chat-composer {\n  flex: 0 0 auto;");
  });

  it("removes the old green and brass room palette values", () => {
    const css = readCss();

    expect(css).not.toContain("--brass:");
    expect(css).not.toContain("#385b68");
    expect(css).not.toContain("#e6ddcf");
    expect(css).not.toContain("#315c54");
    expect(css).not.toContain("#8d3f3f");
    expect(css).not.toContain("#b8894a");
    expect(css).not.toContain("#405a72");
    expect(css).not.toContain("#252b2b");
    expect(css).not.toContain("49, 92, 84");
    expect(css).not.toContain("64, 90, 114");
    expect(css).not.toContain("255, 253, 248");
    expect(css).not.toContain("248, 245, 238");
    expect(css).not.toContain("238, 232, 218");
  });
});
```

- [ ] **Step 3: Verify the focused test passes**

Run:

```powershell
npm run test --workspace apps/web -- tests/design-tokens.test.ts
```

Expected: PASS.

- [ ] **Step 4: Commit**

```powershell
git add apps/web/tests/design-tokens.test.ts
git commit -m "test: stabilize design token line endings"
```

---

### Task 2: Add Live2D Types And Config Parsing

**Files:**
- Modify: `apps/web/src/api/types.ts`
- Create: `apps/web/src/lib/live2dConfig.ts`
- Test: `apps/web/tests/live2dConfig.test.ts`

- [ ] **Step 1: Write the failing config tests**

Create `apps/web/tests/live2dConfig.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { parseLive2DCharacterConfig } from "../src/lib/live2dConfig";

describe("parseLive2DCharacterConfig", () => {
  it("accepts a local Kumiko Live2D config", () => {
    const config = parseLive2DCharacterConfig({
      modelUrl: "/api/local-assets/characters/kumiko/live2d/model.model3.json",
      cubismCoreUrl: "/api/local-assets/characters/kumiko/live2d/live2dcubismcore.min.js",
      expressionMap: {
        neutral: { expression: "neutral" },
        listening: { motionGroup: "idle" },
        thinking: { expression: "thinking" },
        encouraging: { expression: "smile", motionGroup: "tap", motionIndex: 0 }
      }
    });

    expect(config).toEqual({
      modelUrl: "/api/local-assets/characters/kumiko/live2d/model.model3.json",
      cubismCoreUrl: "/api/local-assets/characters/kumiko/live2d/live2dcubismcore.min.js",
      expressionMap: {
        neutral: { expression: "neutral" },
        listening: { motionGroup: "idle" },
        thinking: { expression: "thinking" },
        encouraging: { expression: "smile", motionGroup: "tap", motionIndex: 0 }
      }
    });
  });

  it("rejects external and traversal model URLs", () => {
    expect(
      parseLive2DCharacterConfig({
        modelUrl: "https://example.com/model.model3.json",
        expressionMap: {}
      })
    ).toBeNull();

    expect(
      parseLive2DCharacterConfig({
        modelUrl: "/api/local-assets/characters/kumiko/live2d/../secret.model3.json",
        expressionMap: {}
      })
    ).toBeNull();
  });

  it("drops expression entries that have no usable target", () => {
    const config = parseLive2DCharacterConfig({
      modelUrl: "/api/local-assets/characters/kumiko/live2d/model.model3.json",
      expressionMap: {
        neutral: {},
        listening: { motionGroup: "idle" },
        thinking: { expression: "" },
        encouraging: { motionIndex: -1 }
      }
    });

    expect(config?.expressionMap).toEqual({
      listening: { motionGroup: "idle" }
    });
  });
});
```

- [ ] **Step 2: Run the config tests and verify they fail**

Run:

```powershell
npm run test --workspace apps/web -- tests/live2dConfig.test.ts
```

Expected: FAIL because `../src/lib/live2dConfig` does not exist.

- [ ] **Step 3: Add Live2D types**

Modify the top portion of `apps/web/src/api/types.ts` to introduce shared expression and Live2D types:

```ts
export type CharacterExpression = "neutral" | "listening" | "thinking" | "encouraging";

export interface Live2DExpressionTarget {
  expression?: string;
  motionGroup?: string;
  motionIndex?: number;
}

export interface Live2DCharacterConfig {
  modelUrl: string;
  cubismCoreUrl?: string;
  expressionMap: Partial<Record<CharacterExpression, Live2DExpressionTarget>>;
}

export interface CharacterState {
  displayName: string;
  romanizedName: string;
  expression: CharacterExpression;
  statusText: string;
  live2d?: Live2DCharacterConfig;
}

export interface CharacterVisualState {
  displayName: string;
  romanizedName: string;
  expression: CharacterExpression;
  statusText: string;
  currentLine: string | null;
  live2d?: Live2DCharacterConfig;
}
```

Keep the rest of `apps/web/src/api/types.ts` as it is, with `ChatResponse.expression` still typed from `CharacterState["expression"]`.

- [ ] **Step 4: Add the parser implementation**

Create `apps/web/src/lib/live2dConfig.ts`:

```ts
import type {
  CharacterExpression,
  Live2DCharacterConfig,
  Live2DExpressionTarget
} from "../api/types";

const SAFE_LIVE2D_PREFIX = "/api/local-assets/characters/kumiko/live2d/";
const EXPRESSIONS: CharacterExpression[] = ["neutral", "listening", "thinking", "encouraging"];

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function isSafeLive2DAssetUrl(value: unknown): value is string {
  if (typeof value !== "string") return false;
  if (!value.startsWith(SAFE_LIVE2D_PREFIX)) return false;
  if (value.includes("..")) return false;
  if (value.includes("\\")) return false;
  return value.length > SAFE_LIVE2D_PREFIX.length;
}

function parseTarget(value: unknown): Live2DExpressionTarget | null {
  if (!isRecord(value)) return null;

  const target: Live2DExpressionTarget = {};

  if (typeof value.expression === "string" && value.expression.trim().length > 0) {
    target.expression = value.expression.trim();
  }

  if (typeof value.motionGroup === "string" && value.motionGroup.trim().length > 0) {
    target.motionGroup = value.motionGroup.trim();
  }

  if (Number.isInteger(value.motionIndex) && Number(value.motionIndex) >= 0) {
    target.motionIndex = Number(value.motionIndex);
  }

  return target.expression || target.motionGroup ? target : null;
}

function parseExpressionMap(value: unknown): Live2DCharacterConfig["expressionMap"] {
  if (!isRecord(value)) return {};

  return EXPRESSIONS.reduce<Live2DCharacterConfig["expressionMap"]>((result, expression) => {
    const target = parseTarget(value[expression]);
    if (target) {
      result[expression] = target;
    }
    return result;
  }, {});
}

export function parseLive2DCharacterConfig(value: unknown): Live2DCharacterConfig | null {
  if (!isRecord(value)) return null;
  if (!isSafeLive2DAssetUrl(value.modelUrl)) return null;
  if (value.cubismCoreUrl !== undefined && !isSafeLive2DAssetUrl(value.cubismCoreUrl)) {
    return null;
  }

  return {
    modelUrl: value.modelUrl,
    cubismCoreUrl: typeof value.cubismCoreUrl === "string" ? value.cubismCoreUrl : undefined,
    expressionMap: parseExpressionMap(value.expressionMap)
  };
}
```

- [ ] **Step 5: Verify the config tests pass**

Run:

```powershell
npm run test --workspace apps/web -- tests/live2dConfig.test.ts
```

Expected: PASS.

- [ ] **Step 6: Commit**

```powershell
git add apps/web/src/api/types.ts apps/web/src/lib/live2dConfig.ts apps/web/tests/live2dConfig.test.ts
git commit -m "feat: add live2d character config parsing"
```

---

### Task 3: Serve Local Assets From `user-data`

**Files:**
- Create: `apps/web/src/lib/localAssets.ts`
- Create: `apps/web/app/api/local-assets/[...path]/route.ts`
- Test: `apps/web/tests/local-assets-route.test.ts`

- [ ] **Step 1: Write the local asset route tests**

Create `apps/web/tests/local-assets-route.test.ts`:

```ts
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { GET } from "../app/api/local-assets/[...path]/route";

let tempRoot: string;
const originalUserDataDir = process.env.KUMIKOROOM_USER_DATA_DIR;

async function callAssetRoute(segments: string[]) {
  return GET(new Request("http://localhost/api/local-assets/" + segments.join("/")), {
    params: { path: segments }
  });
}

describe("local asset route", () => {
  beforeEach(async () => {
    tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "kumikoroom-assets-"));
    process.env.KUMIKOROOM_USER_DATA_DIR = tempRoot;
  });

  afterEach(async () => {
    process.env.KUMIKOROOM_USER_DATA_DIR = originalUserDataDir;
    await fs.rm(tempRoot, { recursive: true, force: true });
  });

  it("serves files from the configured user-data directory", async () => {
    const modelPath = path.join(tempRoot, "characters", "kumiko", "live2d", "model.model3.json");
    await fs.mkdir(path.dirname(modelPath), { recursive: true });
    await fs.writeFile(modelPath, JSON.stringify({ Version: 3 }), "utf8");

    const response = await callAssetRoute(["characters", "kumiko", "live2d", "model.model3.json"]);

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("application/json");
    expect(await response.json()).toEqual({ Version: 3 });
  });

  it("rejects traversal path segments", async () => {
    const response = await callAssetRoute(["characters", "..", "secret.txt"]);

    expect(response.status).toBe(400);
    expect(await response.text()).toBe("Invalid local asset path");
  });

  it("returns 404 for missing files", async () => {
    const response = await callAssetRoute(["characters", "kumiko", "live2d", "missing.model3.json"]);

    expect(response.status).toBe(404);
    expect(await response.text()).toBe("Local asset not found");
  });
});
```

- [ ] **Step 2: Run the route tests and verify they fail**

Run:

```powershell
npm run test --workspace apps/web -- tests/local-assets-route.test.ts
```

Expected: FAIL because the route module does not exist.

- [ ] **Step 3: Add path resolution and MIME helpers**

Create `apps/web/src/lib/localAssets.ts`:

```ts
import path from "node:path";

const MIME_TYPES: Record<string, string> = {
  ".json": "application/json",
  ".moc3": "application/octet-stream",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".motion3.json": "application/json",
  ".exp3.json": "application/json",
  ".physics3.json": "application/json",
  ".js": "application/javascript"
};

function defaultUserDataRoot(): string {
  return path.resolve(process.cwd(), "../..", "user-data");
}

function isSafeSegment(segment: string): boolean {
  if (segment.length === 0) return false;
  if (segment === "." || segment === "..") return false;
  if (segment.startsWith(".")) return false;
  if (segment.includes("/") || segment.includes("\\")) return false;
  return true;
}

export function getUserDataRoot(env: NodeJS.ProcessEnv = process.env): string {
  return path.resolve(env.KUMIKOROOM_USER_DATA_DIR ?? defaultUserDataRoot());
}

export function resolveLocalAssetPath(
  segments: string[] | undefined,
  env: NodeJS.ProcessEnv = process.env
): string | null {
  if (!segments || segments.length === 0) return null;
  if (!segments.every(isSafeSegment)) return null;

  const root = getUserDataRoot(env);
  const target = path.resolve(root, ...segments);
  const allowedPrefix = root.endsWith(path.sep) ? root : root + path.sep;

  if (!target.startsWith(allowedPrefix)) return null;
  return target;
}

export function mimeTypeForLocalAsset(filePath: string): string {
  const normalized = filePath.toLowerCase();
  const multiPartMatch = Object.keys(MIME_TYPES).find((extension) => normalized.endsWith(extension));
  return multiPartMatch ? MIME_TYPES[multiPartMatch] : "application/octet-stream";
}
```

- [ ] **Step 4: Add the route**

Create `apps/web/app/api/local-assets/[...path]/route.ts`:

```ts
import fs from "node:fs/promises";
import { mimeTypeForLocalAsset, resolveLocalAssetPath } from "../../../../src/lib/localAssets";

export const runtime = "nodejs";

interface RouteContext {
  params: {
    path?: string[];
  };
}

export async function GET(_request: Request, context: RouteContext): Promise<Response> {
  const targetPath = resolveLocalAssetPath(context.params.path);

  if (!targetPath) {
    return new Response("Invalid local asset path", { status: 400 });
  }

  try {
    const file = await fs.readFile(targetPath);

    return new Response(new Uint8Array(file), {
      status: 200,
      headers: {
        "cache-control": "no-store",
        "content-type": mimeTypeForLocalAsset(targetPath)
      }
    });
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") {
      return new Response("Local asset not found", { status: 404 });
    }

    return new Response("Could not read local asset", { status: 500 });
  }
}
```

- [ ] **Step 5: Verify the route tests pass**

Run:

```powershell
npm run test --workspace apps/web -- tests/local-assets-route.test.ts
```

Expected: PASS.

- [ ] **Step 6: Commit**

```powershell
git add apps/web/src/lib/localAssets.ts apps/web/app/api/local-assets/[...path]/route.ts apps/web/tests/local-assets-route.test.ts
git commit -m "feat: serve local character assets"
```

---

### Task 4: Add Character Visual State And Character Stage

**Files:**
- Create: `apps/web/src/lib/characterVisualState.ts`
- Create: `apps/web/src/components/Live2DViewer.tsx`
- Create: `apps/web/src/components/CharacterStage.tsx`
- Test: `apps/web/tests/CharacterStage.test.tsx`

- [ ] **Step 1: Write the CharacterStage tests**

Create `apps/web/tests/CharacterStage.test.tsx`:

```tsx
import { render, screen } from "@testing-library/react";
import { useEffect } from "react";
import { describe, expect, it } from "vitest";
import { CharacterStage } from "../src/components/CharacterStage";
import type { Live2DViewerProps } from "../src/components/Live2DViewer";
import type { CharacterVisualState } from "../src/api/types";

const baseState: CharacterVisualState = {
  displayName: "黄前久美子",
  romanizedName: "Kumiko Oumae",
  expression: "listening",
  statusText: "正在听你今天想说的音乐",
  currentLine: "今天想从哪首歌开始聊？"
};

function ViewerProbe(props: Live2DViewerProps) {
  return (
    <div data-testid="live2d-viewer">
      {props.modelUrl}|{props.expression}|{props.target?.expression ?? props.target?.motionGroup}
    </div>
  );
}

function FailingViewer(props: Live2DViewerProps) {
  useEffect(() => {
    props.onError("模型加载失败");
  }, [props]);

  return <div data-testid="live2d-viewer">failed viewer</div>;
}

describe("CharacterStage", () => {
  it("renders fallback state when Live2D config is absent", () => {
    render(<CharacterStage visualState={baseState} />);

    const stage = screen.getByLabelText("久美子角色状态");
    expect(stage.textContent).toContain("黄前久美子");
    expect(stage.textContent).toContain("倾听");
    expect(stage.textContent).toContain("Live2D 模型未配置");
    expect(stage.textContent).toContain("今天想从哪首歌开始聊？");
    expect(screen.queryByTestId("live2d-viewer")).toBeNull();
  });

  it("passes model config and expression target into the viewer", () => {
    render(
      <CharacterStage
        visualState={{
          ...baseState,
          expression: "thinking",
          live2d: {
            modelUrl: "/api/local-assets/characters/kumiko/live2d/model.model3.json",
            expressionMap: {
              thinking: { expression: "thinking" }
            }
          }
        }}
        viewerComponent={ViewerProbe}
      />
    );

    expect(screen.getByTestId("live2d-viewer").textContent).toBe(
      "/api/local-assets/characters/kumiko/live2d/model.model3.json|thinking|thinking"
    );
    expect(screen.getByText("思考")).toBeTruthy();
  });

  it("shows a soft load failure message while preserving character state", async () => {
    render(
      <CharacterStage
        visualState={{
          ...baseState,
          live2d: {
            modelUrl: "/api/local-assets/characters/kumiko/live2d/model.model3.json",
            expressionMap: {}
          }
        }}
        viewerComponent={FailingViewer}
      />
    );

    expect(await screen.findByText("模型加载失败")).toBeTruthy();
    expect(screen.getByLabelText("久美子角色状态").textContent).toContain("黄前久美子");
  });
});
```

- [ ] **Step 2: Run the CharacterStage tests and verify they fail**

Run:

```powershell
npm run test --workspace apps/web -- tests/CharacterStage.test.tsx
```

Expected: FAIL because `CharacterStage` and `Live2DViewer` do not exist.

- [ ] **Step 3: Add visual state derivation**

Create `apps/web/src/lib/characterVisualState.ts`:

```ts
import type { CharacterState, CharacterVisualState } from "../api/types";

export function createCharacterVisualState(
  character: CharacterState,
  currentLine: string | null
): CharacterVisualState {
  return {
    displayName: character.displayName,
    romanizedName: character.romanizedName,
    expression: character.expression,
    statusText: character.statusText,
    currentLine,
    live2d: character.live2d
  };
}
```

- [ ] **Step 4: Add a client-only viewer boundary**

Create `apps/web/src/components/Live2DViewer.tsx`:

```tsx
"use client";

import { useEffect } from "react";
import type { CharacterExpression, Live2DExpressionTarget } from "../api/types";

export type Live2DLoadState = "idle" | "loading" | "ready" | "failed";

export interface Live2DViewerProps {
  modelUrl: string;
  cubismCoreUrl?: string;
  expression: CharacterExpression;
  target?: Live2DExpressionTarget;
  onLoadStateChange: (state: Live2DLoadState) => void;
  onError: (message: string) => void;
}

export function Live2DViewer({
  modelUrl,
  expression,
  onLoadStateChange,
  onError
}: Live2DViewerProps) {
  useEffect(() => {
    onLoadStateChange("failed");
    onError("Live2D runtime is not installed yet.");
  }, [onError, onLoadStateChange]);

  return (
    <div
      className="live2d-viewer"
      data-expression={expression}
      data-model-url={modelUrl}
      aria-hidden="true"
    />
  );
}
```

- [ ] **Step 5: Add the CharacterStage component**

Create `apps/web/src/components/CharacterStage.tsx`:

```tsx
"use client";

import { ComponentType, useMemo, useState } from "react";
import type { CharacterExpression, CharacterVisualState } from "../api/types";
import { Live2DViewer, type Live2DLoadState, type Live2DViewerProps } from "./Live2DViewer";

interface CharacterStageProps {
  visualState: CharacterVisualState;
  viewerComponent?: ComponentType<Live2DViewerProps>;
}

const expressionLabel: Record<CharacterExpression, string> = {
  neutral: "平静",
  listening: "倾听",
  thinking: "思考",
  encouraging: "鼓励"
};

function loadStateLabel(state: Live2DLoadState): string {
  switch (state) {
    case "loading":
      return "模型加载中";
    case "ready":
      return "模型已就绪";
    case "failed":
      return "模型未载入";
    default:
      return "本地模型";
  }
}

export function CharacterStage({ visualState, viewerComponent }: CharacterStageProps) {
  const Viewer = viewerComponent ?? Live2DViewer;
  const [loadState, setLoadState] = useState<Live2DLoadState>(visualState.live2d ? "loading" : "idle");
  const [loadError, setLoadError] = useState<string | null>(null);
  const target = visualState.live2d?.expressionMap[visualState.expression];

  const stageLine = useMemo(() => {
    return visualState.currentLine ?? visualState.statusText;
  }, [visualState.currentLine, visualState.statusText]);

  return (
    <aside className="workspace-card character-card" aria-label="久美子角色状态">
      <header className="panel-heading">
        <div>
          <p className="eyebrow">Character</p>
          <h2>{visualState.displayName}</h2>
        </div>
        <span className="soft-badge">{expressionLabel[visualState.expression]}</span>
      </header>

      <div className="character-stage__viewer-shell">
        {visualState.live2d ? (
          <Viewer
            modelUrl={visualState.live2d.modelUrl}
            cubismCoreUrl={visualState.live2d.cubismCoreUrl}
            expression={visualState.expression}
            target={target}
            onLoadStateChange={setLoadState}
            onError={(message) => {
              setLoadState("failed");
              setLoadError(message);
            }}
          />
        ) : (
          <div className="character-stage__fallback">
            <strong>Live2D 模型未配置</strong>
            <span>把本地模型放到 user-data 后，这里会显示角色。</span>
          </div>
        )}
      </div>

      <div className="character-stage__status">
        <span>{loadStateLabel(loadState)}</span>
        <p>{loadError ?? stageLine}</p>
      </div>
    </aside>
  );
}
```

- [ ] **Step 6: Verify the CharacterStage tests pass**

Run:

```powershell
npm run test --workspace apps/web -- tests/CharacterStage.test.tsx
```

Expected: PASS.

- [ ] **Step 7: Commit**

```powershell
git add apps/web/src/lib/characterVisualState.ts apps/web/src/components/Live2DViewer.tsx apps/web/src/components/CharacterStage.tsx apps/web/tests/CharacterStage.test.tsx
git commit -m "feat: add character stage fallback"
```

---

### Task 5: Wire CharacterStage Into RoomShell

**Files:**
- Modify: `apps/web/src/components/RoomShell.tsx`
- Modify: `apps/web/tests/RoomShell.test.tsx`

- [ ] **Step 1: Update RoomShell tests for the character area**

In `apps/web/tests/RoomShell.test.tsx`, change the first test to:

```tsx
  it("renders a chat workspace with the character stage", () => {
    render(<RoomShell initialState={DEFAULT_ROOM_STATE} connectionStatus={connectionStatus} />);

    expect(screen.getByRole("heading", { name: "和久美子说会儿话" })).toBeTruthy();
    expect(screen.getByLabelText("聊天时间线").textContent).toContain("今天想从哪首歌开始聊");
    expect(screen.getByRole("textbox", { name: "写一条消息" })).toBeTruthy();
    expect(screen.getByRole("link", { name: "打开创作资料" }).getAttribute("href")).toBe("/studio");
    expect(screen.getByLabelText("久美子角色状态").textContent).toContain("黄前久美子");
    expect(screen.getByLabelText("久美子角色状态").textContent).toContain("倾听");
    expect(screen.getByLabelText("久美子角色状态").textContent).toContain("今天想从哪首歌开始聊");
    expect(screen.queryByText("陪伴房间")).toBeNull();
  });
```

Inside the existing `"sends exact visible conversation history through the room API"` test, after `expect(screen.getByText("思考")).toBeTruthy();`, add:

```tsx
    expect(screen.getByLabelText("久美子角色状态").textContent).toContain("思考");
    expect(screen.getByLabelText("久美子角色状态").textContent).toContain("嗯，我在听。");
```

- [ ] **Step 2: Run the updated RoomShell tests and verify they fail**

Run:

```powershell
npm run test --workspace apps/web -- tests/RoomShell.test.tsx
```

Expected: FAIL because `RoomShell` has not rendered `CharacterStage` yet.

- [ ] **Step 3: Import CharacterStage and visual state helper**

At the top of `apps/web/src/components/RoomShell.tsx`, add:

```ts
import { CharacterStage } from "./CharacterStage";
import { createCharacterVisualState } from "../lib/characterVisualState";
```

- [ ] **Step 4: Track the latest Kumiko line**

Replace the initial `messages` state and add `currentLine`:

```tsx
  const [messages, setMessages] = useState<ChatMessage[]>(() => [
    {
      id: "idle-line",
      role: "kumiko",
      content: getIdleLine(initialState)
    }
  ]);
  const [currentLine, setCurrentLine] = useState(() => getIdleLine(initialState));
```

Inside the successful chat response block, add `setCurrentLine(response.reply.content);` before appending the reply:

```tsx
      setCurrentExpression(response.expression);
      setCurrentLine(response.reply.content);
      setProviderStatus(response.providerStatus);
      setRecentMemoryEvents(response.memoryEvents);
      setMessages((current) => [...current, response.reply]);
```

- [ ] **Step 5: Derive visual state and render CharacterStage**

Before `return`, add:

```tsx
  const characterVisualState = createCharacterVisualState(
    {
      ...initialState.character,
      expression: currentExpression
    },
    currentLine
  );
```

At the start of the `<main className="room-workspace">`, before the dialogue section, add:

```tsx
      <CharacterStage visualState={characterVisualState} />
```

- [ ] **Step 6: Verify the focused RoomShell tests pass**

Run:

```powershell
npm run test --workspace apps/web -- tests/RoomShell.test.tsx
```

Expected: PASS.

- [ ] **Step 7: Commit**

```powershell
git add apps/web/src/components/RoomShell.tsx apps/web/tests/RoomShell.test.tsx
git commit -m "feat: connect character stage to room"
```

---

### Task 6: Add Three-Zone Room Layout Styles

**Files:**
- Modify: `apps/web/app/globals.css`
- Modify: `apps/web/tests/design-tokens.test.ts`

- [ ] **Step 1: Add style expectations**

In `apps/web/tests/design-tokens.test.ts`, add this test before `"removes the old green and brass room palette values"`:

```ts
  it("defines the character stage layout without breaking the chat viewport", () => {
    const css = readCss();

    expect(css).toContain(
      "grid-template-columns: minmax(240px, 0.36fr) minmax(420px, 1fr) minmax(280px, 0.42fr);"
    );
    expect(css).toContain(".character-card {\n  height: calc(100vh - 64px);");
    expect(css).toContain(".character-stage__viewer-shell");
    expect(css).toContain(".character-stage__fallback");
    expect(css).toContain(".character-stage__status");
  });
```

- [ ] **Step 2: Run the design token tests and verify they fail**

Run:

```powershell
npm run test --workspace apps/web -- tests/design-tokens.test.ts
```

Expected: FAIL because character stage styles do not exist.

- [ ] **Step 3: Update desktop grid and card padding**

In `apps/web/app/globals.css`, replace the `.room-workspace` block with:

```css
.room-workspace {
  height: 100vh;
  display: grid;
  grid-template-columns: minmax(240px, 0.36fr) minmax(420px, 1fr) minmax(280px, 0.42fr);
  gap: 20px;
  padding: 32px;
  overflow: hidden;
}
```

Replace:

```css
.dialogue-card,
.summary-card,
.utility-card,
.ai-card {
  padding: 24px;
}
```

with:

```css
.character-card,
.dialogue-card,
.summary-card,
.utility-card,
.ai-card {
  padding: 24px;
}
```

- [ ] **Step 4: Add character stage styles**

Add these rules after the `.dialogue-card` block:

```css
.character-card {
  height: calc(100vh - 64px);
  min-height: 0;
  display: flex;
  flex-direction: column;
  gap: 16px;
  overflow: hidden;
}

.character-stage__viewer-shell {
  min-height: 0;
  flex: 1 1 auto;
  display: grid;
  place-items: center;
  overflow: hidden;
  border: 1px solid var(--color-line);
  border-radius: 8px;
  background:
    linear-gradient(180deg, rgba(255, 255, 255, 0.72), rgba(245, 228, 232, 0.46)),
    var(--color-surface-strong);
}

.character-stage__fallback {
  width: min(100%, 260px);
  display: grid;
  gap: 8px;
  padding: 18px;
  border: 1px dashed rgba(169, 85, 104, 0.28);
  border-radius: 8px;
  background: rgba(255, 255, 255, 0.68);
  color: var(--color-muted);
  text-align: center;
}

.character-stage__fallback strong {
  color: var(--color-rose);
}

.character-stage__fallback span {
  line-height: 1.6;
}

.live2d-viewer {
  width: 100%;
  height: 100%;
  min-height: 320px;
}

.character-stage__status {
  display: grid;
  gap: 8px;
  padding: 14px;
  border: 1px solid var(--color-line);
  border-radius: 8px;
  background: rgba(255, 255, 255, 0.62);
}

.character-stage__status span {
  color: var(--color-rose);
  font-size: 13px;
  font-weight: 800;
}

.character-stage__status p {
  margin-bottom: 0;
  color: var(--color-muted);
  overflow-wrap: anywhere;
}
```

- [ ] **Step 5: Update responsive rules**

Inside `@media (max-width: 980px)`, replace the `.dialogue-card` block with:

```css
  .character-card {
    min-height: 420px;
  }

  .dialogue-card {
    height: min(720px, calc(100vh - 40px));
    min-height: 520px;
  }
```

Inside `@media (max-width: 640px)`, add:

```css
  .character-card {
    min-height: 360px;
  }

  .live2d-viewer {
    min-height: 240px;
  }
```

- [ ] **Step 6: Verify style tests pass**

Run:

```powershell
npm run test --workspace apps/web -- tests/design-tokens.test.ts
```

Expected: PASS.

- [ ] **Step 7: Commit**

```powershell
git add apps/web/app/globals.css apps/web/tests/design-tokens.test.ts
git commit -m "style: add live2d room layout"
```

---

### Task 7: Add Live2D Runtime Integration

**Files:**
- Modify: `apps/web/package.json`
- Modify: `package-lock.json`
- Create: `apps/web/src/lib/live2dRuntime.ts`
- Modify: `apps/web/src/components/Live2DViewer.tsx`
- Test: `apps/web/tests/Live2DViewer.test.tsx`

- [ ] **Step 1: Install compatible runtime dependencies**

Run:

```powershell
npm install --workspace apps/web pixi-live2d-display@0.4.0 pixi.js@6.5.10 @pixi/app@6.5.10 @pixi/core@6.5.10 @pixi/display@6.5.10 @pixi/loaders@6.5.10 @pixi/math@6.5.10 @pixi/sprite@6.5.10 @pixi/utils@6.5.10
```

Expected: `apps/web/package.json` and `package-lock.json` record the new dependencies.

- [ ] **Step 2: Write Live2DViewer tests with a fake runtime**

Create `apps/web/tests/Live2DViewer.test.tsx`:

```tsx
import { render, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { Live2DViewer, type Live2DRuntimeLoader } from "../src/components/Live2DViewer";

describe("Live2DViewer", () => {
  it("loads a runtime, reports ready, and applies expression targets", async () => {
    const applyTarget = vi.fn();
    const destroy = vi.fn();
    const loader: Live2DRuntimeLoader = vi.fn(async () => ({
      applyTarget,
      destroy
    }));
    const onLoadStateChange = vi.fn();
    const onError = vi.fn();

    const { unmount } = render(
      <Live2DViewer
        modelUrl="/api/local-assets/characters/kumiko/live2d/model.model3.json"
        cubismCoreUrl="/api/local-assets/characters/kumiko/live2d/live2dcubismcore.min.js"
        expression="thinking"
        target={{ expression: "thinking" }}
        onLoadStateChange={onLoadStateChange}
        onError={onError}
        runtimeLoader={loader}
      />
    );

    await waitFor(() => expect(onLoadStateChange).toHaveBeenCalledWith("ready"));
    expect(loader).toHaveBeenCalledWith({
      canvas: expect.any(HTMLCanvasElement),
      modelUrl: "/api/local-assets/characters/kumiko/live2d/model.model3.json",
      cubismCoreUrl: "/api/local-assets/characters/kumiko/live2d/live2dcubismcore.min.js"
    });
    expect(applyTarget).toHaveBeenCalledWith({ expression: "thinking" });
    expect(onError).not.toHaveBeenCalled();

    unmount();
    expect(destroy).toHaveBeenCalled();
  });

  it("reports load failures", async () => {
    const loader: Live2DRuntimeLoader = vi.fn(async () => {
      throw new Error("Cubism Core missing");
    });
    const onLoadStateChange = vi.fn();
    const onError = vi.fn();

    render(
      <Live2DViewer
        modelUrl="/api/local-assets/characters/kumiko/live2d/model.model3.json"
        expression="listening"
        onLoadStateChange={onLoadStateChange}
        onError={onError}
        runtimeLoader={loader}
      />
    );

    await waitFor(() => expect(onLoadStateChange).toHaveBeenCalledWith("failed"));
    expect(onError).toHaveBeenCalledWith("Cubism Core missing");
  });
});
```

- [ ] **Step 3: Run the viewer tests and verify they fail**

Run:

```powershell
npm run test --workspace apps/web -- tests/Live2DViewer.test.tsx
```

Expected: FAIL because `Live2DViewer` does not support `runtimeLoader`.

- [ ] **Step 4: Add the runtime abstraction**

Create `apps/web/src/lib/live2dRuntime.ts`:

```ts
import type { Live2DExpressionTarget } from "../api/types";

interface RuntimeOptions {
  canvas: HTMLCanvasElement;
  modelUrl: string;
  cubismCoreUrl?: string;
}

export interface Live2DRuntimeInstance {
  applyTarget: (target: Live2DExpressionTarget | undefined) => void;
  destroy: () => void;
}

declare global {
  interface Window {
    PIXI?: unknown;
    Live2DCubismCore?: unknown;
  }
}

async function loadScriptOnce(src: string): Promise<void> {
  if (typeof window === "undefined") return;
  if (window.Live2DCubismCore) return;

  const existing = document.querySelector<HTMLScriptElement>(`script[data-kumikoroom-live2d-core="${src}"]`);
  if (existing) {
    await new Promise<void>((resolve, reject) => {
      existing.addEventListener("load", () => resolve(), { once: true });
      existing.addEventListener("error", () => reject(new Error("Cubism Core failed to load")), {
        once: true
      });
    });
    return;
  }

  await new Promise<void>((resolve, reject) => {
    const script = document.createElement("script");
    script.src = src;
    script.async = true;
    script.dataset.kumikoroomLive2dCore = src;
    script.addEventListener("load", () => resolve(), { once: true });
    script.addEventListener("error", () => reject(new Error("Cubism Core failed to load")), {
      once: true
    });
    document.head.appendChild(script);
  });
}

export async function createPixiLive2DInstance({
  canvas,
  modelUrl,
  cubismCoreUrl
}: RuntimeOptions): Promise<Live2DRuntimeInstance> {
  if (typeof window === "undefined") {
    throw new Error("Live2D can only run in the browser");
  }

  if (cubismCoreUrl) {
    await loadScriptOnce(cubismCoreUrl);
  }

  const PIXI = await import("pixi.js");
  const { Live2DModel } = await import("pixi-live2d-display/cubism4");

  window.PIXI = PIXI;

  const app = new PIXI.Application({
    view: canvas,
    resizeTo: canvas.parentElement ?? undefined,
    transparent: true,
    autoStart: true,
    antialias: true
  });
  const model = await Live2DModel.from(modelUrl);

  app.stage.addChild(model);

  const fitModel = () => {
    const width = canvas.clientWidth || 320;
    const height = canvas.clientHeight || 420;
    const modelWidth = Number(model.width) || width;
    const modelHeight = Number(model.height) || height;
    const scale = Math.min(width / modelWidth, height / modelHeight) * 0.92;

    model.scale.set(scale);
    model.x = width / 2 - (modelWidth * scale) / 2;
    model.y = height - modelHeight * scale;
  };

  fitModel();
  window.addEventListener("resize", fitModel);

  return {
    applyTarget(target) {
      if (!target) return;
      if (target.expression && "expression" in model) {
        void model.expression(target.expression);
      }
      if (target.motionGroup && "motion" in model) {
        void model.motion(target.motionGroup, target.motionIndex);
      }
    },
    destroy() {
      window.removeEventListener("resize", fitModel);
      model.destroy();
      app.destroy(true, { children: true, texture: true, baseTexture: true });
    }
  };
}
```

- [ ] **Step 5: Replace Live2DViewer with the runtime-backed implementation**

Replace `apps/web/src/components/Live2DViewer.tsx` with:

```tsx
"use client";

import { useEffect, useRef } from "react";
import type { CharacterExpression, Live2DExpressionTarget } from "../api/types";
import {
  createPixiLive2DInstance,
  type Live2DRuntimeInstance
} from "../lib/live2dRuntime";

export type Live2DLoadState = "idle" | "loading" | "ready" | "failed";

export type Live2DRuntimeLoader = (options: {
  canvas: HTMLCanvasElement;
  modelUrl: string;
  cubismCoreUrl?: string;
}) => Promise<Live2DRuntimeInstance>;

export interface Live2DViewerProps {
  modelUrl: string;
  cubismCoreUrl?: string;
  expression: CharacterExpression;
  target?: Live2DExpressionTarget;
  onLoadStateChange: (state: Live2DLoadState) => void;
  onError: (message: string) => void;
  runtimeLoader?: Live2DRuntimeLoader;
}

export function Live2DViewer({
  modelUrl,
  cubismCoreUrl,
  expression,
  target,
  onLoadStateChange,
  onError,
  runtimeLoader = createPixiLive2DInstance
}: Live2DViewerProps) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const runtimeRef = useRef<Live2DRuntimeInstance | null>(null);

  useEffect(() => {
    let cancelled = false;

    async function loadModel() {
      if (!canvasRef.current) return;

      onLoadStateChange("loading");

      try {
        const runtime = await runtimeLoader({
          canvas: canvasRef.current,
          modelUrl,
          cubismCoreUrl
        });

        if (cancelled) {
          runtime.destroy();
          return;
        }

        runtimeRef.current = runtime;
        onLoadStateChange("ready");
        runtime.applyTarget(target);
      } catch (error) {
        if (!cancelled) {
          onLoadStateChange("failed");
          onError(error instanceof Error ? error.message : "Live2D model failed to load");
        }
      }
    }

    void loadModel();

    return () => {
      cancelled = true;
      runtimeRef.current?.destroy();
      runtimeRef.current = null;
    };
  }, [cubismCoreUrl, modelUrl, onError, onLoadStateChange, runtimeLoader]);

  useEffect(() => {
    runtimeRef.current?.applyTarget(target);
  }, [expression, target]);

  return <canvas ref={canvasRef} className="live2d-viewer" aria-hidden="true" />;
}
```

- [ ] **Step 6: Verify the viewer tests pass**

Run:

```powershell
npm run test --workspace apps/web -- tests/Live2DViewer.test.tsx
```

Expected: PASS.

- [ ] **Step 7: Commit**

```powershell
git add apps/web/package.json package-lock.json apps/web/src/lib/live2dRuntime.ts apps/web/src/components/Live2DViewer.tsx apps/web/tests/Live2DViewer.test.tsx
git commit -m "feat: add live2d runtime viewer"
```

---

### Task 8: Document Local Live2D Asset Setup

**Files:**
- Create: `docs/live2d-local-assets.md`
- Modify: `README.md`

- [ ] **Step 1: Add the local asset guide**

Create `docs/live2d-local-assets.md`:

````md
# Live2D Local Assets

KumikoRoom loads Live2D assets from the ignored `user-data/` directory.

Do not commit character models, textures, Cubism Core files, voice samples, trained voice models, or fan-provided image packs.

## Directory

Use this local layout:

```text
user-data/
  characters/
    kumiko/
      character.json
      live2d/
        live2dcubismcore.min.js
        model.model3.json
        textures/
        motions/
        expressions/
```

## Character Config

`character.json` can use this shape:

```json
{
  "displayName": "黄前久美子",
  "live2d": {
    "modelUrl": "/api/local-assets/characters/kumiko/live2d/model.model3.json",
    "cubismCoreUrl": "/api/local-assets/characters/kumiko/live2d/live2dcubismcore.min.js",
    "expressionMap": {
      "neutral": { "expression": "neutral" },
      "listening": { "motionGroup": "idle" },
      "thinking": { "expression": "thinking" },
      "encouraging": { "expression": "smile" }
    }
  }
}
```

Expression names and motion groups depend on the local model. If an entry does not exist in the model, the room still updates the visible expression badge.

## Cubism Core

For Cubism 3 and Cubism 4 models, place `live2dcubismcore.min.js` next to the model file. Obtain it from a Live2D Cubism SDK source that you are allowed to use.

## Verification

Start the web app:

```powershell
npm run dev:web
```

Open:

```text
http://127.0.0.1:3000/room
```

Expected behavior:

- With no local model, the room shows the fallback character panel.
- With a valid model and Cubism Core file, the room shows the Live2D canvas.
- Chat replies that return `thinking`, `listening`, `neutral`, or `encouraging` update the visible expression state.
````

- [ ] **Step 2: Link the guide from README**

In `README.md`, under `## Development`, add:

````md
Live2D local assets:

```powershell
notepad docs\live2d-local-assets.md
```
````

Under `## Fan Project Boundary`, add:

```md
Live2D models and Cubism Core files are local-only assets. Keep them under `user-data/` and follow `docs/live2d-local-assets.md`.
```

- [ ] **Step 3: Commit**

```powershell
git add docs/live2d-local-assets.md README.md
git commit -m "docs: describe live2d local assets"
```

---

### Task 9: Full Verification

**Files:**
- Verify all files changed by Tasks 1-8.

- [ ] **Step 1: Run all web tests**

Run:

```powershell
npm run test --workspace apps/web
```

Expected: PASS with all web tests.

- [ ] **Step 2: Run root tests**

Run:

```powershell
npm test
```

Expected: PASS for web and desktop workspaces.

- [ ] **Step 3: Start the web app**

Run:

```powershell
npm run dev:web
```

Expected: Next.js starts and prints a local URL, normally `http://localhost:3000`.

- [ ] **Step 4: Manually verify `/room` without local assets**

Open:

```text
http://127.0.0.1:3000/room
```

Expected:

- The room has three visible zones on desktop: character, chat, utility panels.
- The character area shows `黄前久美子`, the current expression label, and `Live2D 模型未配置`.
- The chat composer is visible and usable.
- Sending a message still appends the user message and Kumiko response.

- [ ] **Step 5: Manually verify with local assets**

Place a valid model under:

```text
user-data/characters/kumiko/live2d/model.model3.json
user-data/characters/kumiko/live2d/live2dcubismcore.min.js
```

Add `live2d` config to `DEFAULT_ROOM_STATE.character` temporarily for the manual check:

```ts
live2d: {
  modelUrl: "/api/local-assets/characters/kumiko/live2d/model.model3.json",
  cubismCoreUrl: "/api/local-assets/characters/kumiko/live2d/live2dcubismcore.min.js",
  expressionMap: {
    neutral: { expression: "neutral" },
    listening: { motionGroup: "idle" },
    thinking: { expression: "thinking" },
    encouraging: { expression: "smile" }
  }
}
```

Expected:

- The Live2D canvas appears in the character area.
- Missing model-specific expression names do not break chat.
- The expression badge updates after chat responses.

Remove the temporary `DEFAULT_ROOM_STATE.character.live2d` config after this manual check unless the local model should be the default in your own checkout.

- [ ] **Step 6: Commit final cleanups**

If manual verification required code cleanup after the temporary config check, commit only the permanent cleanup:

```powershell
git status --short
git add <permanent-files-only>
git commit -m "chore: finish live2d room verification"
```

If no permanent changes remain, leave the workspace clean.

---

## Self-Review Checklist

Before executing this plan, confirm:

- Spec goal covered: Task 4 and Task 5 add the character area.
- Local model loading covered: Task 3 serves `user-data`; Task 7 loads Live2D.
- Expression linkage covered: Task 4 maps expression targets; Task 5 updates current expression and line.
- Missing model fallback covered: Task 4 tests fallback and load failure.
- No media committed: Task 3 serves ignored local files; Task 8 documents the rule.
- Desktop pet handoff covered: `CharacterVisualState` in Task 2 and Task 4 carries the reusable state shape.
- Full verification covered: Task 9 runs focused and root tests plus manual room checks.

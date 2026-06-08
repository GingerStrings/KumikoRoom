# Desktop Launcher Stage 1 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make `npm run dev:desktop` open the Electron app and automatically manage the local API and web services for development use.

**Architecture:** Add a desktop launcher layer inside `apps/desktop` with focused modules for config, HTTP readiness checks, child-process management, launch state, and status-page rendering. Keep the current Next.js `/room` UI as the rendered app surface, and keep Stage 1 dependent on the local development checkout plus installed Node/Python tooling.

**Tech Stack:** Electron 31, TypeScript CommonJS, Node child_process/http primitives, Vitest, Next.js 14 dev server, FastAPI via `python -m uvicorn`.

---

## Scope Boundary

This plan implements Stage 1 from `docs/superpowers/specs/2026-06-08-desktop-app-design.md`.

Included:

- One-command desktop development flow through the existing root `npm run dev:desktop` script.
- API and web readiness checks.
- API and web process spawning when services are missing.
- Launch-state status page inside Electron.
- Retry URL handling for failed launches.
- Shutdown of child processes owned by the desktop launcher.
- Encoding-safe menu/status text.
- Focused unit tests and README updates.

Deferred:

- Windows installer.
- App icon.
- Bundled Python or Node runtime.
- Dynamic port allocation.
- Tray behavior.
- Auto-update.

## File Structure

- Modify `apps/desktop/src/config.ts`
  - Define `DesktopConfig`, ports, URLs, repo-root resolution, timeouts, and window options.
  - Keep `getWebUrl()` compatibility for existing tests and callers.
- Create `apps/desktop/src/launchTypes.ts`
  - Share launch state, service status, and launch error types across launcher and status page.
- Create `apps/desktop/src/statusPage.ts`
  - Render the desktop startup/failure HTML and escape logs safely.
- Create `apps/desktop/src/ports.ts`
  - Probe KumikoRoom API and web endpoints and wait for readiness.
- Create `apps/desktop/src/processes.ts`
  - Build API/web child process commands, capture bounded logs, and stop owned children.
- Create `apps/desktop/src/launcher.ts`
  - Coordinate readiness checks, process spawning, retries, state events, and shutdown.
- Create `apps/desktop/src/navigation.ts`
  - Build status-page data URLs and recognize the desktop retry URL.
- Create `apps/desktop/src/appController.ts`
  - Keep the Electron startup/retry/shutdown flow testable through a small window interface.
- Modify `apps/desktop/src/main.ts`
  - Wire Electron window lifecycle to `DesktopLauncher`.
- Modify `apps/desktop/tests/config.test.ts`
  - Cover new config behavior.
- Create `apps/desktop/tests/statusPage.test.ts`
  - Cover status HTML, escaping, and readable text.
- Create `apps/desktop/tests/ports.test.ts`
  - Cover readiness probes and wait behavior.
- Create `apps/desktop/tests/processes.test.ts`
  - Cover command construction, log buffers, and process stop behavior.
- Create `apps/desktop/tests/launcher.test.ts`
  - Cover launch orchestration and shutdown ownership.
- Create `apps/desktop/tests/navigation.test.ts`
  - Cover status data URLs and retry URL detection.
- Create `apps/desktop/tests/appController.test.ts`
  - Cover status rendering, ready navigation, retry, and shutdown behavior without importing Electron.
- Modify `README.md`
  - Document the desktop development entry and failure diagnostics.

## Execution Notes

- Before implementation, use `superpowers:using-git-worktrees` or confirm current workspace isolation.
- Follow TDD exactly: write each listed test, run it and see it fail for the expected reason, then implement the minimal code.
- Use `apply_patch` for manual edits.
- Keep commits small and task-scoped.
- Do not commit `.env`, `.env.local`, `user-data/`, `.next/`, `dist/`, or `tsconfig.tsbuildinfo`.

## Spec Coverage Map

- One-command desktop entry: Task 5 wires Electron startup to `DesktopAppController`; Task 6 documents `npm run dev:desktop`.
- API and web service orchestration: Task 4 implements `DesktopLauncher`.
- Port and readiness checks: Task 2 implements API and web probes.
- API and web process spawning: Task 3 implements command builders and managed child processes.
- Launch progress UI: Task 1 implements `LaunchState` and `statusPage.ts`; Task 5 renders it inside Electron.
- Retry behavior: Task 5 implements `kumikoroom://retry`, menu retry, and controller restart.
- Clean shutdown: Task 3 implements process stop; Task 4 owns launcher shutdown; Task 5 calls shutdown before app quit.
- Encoding-safe menu and status text: Task 1 status page tests verify readable Chinese; Task 5 replaces corrupted menu strings.
- Browser development compatibility: Task 3 starts Next with API env overrides while leaving existing web/API packages in place.
- README instructions: Task 6 updates the desktop development section.
- Verification: Task 6 runs desktop tests, desktop build, root tests, secret scan, and manual smoke test.

---

### Task 1: Desktop Config, Launch Types, and Status Page

**Files:**
- Modify: `apps/desktop/src/config.ts`
- Create: `apps/desktop/src/launchTypes.ts`
- Create: `apps/desktop/src/statusPage.ts`
- Modify: `apps/desktop/tests/config.test.ts`
- Create: `apps/desktop/tests/statusPage.test.ts`

- [ ] **Step 1: Write failing config tests**

Replace `apps/desktop/tests/config.test.ts` with:

```typescript
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  DEFAULT_API_PORT,
  DEFAULT_WEB_PORT,
  DEFAULT_WEB_URL,
  getDesktopConfig,
  getWebUrl,
  parsePort,
  resolveRepoRoot,
  windowOptions
} from "../src/config";

describe("desktop config", () => {
  it("uses the KumikoRoom default ports and URLs", () => {
    const config = getDesktopConfig({}, process.cwd());

    expect(DEFAULT_API_PORT).toBe(8000);
    expect(DEFAULT_WEB_PORT).toBe(3000);
    expect(DEFAULT_WEB_URL).toBe("http://127.0.0.1:3000/room");
    expect(config.api.baseUrl).toBe("http://127.0.0.1:8000");
    expect(config.api.healthUrl).toBe("http://127.0.0.1:8000/api/room/state");
    expect(config.web.url).toBe("http://127.0.0.1:3000/room");
    expect(config.web.healthUrl).toBe("http://127.0.0.1:3000/room");
    expect(config.autoStart).toBe(true);
  });

  it("allows environment overrides", () => {
    const config = getDesktopConfig(
      {
        KUMIKOROOM_API_PORT: "8010",
        KUMIKOROOM_WEB_PORT: "3010",
        KUMIKOROOM_API_URL: "http://127.0.0.1:8010",
        KUMIKOROOM_WEB_URL: "http://127.0.0.1:3010/room",
        KUMIKOROOM_DESKTOP_AUTOSTART: "0"
      },
      process.cwd()
    );

    expect(config.api.port).toBe(8010);
    expect(config.web.port).toBe(3010);
    expect(config.api.baseUrl).toBe("http://127.0.0.1:8010");
    expect(config.web.url).toBe("http://127.0.0.1:3010/room");
    expect(config.autoStart).toBe(false);
  });

  it("keeps getWebUrl compatibility", () => {
    expect(getWebUrl({ KUMIKOROOM_WEB_URL: "http://127.0.0.1:3010/room" })).toBe(
      "http://127.0.0.1:3010/room"
    );
  });

  it("parses valid ports and rejects invalid ports", () => {
    expect(parsePort("4321", 1234, "TEST_PORT")).toBe(4321);
    expect(parsePort(undefined, 1234, "TEST_PORT")).toBe(1234);
    expect(() => parsePort("0", 1234, "TEST_PORT")).toThrow("TEST_PORT");
    expect(() => parsePort("70000", 1234, "TEST_PORT")).toThrow("TEST_PORT");
    expect(() => parsePort("abc", 1234, "TEST_PORT")).toThrow("TEST_PORT");
  });

  it("resolves the repository root from the desktop workspace", () => {
    const repoRoot = resolveRepoRoot(process.cwd());
    const desktopDir = path.join(repoRoot, "apps", "desktop");

    expect(resolveRepoRoot(desktopDir)).toBe(repoRoot);
  });

  it("uses KumikoRoom as window title", () => {
    expect(windowOptions.title).toBe("KumikoRoom");
    expect(windowOptions.show).toBe(false);
    expect(windowOptions.minWidth).toBeGreaterThanOrEqual(1024);
  });
});
```

- [ ] **Step 2: Run the config tests and verify they fail**

Run:

```powershell
npm run test --workspace apps/desktop -- config.test.ts
```

Expected: FAIL because `DEFAULT_API_PORT`, `DEFAULT_WEB_PORT`, `getDesktopConfig`, `parsePort`, or `resolveRepoRoot` is not exported.

- [ ] **Step 3: Implement config and launch types**

Replace `apps/desktop/src/config.ts` with:

```typescript
import fs from "node:fs";
import path from "node:path";
import type { BrowserWindowConstructorOptions } from "electron";

export const DEFAULT_HOST = "127.0.0.1";
export const DEFAULT_API_PORT = 8000;
export const DEFAULT_WEB_PORT = 3000;
export const DEFAULT_WEB_URL = `http://${DEFAULT_HOST}:${DEFAULT_WEB_PORT}/room`;
export const DEFAULT_LAUNCH_TIMEOUT_MS = 45_000;
export const DEFAULT_POLL_INTERVAL_MS = 500;

export interface DesktopServiceConfig {
  host: string;
  port: number;
  baseUrl: string;
  healthUrl: string;
}

export interface DesktopWebConfig extends DesktopServiceConfig {
  url: string;
}

export interface DesktopConfig {
  repoRoot: string;
  apiDir: string;
  webDir: string;
  autoStart: boolean;
  launchTimeoutMs: number;
  pollIntervalMs: number;
  api: DesktopServiceConfig;
  web: DesktopWebConfig;
}

export function parsePort(value: string | undefined, fallback: number, name: string): number {
  if (value === undefined || value.trim().length === 0) {
    return fallback;
  }

  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > 65535) {
    throw new Error(`${name} must be a TCP port between 1 and 65535`);
  }

  return parsed;
}

export function resolveRepoRoot(startDir: string): string {
  let current = path.resolve(startDir);

  while (true) {
    const packagePath = path.join(current, "package.json");
    const apiPath = path.join(current, "apps", "api");
    const webPath = path.join(current, "apps", "web");

    if (fs.existsSync(packagePath) && fs.existsSync(apiPath) && fs.existsSync(webPath)) {
      return current;
    }

    const parent = path.dirname(current);
    if (parent === current) {
      throw new Error(`Unable to resolve KumikoRoom repo root from ${startDir}`);
    }
    current = parent;
  }
}

function trimEnv(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed && trimmed.length > 0 ? trimmed : undefined;
}

export function getDesktopConfig(
  env: NodeJS.ProcessEnv = process.env,
  startDir = process.cwd()
): DesktopConfig {
  const repoRoot = resolveRepoRoot(trimEnv(env.KUMIKOROOM_REPO_ROOT) ?? startDir);
  const apiPort = parsePort(env.KUMIKOROOM_API_PORT, DEFAULT_API_PORT, "KUMIKOROOM_API_PORT");
  const webPort = parsePort(env.KUMIKOROOM_WEB_PORT, DEFAULT_WEB_PORT, "KUMIKOROOM_WEB_PORT");
  const host = DEFAULT_HOST;
  const apiBaseUrl = trimEnv(env.KUMIKOROOM_API_URL) ?? `http://${host}:${apiPort}`;
  const webUrl = trimEnv(env.KUMIKOROOM_WEB_URL) ?? `http://${host}:${webPort}/room`;

  return {
    repoRoot,
    apiDir: path.join(repoRoot, "apps", "api"),
    webDir: path.join(repoRoot, "apps", "web"),
    autoStart: env.KUMIKOROOM_DESKTOP_AUTOSTART !== "0",
    launchTimeoutMs: DEFAULT_LAUNCH_TIMEOUT_MS,
    pollIntervalMs: DEFAULT_POLL_INTERVAL_MS,
    api: {
      host,
      port: apiPort,
      baseUrl: apiBaseUrl,
      healthUrl: `${apiBaseUrl}/api/room/state`
    },
    web: {
      host,
      port: webPort,
      baseUrl: `http://${host}:${webPort}`,
      healthUrl: `http://${host}:${webPort}/room`,
      url: webUrl
    }
  };
}

export function getWebUrl(env: NodeJS.ProcessEnv): string {
  return getDesktopConfig(env).web.url;
}

export const windowOptions = {
  width: 1280,
  height: 820,
  minWidth: 1024,
  minHeight: 680,
  backgroundColor: "#f8f3f1",
  title: "KumikoRoom",
  show: false
} satisfies BrowserWindowConstructorOptions;
```

Create `apps/desktop/src/launchTypes.ts`:

```typescript
export type DesktopServiceName = "api" | "web";

export type LaunchPhase =
  | "idle"
  | "checking-api"
  | "starting-api"
  | "checking-web"
  | "starting-web"
  | "ready"
  | "failed"
  | "stopped";

export type ServiceStatus = "unknown" | "checking" | "starting" | "ready" | "reused" | "failed";

export interface ServiceState {
  name: DesktopServiceName;
  label: string;
  port: number;
  status: ServiceStatus;
  detail?: string;
}

export interface LaunchError {
  service?: DesktopServiceName | "desktop";
  code: "port-occupied" | "process-exited" | "timeout" | "load-failed" | "unknown";
  message: string;
  logs?: string[];
}

export interface LaunchState {
  phase: LaunchPhase;
  title: string;
  detail: string;
  api: ServiceState;
  web: ServiceState;
  webUrl?: string;
  retryable: boolean;
  error?: LaunchError;
}
```

- [ ] **Step 4: Run the config tests and verify they pass**

Run:

```powershell
npm run test --workspace apps/desktop -- config.test.ts
```

Expected: PASS for `config.test.ts`.

- [ ] **Step 5: Write failing status-page tests**

Create `apps/desktop/tests/statusPage.test.ts`:

```typescript
import { describe, expect, it } from "vitest";
import type { LaunchState } from "../src/launchTypes";
import { escapeHtml, renderStatusPage } from "../src/statusPage";

function state(overrides: Partial<LaunchState> = {}): LaunchState {
  return {
    phase: "starting-api",
    title: "正在启动 KumikoRoom",
    detail: "正在准备本地服务",
    retryable: false,
    api: { name: "api", label: "本地 API", port: 8000, status: "starting" },
    web: { name: "web", label: "界面服务", port: 3000, status: "unknown" },
    ...overrides
  };
}

describe("status page", () => {
  it("escapes unsafe log content", () => {
    expect(escapeHtml(`<script>alert("x")</script>`)).toBe(
      "&lt;script&gt;alert(&quot;x&quot;)&lt;/script&gt;"
    );
  });

  it("renders a readable startup page", () => {
    const html = renderStatusPage(state());

    expect(html).toContain("KumikoRoom");
    expect(html).toContain("正在启动 KumikoRoom");
    expect(html).toContain("本地 API");
    expect(html).toContain("界面服务");
    expect(html).toContain("Warm Rose Fog");
  });

  it("renders failure details and retry link", () => {
    const html = renderStatusPage(
      state({
        phase: "failed",
        title: "启动遇到问题",
        detail: "本地 API 没有启动成功",
        retryable: true,
        error: {
          service: "api",
          code: "process-exited",
          message: "API process exited",
          logs: [`<script>alert("bad")</script>`, "uvicorn failed"]
        }
      })
    );

    expect(html).toContain("启动遇到问题");
    expect(html).toContain("kumikoroom://retry");
    expect(html).toContain("&lt;script&gt;alert(&quot;bad&quot;)&lt;/script&gt;");
    expect(html).not.toContain(`<script>alert("bad")</script>`);
  });
});
```

- [ ] **Step 6: Run the status-page tests and verify they fail**

Run:

```powershell
npm run test --workspace apps/desktop -- statusPage.test.ts
```

Expected: FAIL with "Cannot find module '../src/statusPage'".

- [ ] **Step 7: Implement the status page**

Create `apps/desktop/src/statusPage.ts`:

```typescript
import type { LaunchState, ServiceState } from "./launchTypes";

const statusText: Record<ServiceState["status"], string> = {
  unknown: "等待中",
  checking: "检查中",
  starting: "启动中",
  ready: "已就绪",
  reused: "已复用",
  failed: "失败"
};

export function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function serviceRow(service: ServiceState): string {
  return `
    <div class="service-row">
      <div>
        <div class="service-label">${escapeHtml(service.label)}</div>
        <div class="service-detail">端口 ${service.port}${service.detail ? ` · ${escapeHtml(service.detail)}` : ""}</div>
      </div>
      <span class="status status-${service.status}">${statusText[service.status]}</span>
    </div>
  `;
}

function logBlock(state: LaunchState): string {
  const logs = state.error?.logs ?? [];
  if (logs.length === 0) {
    return "";
  }

  return `
    <section class="logs">
      <h2>最近日志</h2>
      <pre>${logs.map(escapeHtml).join("\n")}</pre>
    </section>
  `;
}

export function renderStatusPage(state: LaunchState): string {
  const retry = state.retryable
    ? `<a class="retry" href="kumikoroom://retry">重试启动</a>`
    : "";

  return `<!doctype html>
<html lang="zh-CN">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>${escapeHtml(state.title)}</title>
    <style>
      :root {
        color-scheme: light;
        --bg: #f8f3f1;
        --panel: rgba(255, 252, 250, 0.86);
        --ink: #383235;
        --muted: #7d7477;
        --rose: #c35f7b;
        --rose-soft: #f2d7df;
        --line: rgba(90, 72, 78, 0.14);
        --shadow: 0 24px 80px rgba(82, 52, 62, 0.14);
      }
      * { box-sizing: border-box; }
      body {
        margin: 0;
        min-height: 100vh;
        display: grid;
        place-items: center;
        background:
          radial-gradient(circle at 20% 12%, rgba(244, 212, 221, 0.9), transparent 32%),
          linear-gradient(145deg, #fbf6f4 0%, var(--bg) 46%, #f4ece8 100%);
        color: var(--ink);
        font-family: "Microsoft YaHei", "Segoe UI", sans-serif;
      }
      main {
        width: min(760px, calc(100vw - 48px));
        padding: 34px;
        border: 1px solid var(--line);
        border-radius: 18px;
        background: var(--panel);
        box-shadow: var(--shadow);
      }
      .eyebrow {
        color: var(--rose);
        font-size: 13px;
        font-weight: 700;
        letter-spacing: 0;
      }
      h1 {
        margin: 10px 0 10px;
        font-size: 32px;
        line-height: 1.2;
      }
      p {
        margin: 0;
        color: var(--muted);
        font-size: 15px;
        line-height: 1.7;
      }
      .services {
        display: grid;
        gap: 12px;
        margin: 26px 0;
      }
      .service-row {
        display: flex;
        align-items: center;
        justify-content: space-between;
        gap: 16px;
        padding: 15px 16px;
        border: 1px solid var(--line);
        border-radius: 12px;
        background: rgba(255,255,255,0.58);
      }
      .service-label {
        font-weight: 800;
      }
      .service-detail {
        margin-top: 3px;
        color: var(--muted);
        font-size: 13px;
      }
      .status {
        flex: 0 0 auto;
        border-radius: 999px;
        padding: 6px 10px;
        border: 1px solid var(--line);
        background: #fff;
        font-size: 13px;
        font-weight: 700;
      }
      .status-starting,
      .status-checking {
        color: #8b5a2b;
        background: #fff3df;
      }
      .status-ready,
      .status-reused {
        color: #3d6f5a;
        background: #e6f2ec;
      }
      .status-failed {
        color: #9a304f;
        background: var(--rose-soft);
      }
      .retry {
        display: inline-flex;
        align-items: center;
        justify-content: center;
        min-height: 42px;
        padding: 0 18px;
        border-radius: 999px;
        background: var(--rose);
        color: white;
        font-weight: 800;
        text-decoration: none;
      }
      .logs {
        margin-top: 22px;
      }
      .logs h2 {
        margin: 0 0 8px;
        font-size: 15px;
      }
      pre {
        max-height: 180px;
        overflow: auto;
        margin: 0;
        padding: 14px;
        border-radius: 12px;
        background: rgba(45, 39, 42, 0.92);
        color: #fff8f5;
        font-size: 12px;
        line-height: 1.55;
        white-space: pre-wrap;
      }
    </style>
  </head>
  <body>
    <main>
      <div class="eyebrow">KumikoRoom · Warm Rose Fog</div>
      <h1>${escapeHtml(state.title)}</h1>
      <p>${escapeHtml(state.detail)}</p>
      <section class="services">
        ${serviceRow(state.api)}
        ${serviceRow(state.web)}
      </section>
      ${retry}
      ${logBlock(state)}
    </main>
  </body>
</html>`;
}
```

- [ ] **Step 8: Run Task 1 tests and commit**

Run:

```powershell
npm run test --workspace apps/desktop -- config.test.ts statusPage.test.ts
```

Expected: PASS for both files.

Commit:

```powershell
git add apps/desktop/src/config.ts apps/desktop/src/launchTypes.ts apps/desktop/src/statusPage.ts apps/desktop/tests/config.test.ts apps/desktop/tests/statusPage.test.ts
git commit -m "feat: add desktop launch config and status page"
```

---

### Task 2: HTTP Readiness Probes

**Files:**
- Create: `apps/desktop/src/ports.ts`
- Create: `apps/desktop/tests/ports.test.ts`

- [ ] **Step 1: Write failing readiness tests**

Create `apps/desktop/tests/ports.test.ts`:

```typescript
import http from "node:http";
import { afterEach, describe, expect, it } from "vitest";
import {
  isKumikoApiReady,
  isKumikoWebReady,
  probeHttp,
  waitUntilReady
} from "../src/ports";

const servers: http.Server[] = [];

async function serve(handler: http.RequestListener): Promise<string> {
  const server = http.createServer(handler);
  servers.push(server);

  await new Promise<void>((resolve) => {
    server.listen(0, "127.0.0.1", resolve);
  });

  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("Expected TCP test server");
  }
  return `http://127.0.0.1:${address.port}`;
}

afterEach(async () => {
  await Promise.all(
    servers.splice(0).map(
      (server) =>
        new Promise<void>((resolve, reject) => {
          server.close((error) => (error ? reject(error) : resolve()));
        })
    )
  );
});

describe("desktop HTTP probes", () => {
  it("detects a KumikoRoom API health response", async () => {
    const baseUrl = await serve((_req, res) => {
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ app_name: "KumikoRoom" }));
    });

    await expect(isKumikoApiReady(`${baseUrl}/api/room/state`)).resolves.toEqual({
      ready: true,
      occupied: true,
      status: 200
    });
  });

  it("marks unrelated API responses as occupied but not ready", async () => {
    const baseUrl = await serve((_req, res) => {
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ app_name: "OtherApp" }));
    });

    await expect(isKumikoApiReady(`${baseUrl}/api/room/state`)).resolves.toMatchObject({
      ready: false,
      occupied: true,
      status: 200
    });
  });

  it("detects a KumikoRoom web response", async () => {
    const baseUrl = await serve((_req, res) => {
      res.setHeader("content-type", "text/html; charset=utf-8");
      res.end("<html><title>KumikoRoom</title><body>和久美子说会儿话</body></html>");
    });

    await expect(isKumikoWebReady(`${baseUrl}/room`)).resolves.toMatchObject({
      ready: true,
      occupied: true,
      status: 200
    });
  });

  it("treats connection failures as unoccupied", async () => {
    const result = await probeHttp("http://127.0.0.1:9/room", 50);

    expect(result.ready).toBe(false);
    expect(result.occupied).toBe(false);
    expect(result.error).toBeTruthy();
  });

  it("waits until a probe becomes ready", async () => {
    let attempts = 0;

    const result = await waitUntilReady(
      async () => {
        attempts += 1;
        return { ready: attempts === 3, occupied: attempts === 3 };
      },
      { timeoutMs: 1_000, intervalMs: 1, sleep: () => Promise.resolve() }
    );

    expect(result.ready).toBe(true);
    expect(attempts).toBe(3);
  });
});
```

- [ ] **Step 2: Run readiness tests and verify they fail**

Run:

```powershell
npm run test --workspace apps/desktop -- ports.test.ts
```

Expected: FAIL with "Cannot find module '../src/ports'".

- [ ] **Step 3: Implement readiness probes**

Create `apps/desktop/src/ports.ts`:

```typescript
export interface EndpointReadiness {
  ready: boolean;
  occupied: boolean;
  status?: number;
  error?: string;
}

export interface WaitOptions {
  timeoutMs: number;
  intervalMs: number;
  sleep?: (ms: number) => Promise<void>;
}

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function probeHttp(url: string, timeoutMs = 1_000): Promise<EndpointReadiness & { text?: string }> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await fetch(url, { signal: controller.signal });
    const text = await response.text();
    return {
      ready: response.ok,
      occupied: true,
      status: response.status,
      text
    };
  } catch (error) {
    return {
      ready: false,
      occupied: false,
      error: error instanceof Error ? error.message : String(error)
    };
  } finally {
    clearTimeout(timeout);
  }
}

export async function isKumikoApiReady(url: string, timeoutMs = 1_000): Promise<EndpointReadiness> {
  const result = await probeHttp(url, timeoutMs);
  if (!result.occupied || !result.text) {
    return result;
  }

  try {
    const body = JSON.parse(result.text) as { app_name?: string };
    return {
      ready: result.status === 200 && body.app_name === "KumikoRoom",
      occupied: true,
      status: result.status
    };
  } catch {
    return {
      ready: false,
      occupied: true,
      status: result.status,
      error: "Endpoint did not return KumikoRoom API JSON"
    };
  }
}

export async function isKumikoWebReady(url: string, timeoutMs = 1_000): Promise<EndpointReadiness> {
  const result = await probeHttp(url, timeoutMs);
  if (!result.occupied || !result.text) {
    return result;
  }

  const looksLikeKumikoRoom =
    result.text.includes("KumikoRoom") || result.text.includes("久美子");

  return {
    ready: result.status === 200 && looksLikeKumikoRoom,
    occupied: true,
    status: result.status,
    error: looksLikeKumikoRoom ? undefined : "Endpoint did not return KumikoRoom web HTML"
  };
}

export async function waitUntilReady(
  probe: () => Promise<EndpointReadiness>,
  options: WaitOptions
): Promise<EndpointReadiness> {
  const sleep = options.sleep ?? defaultSleep;
  const startedAt = Date.now();
  let last: EndpointReadiness = { ready: false, occupied: false };

  while (Date.now() - startedAt <= options.timeoutMs) {
    last = await probe();
    if (last.ready) {
      return last;
    }
    await sleep(options.intervalMs);
  }

  return {
    ...last,
    ready: false,
    error: last.error ?? `Timed out after ${options.timeoutMs}ms`
  };
}
```

- [ ] **Step 4: Run readiness tests and commit**

Run:

```powershell
npm run test --workspace apps/desktop -- ports.test.ts
```

Expected: PASS for `ports.test.ts`.

Commit:

```powershell
git add apps/desktop/src/ports.ts apps/desktop/tests/ports.test.ts
git commit -m "feat: add desktop readiness probes"
```

---

### Task 3: Child Process Commands and Logs

**Files:**
- Create: `apps/desktop/src/processes.ts`
- Create: `apps/desktop/tests/processes.test.ts`

- [ ] **Step 1: Write failing process tests**

Create `apps/desktop/tests/processes.test.ts`:

```typescript
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { getDesktopConfig, resolveRepoRoot } from "../src/config";
import {
  BoundedLogBuffer,
  buildApiProcessConfig,
  buildWebProcessConfig,
  createManagedProcess
} from "../src/processes";

describe("desktop process helpers", () => {
  it("builds the API command from desktop config", () => {
    const config = getDesktopConfig({ KUMIKOROOM_API_PORT: "8011" }, process.cwd());
    const command = buildApiProcessConfig(config, {
      existsSync: () => false,
      env: {}
    });

    expect(command.command).toBe("python");
    expect(command.args).toEqual([
      "-m",
      "uvicorn",
      "kumikoroom.main:app",
      "--reload",
      "--host",
      "127.0.0.1",
      "--port",
      "8011"
    ]);
    expect(command.cwd).toBe(path.join(config.repoRoot, "apps", "api"));
  });

  it("prefers an explicit Python executable", () => {
    const config = getDesktopConfig({}, process.cwd());
    const command = buildApiProcessConfig(config, {
      existsSync: () => false,
      env: { KUMIKOROOM_PYTHON: "C:\\Python311\\python.exe" }
    });

    expect(command.command).toBe("C:\\Python311\\python.exe");
  });

  it("builds the web command and passes API URL to Next", () => {
    const config = getDesktopConfig(
      { KUMIKOROOM_WEB_PORT: "3011", KUMIKOROOM_API_URL: "http://127.0.0.1:8011" },
      process.cwd()
    );
    const command = buildWebProcessConfig(config, { platform: "win32" });

    expect(command.command).toBe("npm.cmd");
    expect(command.args).toEqual(["run", "dev", "--workspace", "apps/web", "--", "-H", "127.0.0.1", "-p", "3011"]);
    expect(command.cwd).toBe(resolveRepoRoot(process.cwd()));
    expect(command.env.KUMIKOROOM_API_URL).toBe("http://127.0.0.1:8011");
    expect(command.env.NEXT_PUBLIC_KUMIKOROOM_API_BASE_URL).toBe("http://127.0.0.1:8011");
  });

  it("keeps only the most recent log lines", () => {
    const buffer = new BoundedLogBuffer(3);

    buffer.push("one\ntwo");
    buffer.push("three");
    buffer.push("four");

    expect(buffer.lines()).toEqual(["two", "three", "four"]);
  });

  it("stops an owned child process", async () => {
    const kill = vi.fn();
    const child = {
      stdout: { on: vi.fn() },
      stderr: { on: vi.fn() },
      on: vi.fn(),
      once: vi.fn((_event: string, callback: () => void) => {
        callback();
        return child;
      }),
      kill
    };

    const managed = createManagedProcess("api", child as never, { command: "python", args: [], cwd: process.cwd(), env: {} });
    await managed.stop();

    expect(kill).toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Run process tests and verify they fail**

Run:

```powershell
npm run test --workspace apps/desktop -- processes.test.ts
```

Expected: FAIL with "Cannot find module '../src/processes'".

- [ ] **Step 3: Implement process helpers**

Create `apps/desktop/src/processes.ts`:

```typescript
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import type { DesktopConfig } from "./config";
import type { DesktopServiceName } from "./launchTypes";

export interface ProcessCommand {
  command: string;
  args: string[];
  cwd: string;
  env: NodeJS.ProcessEnv;
}

export interface BuildApiOptions {
  existsSync?: (path: string) => boolean;
  env?: NodeJS.ProcessEnv;
}

export interface BuildWebOptions {
  platform?: NodeJS.Platform;
}

export class BoundedLogBuffer {
  private readonly entries: string[] = [];

  constructor(private readonly limit = 120) {}

  push(chunk: string): void {
    for (const line of chunk.split(/\r?\n/)) {
      const trimmed = line.trimEnd();
      if (trimmed.length === 0) {
        continue;
      }
      this.entries.push(trimmed);
    }

    while (this.entries.length > this.limit) {
      this.entries.shift();
    }
  }

  lines(): string[] {
    return [...this.entries];
  }
}

export interface ManagedProcess {
  service: DesktopServiceName;
  logs: BoundedLogBuffer;
  exited: boolean;
  exitCode?: number | null;
  stop: () => Promise<void>;
}

function venvPython(apiDir: string, existsSync: (path: string) => boolean): string | undefined {
  const candidate =
    process.platform === "win32"
      ? path.join(apiDir, ".venv", "Scripts", "python.exe")
      : path.join(apiDir, ".venv", "bin", "python");

  return existsSync(candidate) ? candidate : undefined;
}

export function buildApiProcessConfig(config: DesktopConfig, options: BuildApiOptions = {}): ProcessCommand {
  const env = options.env ?? process.env;
  const existsSync = options.existsSync ?? fs.existsSync;
  const explicitPython = env.KUMIKOROOM_PYTHON?.trim();

  return {
    command: explicitPython && explicitPython.length > 0 ? explicitPython : venvPython(config.apiDir, existsSync) ?? "python",
    args: [
      "-m",
      "uvicorn",
      "kumikoroom.main:app",
      "--reload",
      "--host",
      config.api.host,
      "--port",
      String(config.api.port)
    ],
    cwd: config.apiDir,
    env: {
      ...process.env,
      KUMIKOROOM_MEMORY_DB_PATH:
        env.KUMIKOROOM_MEMORY_DB_PATH ?? path.join(config.repoRoot, "user-data", "memory", "kumikoroom-memory.sqlite3")
    }
  };
}

export function buildWebProcessConfig(config: DesktopConfig, options: BuildWebOptions = {}): ProcessCommand {
  const platform = options.platform ?? process.platform;

  return {
    command: platform === "win32" ? "npm.cmd" : "npm",
    args: ["run", "dev", "--workspace", "apps/web", "--", "-H", config.web.host, "-p", String(config.web.port)],
    cwd: config.repoRoot,
    env: {
      ...process.env,
      KUMIKOROOM_API_URL: config.api.baseUrl,
      NEXT_PUBLIC_KUMIKOROOM_API_BASE_URL: config.api.baseUrl
    }
  };
}

export function createManagedProcess(
  service: DesktopServiceName,
  child: ChildProcessWithoutNullStreams,
  _command: ProcessCommand
): ManagedProcess {
  const logs = new BoundedLogBuffer();
  const managed: ManagedProcess = {
    service,
    logs,
    exited: false,
    stop: () =>
      new Promise<void>((resolve) => {
        if (managed.exited) {
          resolve();
          return;
        }
        child.once("exit", () => resolve());
        child.kill();
        setTimeout(resolve, 2_000).unref();
      })
  };

  child.stdout.on("data", (chunk) => logs.push(String(chunk)));
  child.stderr.on("data", (chunk) => logs.push(String(chunk)));
  child.on("exit", (code) => {
    managed.exited = true;
    managed.exitCode = code;
  });

  return managed;
}

export function startProcess(service: DesktopServiceName, command: ProcessCommand): ManagedProcess {
  const child = spawn(command.command, command.args, {
    cwd: command.cwd,
    env: command.env,
    shell: false,
    windowsHide: true
  });

  return createManagedProcess(service, child, command);
}
```

- [ ] **Step 4: Run process tests and commit**

Run:

```powershell
npm run test --workspace apps/desktop -- processes.test.ts
```

Expected: PASS for `processes.test.ts`.

Commit:

```powershell
git add apps/desktop/src/processes.ts apps/desktop/tests/processes.test.ts
git commit -m "feat: add desktop managed process helpers"
```

---

### Task 4: Desktop Launcher State Machine

**Files:**
- Create: `apps/desktop/src/launcher.ts`
- Create: `apps/desktop/tests/launcher.test.ts`

- [ ] **Step 1: Write failing launcher tests**

Create `apps/desktop/tests/launcher.test.ts`:

```typescript
import { describe, expect, it, vi } from "vitest";
import { getDesktopConfig } from "../src/config";
import type { EndpointReadiness } from "../src/ports";
import type { ManagedProcess } from "../src/processes";
import { DesktopLauncher } from "../src/launcher";

function ready(): EndpointReadiness {
  return { ready: true, occupied: true, status: 200 };
}

function closed(): EndpointReadiness {
  return { ready: false, occupied: false, error: "ECONNREFUSED" };
}

function occupied(): EndpointReadiness {
  return { ready: false, occupied: true, status: 200, error: "other service" };
}

function fakeProcess(service: "api" | "web"): ManagedProcess {
  return {
    service,
    logs: { lines: () => [`${service} log`] } as never,
    exited: false,
    stop: vi.fn(async () => undefined)
  };
}

describe("DesktopLauncher", () => {
  it("reuses services that are already ready", async () => {
    const config = getDesktopConfig({}, process.cwd());
    const states: string[] = [];
    const launcher = new DesktopLauncher(config, {
      checkApi: vi.fn(async () => ready()),
      checkWeb: vi.fn(async () => ready()),
      waitForApi: vi.fn(),
      waitForWeb: vi.fn(),
      startProcess: vi.fn()
    });

    launcher.onState((state) => states.push(state.phase));
    const result = await launcher.start();

    expect(result.phase).toBe("ready");
    expect(result.webUrl).toBe("http://127.0.0.1:3000/room");
    expect(states).toEqual(["checking-api", "checking-web", "ready"]);
  });

  it("starts missing API and web services", async () => {
    const config = getDesktopConfig({}, process.cwd());
    const started: string[] = [];
    const launcher = new DesktopLauncher(config, {
      checkApi: vi.fn(async () => closed()),
      checkWeb: vi.fn(async () => closed()),
      waitForApi: vi.fn(async () => ready()),
      waitForWeb: vi.fn(async () => ready()),
      startProcess: vi.fn((service) => {
        started.push(service);
        return fakeProcess(service);
      })
    });

    const result = await launcher.start();

    expect(result.phase).toBe("ready");
    expect(started).toEqual(["api", "web"]);
  });

  it("fails when the API port is occupied by another service", async () => {
    const config = getDesktopConfig({}, process.cwd());
    const launcher = new DesktopLauncher(config, {
      checkApi: vi.fn(async () => occupied()),
      checkWeb: vi.fn(async () => ready()),
      waitForApi: vi.fn(),
      waitForWeb: vi.fn(),
      startProcess: vi.fn()
    });

    const result = await launcher.start();

    expect(result.phase).toBe("failed");
    expect(result.error?.code).toBe("port-occupied");
    expect(result.error?.service).toBe("api");
  });

  it("fails with logs when a started service never becomes ready", async () => {
    const config = getDesktopConfig({}, process.cwd());
    const launcher = new DesktopLauncher(config, {
      checkApi: vi.fn(async () => closed()),
      checkWeb: vi.fn(async () => ready()),
      waitForApi: vi.fn(async () => ({ ready: false, occupied: false, error: "Timed out" })),
      waitForWeb: vi.fn(),
      startProcess: vi.fn((service) => fakeProcess(service))
    });

    const result = await launcher.start();

    expect(result.phase).toBe("failed");
    expect(result.error?.code).toBe("timeout");
    expect(result.error?.logs).toEqual(["api log"]);
  });

  it("stops only processes that it started", async () => {
    const config = getDesktopConfig({}, process.cwd());
    const apiProcess = fakeProcess("api");
    const webProcess = fakeProcess("web");
    const launcher = new DesktopLauncher(config, {
      checkApi: vi.fn(async () => closed()),
      checkWeb: vi.fn(async () => closed()),
      waitForApi: vi.fn(async () => ready()),
      waitForWeb: vi.fn(async () => ready()),
      startProcess: vi.fn((service) => (service === "api" ? apiProcess : webProcess))
    });

    await launcher.start();
    await launcher.shutdown();

    expect(apiProcess.stop).toHaveBeenCalled();
    expect(webProcess.stop).toHaveBeenCalled();
  });

  it("stops owned processes before starting again", async () => {
    const config = getDesktopConfig({}, process.cwd());
    const apiProcess = fakeProcess("api");
    const webProcess = fakeProcess("web");
    const launcher = new DesktopLauncher(config, {
      checkApi: vi.fn().mockResolvedValueOnce(closed()).mockResolvedValueOnce(ready()),
      checkWeb: vi.fn().mockResolvedValueOnce(closed()).mockResolvedValueOnce(ready()),
      waitForApi: vi.fn(async () => ready()),
      waitForWeb: vi.fn(async () => ready()),
      startProcess: vi.fn((service) => (service === "api" ? apiProcess : webProcess))
    });

    await launcher.start();
    await launcher.start();

    expect(apiProcess.stop).toHaveBeenCalled();
    expect(webProcess.stop).toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Run launcher tests and verify they fail**

Run:

```powershell
npm run test --workspace apps/desktop -- launcher.test.ts
```

Expected: FAIL with "Cannot find module '../src/launcher'".

- [ ] **Step 3: Implement launcher orchestration**

Create `apps/desktop/src/launcher.ts`:

```typescript
import type { DesktopConfig } from "./config";
import type { DesktopServiceName, LaunchError, LaunchState, ServiceState } from "./launchTypes";
import { isKumikoApiReady, isKumikoWebReady, waitUntilReady, type EndpointReadiness } from "./ports";
import {
  buildApiProcessConfig,
  buildWebProcessConfig,
  startProcess,
  type ManagedProcess
} from "./processes";

export interface LauncherDeps {
  checkApi?: () => Promise<EndpointReadiness>;
  checkWeb?: () => Promise<EndpointReadiness>;
  waitForApi?: () => Promise<EndpointReadiness>;
  waitForWeb?: () => Promise<EndpointReadiness>;
  startProcess?: (service: DesktopServiceName) => ManagedProcess;
}

type Listener = (state: LaunchState) => void;

export class DesktopLauncher {
  private readonly listeners = new Set<Listener>();
  private readonly owned = new Map<DesktopServiceName, ManagedProcess>();
  private state: LaunchState;

  constructor(
    private readonly config: DesktopConfig,
    private readonly deps: LauncherDeps = {}
  ) {
    this.state = this.makeState("idle", "准备启动 KumikoRoom", "等待本地服务检查。");
  }

  onState(listener: Listener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  currentState(): LaunchState {
    return this.state;
  }

  async start(): Promise<LaunchState> {
    await this.stopOwnedProcesses();

    const api = await this.ensureApi();
    if (!api.ready) {
      return this.fail(api.error);
    }

    const web = await this.ensureWeb();
    if (!web.ready) {
      return this.fail(web.error);
    }

    return this.emit(
      this.makeState("ready", "KumikoRoom 已就绪", "正在打开对话界面。", {
        api: { status: api.reused ? "reused" : "ready", detail: api.reused ? "已复用现有服务" : "由桌面端启动" },
        web: { status: web.reused ? "reused" : "ready", detail: web.reused ? "已复用现有服务" : "由桌面端启动" },
        webUrl: this.config.web.url,
        retryable: false
      })
    );
  }

  async shutdown(): Promise<void> {
    await this.stopOwnedProcesses();
    this.emit(this.makeState("stopped", "KumikoRoom 已关闭", "桌面端启动的本地服务已停止。"));
  }

  private async stopOwnedProcesses(): Promise<void> {
    const processes = [...this.owned.values()];
    this.owned.clear();
    await Promise.all(processes.map((process) => process.stop()));
  }

  private async ensureApi(): Promise<{ ready: boolean; reused?: boolean; error?: LaunchError }> {
    this.emit(this.makeState("checking-api", "正在检查本地 API", "确认 API 服务是否已经可用。", {
      api: { status: "checking" }
    }));

    const existing = await (this.deps.checkApi ?? (() => isKumikoApiReady(this.config.api.healthUrl)))();
    if (existing.ready) {
      return { ready: true, reused: true };
    }
    if (existing.occupied) {
      return {
        ready: false,
        error: {
          service: "api",
          code: "port-occupied",
          message: `端口 ${this.config.api.port} 已被其他服务占用。`
        }
      };
    }
    if (!this.config.autoStart) {
      return {
        ready: false,
        error: {
          service: "api",
          code: "timeout",
          message: "自动启动已关闭，本地 API 当前不可用。"
        }
      };
    }

    this.emit(this.makeState("starting-api", "正在启动本地 API", "桌面端正在启动 FastAPI 服务。", {
      api: { status: "starting" }
    }));
    const process = (this.deps.startProcess ?? this.defaultStartProcess)("api");
    this.owned.set("api", process);
    const ready = await (this.deps.waitForApi ??
      (() =>
        waitUntilReady(() => isKumikoApiReady(this.config.api.healthUrl), {
          timeoutMs: this.config.launchTimeoutMs,
          intervalMs: this.config.pollIntervalMs
        })))();

    if (ready.ready) {
      return { ready: true };
    }

    return {
      ready: false,
      error: {
        service: "api",
        code: process.exited ? "process-exited" : "timeout",
        message: ready.error ?? "本地 API 没有在限定时间内启动。",
        logs: process.logs.lines()
      }
    };
  }

  private async ensureWeb(): Promise<{ ready: boolean; reused?: boolean; error?: LaunchError }> {
    this.emit(this.makeState("checking-web", "正在检查界面服务", "确认本地界面是否已经可用。", {
      api: { status: "ready" },
      web: { status: "checking" }
    }));

    const existing = await (this.deps.checkWeb ?? (() => isKumikoWebReady(this.config.web.healthUrl)))();
    if (existing.ready) {
      return { ready: true, reused: true };
    }
    if (existing.occupied) {
      return {
        ready: false,
        error: {
          service: "web",
          code: "port-occupied",
          message: `端口 ${this.config.web.port} 已被其他服务占用。`
        }
      };
    }
    if (!this.config.autoStart) {
      return {
        ready: false,
        error: {
          service: "web",
          code: "timeout",
          message: "自动启动已关闭，本地界面服务当前不可用。"
        }
      };
    }

    this.emit(this.makeState("starting-web", "正在启动界面服务", "桌面端正在启动 Next.js 开发服务。", {
      api: { status: "ready" },
      web: { status: "starting" }
    }));
    const process = (this.deps.startProcess ?? this.defaultStartProcess)("web");
    this.owned.set("web", process);
    const ready = await (this.deps.waitForWeb ??
      (() =>
        waitUntilReady(() => isKumikoWebReady(this.config.web.healthUrl), {
          timeoutMs: this.config.launchTimeoutMs,
          intervalMs: this.config.pollIntervalMs
        })))();

    if (ready.ready) {
      return { ready: true };
    }

    return {
      ready: false,
      error: {
        service: "web",
        code: process.exited ? "process-exited" : "timeout",
        message: ready.error ?? "界面服务没有在限定时间内启动。",
        logs: process.logs.lines()
      }
    };
  }

  private defaultStartProcess = (service: DesktopServiceName): ManagedProcess => {
    const command =
      service === "api" ? buildApiProcessConfig(this.config) : buildWebProcessConfig(this.config);
    return startProcess(service, command);
  };

  private fail(error?: LaunchError): LaunchState {
    return this.emit(
      this.makeState("failed", "启动遇到问题", error?.message ?? "本地服务没有启动成功。", {
        error: error ?? {
          code: "unknown",
          message: "本地服务没有启动成功。"
        },
        retryable: true,
        api: error?.service === "api" ? { status: "failed" } : undefined,
        web: error?.service === "web" ? { status: "failed" } : undefined
      })
    );
  }

  private makeState(
    phase: LaunchState["phase"],
    title: string,
    detail: string,
    overrides: {
      api?: Partial<ServiceState>;
      web?: Partial<ServiceState>;
      error?: LaunchError;
      retryable?: boolean;
      webUrl?: string;
    } = {}
  ): LaunchState {
    return {
      phase,
      title,
      detail,
      retryable: overrides.retryable ?? false,
      error: overrides.error,
      webUrl: overrides.webUrl,
      api: {
        name: "api",
        label: "本地 API",
        port: this.config.api.port,
        status: "unknown",
        ...overrides.api
      },
      web: {
        name: "web",
        label: "界面服务",
        port: this.config.web.port,
        status: "unknown",
        ...overrides.web
      }
    };
  }

  private emit(state: LaunchState): LaunchState {
    this.state = state;
    for (const listener of this.listeners) {
      listener(state);
    }
    return state;
  }
}
```

- [ ] **Step 4: Run launcher tests and commit**

Run:

```powershell
npm run test --workspace apps/desktop -- launcher.test.ts
```

Expected: PASS for `launcher.test.ts`.

Commit:

```powershell
git add apps/desktop/src/launcher.ts apps/desktop/tests/launcher.test.ts
git commit -m "feat: add desktop service launcher"
```

---

### Task 5: Electron Main Wiring and Retry Navigation

**Files:**
- Create: `apps/desktop/src/navigation.ts`
- Create: `apps/desktop/src/appController.ts`
- Modify: `apps/desktop/src/main.ts`
- Create: `apps/desktop/tests/navigation.test.ts`
- Create: `apps/desktop/tests/appController.test.ts`

- [ ] **Step 1: Write failing navigation tests**

Create `apps/desktop/tests/navigation.test.ts`:

```typescript
import { describe, expect, it } from "vitest";
import type { LaunchState } from "../src/launchTypes";
import { isRetryUrl, statusPageDataUrl } from "../src/navigation";

const state: LaunchState = {
  phase: "failed",
  title: "启动遇到问题",
  detail: "界面服务没有启动成功",
  retryable: true,
  api: { name: "api", label: "本地 API", port: 8000, status: "ready" },
  web: { name: "web", label: "界面服务", port: 3000, status: "failed" }
};

describe("desktop navigation helpers", () => {
  it("builds a UTF-8 data URL for the status page", () => {
    const url = statusPageDataUrl(state);

    expect(url.startsWith("data:text/html;charset=UTF-8,")).toBe(true);
    expect(decodeURIComponent(url.split(",", 2)[1])).toContain("启动遇到问题");
  });

  it("recognizes retry URLs", () => {
    expect(isRetryUrl("kumikoroom://retry")).toBe(true);
    expect(isRetryUrl("http://127.0.0.1:3000/room")).toBe(false);
  });
});
```

- [ ] **Step 2: Run navigation tests and verify they fail**

Run:

```powershell
npm run test --workspace apps/desktop -- navigation.test.ts
```

Expected: FAIL with "Cannot find module '../src/navigation'".

- [ ] **Step 3: Implement navigation helpers**

Create `apps/desktop/src/navigation.ts`:

```typescript
import type { LaunchState } from "./launchTypes";
import { renderStatusPage } from "./statusPage";

export const RETRY_URL = "kumikoroom://retry";

export function statusPageDataUrl(state: LaunchState): string {
  return `data:text/html;charset=UTF-8,${encodeURIComponent(renderStatusPage(state))}`;
}

export function isRetryUrl(url: string): boolean {
  return url === RETRY_URL;
}
```

- [ ] **Step 4: Run navigation tests and verify they pass**

Run:

```powershell
npm run test --workspace apps/desktop -- navigation.test.ts
```

Expected: PASS for `navigation.test.ts`.

- [ ] **Step 5: Write failing app-controller tests**

Create `apps/desktop/tests/appController.test.ts`:

```typescript
import { describe, expect, it, vi } from "vitest";
import type { LaunchState } from "../src/launchTypes";
import { DesktopAppController, type LauncherLike } from "../src/appController";

function state(phase: LaunchState["phase"], webUrl?: string): LaunchState {
  return {
    phase,
    title: phase === "ready" ? "KumikoRoom 已就绪" : "正在启动 KumikoRoom",
    detail: "测试状态",
    retryable: phase === "failed",
    webUrl,
    api: { name: "api", label: "本地 API", port: 8000, status: phase === "ready" ? "ready" : "starting" },
    web: { name: "web", label: "界面服务", port: 3000, status: phase === "ready" ? "ready" : "unknown" }
  };
}

function launcher(result: LaunchState): LauncherLike {
  const listeners: Array<(state: LaunchState) => void> = [];
  return {
    currentState: () => state("idle"),
    onState: (listener) => {
      listeners.push(listener);
      return () => undefined;
    },
    start: vi.fn(async () => {
      listeners.forEach((listener) => listener(state("starting-api")));
      return result;
    }),
    shutdown: vi.fn(async () => undefined)
  };
}

describe("DesktopAppController", () => {
  it("renders launch status and loads the web URL when ready", async () => {
    const loadURL = vi.fn(async () => undefined);
    const readyLauncher = launcher(state("ready", "http://127.0.0.1:3000/room"));
    const controller = new DesktopAppController(
      { loadURL },
      () => readyLauncher,
      (launchState) => `status:${launchState.phase}`
    );

    await controller.start();

    expect(loadURL).toHaveBeenCalledWith("status:idle");
    expect(loadURL).toHaveBeenCalledWith("status:starting-api");
    expect(loadURL).toHaveBeenCalledWith("http://127.0.0.1:3000/room");
  });

  it("renders failure status when launcher returns a failed state", async () => {
    const loadURL = vi.fn(async () => undefined);
    const failed = state("failed");
    const controller = new DesktopAppController(
      { loadURL },
      () => launcher(failed),
      (launchState) => `status:${launchState.phase}`
    );

    await controller.start();

    expect(loadURL).toHaveBeenLastCalledWith("status:failed");
  });

  it("shuts down the active launcher", async () => {
    const loadURL = vi.fn(async () => undefined);
    const activeLauncher = launcher(state("ready", "http://127.0.0.1:3000/room"));
    const controller = new DesktopAppController({ loadURL }, () => activeLauncher);

    await controller.start();
    await controller.shutdown();

    expect(activeLauncher.shutdown).toHaveBeenCalled();
  });
});
```

- [ ] **Step 6: Run app-controller tests and verify they fail**

Run:

```powershell
npm run test --workspace apps/desktop -- appController.test.ts
```

Expected: FAIL with "Cannot find module '../src/appController'".

- [ ] **Step 7: Implement app controller**

Create `apps/desktop/src/appController.ts`:

```typescript
import type { LaunchState } from "./launchTypes";
import { statusPageDataUrl } from "./navigation";

export interface DesktopWindowLike {
  loadURL: (url: string) => Promise<unknown>;
}

export interface LauncherLike {
  currentState: () => LaunchState;
  onState: (listener: (state: LaunchState) => void) => () => void;
  start: () => Promise<LaunchState>;
  shutdown: () => Promise<void>;
}

export type LauncherFactory = () => LauncherLike;
export type StatusUrlRenderer = (state: LaunchState) => string;

export class DesktopAppController {
  private activeLauncher: LauncherLike | null = null;
  private unsubscribe: (() => void) | null = null;
  private launching = false;

  constructor(
    private readonly window: DesktopWindowLike,
    private readonly createLauncher: LauncherFactory,
    private readonly renderStatusUrl: StatusUrlRenderer = statusPageDataUrl
  ) {}

  async start(): Promise<void> {
    if (this.launching) {
      return;
    }

    this.launching = true;
    await this.shutdownActiveLauncher();
    const launcher = this.createLauncher();
    this.activeLauncher = launcher;
    this.unsubscribe = launcher.onState((state) => {
      if (state.phase !== "ready") {
        void this.showStatus(state);
      }
    });

    try {
      await this.showStatus(launcher.currentState());
      const result = await launcher.start();
      if (result.phase === "ready" && result.webUrl) {
        await this.window.loadURL(result.webUrl);
      } else {
        await this.showStatus(result);
      }
    } catch (error) {
      await this.showStatus({
        phase: "failed",
        title: "启动遇到问题",
        detail: error instanceof Error ? error.message : String(error),
        retryable: true,
        api: { name: "api", label: "本地 API", port: 8000, status: "failed" },
        web: { name: "web", label: "界面服务", port: 3000, status: "failed" },
        error: {
          service: "desktop",
          code: "unknown",
          message: error instanceof Error ? error.message : String(error)
        }
      });
    } finally {
      this.launching = false;
    }
  }

  async shutdown(): Promise<void> {
    await this.shutdownActiveLauncher();
  }

  private async showStatus(state: LaunchState): Promise<void> {
    await this.window.loadURL(this.renderStatusUrl(state));
  }

  private async shutdownActiveLauncher(): Promise<void> {
    this.unsubscribe?.();
    this.unsubscribe = null;
    const launcher = this.activeLauncher;
    this.activeLauncher = null;
    if (launcher) {
      await launcher.shutdown();
    }
  }
}
```

- [ ] **Step 8: Run app-controller tests and verify they pass**

Run:

```powershell
npm run test --workspace apps/desktop -- appController.test.ts
```

Expected: PASS for `appController.test.ts`.

- [ ] **Step 9: Wire Electron main process**

Replace `apps/desktop/src/main.ts` with:

```typescript
import { app, BrowserWindow, Menu, shell } from "electron";
import { DesktopAppController } from "./appController";
import { getDesktopConfig, windowOptions } from "./config";
import { DesktopLauncher } from "./launcher";
import { isRetryUrl } from "./navigation";

let mainWindow: BrowserWindow | null = null;
let controller: DesktopAppController | null = null;
let quitting = false;

function installMenu(): void {
  Menu.setApplicationMenu(
    Menu.buildFromTemplate([
      {
        label: "KumikoRoom",
        submenu: [
          {
            label: "重试启动",
            click: () => {
              void controller?.start();
            }
          },
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
  mainWindow = new BrowserWindow(windowOptions);
  controller = new DesktopAppController(mainWindow, () => new DesktopLauncher(getDesktopConfig(process.env, process.cwd())));

  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (isRetryUrl(url)) {
      void controller?.start();
      return { action: "deny" };
    }

    void shell.openExternal(url);
    return { action: "deny" };
  });

  mainWindow.webContents.on("will-navigate", (event, url) => {
    if (isRetryUrl(url)) {
      event.preventDefault();
      void controller?.start();
    }
  });

  mainWindow.once("ready-to-show", () => {
    mainWindow?.show();
  });

  await controller.start();
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

app.on("before-quit", (event) => {
  if (quitting || !controller) {
    return;
  }

  event.preventDefault();
  quitting = true;
  const activeController = controller;
  controller = null;
  void activeController.shutdown().finally(() => app.quit());
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") {
    app.quit();
  }
});
```

- [ ] **Step 10: Run desktop tests and TypeScript build**

Run:

```powershell
npm run test --workspace apps/desktop
npm run build --workspace apps/desktop
```

Expected: both commands exit 0.

- [ ] **Step 11: Commit Electron wiring**

Commit:

```powershell
git add apps/desktop/src/navigation.ts apps/desktop/src/appController.ts apps/desktop/src/main.ts apps/desktop/tests/navigation.test.ts apps/desktop/tests/appController.test.ts
git commit -m "feat: wire desktop launcher into electron"
```

---

### Task 6: Documentation and End-to-End Verification

**Files:**
- Modify: `README.md`

- [ ] **Step 1: Update README desktop section**

Modify the desktop section in `README.md` to:

````markdown
Desktop development app:

```powershell
npm install
npm run dev:desktop
```

The desktop command builds and opens the Electron shell. In Stage 1 it also checks the local FastAPI and Next.js services, starts missing services from the repository checkout, shows launch progress in the desktop window, and loads `/room` when both services are ready.

Useful environment overrides:

```powershell
$env:KUMIKOROOM_API_PORT="8000"
$env:KUMIKOROOM_WEB_PORT="3000"
$env:KUMIKOROOM_PYTHON="C:\Path\To\python.exe"
$env:KUMIKOROOM_DESKTOP_AUTOSTART="0"
```

If startup fails, use the desktop status page logs first. For DeepSeek-backed chat, keep `DEEPSEEK_API_KEY` local and start from `.env.example`.
````

- [ ] **Step 2: Run full desktop verification**

Run:

```powershell
npm run test --workspace apps/desktop
npm run build --workspace apps/desktop
```

Expected: both commands exit 0.

- [ ] **Step 3: Run cross-workspace verification**

Run:

```powershell
npm test
```

Expected: web and desktop test suites exit 0.

- [ ] **Step 4: Check generated and ignored files**

Run:

```powershell
git status -sb
rg -n "sk-[A-Za-z0-9]{20,}|044422|b699d|e0aa437" .
```

Expected:

- `git status -sb` shows only intended source, test, and README changes.
- `rg` exits 1 with no matches for secrets.

- [ ] **Step 5: Manual desktop smoke test**

Run:

```powershell
npm run dev:desktop
```

Expected:

- Electron opens a KumikoRoom window.
- The launch status page appears while services start.
- The API service is reachable at `http://127.0.0.1:8000/api/room/state`.
- The web service is reachable at `http://127.0.0.1:3000/room`.
- The Electron window loads `/room`.
- Quitting Electron stops processes started by the desktop launcher.

- [ ] **Step 6: Commit docs and final verification notes**

Commit:

```powershell
git add README.md
git commit -m "docs: document desktop development launcher"
```

---

## Final Review Checklist

- [ ] `docs/superpowers/specs/2026-06-08-desktop-app-design.md` Stage 1 acceptance criteria map to implemented tasks.
- [ ] Launcher starts missing API and web services.
- [ ] Launcher reuses already-running KumikoRoom API and web services.
- [ ] Launcher reports occupied ports clearly.
- [ ] Status page uses readable Chinese text and escapes logs.
- [ ] Electron retry link and menu action retry startup.
- [ ] Quitting Electron stops only owned child processes.
- [ ] `npm run test --workspace apps/desktop` exits 0.
- [ ] `npm run build --workspace apps/desktop` exits 0.
- [ ] `npm test` exits 0.
- [ ] Secret scan has no matches.
- [ ] Manual `npm run dev:desktop` smoke test result is recorded in the final response.

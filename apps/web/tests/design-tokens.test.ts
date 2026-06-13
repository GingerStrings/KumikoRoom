import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const cssPath = path.resolve(__dirname, "../app/globals.css");

function expectRuleToContain(css: string, selector: string, declarations: string[]) {
  const escapedSelector = selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = css.match(new RegExp(`${escapedSelector}\\s*\\{(?<body>[^}]*)\\}`));

  expect(match, `Expected ${selector} rule to exist`).not.toBeNull();

  const body = match?.groups?.body ?? "";

  for (const declaration of declarations) {
    expect(body).toContain(declaration);
  }
}

describe("Liz Bluebird room visual tokens", () => {
  it("uses the Liz and the Blue Bird inspired palette tokens", () => {
    const css = fs.readFileSync(cssPath, "utf8");

    expect(css).toContain("--color-bg: #fdfff8");
    expect(css).toContain("--color-bg-mist: #d3f4f8");
    expect(css).toContain("--color-bg-pink: #ffebf9");
    expect(css).toContain("--color-bg-green: #dffbea");
    expect(css).toContain("--color-accent-blue: #0b73d4");
    expect(css).toContain("--color-accent-sky: #9ce9ff");
    expect(css).toContain("--color-accent-reed: #95ad92");
    expect(css).toContain("--color-accent-kumiko: #b87b68");
    expect(css).toContain("--color-text: #263a40");
    expect(css).toContain("--color-muted: #6b7d80");
  });

  it("keeps legacy room variable aliases mapped to the Liz tokens", () => {
    const css = fs.readFileSync(cssPath, "utf8");

    expect(css).toContain("--paper: var(--color-surface-strong);");
    expect(css).toContain("--paper-soft: var(--color-surface);");
    expect(css).toContain("--ink: var(--color-text);");
    expect(css).toContain("--muted: var(--color-muted);");
    expect(css).toContain("--line: var(--color-line);");
    expect(css).toContain("--green: var(--color-accent-reed);");
    expect(css).toContain("--red: var(--color-accent-kumiko);");
    expect(css).toContain("--gold: var(--color-accent-kumiko);");
    expect(css).toContain("--blue: var(--color-accent-blue);");
  });

  it("covers all dynamic connection tone selectors", () => {
    const css = fs.readFileSync(cssPath, "utf8");

    [
      "connection-chip--muted",
      "connection-chip--ready",
      "connection-chip--warning",
      "connection-pill--muted",
      "connection-pill--ready",
      "connection-pill--warning",
    ].forEach((selector) => {
      expect(css).toContain(`.${selector}`);
    });
  });

  it("keeps the room composer visible in the first viewport", () => {
    const css = fs.readFileSync(cssPath, "utf8").replace(/\r\n/g, "\n");

    expectRuleToContain(css, ".room-workspace", [
      "height: min(724px, calc(100vh - 48px));",
      "overflow: hidden;",
    ]);
    expectRuleToContain(css, ".chat", ["grid-template-rows: 60px minmax(0, 1fr) auto;"]);
    expectRuleToContain(css, ".chat-timeline", ["min-height: 0;"]);
    expectRuleToContain(css, ".chat-composer", ["border-top: 1px solid #d8e2dd;"]);
  });

  it("defines the v6 room shell and settings popover selectors", () => {
    const css = fs.readFileSync(cssPath, "utf8");

    [
      ".room-stage",
      ".room-workspace {",
      ".session-sidebar {",
      ".session-sidebar--collapsed",
      ".thread[data-active=\"true\"]",
      ".chat {",
      ".chat-head",
      ".profile",
      ".media-player",
      ".settings-trigger",
      ".settings-popover {",
      ".settings-popover__header",
      ".model-status-row",
      ".settings-section",
    ].forEach((selector) => {
      expect(css).toContain(selector);
    });
  });

  it("removes stale right rail selectors", () => {
    const css = fs.readFileSync(cssPath, "utf8");

    [
      ".room-workspace:has(.workspace-side)",
      ".room-workspace--sessions-collapsed:has(.workspace-side)",
      ".workspace-side",
      ".summary-card",
      ".utility-card",
      ".ai-card",
      ".summary-list",
      ".summary-row",
      ".utility-row",
      ".utility-note",
      ".memory-events",
    ].forEach((selector) => {
      expect(css).not.toContain(selector);
    });
  });

  it("removes the old rose, fog, green, and brass room palette values", () => {
    const css = fs.readFileSync(cssPath, "utf8");

    expect(css).not.toContain("--color-rose");
    expect(css).not.toContain("--color-fog");
    expect(css).not.toContain("--brass:");
    expect(css).not.toContain("#fafaf8");
    expect(css).not.toContain("#a95568");
    expect(css).not.toContain("#c97f8e");
    expect(css).not.toContain("#f5e4e8");
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

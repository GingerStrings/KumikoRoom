import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const cssPath = path.resolve(__dirname, "../app/globals.css");
const homeHeroAssetPath = path.resolve(__dirname, "../public/assets/home-rehearsal-v2.png");
const chatAvatarAssetPath = path.resolve(__dirname, "../public/assets/kumiko-avatar-v1.png");

function expectRuleToContain(css: string, selector: string, declarations: string[]) {
  const body = ruleBody(css, selector);

  for (const declaration of declarations) {
    expect(body).toContain(declaration);
  }
}

function ruleBody(css: string, selector: string): string {
  const escapedSelector = selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = css.match(new RegExp(`${escapedSelector}\\s*\\{(?<body>[^}]*)\\}`));

  expect(match, `Expected ${selector} rule to exist`).not.toBeNull();

  return match?.groups?.body ?? "";
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
      "connection-strip--ready",
      "connection-strip--warning",
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
      ".chat-nav-link",
      ".session-sidebar {",
      ".session-sidebar--collapsed",
      ".thread[data-active=\"true\"]",
      ".chat {",
      ".chat-head",
      ".profile",
      ".media-player",
      ".track-actions",
      ".source-badge",
      ".settings-trigger",
      ".settings-popover {",
      ".settings-popover__header",
      ".model-status-row",
      ".settings-section",
    ].forEach((selector) => {
      expect(css).toContain(selector);
    });
  });

  it("defines the platform player and video mini-window selectors", () => {
    const css = fs.readFileSync(cssPath, "utf8");

    [
      ".track-actions",
      ".source-badge",
      ".source-badge[data-source=\"bilibili\"]",
      ".source-badge[data-source=\"netease\"]",
      ".control.video",
      ".video-mini-window",
      ".video-mini-window--compact",
      ".video-mini-window--large",
      ".video-mini-window__frame",
      ".video-mini-window__button",
      ".video-mini-window__link",
    ].forEach((selector) => {
      expect(css).toContain(selector);
    });
  });

  it("keeps platform player controls and mini-window viewport constraints aligned", () => {
    const css = fs.readFileSync(cssPath, "utf8").replace(/\r\n/g, "\n");

    expectRuleToContain(css, ".player-controls", [
      "grid-template-columns: clamp(28px, 10vw, 34px) clamp(38px, 12vw, 42px) clamp(28px, 10vw, 34px) minmax(44px, 1fr) clamp(28px, 10vw, 34px);",
    ]);
    expectRuleToContain(css, ".player-controls[data-has-video=\"true\"]", [
      "grid-template-columns: clamp(28px, 9vw, 34px) clamp(38px, 12vw, 42px) clamp(28px, 9vw, 34px) minmax(36px, 1fr) clamp(28px, 9vw, 34px) clamp(28px, 9vw, 34px);",
    ]);
    expect(css).toContain("@media (max-height: 520px)");
    expect(css).toContain("max-height: calc(100vh - 24px);");
  });

  it("keeps the right rail media player from overflowing narrow player widths", () => {
    const css = fs.readFileSync(cssPath, "utf8").replace(/\r\n/g, "\n");

    expectRuleToContain(css, ".media-player", [
      "min-width: 0;",
      "overflow: hidden;",
    ]);
    expectRuleToContain(css, ".player-controls", [
      "grid-template-columns: clamp(28px, 10vw, 34px) clamp(38px, 12vw, 42px) clamp(28px, 10vw, 34px) minmax(44px, 1fr) clamp(28px, 10vw, 34px);",
    ]);
    expectRuleToContain(css, ".queue-preview", [
      "display: grid;",
      "grid-template-columns: minmax(0, 1fr) auto;",
      "overflow: hidden;",
    ]);
    expectRuleToContain(css, ".queue-preview-main", [
      "min-width: 0;",
      "overflow: hidden;",
    ]);
    expectRuleToContain(css, ".music-queue-panel", [
      "position: fixed;",
      "max-width: calc(100vw - 32px);",
    ]);
    expect(css).not.toContain(".playlist {");
  });

  it("uses the soft Kumiko chat avatar asset in message chrome", () => {
    const css = fs.readFileSync(cssPath, "utf8").replace(/\r\n/g, "\n");

    expect(fs.existsSync(chatAvatarAssetPath)).toBe(true);
    expectRuleToContain(css, ".avatar", ['url("/assets/kumiko-avatar-v1.png")']);
  });

  it("keeps the user chat avatar visually distinct from Kumiko", () => {
    const css = fs.readFileSync(cssPath, "utf8").replace(/\r\n/g, "\n");
    const body = ruleBody(css, ".avatar.user-avatar");

    expect(body).toContain("background:");
    expect(body).not.toContain("kumiko-avatar-v1.png");
  });

  it("keeps non-chat pages aligned with the v6 window language", () => {
    const css = fs.readFileSync(cssPath, "utf8").replace(/\r\n/g, "\n");

    expect(fs.existsSync(homeHeroAssetPath)).toBe(true);
    expectRuleToContain(css, ".home-lobby", [
      'url("/assets/home-rehearsal-v2.png")',
      "place-items: stretch;",
    ]);
    expectRuleToContain(css, ".home-entry-window", [
      "border: 0;",
      "box-shadow: none;",
    ]);
    expectRuleToContain(css, ".studio-workbench", [
      'url("/assets/home-rehearsal-v2.png")',
      "place-items: stretch;",
    ]);
    expectRuleToContain(css, ".studio-window", [
      "border: 0;",
      "box-shadow: none;",
    ]);
  });

  it("removes the old non-chat card-grid selectors", () => {
    const css = fs.readFileSync(cssPath, "utf8");

    [
      ".home-shell",
      ".home-panel",
      ".home-panel--intro",
      ".panel-heading",
      ".soft-badge",
      ".route-grid",
      ".route-card",
      ".route-card__mark",
      ".studio-shell",
      ".studio-header",
      ".studio-grid",
      ".studio-module",
      ".text-link",
    ].forEach((selector) => {
      expect(css).not.toContain(selector);
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

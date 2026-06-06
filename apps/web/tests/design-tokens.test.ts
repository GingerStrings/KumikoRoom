import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const cssPath = path.resolve(__dirname, "../app/globals.css");

describe("approved Palette C tokens", () => {
  it("uses the warm rose fog palette tokens", () => {
    const css = fs.readFileSync(cssPath, "utf8");

    expect(css).toContain("--color-bg: #fafaf8");
    expect(css).toContain("--color-text: #3f3a3d");
    expect(css).toContain("--color-muted: #756f73");
    expect(css).toContain("--color-rose: #a95568");
    expect(css).toContain("--color-rose-soft: #f5e4e8");
    expect(css).toContain("--color-fog-soft: #eef4f7");
  });

  it("keeps legacy room variable aliases mapped to Palette C values", () => {
    const css = fs.readFileSync(cssPath, "utf8");

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

  it("removes the old green and brass room palette values", () => {
    const css = fs.readFileSync(cssPath, "utf8");

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

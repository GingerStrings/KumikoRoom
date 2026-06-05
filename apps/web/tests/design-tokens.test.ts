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

  it("removes the old green and brass room palette tokens", () => {
    const css = fs.readFileSync(cssPath, "utf8");

    expect(css).not.toContain("--ink:");
    expect(css).not.toContain("--brass:");
    expect(css).not.toContain("#385b68");
    expect(css).not.toContain("#e6ddcf");
  });
});

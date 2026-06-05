import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const projectRoot = path.resolve(__dirname, "..");
const oldProductNamePattern = new RegExp(["Muse", "Flow"].join(""));

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
  it("does not expose the old product name in the new web app", () => {
    const allText = readTextFiles(projectRoot).join("\n");

    expect(allText).not.toMatch(oldProductNamePattern);
  });
});

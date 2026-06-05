import { describe, expect, it } from "vitest";
import { DEFAULT_WEB_URL, getWebUrl, windowOptions } from "../src/config";

describe("desktop config", () => {
  it("uses the KumikoRoom default web URL", () => {
    expect(DEFAULT_WEB_URL).toBe("http://127.0.0.1:3000/room");
  });

  it("allows a custom web URL", () => {
    expect(getWebUrl({ KUMIKOROOM_WEB_URL: "http://127.0.0.1:3010/room" })).toBe(
      "http://127.0.0.1:3010/room"
    );
  });

  it("uses KumikoRoom as window title", () => {
    expect(windowOptions.title).toBe("KumikoRoom");
  });
});

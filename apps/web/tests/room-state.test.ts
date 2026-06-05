import { describe, expect, it } from "vitest";
import { DEFAULT_ROOM_STATE, getIdleLine } from "../src/lib/roomState";

describe("default Kumiko room state", () => {
  it("uses KumikoRoom as the app identity", () => {
    expect(DEFAULT_ROOM_STATE.appName).toBe("KumikoRoom");
    expect(DEFAULT_ROOM_STATE.roomName).toBe("陪伴房间");
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

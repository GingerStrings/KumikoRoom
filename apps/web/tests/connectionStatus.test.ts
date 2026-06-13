import { describe, expect, it } from "vitest";
import { getConnectionStatus } from "../src/lib/connectionStatus";

describe("connection status", () => {
  it("labels the default local API as a mock connection", () => {
    expect(getConnectionStatus("http://127.0.0.1:8000")).toEqual({
      mode: "local-mock-api",
      label: "本地 API",
      detail: "本地服务已连接。",
      tone: "muted"
    });
  });

  it("labels a remote API as configured", () => {
    expect(getConnectionStatus("https://api.example.com")).toEqual({
      mode: "configured-api",
      label: "已配置 API",
      detail: "远程服务已配置。",
      tone: "ready"
    });
  });

  it("labels an empty API URL as unconfigured", () => {
    expect(getConnectionStatus("")).toEqual({
      mode: "unconfigured",
      label: "未配置 API",
      detail: "聊天接口还没有可用地址。",
      tone: "warning"
    });
  });
});

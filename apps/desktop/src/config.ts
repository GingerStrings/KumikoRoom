import type { BrowserWindowConstructorOptions } from "electron";

export const DEFAULT_WEB_URL = "http://127.0.0.1:3000/room";

export function getWebUrl(env: NodeJS.ProcessEnv): string {
  const configured = env.KUMIKOROOM_WEB_URL?.trim();
  return configured && configured.length > 0 ? configured : DEFAULT_WEB_URL;
}

export const windowOptions = {
  width: 1280,
  height: 820,
  minWidth: 1024,
  minHeight: 680,
  backgroundColor: "#f4f0e8",
  title: "KumikoRoom",
  show: false
} satisfies BrowserWindowConstructorOptions;

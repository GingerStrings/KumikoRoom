export const DEFAULT_API_URL = "http://127.0.0.1:8000";

export interface ConnectionStatus {
  mode: "local-mock-api" | "configured-api" | "unconfigured";
  label: string;
  detail: string;
  tone: "muted" | "ready" | "warning";
}

export function getConnectionStatus(apiUrl = process.env.KUMIKOROOM_API_URL ?? DEFAULT_API_URL): ConnectionStatus {
  const normalizedUrl = apiUrl.trim();

  if (!normalizedUrl) {
    return {
      mode: "unconfigured",
      label: "未配置 API",
      detail: "聊天接口还没有可用地址。",
      tone: "warning"
    };
  }

  const isLocal =
    normalizedUrl.includes("127.0.0.1") ||
    normalizedUrl.includes("localhost") ||
    normalizedUrl.includes("::1");

  if (isLocal) {
    return {
      mode: "local-mock-api",
      label: "本地 API",
      detail: "本地服务已连接。",
      tone: "muted"
    };
  }

  return {
    mode: "configured-api",
    label: "已配置 API",
    detail: "远程服务已配置。",
    tone: "ready"
  };
}

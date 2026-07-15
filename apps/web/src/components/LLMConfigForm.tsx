"use client";

import { FormEvent } from "react";
import type { LLMConfig, LLMTestResult, LlmProvider } from "../api/types";

export interface LLMConfigFormProps {
  value: LLMConfig | null;
  onChange: (next: LLMConfig | null) => void;
  onTest: () => void;
  testResult: LLMTestResult | null;
  isTesting: boolean;
}

interface LlmPreset {
  label: string;
  provider: LlmProvider;
  baseUrl: string;
  defaultModel: string | null;
}

const PRESETS: LlmPreset[] = [
  {
    label: "DeepSeek",
    provider: "deepseek",
    baseUrl: "https://api.deepseek.com",
    defaultModel: "deepseek-chat"
  },
  {
    label: "OpenAI",
    provider: "openai_compatible",
    baseUrl: "https://api.openai.com/v1",
    defaultModel: "gpt-4o-mini"
  },
  {
    label: "Moonshot Kimi",
    provider: "openai_compatible",
    baseUrl: "https://api.moonshot.cn/v1",
    defaultModel: "moonshot-v1-8k"
  },
  {
    label: "SiliconFlow",
    provider: "openai_compatible",
    baseUrl: "https://api.siliconflow.cn/v1",
    defaultModel: "Qwen/Qwen2.5-7B-Instruct"
  },
  {
    label: "Volcengine Ark",
    provider: "openai_compatible",
    baseUrl: "https://ark.cn-beijing.volces.com/api/v3",
    defaultModel: null
  },
  {
    label: "Ollama 本地",
    provider: "openai_compatible",
    baseUrl: "http://localhost:11434/v1",
    defaultModel: "qwen2.5:7b"
  }
];

const DEFAULT_VALUE: LLMConfig = {
  provider: "openai_compatible",
  baseUrl: "",
  apiKey: "",
  model: ""
};

function applyPreset(preset: LlmPreset, current: LLMConfig | null): LLMConfig {
  const baseApiKey = current?.apiKey ?? null;
  const baseModel = current?.model ?? null;
  return {
    provider: preset.provider,
    baseUrl: preset.baseUrl,
    apiKey: baseApiKey,
    model: preset.defaultModel ?? baseModel
  };
}

function updateField(
  current: LLMConfig | null,
  field: keyof LLMConfig,
  next: string
): LLMConfig {
  const base = current ?? DEFAULT_VALUE;
  return { ...base, [field]: next || null };
}

export function LLMConfigForm({
  value,
  onChange,
  onTest,
  testResult,
  isTesting
}: LLMConfigFormProps) {
  const current = value ?? DEFAULT_VALUE;

  const handleRestoreDefault = () => {
    onChange(null);
  };

  const handleSubmit = (event: FormEvent) => {
    event.preventDefault();
    onTest();
  };

  const isTestable =
    value !== null &&
    current.provider !== "mock" &&
    !!current.baseUrl?.trim() &&
    !!current.model?.trim() &&
    (current.provider !== "deepseek" || !!current.apiKey?.trim());

  return (
    <form className="llm-config-form" aria-label="模型配置" onSubmit={handleSubmit}>
      <div className="llm-config-form__presets" role="group" aria-label="预设服务商">
        {PRESETS.map((preset) => (
          <button
            key={preset.label}
            type="button"
            className="llm-preset-btn"
            onClick={() => onChange(applyPreset(preset, value))}
          >
            {preset.label}
          </button>
        ))}
      </div>

      <label className="llm-config-field">
        <span>Provider</span>
        <select
          aria-label="provider"
          value={current.provider}
          onChange={(event) =>
            onChange(updateField(value, "provider", event.target.value))
          }
        >
          <option value="mock">mock（本地）</option>
          <option value="deepseek">deepseek</option>
          <option value="openai_compatible">openai_compatible</option>
        </select>
      </label>

      <label className="llm-config-field">
        <span>Base URL</span>
        <input
          type="text"
          aria-label="base url"
          placeholder="https://api.example.com/v1"
          value={current.baseUrl ?? ""}
          onChange={(event) =>
            onChange(updateField(value, "baseUrl", event.target.value))
          }
        />
      </label>

      <label className="llm-config-field">
        <span>API Key</span>
        <input
          type="password"
          aria-label="api key"
          placeholder="sk-..."
          value={current.apiKey ?? ""}
          onChange={(event) =>
            onChange(updateField(value, "apiKey", event.target.value))
          }
        />
      </label>

      <label className="llm-config-field">
        <span>Model</span>
        <input
          type="text"
          aria-label="model"
          placeholder="model name"
          value={current.model ?? ""}
          onChange={(event) =>
            onChange(updateField(value, "model", event.target.value))
          }
        />
      </label>

      <div className="llm-config-form__actions">
        <button
          type="submit"
          className="llm-test-btn"
          disabled={isTesting || !isTestable}
        >
          {isTesting ? "测试中..." : "测试连接"}
        </button>
        <button
          type="button"
          className="llm-restore-btn"
          onClick={handleRestoreDefault}
        >
          恢复默认
        </button>
      </div>

      {testResult ? (
        <div
          className={`llm-test-status ${testResult.ok ? "llm-test-status--ok" : "llm-test-status--err"}`}
          role="status"
        >
          {testResult.ok
            ? `✓ ${testResult.model ?? ""} · ${testResult.latencyMs ?? "?"}ms`
            : `✗ ${testResult.error ?? "连接失败"}`}
        </div>
      ) : null}

      <p className="llm-config-form__hint">API Key 仅存在本浏览器。</p>
    </form>
  );
}

import { fireEvent, render, screen } from "@testing-library/react";
import React from "react";
import { describe, expect, it, vi } from "vitest";
import type { LLMConfig, LLMTestResult } from "../src/api/types";
import { LLMConfigForm } from "../src/components/LLMConfigForm";

function renderForm(overrides: Partial<React.ComponentProps<typeof LLMConfigForm>> = {}) {
  const onChange = vi.fn();
  const onTest = vi.fn();
  const props: React.ComponentProps<typeof LLMConfigForm> = {
    value: null,
    onChange,
    onTest,
    testResult: null,
    isTesting: false,
    ...overrides
  };
  return { ...render(<LLMConfigForm {...props} />), onChange, onTest };
}

describe("LLMConfigForm", () => {
  it("renders three config inputs and six preset buttons", () => {
    renderForm();

    expect(screen.getByLabelText("base url")).toBeTruthy();
    expect(screen.getByLabelText("api key").getAttribute("type")).toBe("password");
    expect(screen.getByLabelText("model")).toBeTruthy();
    expect(screen.getByLabelText("provider")).toBeTruthy();

    expect(screen.getByText("DeepSeek")).toBeTruthy();
    expect(screen.getByText("OpenAI")).toBeTruthy();
    expect(screen.getByText("Moonshot Kimi")).toBeTruthy();
    expect(screen.getByText("SiliconFlow")).toBeTruthy();
    expect(screen.getByText("Volcengine Ark")).toBeTruthy();
    expect(screen.getByText("Ollama 本地")).toBeTruthy();
  });

  it("filling a preset sets base url and model, preserves api key", () => {
    const { onChange } = renderForm({
      value: {
        provider: "openai_compatible",
        baseUrl: "",
        apiKey: "sk-existing",
        model: ""
      }
    });

    fireEvent.click(screen.getByText("Moonshot Kimi"));

    expect(onChange).toHaveBeenCalledWith({
      provider: "openai_compatible",
      baseUrl: "https://api.moonshot.cn/v1",
      apiKey: "sk-existing",
      model: "moonshot-v1-8k"
    });
  });

  it("Volcengine preset leaves model empty for user to fill endpoint id", () => {
    const { onChange } = renderForm({ value: null });

    fireEvent.click(screen.getByText("Volcengine Ark"));

    expect(onChange).toHaveBeenCalledWith({
      provider: "openai_compatible",
      baseUrl: "https://ark.cn-beijing.volces.com/api/v3",
      apiKey: null,
      model: null
    });
  });

  it("DeepSeek preset selects deepseek provider", () => {
    const { onChange } = renderForm({ value: null });

    fireEvent.click(screen.getByText("DeepSeek"));

    expect(onChange).toHaveBeenCalledWith(
      expect.objectContaining({
        provider: "deepseek",
        baseUrl: "https://api.deepseek.com",
        model: "deepseek-chat"
      })
    );
  });

  it("typing into inputs calls onChange with updated fields", () => {
    const { onChange } = renderForm({
      value: {
        provider: "openai_compatible",
        baseUrl: "https://api.openai.com/v1",
        apiKey: "",
        model: "gpt-4o-mini"
      }
    });

    fireEvent.change(screen.getByLabelText("api key"), {
      target: { value: "sk-typed" }
    });

    expect(onChange).toHaveBeenLastCalledWith({
      provider: "openai_compatible",
      baseUrl: "https://api.openai.com/v1",
      apiKey: "sk-typed",
      model: "gpt-4o-mini"
    });
  });

  it("clicking test button calls onTest", () => {
    const { onTest } = renderForm({
      value: {
        provider: "openai_compatible",
        baseUrl: "https://api.openai.com/v1",
        apiKey: "sk-test",
        model: "gpt-4o-mini"
      }
    });

    fireEvent.click(screen.getByText("测试连接"));

    expect(onTest).toHaveBeenCalledTimes(1);
  });

  it("disables test button while testing", () => {
    renderForm({
      isTesting: true,
      value: {
        provider: "openai_compatible",
        baseUrl: "https://api.openai.com/v1",
        apiKey: "sk-test",
        model: "gpt-4o-mini"
      }
    });

    expect((screen.getByText("测试中...") as HTMLButtonElement).disabled).toBe(true);
  });

  it("disables test button for mock provider", () => {
    renderForm({
      value: { provider: "mock", baseUrl: null, apiKey: null, model: null }
    });

    expect((screen.getByText("测试连接") as HTMLButtonElement).disabled).toBe(true);
  });

  it("disables test button when value is null (no preset chosen yet)", () => {
    renderForm({ value: null });

    expect((screen.getByText("测试连接") as HTMLButtonElement).disabled).toBe(true);
  });

  it("disables test button when base_url is missing", () => {
    renderForm({
      value: {
        provider: "openai_compatible",
        baseUrl: null,
        apiKey: "sk-test",
        model: "gpt-4o-mini"
      }
    });

    expect((screen.getByText("测试连接") as HTMLButtonElement).disabled).toBe(true);
  });

  it("disables test button when model is missing", () => {
    renderForm({
      value: {
        provider: "openai_compatible",
        baseUrl: "https://api.openai.com/v1",
        apiKey: "sk-test",
        model: null
      }
    });

    expect((screen.getByText("测试连接") as HTMLButtonElement).disabled).toBe(true);
  });

  it("enables test button for openai_compatible without api_key (Ollama case)", () => {
    renderForm({
      value: {
        provider: "openai_compatible",
        baseUrl: "http://localhost:11434/v1",
        apiKey: null,
        model: "qwen2.5:7b"
      }
    });

    expect((screen.getByText("测试连接") as HTMLButtonElement).disabled).toBe(false);
  });

  it("disables test button for deepseek provider when api_key is missing", () => {
    renderForm({
      value: {
        provider: "deepseek",
        baseUrl: "https://api.deepseek.com",
        apiKey: null,
        model: "deepseek-chat"
      }
    });

    expect((screen.getByText("测试连接") as HTMLButtonElement).disabled).toBe(true);
  });

  it("shows success status with model and latency", () => {
    const testResult: LLMTestResult = {
      ok: true,
      error: null,
      model: "gpt-4o-mini",
      latencyMs: 312
    };

    renderForm({ testResult });

    expect(screen.getByText(/✓.*gpt-4o-mini.*312ms/)).toBeTruthy();
  });

  it("shows failure status with error message", () => {
    const testResult: LLMTestResult = {
      ok: false,
      error: "HTTP 401",
      model: "gpt-4o-mini",
      latencyMs: 42
    };

    renderForm({ testResult });

    expect(screen.getByText(/✗.*HTTP 401/)).toBeTruthy();
  });

  it("restore default calls onChange with null", () => {
    const { onChange } = renderForm({
      value: {
        provider: "openai_compatible",
        baseUrl: "https://api.openai.com/v1",
        apiKey: "sk-test",
        model: "gpt-4o-mini"
      }
    });

    fireEvent.click(screen.getByText("恢复默认"));

    expect(onChange).toHaveBeenCalledWith(null);
  });

  it("shows local storage hint", () => {
    renderForm();

    expect(screen.getByText("API Key 仅存在本浏览器。")).toBeTruthy();
  });

  it("renders current values from value prop", () => {
    const value: LLMConfig = {
      provider: "openai_compatible",
      baseUrl: "https://api.openai.com/v1",
      apiKey: "sk-rendered",
      model: "gpt-4o-mini"
    };

    renderForm({ value });

    expect((screen.getByLabelText("base url") as HTMLInputElement).value).toBe(
      "https://api.openai.com/v1"
    );
    expect((screen.getByLabelText("api key") as HTMLInputElement).value).toBe(
      "sk-rendered"
    );
    expect((screen.getByLabelText("model") as HTMLInputElement).value).toBe(
      "gpt-4o-mini"
    );
  });
});

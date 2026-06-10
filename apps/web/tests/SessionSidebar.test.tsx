import { act, fireEvent, render, screen } from "@testing-library/react";
import React from "react";
import { describe, expect, it, vi } from "vitest";
import type { ChatSession } from "../src/api/types";
import { SessionSidebar } from "../src/components/SessionSidebar";

const sessions: ChatSession[] = [
  {
    id: "session-1",
    title: "Evening songs",
    latestMessagePreview: "Quiet piano for the evening",
    createdAt: "2026-06-10T10:00:00.000Z",
    updatedAt: "2026-06-10T12:00:00.000Z"
  },
  {
    id: "session-2",
    title: "Practice notes",
    latestMessagePreview: null,
    createdAt: "2026-06-09T10:00:00.000Z",
    updatedAt: "2026-06-09T12:00:00.000Z"
  }
];

function deferredPromise() {
  let resolve!: () => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<void>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });

  return { promise, resolve, reject };
}

function renderSidebar(
  overrides: Partial<React.ComponentProps<typeof SessionSidebar>> = {}
) {
  const props: React.ComponentProps<typeof SessionSidebar> = {
    collapsed: false,
    sessions,
    activeSessionId: "session-1",
    isLoading: false,
    error: null,
    onCreate: vi.fn(),
    onSelect: vi.fn(),
    onRename: vi.fn(),
    onDelete: vi.fn(),
    onRetry: vi.fn(),
    onToggleCollapsed: vi.fn(),
    ...overrides
  };

  render(<SessionSidebar {...props} />);
  return props;
}

describe("SessionSidebar", () => {
  it("renders sessions and selects a conversation from the expanded list", () => {
    const props = renderSidebar();

    expect(screen.getByRole("button", { name: "新建会话" })).toBeTruthy();
    expect(screen.getByText("Evening songs")).toBeTruthy();
    expect(screen.getByText("Quiet piano for the evening")).toBeTruthy();
    expect(screen.getByText("Practice notes")).toBeTruthy();
    expect(screen.getByText("还没有消息")).toBeTruthy();
    expect(
      screen.getByRole("button", { name: "收起会话列表" }).getAttribute("aria-expanded")
    ).toBe("true");

    fireEvent.click(screen.getByRole("button", { name: "Practice notes" }));

    expect(props.onSelect).toHaveBeenCalledWith("session-2");
    expect(screen.getByRole("button", { name: "Evening songs" }).getAttribute("aria-current")).toBe(
      "true"
    );
  });

  it("hides session content when collapsed and exposes the expand control", () => {
    const props = renderSidebar({ collapsed: true });
    const expandButton = screen.getByRole("button", { name: "展开会话列表" });

    expect(screen.queryByText("Evening songs")).toBeNull();
    expect(screen.queryByText("Practice notes")).toBeNull();
    expect(expandButton.getAttribute("aria-expanded")).toBe("false");

    fireEvent.click(expandButton);

    expect(props.onToggleCollapsed).toHaveBeenCalledTimes(1);
  });

  it("keeps the rename draft after an async failure and catches the rejection", async () => {
    const rename = deferredPromise();
    const onRename = vi.fn(() => rename.promise);
    renderSidebar({ onRename });

    fireEvent.click(screen.getByRole("button", { name: "重命名 Evening songs" }));

    const input = screen.getByRole("textbox", { name: "会话标题" });
    fireEvent.change(input, { target: { value: "  Late night  " } });
    fireEvent.click(screen.getByRole("button", { name: "保存标题" }));

    expect(onRename).toHaveBeenCalledWith("session-1", "Late night");
    expect(screen.getByRole("textbox", { name: "会话标题" })).toBeTruthy();
    expect((screen.getByRole("button", { name: "保存标题" }) as HTMLButtonElement).disabled).toBe(
      true
    );
    expect(screen.queryByRole("button", { name: "重命名 Evening songs" })).toBeNull();
    expect(screen.queryByRole("button", { name: "删除 Evening songs" })).toBeNull();

    await act(async () => {
      rename.reject(new Error("rename failed"));
      await Promise.resolve();
    });

    expect((screen.getByRole("textbox", { name: "会话标题" }) as HTMLInputElement).value).toBe(
      "  Late night  "
    );
    expect((screen.getByRole("button", { name: "保存标题" }) as HTMLButtonElement).disabled).toBe(
      false
    );
  });

  it("exits rename mode only after an async rename succeeds", async () => {
    const rename = deferredPromise();
    const onRename = vi.fn(() => rename.promise);
    renderSidebar({ onRename });

    fireEvent.click(screen.getByRole("button", { name: "重命名 Evening songs" }));
    fireEvent.change(screen.getByRole("textbox", { name: "会话标题" }), {
      target: { value: "Late night" }
    });
    fireEvent.click(screen.getByRole("button", { name: "保存标题" }));

    expect(screen.getByRole("textbox", { name: "会话标题" })).toBeTruthy();

    await act(async () => {
      rename.resolve();
      await rename.promise;
    });

    expect(screen.queryByRole("textbox", { name: "会话标题" })).toBeNull();
  });

  it("does not submit an empty session title", () => {
    const props = renderSidebar();

    fireEvent.click(screen.getByRole("button", { name: "重命名 Evening songs" }));
    fireEvent.change(screen.getByRole("textbox", { name: "会话标题" }), {
      target: { value: "   " }
    });
    fireEvent.submit(screen.getByRole("textbox", { name: "会话标题" }).closest("form")!);

    expect(props.onRename).not.toHaveBeenCalled();
    expect(screen.getByRole("textbox", { name: "会话标题" })).toBeTruthy();
  });

  it("deletes a session and retries after an error", () => {
    const props = renderSidebar({ error: "会话加载失败" });

    fireEvent.click(screen.getByRole("button", { name: "删除 Evening songs" }));
    expect(props.onDelete).toHaveBeenCalledWith("session-1");

    expect(screen.getByRole("alert").textContent).toContain("会话加载失败");
    fireEvent.click(screen.getByRole("button", { name: "重试" }));
    expect(props.onRetry).toHaveBeenCalledTimes(1);
  });

  it("prevents duplicate creates while an async action is pending", () => {
    const create = deferredPromise();
    const onCreate = vi.fn(() => create.promise);
    renderSidebar({ onCreate });

    const createButton = screen.getByRole("button", { name: "新建会话" });
    fireEvent.click(createButton);
    fireEvent.click(createButton);

    expect(onCreate).toHaveBeenCalledTimes(1);
    expect((createButton as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByRole("button", { name: "Practice notes" }) as HTMLButtonElement).disabled).toBe(
      true
    );
    expect(
      (screen.getByRole("button", { name: "删除 Evening songs" }) as HTMLButtonElement).disabled
    ).toBe(true);
  });

  it("renders loading and empty states without conflicting copy", () => {
    const { rerender } = render(
      <SessionSidebar
        collapsed={false}
        sessions={[]}
        activeSessionId={null}
        isLoading
        error={null}
        onCreate={vi.fn()}
        onSelect={vi.fn()}
        onRename={vi.fn()}
        onDelete={vi.fn()}
        onRetry={vi.fn()}
        onToggleCollapsed={vi.fn()}
      />
    );

    expect(screen.getByRole("status").textContent).toBe("正在加载会话...");
    expect(screen.queryByText("还没有会话。")).toBeNull();

    rerender(
      <SessionSidebar
        collapsed={false}
        sessions={[]}
        activeSessionId={null}
        isLoading={false}
        error={null}
        onCreate={vi.fn()}
        onSelect={vi.fn()}
        onRename={vi.fn()}
        onDelete={vi.fn()}
        onRetry={vi.fn()}
        onToggleCollapsed={vi.fn()}
      />
    );

    expect(screen.getByText("还没有会话。")).toBeTruthy();
    expect(screen.queryByText("正在加载会话...")).toBeNull();
  });
});

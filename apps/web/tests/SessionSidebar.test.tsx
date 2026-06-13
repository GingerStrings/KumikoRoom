import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
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

function renderSidebar(overrides: Partial<React.ComponentProps<typeof SessionSidebar>> = {}) {
  const props: React.ComponentProps<typeof SessionSidebar> = {
    collapsed: false,
    sessions,
    activeSessionId: "session-1",
    isLoading: false,
    isBusy: false,
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
  it("renders the v6 conversation list and selects a conversation", () => {
    const props = renderSidebar();

    const createButton = screen.getByRole("button", { name: "新建会话" });
    expect(createButton.classList.contains("tool")).toBe(true);
    expect(createButton.textContent).toBe("+");
    expect(document.querySelector(".brand .brand-mark")?.textContent).toBe("KR");
    expect(screen.getByPlaceholderText("搜索会话")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "收起会话列表" })).toBeNull();

    expect(screen.getByText("Evening songs")).toBeTruthy();
    expect(screen.getByText("Quiet piano for the evening")).toBeTruthy();
    expect(screen.getByText("Practice notes")).toBeTruthy();
    expect(screen.getByText("还没有消息")).toBeTruthy();

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

  it("keeps rename and delete actions behind the row menu", () => {
    renderSidebar();

    expect(screen.queryByRole("button", { name: "重命名 Evening songs" })).toBeNull();
    expect(screen.queryByRole("button", { name: "删除 Evening songs" })).toBeNull();
  });

  it("renames and confirms deleting sessions from the row menu", async () => {
    const props = renderSidebar();

    fireEvent.click(screen.getByRole("button", { name: "更多 Evening songs" }));
    fireEvent.click(screen.getByRole("menuitem", { name: "重命名 Evening songs" }));

    const input = screen.getByLabelText("会话名称");
    fireEvent.change(input, { target: { value: "Rehearsal log" } });
    await act(async () => {
      fireEvent.submit(input.closest("form")!);
    });

    await waitFor(() => expect(props.onRename).toHaveBeenCalledWith("session-1", "Rehearsal log"));
    await waitFor(() => expect(screen.queryByLabelText("会话名称")).toBeNull());

    fireEvent.click(screen.getByRole("button", { name: "更多 Practice notes" }));
    fireEvent.click(screen.getByRole("menuitem", { name: "删除 Practice notes" }));

    expect(screen.getByText("删除这个会话？")).toBeTruthy();
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "确认删除 Practice notes" }));
    });

    expect(props.onDelete).toHaveBeenCalledWith("session-2");
  });

  it("retries after an error without replacing existing session rows", () => {
    const props = renderSidebar({ error: "会话加载失败" });

    expect(screen.getByRole("alert").textContent).toContain("会话加载失败");
    expect(screen.getByRole("button", { name: "Evening songs" })).toBeTruthy();
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
  });

  it("keeps rows visible when the parent is busy", () => {
    renderSidebar({ isBusy: true });

    expect(screen.queryByText("正在加载会话...")).toBeNull();
    expect(screen.getByRole("button", { name: "Evening songs" })).toBeTruthy();
    expect((screen.getByRole("button", { name: "Practice notes" }) as HTMLButtonElement).disabled).toBe(
      true
    );
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

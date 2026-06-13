"use client";

import { FormEvent, KeyboardEvent, useRef, useState } from "react";
import type { ChatSession } from "../api/types";

type SessionAction = () => void | Promise<void>;

interface SessionSidebarProps {
  collapsed: boolean;
  sessions: ChatSession[];
  activeSessionId: string | null;
  isLoading: boolean;
  isBusy?: boolean;
  error: string | null;
  onCreate: SessionAction;
  onSelect: (sessionId: string) => void | Promise<void>;
  onRename: (sessionId: string, title: string) => void | Promise<void>;
  onDelete: (sessionId: string) => void | Promise<void>;
  onRetry: SessionAction;
  onToggleCollapsed: () => void;
}

export function SessionSidebar({
  collapsed,
  sessions,
  activeSessionId,
  isLoading,
  isBusy = false,
  error,
  onCreate,
  onSelect,
  onRename,
  onDelete,
  onRetry,
  onToggleCollapsed
}: SessionSidebarProps) {
  const [pendingAction, setPendingAction] = useState<string | null>(null);
  const [openMenuSessionId, setOpenMenuSessionId] = useState<string | null>(null);
  const [renamingSessionId, setRenamingSessionId] = useState<string | null>(null);
  const [renameTitle, setRenameTitle] = useState("");
  const [deleteConfirmSessionId, setDeleteConfirmSessionId] = useState<string | null>(null);
  const pendingActionRef = useRef<string | null>(null);
  const isPending = pendingAction !== null || isBusy;

  function clearPendingAction(actionName: string) {
    if (pendingActionRef.current !== actionName) return;

    pendingActionRef.current = null;
    setPendingAction(null);
  }

  function runAction(actionName: string, action: SessionAction) {
    if (pendingActionRef.current || isBusy) return;

    pendingActionRef.current = actionName;
    setPendingAction(actionName);

    try {
      const result = action();
      if (!result) {
        clearPendingAction(actionName);
        return;
      }

      void result.catch(() => undefined).finally(() => clearPendingAction(actionName));
    } catch {
      // The parent surfaces operation errors through the error prop.
      clearPendingAction(actionName);
    }
  }

  function beginRename(session: ChatSession) {
    if (isPending) return;

    setOpenMenuSessionId(null);
    setDeleteConfirmSessionId(null);
    setRenamingSessionId(session.id);
    setRenameTitle(session.title);
  }

  function cancelRename() {
    setRenamingSessionId(null);
    setRenameTitle("");
  }

  function submitRename(event: FormEvent<HTMLFormElement>, session: ChatSession) {
    event.preventDefault();
    const nextTitle = renameTitle.trim();
    if (!nextTitle || nextTitle === session.title) {
      cancelRename();
      return;
    }

    runAction(`rename:${session.id}`, async () => {
      await onRename(session.id, nextTitle);
      cancelRename();
    });
  }

  function handleRenameKeyDown(event: KeyboardEvent<HTMLInputElement>) {
    if (event.key === "Escape") {
      event.preventDefault();
      cancelRename();
    }
  }

  function askDelete(sessionId: string) {
    if (isPending) return;

    setOpenMenuSessionId(null);
    setRenamingSessionId(null);
    setDeleteConfirmSessionId(sessionId);
  }

  function confirmDelete(session: ChatSession) {
    runAction(`delete:${session.id}`, async () => {
      await onDelete(session.id);
      setDeleteConfirmSessionId(null);
    });
  }

  if (collapsed) {
    return (
      <aside className="sidebar session-sidebar session-sidebar--collapsed" aria-label="会话列表">
        <button
          className="tool session-sidebar__toggle"
          type="button"
          aria-label="展开会话列表"
          aria-expanded={false}
          title="展开会话列表"
          onClick={onToggleCollapsed}
        >
          +
        </button>
      </aside>
    );
  }

  return (
    <aside className="sidebar session-sidebar" aria-label="会话列表">
      <div className="brand session-sidebar__header">
        <span className="brand-mark">KR</span>
        <div className="brand-copy">
          <strong>KumikoRoom</strong>
          <span>北宇治 · 放学后</span>
        </div>
        <button
          className="tool session-sidebar__create"
          type="button"
          aria-label="新建会话"
          title="新建会话"
          disabled={isPending}
          onClick={() => runAction("create", onCreate)}
        >
          +
        </button>
      </div>

      <label className="search">
        <span aria-hidden="true">⌕</span>
        <input placeholder="搜索会话" />
      </label>

      <div className="thread-list-wrap">
        {error ? (
          <div className="thread thread--status session-sidebar__error" role="alert">
            <span className="avatar" aria-hidden="true" />
            <span className="thread-text">
              <strong>{error}</strong>
              <span>可以稍后再试一次</span>
            </span>
            <button
              className="thread-mini-action"
              type="button"
              disabled={isPending}
              onClick={() => runAction("retry", onRetry)}
            >
              重试
            </button>
          </div>
        ) : null}

        {isLoading && sessions.length === 0 ? (
          <p className="thread thread--status session-sidebar__status" role="status">
            正在加载会话...
          </p>
        ) : null}

        {!isLoading && !error && sessions.length === 0 ? (
          <p className="thread thread--status session-sidebar__status">还没有会话。</p>
        ) : null}

        {sessions.length > 0 ? (
          <ul className="thread-list session-sidebar__list">
            {sessions.map((session) => {
              const isActive = session.id === activeSessionId;
              const isRenaming = renamingSessionId === session.id;
              const menuOpen = openMenuSessionId === session.id;
              const confirmingDelete = deleteConfirmSessionId === session.id;

              return (
                <li className="session-sidebar__item" key={session.id}>
                  {isRenaming ? (
                    <form
                      className="session-rename-form"
                      onSubmit={(event) => submitRename(event, session)}
                    >
                      <span className="avatar" aria-hidden="true" />
                      <label className="sr-only" htmlFor={`session-rename-${session.id}`}>
                        会话名称
                      </label>
                      <input
                        id={`session-rename-${session.id}`}
                        value={renameTitle}
                        disabled={isPending}
                        autoFocus
                        onChange={(event) => setRenameTitle(event.target.value)}
                        onKeyDown={handleRenameKeyDown}
                      />
                      <div className="session-rename-actions">
                        <button type="submit" aria-label={`保存 ${session.title}`} disabled={isPending}>
                          ✓
                        </button>
                        <button
                          type="button"
                          aria-label={`取消重命名 ${session.title}`}
                          disabled={isPending}
                          onClick={cancelRename}
                        >
                          ×
                        </button>
                      </div>
                    </form>
                  ) : (
                    <>
                      <button
                        className="thread session-sidebar__select"
                        type="button"
                        data-active={isActive ? "true" : undefined}
                        aria-current={isActive ? "true" : undefined}
                        aria-label={session.title}
                        disabled={isPending}
                        onClick={() => runAction(`select:${session.id}`, () => onSelect(session.id))}
                      >
                        <span className="avatar" aria-hidden="true" />
                        <span className="thread-text">
                          <strong>{session.title}</strong>
                          <span>{session.latestMessagePreview ?? "还没有消息"}</span>
                        </span>
                        <time>{formatSessionTime(session.updatedAt)}</time>
                      </button>

                      <div className="session-sidebar__actions">
                        <button
                          className="session-action-trigger"
                          type="button"
                          aria-label={`更多 ${session.title}`}
                          aria-haspopup="menu"
                          aria-expanded={menuOpen}
                          disabled={isPending}
                          onClick={() => setOpenMenuSessionId(menuOpen ? null : session.id)}
                        >
                          ⋯
                        </button>
                        {menuOpen ? (
                          <div className="session-action-menu" role="menu" aria-label={`${session.title} 操作`}>
                            <button
                              type="button"
                              role="menuitem"
                              aria-label={`重命名 ${session.title}`}
                              onClick={() => beginRename(session)}
                            >
                              重命名
                            </button>
                            <button
                              type="button"
                              role="menuitem"
                              aria-label={`删除 ${session.title}`}
                              onClick={() => askDelete(session.id)}
                            >
                              删除
                            </button>
                          </div>
                        ) : null}
                      </div>

                      {confirmingDelete ? (
                        <div
                          className="session-delete-confirm"
                          role="alertdialog"
                          aria-label={`删除 ${session.title}`}
                        >
                          <span>删除这个会话？</span>
                          <button
                            type="button"
                            aria-label={`确认删除 ${session.title}`}
                            disabled={isPending}
                            onClick={() => confirmDelete(session)}
                          >
                            删除
                          </button>
                          <button
                            type="button"
                            aria-label={`取消删除 ${session.title}`}
                            disabled={isPending}
                            onClick={() => setDeleteConfirmSessionId(null)}
                          >
                            取消
                          </button>
                        </div>
                      ) : null}
                    </>
                  )}
                </li>
              );
            })}
          </ul>
        ) : null}
      </div>
    </aside>
  );
}

function formatSessionTime(value: string): string {
  const timestamp = Date.parse(value);
  if (Number.isNaN(timestamp)) return "";

  const date = new Date(timestamp);
  const now = new Date();
  const isToday = date.toDateString() === now.toDateString();

  if (isToday) {
    return date.toLocaleTimeString("zh-CN", {
      hour: "2-digit",
      minute: "2-digit",
      hour12: false
    });
  }

  return date.toLocaleDateString("zh-CN", {
    month: "numeric",
    day: "numeric"
  });
}

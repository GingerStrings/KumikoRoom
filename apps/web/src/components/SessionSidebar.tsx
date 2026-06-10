"use client";

import { FormEvent, useRef, useState } from "react";
import type { ChatSession } from "../api/types";

type SessionAction = () => void | Promise<void>;

interface SessionSidebarProps {
  collapsed: boolean;
  sessions: ChatSession[];
  activeSessionId: string | null;
  isLoading: boolean;
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
  error,
  onCreate,
  onSelect,
  onRename,
  onDelete,
  onRetry,
  onToggleCollapsed
}: SessionSidebarProps) {
  const [editingSessionId, setEditingSessionId] = useState<string | null>(null);
  const [editingTitle, setEditingTitle] = useState("");
  const [pendingAction, setPendingAction] = useState<string | null>(null);
  const pendingActionRef = useRef<string | null>(null);
  const isPending = pendingAction !== null;

  function clearPendingAction(actionName: string) {
    if (pendingActionRef.current !== actionName) return;

    pendingActionRef.current = null;
    setPendingAction(null);
  }

  function runAction(actionName: string, action: SessionAction, onSuccess?: () => void) {
    if (pendingActionRef.current) return;

    pendingActionRef.current = actionName;
    setPendingAction(actionName);

    try {
      const result = action();
      if (!result) {
        onSuccess?.();
        clearPendingAction(actionName);
        return;
      }

      void result
        .then(() => onSuccess?.())
        .catch(() => undefined)
        .finally(() => clearPendingAction(actionName));
    } catch {
      // The parent surfaces operation errors through the error prop.
      clearPendingAction(actionName);
    }
  }

  function beginRename(session: ChatSession) {
    setEditingSessionId(session.id);
    setEditingTitle(session.title);
  }

  function handleRename(event: FormEvent<HTMLFormElement>, sessionId: string) {
    event.preventDefault();
    const title = editingTitle.trim();
    if (!title || isPending) return;

    runAction(
      `rename:${sessionId}`,
      () => onRename(sessionId, title),
      () => {
        setEditingSessionId(null);
        setEditingTitle("");
      }
    );
  }

  if (collapsed) {
    return (
      <aside className="session-sidebar session-sidebar--collapsed" aria-label="会话列表">
        <button
          className="session-sidebar__toggle"
          type="button"
          aria-label="展开会话列表"
          aria-expanded={false}
          title="展开会话列表"
          onClick={onToggleCollapsed}
        >
          ›
        </button>
      </aside>
    );
  }

  return (
    <aside className="session-sidebar" aria-label="会话列表">
      <header className="session-sidebar__header">
        <h2>会话</h2>
        <button
          className="session-sidebar__toggle"
          type="button"
          aria-label="收起会话列表"
          aria-expanded={true}
          title="收起会话列表"
          onClick={onToggleCollapsed}
        >
          ‹
        </button>
      </header>

      <button
        className="session-sidebar__create"
        type="button"
        disabled={isPending}
        onClick={() => runAction("create", onCreate)}
      >
        新建会话
      </button>

      {error ? (
        <div className="session-sidebar__error" role="alert">
          <p>{error}</p>
          <button
            type="button"
            disabled={isPending}
            onClick={() => runAction("retry", onRetry)}
          >
            重试
          </button>
        </div>
      ) : null}

      {isLoading ? (
        <p className="session-sidebar__status" role="status">
          正在加载会话...
        </p>
      ) : null}

      {!isLoading && !error && sessions.length === 0 ? (
        <p className="session-sidebar__status">还没有会话。</p>
      ) : null}

      {!isLoading && sessions.length > 0 ? (
        <ul className="session-sidebar__list">
          {sessions.map((session) => {
            const isActive = session.id === activeSessionId;
            const isEditing = session.id === editingSessionId;

            return (
              <li
                className="session-sidebar__item"
                data-active={isActive ? "true" : undefined}
                key={session.id}
              >
                {isEditing ? (
                  <form
                    className="session-sidebar__rename"
                    onSubmit={(event) => handleRename(event, session.id)}
                  >
                    <input
                      aria-label="会话标题"
                      value={editingTitle}
                      onChange={(event) => setEditingTitle(event.target.value)}
                    />
                    <button
                      type="submit"
                      aria-label="保存标题"
                      title="保存标题"
                      disabled={isPending}
                    >
                      保存
                    </button>
                  </form>
                ) : (
                  <button
                    className="session-sidebar__select"
                    type="button"
                    aria-current={isActive ? "true" : undefined}
                    aria-label={session.title}
                    disabled={isPending}
                    onClick={() => runAction(`select:${session.id}`, () => onSelect(session.id))}
                  >
                    <strong>{session.title}</strong>
                    <span>{session.latestMessagePreview ?? "还没有消息"}</span>
                  </button>
                )}

                {!isEditing ? (
                  <div className="session-sidebar__actions">
                    <button
                      type="button"
                      aria-label={`重命名 ${session.title}`}
                      title={`重命名 ${session.title}`}
                      disabled={isPending}
                      onClick={() => beginRename(session)}
                    >
                      改
                    </button>
                    <button
                      type="button"
                      aria-label={`删除 ${session.title}`}
                      title={`删除 ${session.title}`}
                      disabled={isPending}
                      onClick={() => runAction(`delete:${session.id}`, () => onDelete(session.id))}
                    >
                      ×
                    </button>
                  </div>
                ) : null}
              </li>
            );
          })}
        </ul>
      ) : null}
    </aside>
  );
}

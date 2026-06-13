"use client";

import { FormEvent, KeyboardEvent, useCallback, useEffect, useRef, useState } from "react";
import {
  createSession,
  deleteSession,
  getSessionMessages,
  getSessions,
  postChat,
  renameSession
} from "../api/client";
import type {
  ChatMessage,
  ChatSession,
  PersonaStrength,
  ProviderStatus,
  RoomState,
  StoredChatMessage
} from "../api/types";
import type { ConnectionStatus } from "../lib/connectionStatus";
import { SessionSidebar } from "./SessionSidebar";

const LAST_SESSION_STORAGE_KEY = "kumikoroom.lastSessionId";
const PLAYER_TRACKS = [
  { title: "雨后的走廊", subtitle: "练习室 · 傍晚" },
  { title: "合奏前调音", subtitle: "部室 · 木管声部" },
  { title: "青鸟的间奏", subtitle: "长笛 · 双簧管" }
];

interface FailedOutgoingMessage {
  id: string;
  content: string;
  sessionId: string;
  recentMessages: ChatMessage[];
}

interface RoomShellProps {
  initialState: RoomState;
  connectionStatus: ConnectionStatus;
}

export function RoomShell({ initialState, connectionStatus }: RoomShellProps) {
  const initializedSessionsRef = useRef(false);
  const activeSessionIdRef = useRef<string | null>(null);
  const isSendingRef = useRef(false);
  const sessionActionPendingRef = useRef(false);
  const sessionsLoadingRef = useRef(false);
  const timelineRef = useRef<HTMLDivElement | null>(null);
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [draft, setDraft] = useState("");
  const [isSending, setIsSending] = useState(false);
  const [sendError, setSendError] = useState<string | null>(null);
  const [personaStrength, setPersonaStrength] = useState<PersonaStrength>("medium");
  const [memoryEnabled, setMemoryEnabled] = useState(true);
  const [settingsHydrated, setSettingsHydrated] = useState(false);
  const [providerStatus, setProviderStatus] = useState<ProviderStatus | null>(null);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [mobileSessionsOpen, setMobileSessionsOpen] = useState(false);
  const [mobileSessionMenuId, setMobileSessionMenuId] = useState<string | null>(null);
  const [mobileRenamingSessionId, setMobileRenamingSessionId] = useState<string | null>(null);
  const [mobileRenameTitle, setMobileRenameTitle] = useState("");
  const [mobileDeleteConfirmId, setMobileDeleteConfirmId] = useState<string | null>(null);
  const [sessions, setSessions] = useState<ChatSession[]>([]);
  const [activeSessionId, setActiveSessionIdState] = useState<string | null>(null);
  const [sessionMessages, setSessionMessages] = useState<StoredChatMessage[]>([]);
  const [sessionsLoading, setSessionsLoading] = useState(false);
  const [sessionActionPending, setSessionActionPending] = useState(false);
  const [sessionError, setSessionError] = useState<string | null>(null);
  const [pendingOutgoingMessageId, setPendingOutgoingMessageId] = useState<string | null>(null);
  const [failedOutgoing, setFailedOutgoing] = useState<FailedOutgoingMessage | null>(null);
  const [playerTrackIndex, setPlayerTrackIndex] = useState(0);
  const [isPlayerPlaying, setIsPlayerPlaying] = useState(true);
  const connectionLabel = providerStatus?.label ?? connectionStatus.label;
  const activeTrack = PLAYER_TRACKS[playerTrackIndex] ?? PLAYER_TRACKS[0];
  const setActiveSessionId = useCallback((sessionId: string | null) => {
    activeSessionIdRef.current = sessionId;
    setActiveSessionIdState(sessionId);
  }, []);
  const setSessionsLoadingState = useCallback((loading: boolean) => {
    sessionsLoadingRef.current = loading;
    setSessionsLoading(loading);
  }, []);
  const setSessionActionPendingState = useCallback((pending: boolean) => {
    sessionActionPendingRef.current = pending;
    setSessionActionPending(pending);
  }, []);
  const setSendingState = useCallback((sending: boolean) => {
    isSendingRef.current = sending;
    setIsSending(sending);
  }, []);
  const isSessionOperationBlocked = useCallback(
    () => sessionsLoadingRef.current || sessionActionPendingRef.current || isSendingRef.current,
    []
  );
  const isSessionBusy = sessionsLoading || sessionActionPending || isSending;
  const isComposerDisabled = isSessionBusy || !activeSessionId;
  const isSparseTimeline = shouldUseSparseTimeline(messages);
  const shouldShowEmptyTimeline = activeSessionId !== null && messages.length === 0 && !isSending;
  const resetToEmptyTimeline = useCallback(() => {
    setMessages([]);
    setSessionMessages([]);
  }, []);

  const loadSessionMessages = useCallback(
    async (sessionId: string) => {
      const storedMessages = await getSessionMessages(sessionId);
      setSendError(null);
      setFailedOutgoing(null);
      setPendingOutgoingMessageId(null);
      setSessionMessages(storedMessages);

      if (storedMessages.length === 0) {
        resetToEmptyTimeline();
        return;
      }

      setMessages(storedMessages.map(storedToChatMessage));
    },
    [resetToEmptyTimeline]
  );

  const loadSessions = useCallback(
    async (preferredSessionId?: string | null) => {
      setSessionsLoadingState(true);
      setSessionError(null);

      try {
        let loadedSessions = await getSessions();
        if (loadedSessions.length === 0) {
          const createdSession = await createSession();
          loadedSessions = [createdSession];
        }

        const selectedSession =
          loadedSessions.find((session) => session.id === preferredSessionId) ?? loadedSessions[0];

        await loadSessionMessages(selectedSession.id);
        setSessions(loadedSessions);
        setActiveSessionId(selectedSession.id);
      } catch {
        setSessionError("会话加载失败");
      } finally {
        setSessionsLoadingState(false);
      }
    },
    [loadSessionMessages, setActiveSessionId, setSessionsLoadingState]
  );

  useEffect(() => {
    if (typeof window === "undefined") return;

    const savedPersona = window.localStorage.getItem("kumikoroom.personaStrength");
    if (savedPersona === "medium" || savedPersona === "strong") {
      setPersonaStrength(savedPersona);
    }

    const savedMemoryEnabled = window.localStorage.getItem("kumikoroom.memoryEnabled");
    if (savedMemoryEnabled === "false") {
      setMemoryEnabled(false);
    }

    setSettingsHydrated(true);
  }, []);

  useEffect(() => {
    if (typeof window === "undefined" || initializedSessionsRef.current) return;

    initializedSessionsRef.current = true;
    const savedSessionId = window.localStorage.getItem(LAST_SESSION_STORAGE_KEY);
    void loadSessions(savedSessionId);
  }, [loadSessions]);

  useEffect(() => {
    if (!settingsHydrated || typeof window === "undefined") return;

    window.localStorage.setItem("kumikoroom.personaStrength", personaStrength);
  }, [personaStrength, settingsHydrated]);

  useEffect(() => {
    if (!settingsHydrated || typeof window === "undefined") return;

    window.localStorage.setItem("kumikoroom.memoryEnabled", String(memoryEnabled));
  }, [memoryEnabled, settingsHydrated]);

  useEffect(() => {
    if (typeof window === "undefined" || !activeSessionId) return;

    window.localStorage.setItem(LAST_SESSION_STORAGE_KEY, activeSessionId);
  }, [activeSessionId]);

  useEffect(() => {
    const timeline = timelineRef.current;
    if (!timeline) return;

    timeline.scrollTop = timeline.scrollHeight;
  }, [messages, isSending, failedOutgoing]);

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const message = draft.trim();
    if (!message || isSendingRef.current || isSessionOperationBlocked() || !activeSessionIdRef.current) {
      return;
    }

    setDraft("");
    await sendChatMessage(message);
  }

  async function handleRetryFailedMessage() {
    if (!failedOutgoing || isSessionOperationBlocked()) return;

    await sendChatMessage(failedOutgoing.content, failedOutgoing);
  }

  async function sendChatMessage(message: string, retryMessage?: FailedOutgoingMessage) {
    const submittedSessionId = retryMessage?.sessionId ?? activeSessionIdRef.current;
    if (!submittedSessionId) return;

    setSendError(null);
    setFailedOutgoing(null);
    setSendingState(true);

    const recentMessages = retryMessage?.recentMessages ?? messages.slice(-8);
    const userMessage: ChatMessage = {
      id: retryMessage?.id ?? `user-${Date.now()}`,
      role: "user",
      content: message
    };
    setPendingOutgoingMessageId(userMessage.id);

    if (!retryMessage) {
      setMessages((current) => [...current, userMessage]);
    }

    try {
      const response = await postChat({
        message,
        roomState: initialState,
        sessionId: submittedSessionId ?? undefined,
        recentMessages,
        personaStrength,
        memoryEnabled
      });
      if (activeSessionIdRef.current !== submittedSessionId) {
        return;
      }

      const storedSessionId = response.session?.id ?? submittedSessionId;

      setProviderStatus(response.providerStatus);
      setMessages((current) => [...current, response.reply]);
      if (storedSessionId) {
        setSessionMessages((current) => [
          ...current,
          chatMessageToStored(userMessage, storedSessionId),
          chatMessageToStored(response.reply, storedSessionId, response.providerStatus)
        ]);
      }
      const responseSession = response.session;
      if (responseSession) {
        setSessions((current) => upsertSessionToFront(current, responseSession));
        if (responseSession.id === submittedSessionId) {
          setActiveSessionId(responseSession.id);
        }
      }
    } catch {
      setFailedOutgoing({
        id: userMessage.id,
        content: message,
        sessionId: submittedSessionId,
        recentMessages
      });
      setSendError("消息没送出去，检查本地 API 后可以重试。");
    } finally {
      setPendingOutgoingMessageId(null);
      setSendingState(false);
    }
  }

  function handleComposerKeyDown(event: KeyboardEvent<HTMLTextAreaElement>) {
    const nativeEvent = event.nativeEvent as KeyboardEvent<HTMLTextAreaElement>["nativeEvent"] & {
      isComposing?: boolean;
      keyCode?: number;
    };
    const isComposing = nativeEvent.isComposing || nativeEvent.keyCode === 229;

    if (event.key !== "Enter" || event.shiftKey || isComposing) {
      return;
    }

    event.preventDefault();
    if (isComposerDisabled || draft.trim().length === 0) {
      return;
    }

    event.currentTarget.form?.requestSubmit();
  }

  async function handleCreateSession() {
    if (isSessionOperationBlocked()) return;

    setSessionActionPendingState(true);
    setSessionError(null);

    try {
      const createdSession = await createSession();
      await loadSessionMessages(createdSession.id);
      setSessions((current) => upsertSessionToFront(current, createdSession));
      setActiveSessionId(createdSession.id);
    } catch {
      setSessionError("会话加载失败");
      throw new Error("Session create failed");
    } finally {
      setSessionActionPendingState(false);
    }
  }

  async function handleSelectSession(sessionId: string) {
    if (sessionId === activeSessionIdRef.current || isSessionOperationBlocked()) return;

    setSessionActionPendingState(true);
    setSessionError(null);

    try {
      await loadSessionMessages(sessionId);
      setActiveSessionId(sessionId);
    } catch {
      setSessionError("会话加载失败");
      throw new Error("Session select failed");
    } finally {
      setSessionActionPendingState(false);
    }
  }

  async function handleRenameSession(sessionId: string, title: string) {
    setSessionError(null);

    try {
      const updatedSession = await renameSession(sessionId, title);
      setSessions((current) =>
        current.map((session) => (session.id === sessionId ? updatedSession : session))
      );
    } catch {
      setSessionError("会话加载失败");
      throw new Error("Session rename failed");
    }
  }

  async function handleDeleteSession(sessionId: string) {
    if (isSessionOperationBlocked()) return;

    setSessionActionPendingState(true);
    setSessionError(null);

    try {
      await deleteSession(sessionId);
      const remainingSessions = sessions.filter((session) => session.id !== sessionId);

      if (remainingSessions.length === 0) {
        const createdSession = await createSession();
        await loadSessionMessages(createdSession.id);
        setSessions([createdSession]);
        setActiveSessionId(createdSession.id);
        return;
      }

      if (sessionId === activeSessionIdRef.current) {
        const nextSession = remainingSessions[0];
        await loadSessionMessages(nextSession.id);
        setSessions(remainingSessions);
        setActiveSessionId(nextSession.id);
        return;
      }

      setSessions(remainingSessions);
    } catch {
      setSessionError("会话加载失败");
      throw new Error("Session delete failed");
    } finally {
      setSessionActionPendingState(false);
    }
  }

  async function handleMobileCreateSession() {
    try {
      await handleCreateSession();
      resetMobileSessionManagement();
      setMobileSessionsOpen(false);
    } catch {
      // Session errors are shown by the shared sidebar state.
    }
  }

  async function handleMobileSelectSession(sessionId: string) {
    try {
      await handleSelectSession(sessionId);
      resetMobileSessionManagement();
      setMobileSessionsOpen(false);
    } catch {
      // Session errors are shown by the shared sidebar state.
    }
  }

  function resetMobileSessionManagement() {
    setMobileSessionMenuId(null);
    setMobileRenamingSessionId(null);
    setMobileRenameTitle("");
    setMobileDeleteConfirmId(null);
  }

  function beginMobileRename(session: ChatSession) {
    if (isSessionBusy) return;

    setMobileSessionMenuId(null);
    setMobileDeleteConfirmId(null);
    setMobileRenamingSessionId(session.id);
    setMobileRenameTitle(session.title);
  }

  function cancelMobileRename() {
    setMobileRenamingSessionId(null);
    setMobileRenameTitle("");
  }

  async function submitMobileRename(event: FormEvent<HTMLFormElement>, session: ChatSession) {
    event.preventDefault();
    const nextTitle = mobileRenameTitle.trim();
    if (!nextTitle || nextTitle === session.title) {
      cancelMobileRename();
      return;
    }

    try {
      await handleRenameSession(session.id, nextTitle);
      cancelMobileRename();
    } catch {
      // Session errors are shown by the shared sidebar state.
    }
  }

  function handleMobileRenameKeyDown(event: KeyboardEvent<HTMLInputElement>) {
    if (event.key === "Escape") {
      event.preventDefault();
      cancelMobileRename();
    }
  }

  function askMobileDelete(sessionId: string) {
    if (isSessionBusy) return;

    setMobileSessionMenuId(null);
    setMobileRenamingSessionId(null);
    setMobileDeleteConfirmId(sessionId);
  }

  async function confirmMobileDelete(session: ChatSession) {
    try {
      await handleDeleteSession(session.id);
      setMobileDeleteConfirmId(null);
      setMobileSessionMenuId(null);
    } catch {
      // Session errors are shown by the shared sidebar state.
    }
  }

  return (
    <main className="room-stage">
      <section className="room-workspace" aria-label="KumikoRoom">
        <SessionSidebar
          collapsed={false}
          sessions={sessions}
          activeSessionId={activeSessionId}
          isLoading={sessionsLoading && sessions.length === 0}
          isBusy={isSessionBusy}
          error={sessionError}
          onCreate={handleCreateSession}
          onSelect={handleSelectSession}
          onRename={handleRenameSession}
          onDelete={handleDeleteSession}
          onRetry={() => loadSessions(activeSessionId)}
          onToggleCollapsed={() => undefined}
        />

        <section className="chat" aria-label="聊天">
          <header className="chat-head">
            <div className="person">
              <span className="avatar small" aria-hidden="true" />
              <span className="person-copy">
                <strong>{initialState.character.displayName}</strong>
                <span>{isSending ? "正在回复" : "刚刚"}</span>
              </span>
            </div>
            <div className="toolbar">
              <div className="mobile-session-tools" aria-label="会话工具">
                <button
                  className="tool mobile-session-trigger"
                  type="button"
                  aria-label="打开会话列表"
                  aria-controls="mobile-session-panel"
                  aria-expanded={mobileSessionsOpen}
                  onClick={() => setMobileSessionsOpen((current) => !current)}
                >
                  ≡
                </button>
                <button
                  className="tool mobile-session-create"
                  type="button"
                  aria-label="新建聊天"
                  disabled={isSessionBusy}
                  onClick={() => void handleMobileCreateSession()}
                >
                  +
                </button>
              </div>
              <nav className="chat-nav" aria-label="页面导航">
                <a className="tool chat-nav-link" href="/">
                  首页
                </a>
                <a className="tool chat-nav-link" href="/studio">
                  资料室
                </a>
              </nav>
              <span
                className={`api api--${connectionStatus.tone}`}
                role="status"
                aria-label={connectionLabel}
              >
                {connectionLabel}
              </span>
              <button className="tool" type="button" aria-label="搜索聊天">
                ⌕
              </button>
              <button
                className="tool settings-trigger"
                type="button"
                aria-label="模型与偏好"
                aria-haspopup="dialog"
                aria-expanded={settingsOpen}
                aria-controls="room-settings-popover"
                onClick={() => setSettingsOpen((current) => !current)}
              >
                ⋯
              </button>
              {settingsOpen ? (
                <div
                  className="settings-popover"
                  id="room-settings-popover"
                  role="dialog"
                  aria-label="模型与偏好设置"
                >
                  <div className="settings-popover__header">
                    <h2>模型与偏好</h2>
                    <button
                      type="button"
                      aria-label="关闭模型设置"
                      onClick={() => setSettingsOpen(false)}
                    >
                      ×
                    </button>
                  </div>
                  <div className="model-status-row">
                    <span>当前连接</span>
                    <strong>{connectionLabel}</strong>
                  </div>
                  <div className="settings-section">
                    <span>模型</span>
                    <strong>{providerStatus?.model ?? "发送后同步"}</strong>
                  </div>
                  <div className="ai-setting-row">
                    <span>人设强度</span>
                    <div className="segmented-control" role="group" aria-label="人设强度">
                      <button
                        type="button"
                        aria-pressed={personaStrength === "medium"}
                        onClick={() => setPersonaStrength("medium")}
                      >
                        中
                      </button>
                      <button
                        type="button"
                        aria-pressed={personaStrength === "strong"}
                        onClick={() => setPersonaStrength("strong")}
                      >
                        强
                      </button>
                    </div>
                  </div>
                  <label className="memory-toggle">
                    <span>自动记忆</span>
                    <input
                      type="checkbox"
                      checked={memoryEnabled}
                      onChange={(event) => setMemoryEnabled(event.target.checked)}
                    />
                  </label>
                </div>
              ) : null}
            </div>
          </header>

          {mobileSessionsOpen ? (
            <div className="mobile-session-panel" id="mobile-session-panel" role="dialog" aria-label="会话列表">
              <div className="mobile-session-panel__header">
                <strong>会话</strong>
                <button type="button" aria-label="关闭会话列表" onClick={() => setMobileSessionsOpen(false)}>
                  ×
                </button>
              </div>

              {sessionError ? (
                <div className="mobile-session-status" role="alert">
                  <span>{sessionError}</span>
                  <button type="button" disabled={isSessionBusy} onClick={() => void loadSessions(activeSessionId)}>
                    重试
                  </button>
                </div>
              ) : null}

              {sessionsLoading && sessions.length === 0 ? (
                <p className="mobile-session-status" role="status">
                  正在加载会话...
                </p>
              ) : null}

              {!sessionsLoading && !sessionError && sessions.length === 0 ? (
                <p className="mobile-session-status">还没有会话。</p>
              ) : null}

              {sessions.length > 0 ? (
                <div className="mobile-session-list">
                  {sessions.map((session) => {
                    const isRenaming = mobileRenamingSessionId === session.id;
                    const menuOpen = mobileSessionMenuId === session.id;
                    const confirmingDelete = mobileDeleteConfirmId === session.id;

                    return (
                      <div className="mobile-session-item" key={session.id}>
                        {isRenaming ? (
                          <form
                            className="mobile-session-rename-form"
                            onSubmit={(event) => void submitMobileRename(event, session)}
                          >
                            <label className="sr-only" htmlFor={`mobile-session-rename-${session.id}`}>
                              会话名称
                            </label>
                            <input
                              id={`mobile-session-rename-${session.id}`}
                              value={mobileRenameTitle}
                              disabled={isSessionBusy}
                              autoFocus
                              onChange={(event) => setMobileRenameTitle(event.target.value)}
                              onKeyDown={handleMobileRenameKeyDown}
                            />
                            <button type="submit" aria-label={`保存 ${session.title}`} disabled={isSessionBusy}>
                              保存
                            </button>
                            <button
                              type="button"
                              aria-label={`取消重命名 ${session.title}`}
                              disabled={isSessionBusy}
                              onClick={cancelMobileRename}
                            >
                              取消
                            </button>
                          </form>
                        ) : (
                          <div className="mobile-session-row-wrap">
                            <button
                              className="mobile-session-row"
                              type="button"
                              data-active={session.id === activeSessionId ? "true" : undefined}
                              aria-current={session.id === activeSessionId ? "true" : undefined}
                              aria-label={session.title}
                              disabled={isSessionBusy}
                              onClick={() => void handleMobileSelectSession(session.id)}
                            >
                              <span className="avatar" aria-hidden="true" />
                              <span>
                                <strong>{session.title}</strong>
                                <small>{session.latestMessagePreview ?? "还没有消息"}</small>
                              </span>
                            </button>
                            <button
                              className="mobile-session-more"
                              type="button"
                              aria-label={`更多 ${session.title}`}
                              aria-haspopup="menu"
                              aria-expanded={menuOpen}
                              disabled={isSessionBusy}
                              onClick={() => setMobileSessionMenuId(menuOpen ? null : session.id)}
                            >
                              ⋯
                            </button>
                          </div>
                        )}

                        {menuOpen ? (
                          <div className="mobile-session-menu" role="menu" aria-label={`${session.title} 操作`}>
                            <button
                              type="button"
                              role="menuitem"
                              aria-label={`重命名 ${session.title}`}
                              onClick={() => beginMobileRename(session)}
                            >
                              重命名
                            </button>
                            <button
                              type="button"
                              role="menuitem"
                              aria-label={`删除 ${session.title}`}
                              onClick={() => askMobileDelete(session.id)}
                            >
                              删除
                            </button>
                          </div>
                        ) : null}

                        {confirmingDelete ? (
                          <div
                            className="mobile-session-delete-confirm"
                            role="alertdialog"
                            aria-label={`删除 ${session.title}`}
                          >
                            <span>删除这个会话？</span>
                            <button
                              type="button"
                              aria-label={`确认删除 ${session.title}`}
                              disabled={isSessionBusy}
                              onClick={() => void confirmMobileDelete(session)}
                            >
                              删除
                            </button>
                            <button
                              type="button"
                              aria-label={`取消删除 ${session.title}`}
                              disabled={isSessionBusy}
                              onClick={() => setMobileDeleteConfirmId(null)}
                            >
                              取消
                            </button>
                          </div>
                        ) : null}
                      </div>
                    );
                  })}
                </div>
              ) : null}
            </div>
          ) : null}

          <div
            ref={timelineRef}
            className={isSparseTimeline ? "log chat-timeline chat-timeline--sparse" : "log chat-timeline"}
            aria-label="聊天时间线"
            aria-live="polite"
          >
            <div className="log-inner">
              <div className="day">今天</div>
              {shouldShowEmptyTimeline ? (
                <p className="timeline-empty" role="status">
                  还没有消息
                </p>
              ) : null}
              {messages.map((message) => {
                const isUser = message.role === "user";
                const isShort = message.content.trim().length <= 24;
                const isPending = pendingOutgoingMessageId === message.id;
                const isFailed = failedOutgoing?.id === message.id;
                const messageClassName = [
                  "message",
                  isUser ? "me" : "",
                  isShort ? "message--short" : "",
                  isPending ? "message--pending" : "",
                  isFailed ? "message--failed" : ""
                ]
                  .filter(Boolean)
                  .join(" ");

                return (
                  <article className={messageClassName} key={message.id}>
                    {!isUser ? <span className="avatar small" aria-hidden="true" /> : null}
                    <div className="message-block">
                      <div className="meta">
                        <span>{isUser ? "你" : initialState.character.displayName}</span>
                        <span>{getMessageStatusLabel(isUser, isPending, isFailed)}</span>
                      </div>
                      <p className="bubble">{message.content}</p>
                      {isFailed ? (
                        <button
                          className="message-retry"
                          type="button"
                          disabled={isSending}
                          onClick={handleRetryFailedMessage}
                        >
                          重试发送
                        </button>
                      ) : null}
                      <div className="message-actions" aria-label="消息操作">
                        <button type="button" aria-label="复制">
                          ⧉
                        </button>
                        <button type="button" aria-label={isUser ? "编辑" : "重试"}>
                          {isUser ? "✎" : "↻"}
                        </button>
                      </div>
                    </div>
                    {isUser ? <span className="avatar small" aria-hidden="true" /> : null}
                  </article>
                );
              })}
              {isSending ? (
                <article className="message message--typing" aria-label="久美子正在输入">
                  <span className="avatar small" aria-hidden="true" />
                  <div className="message-block">
                    <div className="meta">
                      <span>{initialState.character.displayName}</span>
                      <span>正在输入</span>
                    </div>
                    <p className="bubble typing-bubble" aria-hidden="true">
                      <span />
                      <span />
                      <span />
                    </p>
                  </div>
                </article>
              ) : null}
            </div>
          </div>

          <form className="composer chat-composer" onSubmit={handleSubmit}>
            <div className="composer-tools" aria-label="输入工具">
              <button className="tool" type="button" aria-label="表情">
                ·
              </button>
              <button className="tool" type="button" aria-label="图片">
                □
              </button>
              <button className="tool" type="button" aria-label="语音">
                ♬
              </button>
            </div>
            <div className="composer-main">
              <label className="sr-only" htmlFor="workspace-message">
                写一条消息
              </label>
              <textarea
                id="workspace-message"
                aria-label="写一条消息"
                placeholder="输入消息..."
                rows={1}
                value={draft}
                disabled={isComposerDisabled}
                onChange={(event) => setDraft(event.target.value)}
                onKeyDown={handleComposerKeyDown}
              />
              <div className="composer-actions" aria-label="消息操作">
                <button
                  className="send"
                  type="submit"
                  disabled={isComposerDisabled || draft.trim().length === 0}
                >
                  {isSending ? "发送中" : "发送"}
                </button>
              </div>
            </div>
            {sendError ? (
              <p className="composer-error" role="alert">
                {sendError}
              </p>
            ) : null}
          </form>
        </section>

        <aside className="profile" aria-label="播放器面板" data-playing={isPlayerPlaying ? "true" : "false"}>
          <div className="standee-stage" aria-hidden="true">
            <img className="standee-img" src="/assets/kumiko-standee-v1.png" alt="" />
          </div>
          <section className="media-player" aria-label="氛围播放器">
            <div className="track-head">
              <div className="track-title">
                <strong>{activeTrack.title}</strong>
                <span>{activeTrack.subtitle}</span>
              </div>
              <div className="equalizer" aria-hidden="true">
                <i />
                <i />
                <i />
              </div>
            </div>
            <div className="progress" aria-label="播放进度">
              <span>00:42</span>
              <div className="bar">
                <span />
              </div>
              <span>02:18</span>
            </div>
            <div className="player-controls">
              <button className="control" type="button" aria-label="上一首">
                ‹
              </button>
              <button
                className="control play"
                type="button"
                aria-label={isPlayerPlaying ? "暂停" : "播放"}
                onClick={() => setIsPlayerPlaying((current) => !current)}
              >
                {isPlayerPlaying ? "Ⅱ" : "▶"}
              </button>
              <button className="control" type="button" aria-label="下一首">
                ›
              </button>
              <div className="volume" aria-label="音量">
                <span />
              </div>
              <button className="control" type="button" aria-label="循环">
                ↻
              </button>
            </div>
            <div className="playlist" aria-label="播放列表">
              {PLAYER_TRACKS.map((track, index) => (
                <button
                  type="button"
                  data-active={index === playerTrackIndex ? "true" : undefined}
                  key={track.title}
                  onClick={() => setPlayerTrackIndex(index)}
                >
                  {track.title.replace("的", "")}
                </button>
              ))}
            </div>
          </section>
        </aside>
      </section>
    </main>
  );
}

function shouldUseSparseTimeline(messages: ChatMessage[]): boolean {
  const visibleMessages = messages.filter((message) => message.id !== "idle-line");
  if (visibleMessages.length === 0) return false;

  const speakers = new Set(visibleMessages.map((message) => message.role));
  return (
    speakers.size === 1 &&
    visibleMessages.every((message) => message.content.trim().length > 0) &&
    visibleMessages.every((message) => message.content.trim().length <= 24)
  );
}

function getMessageStatusLabel(isUser: boolean, isPending: boolean, isFailed: boolean): string {
  if (!isUser) return "刚刚";
  if (isFailed) return "未送达";
  if (isPending) return "发送中";

  return "刚刚";
}

function storedToChatMessage(message: StoredChatMessage): ChatMessage {
  return {
    id: message.id,
    role: message.role,
    content: message.content
  };
}

function chatMessageToStored(
  message: ChatMessage,
  sessionId: string,
  providerStatus?: ProviderStatus
): StoredChatMessage {
  return {
    ...message,
    sessionId,
    createdAt: new Date().toISOString(),
    provider: providerStatus?.provider ?? null,
    providerModel: providerStatus?.model ?? null,
    providerConfigured: providerStatus?.configured ?? null,
    providerLabel: providerStatus?.label ?? null
  };
}

function upsertSessionToFront(sessions: ChatSession[], updatedSession: ChatSession): ChatSession[] {
  return [updatedSession, ...sessions.filter((session) => session.id !== updatedSession.id)];
}

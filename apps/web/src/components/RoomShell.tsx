"use client";

import { FormEvent, useCallback, useEffect, useRef, useState } from "react";
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
  MemoryEvent,
  PersonaStrength,
  ProviderStatus,
  RoomState,
  StoredChatMessage
} from "../api/types";
import type { ConnectionStatus } from "../lib/connectionStatus";
import { getIdleLine } from "../lib/roomState";
import { SessionSidebar } from "./SessionSidebar";

const LAST_SESSION_STORAGE_KEY = "kumikoroom.lastSessionId";
const SIDEBAR_COLLAPSED_STORAGE_KEY = "kumikoroom.sessionsCollapsed";

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
  const [messages, setMessages] = useState<ChatMessage[]>([
    {
      id: "idle-line",
      role: "kumiko",
      content: getIdleLine(initialState)
    }
  ]);
  const [draft, setDraft] = useState("");
  const [currentExpression, setCurrentExpression] = useState(initialState.character.expression);
  const [isSending, setIsSending] = useState(false);
  const [sendError, setSendError] = useState<string | null>(null);
  const [personaStrength, setPersonaStrength] = useState<PersonaStrength>("medium");
  const [memoryEnabled, setMemoryEnabled] = useState(true);
  const [settingsHydrated, setSettingsHydrated] = useState(false);
  const [providerStatus, setProviderStatus] = useState<ProviderStatus | null>(null);
  const [recentMemoryEvents, setRecentMemoryEvents] = useState<MemoryEvent[]>([]);
  const [sessions, setSessions] = useState<ChatSession[]>([]);
  const [activeSessionId, setActiveSessionIdState] = useState<string | null>(null);
  const [sessionMessages, setSessionMessages] = useState<StoredChatMessage[]>([]);
  const [sessionsCollapsed, setSessionsCollapsed] = useState(false);
  const [sessionsLoading, setSessionsLoading] = useState(false);
  const [sessionActionPending, setSessionActionPending] = useState(false);
  const [sessionError, setSessionError] = useState<string | null>(null);
  const connectionLabel = providerStatus?.label ?? connectionStatus.label;
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
  const resetToIdleLine = useCallback(() => {
    setMessages([
      {
        id: "idle-line",
        role: "kumiko",
        content: getIdleLine(initialState)
      }
    ]);
    setSessionMessages([]);
  }, [initialState]);

  const loadSessionMessages = useCallback(
    async (sessionId: string) => {
      const storedMessages = await getSessionMessages(sessionId);
      setSessionMessages(storedMessages);

      if (storedMessages.length === 0) {
        resetToIdleLine();
        return;
      }

      setMessages(storedMessages.map(storedToChatMessage));
    },
    [resetToIdleLine]
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
    const savedCollapsed = window.localStorage.getItem(SIDEBAR_COLLAPSED_STORAGE_KEY);
    const savedSessionId = window.localStorage.getItem(LAST_SESSION_STORAGE_KEY);
    setSessionsCollapsed(savedCollapsed === "true");
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
    if (typeof window === "undefined") return;

    window.localStorage.setItem(SIDEBAR_COLLAPSED_STORAGE_KEY, String(sessionsCollapsed));
  }, [sessionsCollapsed]);

  const summaryItems = [
    {
      label: "今日心情",
      value: initialState.music.listeningMood ?? "还没记录"
    },
    {
      label: "听歌日记",
      value: initialState.diarySummary
    },
    {
      label: "灵感便签",
      value: `${initialState.inspirationCount} 条灵感`
    },
    {
      label: "创作工程",
      value: `${initialState.studio.unfinishedCount} 个待整理`
    }
  ];

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const message = draft.trim();
    const submittedSessionId = activeSessionIdRef.current;
    if (!message || isSendingRef.current || isSessionOperationBlocked() || !submittedSessionId) {
      return;
    }

    setDraft("");
    setSendError(null);
    setSendingState(true);

    try {
      const recentMessages = messages.slice(-8);
      const userMessage: ChatMessage = {
        id: `user-${Date.now()}`,
        role: "user",
        content: message
      };
      setMessages((current) => [...current, userMessage]);

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

      setCurrentExpression(response.expression);
      setProviderStatus(response.providerStatus);
      setRecentMemoryEvents(response.memoryEvents);
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
      setSendError("消息发送失败，请确认本地 API 是否在运行。");
    } finally {
      setSendingState(false);
    }
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

  return (
    <main
      className={
        sessionsCollapsed ? "room-workspace room-workspace--sessions-collapsed" : "room-workspace"
      }
    >
      <SessionSidebar
        collapsed={sessionsCollapsed}
        sessions={sessions}
        activeSessionId={activeSessionId}
        isLoading={isSessionBusy}
        error={sessionError}
        onCreate={handleCreateSession}
        onSelect={handleSelectSession}
        onRename={handleRenameSession}
        onDelete={handleDeleteSession}
        onRetry={() => loadSessions(activeSessionId)}
        onToggleCollapsed={() => setSessionsCollapsed((current) => !current)}
      />
      <section className="workspace-card dialogue-card" aria-label="对话工作区">
        <header className="panel-heading">
          <div>
            <p className="eyebrow">KumikoRoom</p>
            <h1>和久美子说会儿话</h1>
          </div>
          <span
            className={`connection-chip connection-chip--${connectionStatus.tone}`}
            role="status"
            aria-label={connectionLabel}
          >
            {connectionLabel}
          </span>
        </header>

        <div className="chat-timeline" aria-label="聊天时间线">
          {messages.map((message) => (
            <article className={`chat-message chat-message--${message.role}`} key={message.id}>
              <span>{message.role === "kumiko" ? initialState.character.displayName : "你"}</span>
              <p>{message.content}</p>
            </article>
          ))}
        </div>

        <form className="chat-composer" onSubmit={handleSubmit}>
          <label className="sr-only" htmlFor="workspace-message">
            写一条消息
          </label>
          <textarea
            id="workspace-message"
            aria-label="写一条消息"
            placeholder="今天想聊哪首歌，或者记录一个灵感？"
            rows={3}
            value={draft}
            disabled={isComposerDisabled}
            onChange={(event) => setDraft(event.target.value)}
          />
          {sendError ? (
            <p className="composer-error" role="alert">
              {sendError}
            </p>
          ) : null}
          <div className="composer-actions" aria-label="消息操作">
            <button type="submit" disabled={isComposerDisabled || draft.trim().length === 0}>
              {isSending ? "发送中" : "发送"}
            </button>
          </div>
        </form>
      </section>

      <aside className="workspace-side">
        <section className="workspace-card summary-card" aria-label="今日摘要">
          <div className="panel-heading">
            <div>
              <p className="eyebrow">Today</p>
              <h2>今日摘要</h2>
            </div>
            <span className="soft-badge">{expressionLabel[currentExpression]}</span>
          </div>
          <div className="summary-list">
            {summaryItems.map((item) => (
              <div className="summary-row" key={item.label}>
                <span>{item.label}</span>
                <strong>{item.value}</strong>
              </div>
            ))}
          </div>
          <a className="text-link" href={initialState.studio.route} aria-label="打开创作资料">
            打开创作资料
          </a>
        </section>

        <section className="workspace-card utility-card" aria-label="本地音乐状态">
          <p className="eyebrow">Local</p>
          <h2>本地音乐状态</h2>
          <div className="utility-row">
            <span>当前曲目</span>
            <strong>{initialState.music.currentTrackTitle ?? "未选择歌曲"}</strong>
          </div>
          <div className="utility-row">
            <span>播放器</span>
            <strong>待接入</strong>
          </div>
        </section>

        <section className="workspace-card ai-card" aria-label="AI 设置">
          <p className="eyebrow">AI</p>
          <h2>模型与记忆</h2>
          <div className="utility-row">
            <span>当前连接</span>
            <strong>{connectionLabel}</strong>
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
            <input
              type="checkbox"
              checked={memoryEnabled}
              onChange={(event) => setMemoryEnabled(event.target.checked)}
            />
            自动记忆
          </label>
          <div className="memory-events" aria-label="最近记住的内容">
            {recentMemoryEvents.length === 0 ? (
              <p>还没有新的记忆。</p>
            ) : (
              recentMemoryEvents.map((event) => <p key={event.id}>{event.text}</p>)
            )}
          </div>
        </section>
      </aside>
    </main>
  );
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
  return [
    updatedSession,
    ...sessions.filter((session) => session.id !== updatedSession.id)
  ];
}

const expressionLabel: Record<RoomState["character"]["expression"], string> = {
  neutral: "平静",
  listening: "倾听",
  thinking: "思考",
  encouraging: "鼓励"
};

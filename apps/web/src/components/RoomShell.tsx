"use client";

import { FormEvent, KeyboardEvent, SyntheticEvent, useCallback, useEffect, useRef, useState } from "react";
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
  RoomClientAction,
  RoomState,
  StoredChatMessage
} from "../api/types";
import type { ConnectionStatus } from "../lib/connectionStatus";
import { PLAYER_TRACKS, buildListeningContext } from "../lib/musicItems";
import type { ListeningContext, MusicItem, MusicSourceKind } from "../lib/musicItems";
import { buildMusicAgentState } from "../lib/musicAgentState";
import {
  addQueueItem,
  applyClientMusicActionToQueue,
  clearUpcomingQueue,
  createInitialMusicQueue,
  DEFAULT_RECENT_LIMIT,
  getCurrentQueueEntry,
  getPlaybackQueueEntries,
  getQueuePreview,
  getRecentQueueEntries,
  getSavedQueueEntries,
  getUpcomingQueueEntries,
  playQueueItem,
  removeQueueEntry,
  saveQueueItem,
  toggleQueueEntrySaved,
  unsaveQueueItem,
  type MusicQueueEntry,
  type MusicQueueState
} from "../lib/musicQueue";
import { SessionSidebar } from "./SessionSidebar";
import { VideoMiniWindow } from "./VideoMiniWindow";

const LAST_SESSION_STORAGE_KEY = "kumikoroom.lastSessionId";
const MUSIC_QUEUE_STORAGE_KEY = "kumikoroom.musicQueue";

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
  const platformAudioRef = useRef<HTMLAudioElement | null>(null);
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
  const [musicQueue, setMusicQueue] = useState<MusicQueueState>(() => createInitialMusicQueue(PLAYER_TRACKS));
  const [musicQueueHydrated, setMusicQueueHydrated] = useState(false);
  const [queuePanelOpen, setQueuePanelOpen] = useState(false);
  const [queuePanelTab, setQueuePanelTab] = useState<"upcoming" | "recent" | "saved">("upcoming");
  const [isPlayerPlaying, setIsPlayerPlaying] = useState(true);
  const [playerCurrentTime, setPlayerCurrentTime] = useState(0);
  const [playerDuration, setPlayerDuration] = useState((PLAYER_TRACKS[0]?.durationMs ?? 0) / 1000);
  const [videoWindowOpen, setVideoWindowOpen] = useState(false);
  const [videoWindowSize, setVideoWindowSize] = useState<"compact" | "large">("compact");
  const musicQueueRef = useRef(musicQueue);
  const videoWindowOpenRef = useRef(videoWindowOpen);
  const connectionLabel = providerStatus?.label ?? connectionStatus.label;
  musicQueueRef.current = musicQueue;
  videoWindowOpenRef.current = videoWindowOpen;
  const playerQueueEntries = getPlaybackQueueEntries(musicQueue);
  const playerQueue = playerQueueEntries.map((entry) => entry.item);
  const activeQueueEntry = getCurrentQueueEntry(musicQueue) ?? playerQueueEntries[0] ?? null;
  const activeTrack = activeQueueEntry?.item ?? PLAYER_TRACKS[0];
  const playerTrackIndex = Math.max(0, playerQueue.findIndex((track) => track.id === activeTrack.id));
  const queuePreview = getQueuePreview(musicQueue);
  const upcomingQueueEntries = getUpcomingQueueEntries(musicQueue);
  const recentQueueEntries = getRecentQueueEntries(musicQueue);
  const savedQueueEntries = getSavedQueueEntries(musicQueue);
  const visibleQueuePanelEntries = getVisibleQueuePanelEntries(
    queuePanelTab,
    upcomingQueueEntries,
    recentQueueEntries,
    savedQueueEntries
  );
  const hasPlatformAudio = Boolean(activeTrack.platformAudioUrl);
  const activeTrackDuration = activeTrack.durationMs / 1000;
  const playerDurationSeconds = playerDuration > 0 ? playerDuration : activeTrackDuration;
  const playerProgress = hasPlatformAudio && playerDurationSeconds > 0
    ? Math.min(100, Math.max(0, (playerCurrentTime / playerDurationSeconds) * 100))
    : 0;
  const playerProgressWidth = `${Math.round(playerProgress * 10) / 10}%`;
  const playButtonLabel = hasPlatformAudio ? (isPlayerPlaying ? "暂停" : "播放") : "打开平台播放器";
  const activeListeningContext = buildListeningContext(activeTrack, isPlayerPlaying);
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
    if (typeof window === "undefined") return;

    const storedQueue = readStoredMusicQueue(window.localStorage);
    if (storedQueue) {
      commitMusicQueue(storedQueue);
    }
    setMusicQueueHydrated(true);
  }, []);

  useEffect(() => {
    if (!musicQueueHydrated || typeof window === "undefined") return;

    window.localStorage.setItem(MUSIC_QUEUE_STORAGE_KEY, JSON.stringify(musicQueue));
  }, [musicQueue, musicQueueHydrated]);

  useEffect(() => {
    if (activeTrack.canOpenVideo) return;

    commitVideoWindowOpen(false);
  }, [activeTrack.canOpenVideo]);

  useEffect(() => {
    setPlayerCurrentTime(0);
    setPlayerDuration(activeTrack.durationMs / 1000);
  }, [activeTrack.id, activeTrack.durationMs]);

  useEffect(() => {
    if (!activeTrack.platformAudioUrl || !isPlayerPlaying) return;

    void playPlatformAudio();
  }, [activeTrack.id, activeTrack.platformAudioUrl, isPlayerPlaying]);

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

    const listeningContext = activeListeningContext;
    const musicState = buildMusicAgentState(musicQueue, {
      isPlaying: isPlayerPlaying,
      currentTimeMs: Math.round(playerCurrentTime * 1000),
      durationMs: Math.round(playerDurationSeconds * 1000)
    });

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
        roomState: buildCurrentRoomState(initialState, listeningContext),
        sessionId: submittedSessionId ?? undefined,
        recentMessages,
        personaStrength,
        memoryEnabled,
        listeningContext,
        musicState
      });
      if (activeSessionIdRef.current !== submittedSessionId) {
        return;
      }

      const storedSessionId = response.session?.id ?? submittedSessionId;

      setProviderStatus(response.providerStatus);
      setMessages((current) => [...current, response.reply]);
      applyRoomClientActions(response.clientActions);
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

  function applyRoomClientActions(actions: RoomClientAction[]) {
    if (actions.length === 0) {
      return;
    }

    const queueBeforeActions = musicQueueRef.current;
    const activeEntryBeforeActions = getCurrentQueueEntry(queueBeforeActions);
    const activeTrackBeforeActions = activeEntryBeforeActions?.item ?? activeTrack;
    const previousActiveTrackId = activeTrackBeforeActions.id;
    let nextQueueState = queueBeforeActions;
    let nextVideoWindowOpen = videoWindowOpenRef.current;
    let shouldPlay = false;

    for (const clientAction of actions) {
      switch (clientAction.type) {
        case "play_music_item":
          nextQueueState = applyClientMusicActionToQueue(nextQueueState, clientAction.item);
          nextVideoWindowOpen = clientAction.item.canOpenVideo ? nextVideoWindowOpen : false;
          shouldPlay = true;
          break;
        case "add_music_to_queue":
          nextQueueState = addQueueItem(nextQueueState, clientAction.item);
          break;
        case "remove_music_from_queue":
          if (getUpcomingQueueEntries(nextQueueState).some((entry) => entry.id === clientAction.itemId)) {
            nextQueueState = removeQueueEntry(nextQueueState, clientAction.itemId);
          }
          break;
        case "save_music_item":
          nextQueueState = saveQueueItem(nextQueueState, clientAction.item);
          break;
        case "unsave_music_item":
          nextQueueState = unsaveQueueItem(nextQueueState, clientAction.itemId);
          break;
        case "clear_music_queue":
          nextQueueState = clearUpcomingQueue(nextQueueState);
          break;
        case "open_video_window":
          nextQueueState = applyClientMusicActionToQueue(nextQueueState, clientAction.item);
          nextVideoWindowOpen = clientAction.item.canOpenVideo;
          shouldPlay = true;
          break;
      }
    }

    const nextActiveEntry = getCurrentQueueEntry(nextQueueState);
    const nextTrack = nextActiveEntry?.item ?? activeTrackBeforeActions;

    if (nextTrack.id !== previousActiveTrackId) {
      platformAudioRef.current?.pause();
      setPlayerCurrentTime(0);
      setPlayerDuration(nextTrack.durationMs / 1000);
    }

    if (shouldPlay) {
      setIsPlayerPlaying(true);
    }

    const resolvedVideoWindowOpen = nextTrack.canOpenVideo ? nextVideoWindowOpen : false;
    commitMusicQueue(nextQueueState);
    commitVideoWindowOpen(resolvedVideoWindowOpen);
  }

  function handlePreviousTrack() {
    selectPlayerTrack((playerTrackIndex - 1 + playerQueue.length) % playerQueue.length);
  }

  function handleNextTrack() {
    selectPlayerTrack((playerTrackIndex + 1) % playerQueue.length);
  }

  function selectPlayerTrack(nextIndex: number) {
    const nextTrack = playerQueue[nextIndex] ?? playerQueue[0] ?? PLAYER_TRACKS[0];

    platformAudioRef.current?.pause();
    updateMusicQueue((currentQueue) => playQueueItem(currentQueue, nextTrack.id));
    setPlayerCurrentTime(0);
    setPlayerDuration(nextTrack.durationMs / 1000);
    if (!nextTrack.canOpenVideo) {
      commitVideoWindowOpen(false);
    }
  }

  function handleQueueEntryPlay(entryId: string) {
    const entry = musicQueue.entries.find((candidate) => candidate.id === entryId);
    if (!entry) return;

    platformAudioRef.current?.pause();
    updateMusicQueue((currentQueue) => playQueueItem(currentQueue, entryId));
    setPlayerCurrentTime(0);
    setPlayerDuration(entry.item.durationMs / 1000);
    setIsPlayerPlaying(true);
    if (!entry.item.canOpenVideo) {
      commitVideoWindowOpen(false);
    }
  }

  function handleQueueEntryRemove(entryId: string) {
    updateMusicQueue((currentQueue) => removeQueueEntry(currentQueue, entryId));
  }

  function handleQueueEntrySave(entryId: string) {
    updateMusicQueue((currentQueue) => toggleQueueEntrySaved(currentQueue, entryId));
  }

  function handleQueueEntryVideo(entry: MusicQueueEntry) {
    updateMusicQueue((currentQueue) => playQueueItem(currentQueue, entry.id));
    setPlayerCurrentTime(0);
    setPlayerDuration(entry.item.durationMs / 1000);
    setIsPlayerPlaying(true);
    commitVideoWindowOpen(true);
  }

  function handlePlayPause() {
    if (!hasPlatformAudio) {
      if (activeTrack.canOpenVideo) {
        commitVideoWindowOpen(true);
        setIsPlayerPlaying(true);
      }
      return;
    }

    if (isPlayerPlaying) {
      platformAudioRef.current?.pause();
      setIsPlayerPlaying(false);
      return;
    }

    setIsPlayerPlaying(true);
    void playPlatformAudio();
  }

  function commitMusicQueue(nextQueueState: MusicQueueState) {
    musicQueueRef.current = nextQueueState;
    setMusicQueue(nextQueueState);
  }

  function updateMusicQueue(updater: (currentQueue: MusicQueueState) => MusicQueueState) {
    commitMusicQueue(updater(musicQueueRef.current));
  }

  function commitVideoWindowOpen(open: boolean) {
    videoWindowOpenRef.current = open;
    setVideoWindowOpen(open);
  }

  async function playPlatformAudio() {
    const audio = platformAudioRef.current;

    if (!audio) {
      return;
    }

    try {
      await audio.play();
    } catch {
      setIsPlayerPlaying(false);
    }
  }

  function handlePlatformAudioLoadedMetadata(event: SyntheticEvent<HTMLAudioElement>) {
    const audio = event.currentTarget;
    const metadataDuration = Number.isFinite(audio.duration) && audio.duration > 0
      ? audio.duration
      : activeTrack.durationMs / 1000;

    setPlayerDuration(metadataDuration);
    setPlayerCurrentTime(audio.currentTime);
  }

  function handlePlatformAudioTimeUpdate(event: SyntheticEvent<HTMLAudioElement>) {
    setPlayerCurrentTime(event.currentTarget.currentTime);
  }

  function handlePlatformAudioEnded(event: SyntheticEvent<HTMLAudioElement>) {
    setPlayerCurrentTime(event.currentTarget.currentTime);
    setIsPlayerPlaying(false);
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
                    {isUser ? <span className="avatar small user-avatar" aria-hidden="true" /> : null}
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
            {activeTrack.platformAudioUrl ? (
              <audio
                ref={platformAudioRef}
                className="platform-audio-host"
                src={activeTrack.platformAudioUrl}
                preload="metadata"
                onLoadedMetadata={handlePlatformAudioLoadedMetadata}
                onTimeUpdate={handlePlatformAudioTimeUpdate}
                onEnded={handlePlatformAudioEnded}
              />
            ) : null}
            <div className="track-head">
              <div className="track-title">
                <strong>{activeTrack.title}</strong>
                <span>{activeTrack.creator}</span>
              </div>
              <div className="track-actions">
                <span className="source-badge" data-source={activeTrack.source}>
                  {getMusicSourceLabel(activeTrack.source)}
                </span>
                <div className="equalizer" aria-hidden="true">
                  <i />
                  <i />
                  <i />
                </div>
              </div>
            </div>
            <div className="progress" aria-label="播放进度">
              <span>{hasPlatformAudio ? formatPlayerTime(playerCurrentTime) : "平台内"}</span>
              <div className="bar">
                <span style={{ width: playerProgressWidth }} />
              </div>
              <span>{hasPlatformAudio ? formatPlayerTime(playerDurationSeconds) : "控制"}</span>
            </div>
            <div
              className="player-controls"
              data-has-video={activeTrack.canOpenVideo ? "true" : undefined}
            >
              <button className="control" type="button" aria-label="上一首" onClick={handlePreviousTrack}>
                ‹
              </button>
              <button
                className="control play"
                type="button"
                aria-label={playButtonLabel}
                onClick={handlePlayPause}
              >
                {hasPlatformAudio && isPlayerPlaying ? "Ⅱ" : "▶"}
              </button>
              <button className="control" type="button" aria-label="下一首" onClick={handleNextTrack}>
                ›
              </button>
              <div className="volume" aria-label="音量">
                <span />
              </div>
              <button className="control" type="button" aria-label="循环">
                ↻
              </button>
              {activeTrack.canOpenVideo ? (
                <button
                  className="control video"
                  type="button"
                  aria-label="打开视频小窗"
                  onClick={() => commitVideoWindowOpen(true)}
                >
                  ▣
                </button>
              ) : null}
            </div>
            <div className="queue-preview" aria-label="播放队列预览">
              <button
                className="queue-preview-main"
                type="button"
                onClick={() => {
                  if (queuePreview.nextEntryId) {
                    handleQueueEntryPlay(queuePreview.nextEntryId);
                  } else {
                    setQueuePanelOpen(true);
                  }
                }}
              >
                <span className="queue-preview-label">队列</span>
                <span className="queue-preview-copy">
                  <strong>{queuePreview.nextTitle ?? "暂无下一首"}</strong>
                  <span>
                    {queuePreview.nextCreator
                      ? `${getMusicSourceLabel(queuePreview.nextSource ?? activeTrack.source)} · ${queuePreview.nextCreator}`
                      : "可以让久美子继续帮你找歌"}
                  </span>
                </span>
                {queuePreview.remainingCount > 1 ? (
                  <span className="queue-preview-count">+{queuePreview.remainingCount - 1}</span>
                ) : null}
              </button>
              <button
                className="queue-manage"
                type="button"
                aria-label="管理播放队列"
                onClick={() => setQueuePanelOpen(true)}
              >
                管理
              </button>
            </div>
          </section>
        </aside>
        {queuePanelOpen ? (
          <section className="music-queue-panel" role="dialog" aria-label="音乐记录">
            <div className="music-queue-panel-head">
              <div>
                <strong>音乐记录</strong>
                <span>正在播放、接下来和收藏</span>
              </div>
              <button type="button" aria-label="关闭音乐记录" onClick={() => setQueuePanelOpen(false)}>
                ×
              </button>
            </div>
            <div className="music-queue-tabs" role="tablist" aria-label="音乐记录分类">
              {(["upcoming", "recent", "saved"] as const).map((tab) => (
                <button
                  key={tab}
                  type="button"
                  role="tab"
                  aria-selected={queuePanelTab === tab}
                  onClick={() => setQueuePanelTab(tab)}
                >
                  {tab === "upcoming" ? "接下来" : tab === "recent" ? "最近" : "收藏"}
                </button>
              ))}
            </div>
            <div className="music-queue-list">
              {queuePanelTab === "upcoming" && activeQueueEntry ? (
                <div className="music-queue-now">
                  <span className="music-queue-section-label">正在播放</span>
                  <article className="music-queue-row" data-active="true">
                    <div className="music-queue-row-copy">
                      <span className="source-badge" data-source={activeQueueEntry.item.source}>
                        {getMusicSourceLabel(activeQueueEntry.item.source)}
                      </span>
                      <div>
                        <strong>{activeQueueEntry.item.title}</strong>
                        <span>{activeQueueEntry.item.creator}</span>
                        {activeQueueEntry.sourceQuery ? <em>来自: {activeQueueEntry.sourceQuery}</em> : null}
                        {activeQueueEntry.selectedReason ? <em>{activeQueueEntry.selectedReason}</em> : null}
                      </div>
                    </div>
                    <div className="music-queue-row-actions">
                      <button type="button" onClick={() => handleQueueEntryPlay(activeQueueEntry.id)}>
                        播放
                      </button>
                      <button
                        type="button"
                        aria-label={`${activeQueueEntry.saved ? "取消收藏" : "收藏"} ${activeQueueEntry.item.title}`}
                        onClick={() => handleQueueEntrySave(activeQueueEntry.id)}
                      >
                        {activeQueueEntry.saved ? "取消收藏" : "收藏"}
                      </button>
                      {activeQueueEntry.item.canOpenVideo ? (
                        <button type="button" onClick={() => handleQueueEntryVideo(activeQueueEntry)}>
                          小窗
                        </button>
                      ) : null}
                    </div>
                  </article>
                </div>
              ) : null}
              {queuePanelTab === "upcoming" && visibleQueuePanelEntries.length > 0 ? (
                <span className="music-queue-section-label">接下来</span>
              ) : null}
              {visibleQueuePanelEntries.map((entry) => (
                <article
                  className="music-queue-row"
                  key={`${queuePanelTab}-${entry.id}`}
                >
                  <div className="music-queue-row-copy">
                    <span className="source-badge" data-source={entry.item.source}>
                      {getMusicSourceLabel(entry.item.source)}
                    </span>
                    <div>
                      <strong>{entry.item.title}</strong>
                      <span>{entry.item.creator}</span>
                      {entry.sourceQuery ? <em>来自: {entry.sourceQuery}</em> : null}
                      {entry.selectedReason ? <em>{entry.selectedReason}</em> : null}
                    </div>
                  </div>
                  <div className="music-queue-row-actions">
                    <button type="button" onClick={() => handleQueueEntryPlay(entry.id)}>
                      播放
                    </button>
                    <button
                      type="button"
                      aria-label={`${entry.saved ? "取消收藏" : "收藏"} ${entry.item.title}`}
                      onClick={() => handleQueueEntrySave(entry.id)}
                    >
                      {entry.saved ? "取消收藏" : "收藏"}
                    </button>
                    {entry.item.canOpenVideo ? (
                      <button type="button" onClick={() => handleQueueEntryVideo(entry)}>
                        小窗
                      </button>
                    ) : null}
                    <button type="button" onClick={() => handleQueueEntryRemove(entry.id)}>
                      移除
                    </button>
                  </div>
                </article>
              ))}
              {visibleQueuePanelEntries.length === 0 ? (
                <p className="music-queue-empty">
                  {getQueuePanelEmptyLabel(queuePanelTab)}
                </p>
              ) : null}
            </div>
          </section>
        ) : null}
      </section>
      {videoWindowOpen && activeTrack.canOpenVideo ? (
        <VideoMiniWindow
          item={activeTrack}
          size={videoWindowSize}
          onClose={() => commitVideoWindowOpen(false)}
          onToggleSize={() =>
            setVideoWindowSize((current) => (current === "compact" ? "large" : "compact"))
          }
        />
      ) : null}
    </main>
  );
}

function isMusicItem(value: unknown): value is MusicItem {
  if (!value || typeof value !== "object") {
    return false;
  }

  const candidate = value as Partial<MusicItem>;
  return (
    typeof candidate.id === "string" &&
    (candidate.source === "bilibili" || candidate.source === "netease") &&
    typeof candidate.title === "string" &&
    typeof candidate.creator === "string" &&
    typeof candidate.durationMs === "number" &&
    Array.isArray(candidate.tags) &&
    typeof candidate.canOpenVideo === "boolean"
  );
}

function readStoredMusicQueue(storage: Storage): MusicQueueState | null {
  const rawQueue = storage.getItem(MUSIC_QUEUE_STORAGE_KEY);
  if (!rawQueue) return null;

  try {
    const parsed = JSON.parse(rawQueue);
    if (!isRecord(parsed) || !Array.isArray(parsed.entries)) {
      return null;
    }

    const entries = parsed.entries.filter(isMusicQueueEntry);
    const currentId = typeof parsed.currentId === "string" ? parsed.currentId : null;
    const validCurrentId = currentId && entries.some((entry) => entry.id === currentId) ? currentId : null;
    const recentLimit = typeof parsed.recentLimit === "number" && parsed.recentLimit > 0
      ? parsed.recentLimit
      : DEFAULT_RECENT_LIMIT;

    return {
      entries,
      currentId: validCurrentId,
      recentLimit,
    };
  } catch {
    return null;
  }
}

function isMusicQueueEntry(value: unknown): value is MusicQueueEntry {
  if (!isRecord(value)) {
    return false;
  }

  return (
    typeof value.id === "string" &&
    isMusicItem(value.item) &&
    (value.status === "current" || value.status === "queued" || value.status === "played") &&
    (value.addedBy === "agent" || value.addedBy === "user" || value.addedBy === "default") &&
    typeof value.addedAt === "string" &&
    typeof value.playCount === "number" &&
    isOptionalString(value.lastPlayedAt) &&
    isOptionalString(value.sourceQuery) &&
    isOptionalString(value.selectedReason) &&
    isOptionalStringArray(value.selectionEvidence) &&
    isOptionalNumber(value.selectionScore) &&
    isOptionalBoolean(value.saved)
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object";
}

function isOptionalString(value: unknown): boolean {
  return value === undefined || typeof value === "string";
}

function isOptionalNumber(value: unknown): boolean {
  return value === undefined || typeof value === "number";
}

function isOptionalBoolean(value: unknown): boolean {
  return value === undefined || typeof value === "boolean";
}

function isOptionalStringArray(value: unknown): boolean {
  return value === undefined || (Array.isArray(value) && value.every((entry) => typeof entry === "string"));
}

function getVisibleQueuePanelEntries(
  tab: "upcoming" | "recent" | "saved",
  upcomingEntries: MusicQueueEntry[],
  recentEntries: MusicQueueEntry[],
  savedEntries: MusicQueueEntry[]
): MusicQueueEntry[] {
  if (tab === "recent") return recentEntries;
  if (tab === "saved") return savedEntries;
  return upcomingEntries;
}

function getQueuePanelEmptyLabel(tab: "upcoming" | "recent" | "saved"): string {
  if (tab === "upcoming") return "接下来还没有歌曲";
  if (tab === "saved") return "还没有收藏";

  return "还没有最近播放";
}

function getMusicSourceLabel(source: MusicSourceKind): string {
  if (source === "bilibili") return "B站";

  return "网易云";
}

function buildCurrentRoomState(initialState: RoomState, listeningContext: ListeningContext): RoomState {
  return {
    ...initialState,
    music: {
      currentTrackTitle: listeningContext.title,
      currentArtist: listeningContext.creator,
      listeningMood: listeningContext.isPlaying ? "playing" : "paused"
    }
  };
}

function formatPlayerTime(value: number): string {
  const safeValue = Number.isFinite(value) ? Math.max(0, Math.floor(value)) : 0;
  const minutes = Math.floor(safeValue / 60);
  const seconds = safeValue % 60;

  return `${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`;
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

"use client";

import { FormEvent, useState } from "react";
import { postChat } from "../api/client";
import type { ChatMessage, RoomState } from "../api/types";
import type { ConnectionStatus } from "../lib/connectionStatus";
import { getIdleLine } from "../lib/roomState";

interface RoomShellProps {
  initialState: RoomState;
  connectionStatus: ConnectionStatus;
}

export function RoomShell({ initialState, connectionStatus }: RoomShellProps) {
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
    if (!message || isSending) return;

    setDraft("");
    setSendError(null);
    setIsSending(true);
    setMessages((current) => [
      ...current,
      {
        id: `user-${Date.now()}`,
        role: "user",
        content: message
      }
    ]);

    try {
      const response = await postChat({ message, roomState: initialState });
      setCurrentExpression(response.expression);
      setMessages((current) => [...current, response.reply]);
    } catch {
      setSendError("消息发送失败，请确认本地 API 是否在运行。");
    } finally {
      setIsSending(false);
    }
  }

  return (
    <main className="room-workspace">
      <section className="workspace-card dialogue-card" aria-label="对话工作区">
        <header className="panel-heading">
          <div>
            <p className="eyebrow">KumikoRoom</p>
            <h1>对话工作区</h1>
          </div>
          <span
            className={`connection-chip connection-chip--${connectionStatus.tone}`}
            role="status"
            aria-label={connectionStatus.label}
          >
            连接状态
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
            onChange={(event) => setDraft(event.target.value)}
          />
          {sendError ? (
            <p className="composer-error" role="alert">
              {sendError}
            </p>
          ) : null}
          <div className="composer-actions" aria-label="消息操作">
            <button type="submit" disabled={isSending || draft.trim().length === 0}>
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
          <div className="utility-row">
            <span>模型连接</span>
            <strong>{connectionStatus.label}</strong>
          </div>
          <p className="utility-note">{connectionStatus.detail}</p>
        </section>
      </aside>
    </main>
  );
}

const expressionLabel: Record<RoomState["character"]["expression"], string> = {
  neutral: "平静",
  listening: "倾听",
  thinking: "思考",
  encouraging: "鼓励"
};

"use client";

import type { ChatMessage, RoomState } from "../api/types";
import { getIdleLine } from "../lib/roomState";

interface RoomShellProps {
  initialState: RoomState;
}

export function RoomShell({ initialState }: RoomShellProps) {
  const messages: ChatMessage[] = [
    {
      id: "idle-line",
      role: "kumiko",
      content: getIdleLine(initialState)
    }
  ];

  return (
    <main className="room-shell">
      <section className="room-presence" aria-label="久美子状态">
        <p className="room-kicker">{initialState.roomName}</p>
        <h1>KumikoRoom</h1>
        <div className="portrait-panel" aria-label="久美子立绘占位">
          <div className="portrait-mark" aria-hidden="true">
            K
          </div>
          <div>
            <strong>{initialState.character.displayName}</strong>
            <span>{initialState.character.romanizedName}</span>
          </div>
          <p>{initialState.character.statusText}</p>
        </div>
        <div className="presence-meta">
          <span>表情</span>
          <strong>{expressionLabel[initialState.character.expression]}</strong>
        </div>
      </section>

      <section className="chat-panel" aria-label="聊天区域">
        <div className="chat-panel__header">
          <div>
            <p className="room-kicker">conversation</p>
            <h2>今天的声音</h2>
          </div>
          <button className="ghost-button" type="button" disabled>
            TTS
          </button>
        </div>

        <div className="chat-timeline" aria-label="聊天时间线">
          {messages.map((message) => (
            <article className={`chat-message chat-message--${message.role}`} key={message.id}>
              <span>{message.role === "kumiko" ? initialState.character.displayName : "你"}</span>
              <p>{message.content}</p>
            </article>
          ))}
        </div>

        <form className="chat-composer">
          <label htmlFor="room-message">给久美子发消息</label>
          <textarea
            id="room-message"
            aria-label="给久美子发消息"
            placeholder="今天想听什么，或者想聊哪首歌？"
            rows={3}
          />
          <div className="composer-actions" aria-label="消息操作">
            <button type="button" disabled>
              存到日记
            </button>
            <button type="button" disabled>
              存为灵感
            </button>
            <button type="submit" disabled>
              发送
            </button>
          </div>
        </form>
      </section>

      <aside className="room-sidebar" aria-label="房间侧栏">
        <section>
          <h2>今日心情</h2>
          <p>{initialState.music.listeningMood ?? "还没记录"}</p>
        </section>
        <section>
          <h2>听歌日记</h2>
          <p>{initialState.diarySummary}</p>
        </section>
        <section>
          <h2>灵感便签</h2>
          <p>{initialState.inspirationCount} 条灵感</p>
        </section>
        <section>
          <h2>未完成工程</h2>
          <p>{initialState.studio.unfinishedCount} 个工程</p>
        </section>
        <a className="studio-link" href={initialState.studio.route} aria-label="打开创作资料室">
          打开{initialState.studio.label}
        </a>
      </aside>

      <section className="music-dock" aria-label="本地音乐播放器">
        <div>
          <span>当前曲目</span>
          <strong>{initialState.music.currentTrackTitle ?? "未选择歌曲"}</strong>
        </div>
        <div className="transport" aria-label="播放控制">
          <button type="button" disabled>
            上一首
          </button>
          <button type="button" disabled>
            播放
          </button>
          <button type="button" disabled>
            下一首
          </button>
        </div>
      </section>
    </main>
  );
}

const expressionLabel: Record<RoomState["character"]["expression"], string> = {
  neutral: "平静",
  listening: "倾听",
  thinking: "思考",
  encouraging: "鼓励"
};

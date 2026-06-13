import type { ConnectionStatus } from "../lib/connectionStatus";

interface HomeNavigationProps {
  connectionStatus: ConnectionStatus;
}

export function HomeNavigation({ connectionStatus }: HomeNavigationProps) {
  return (
    <main className="home-lobby" aria-label="KumikoRoom 首页">
      <section className="home-entry-window" aria-labelledby="home-title">
        <div className="home-entry-visual" aria-hidden="true" />

        <div className="home-entry-copy">
          <p className="eyebrow">KumikoRoom</p>
          <h1 id="home-title" className="home-title" aria-label="KumikoRoom">
            <span>Kumiko</span>
            <span>Room</span>
          </h1>
          <p className="home-lede">窗外还在下小雨，谱架留在原来的位置。</p>

          <div className={`connection-strip connection-strip--${connectionStatus.tone}`}>
            <div>
              <strong>{connectionStatus.label}</strong>
              <span>{connectionStatus.detail}</span>
            </div>
            <i className="connection-dot" aria-hidden="true" />
          </div>

          <nav className="home-entry-actions" aria-label="主要入口">
            <a className="home-primary-link" href="/room">
              开始聊天
            </a>
            <a className="home-secondary-link" href="/studio">
              资料室
            </a>
          </nav>
        </div>
      </section>
    </main>
  );
}

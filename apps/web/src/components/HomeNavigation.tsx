import type { ConnectionStatus } from "../lib/connectionStatus";

interface HomeNavigationProps {
  connectionStatus: ConnectionStatus;
}

export function HomeNavigation({ connectionStatus }: HomeNavigationProps) {
  return (
    <main className="home-lobby" aria-label="KumikoRoom 导航">
      <section className="home-entry-window" aria-labelledby="home-title">
        <div className="home-entry-visual" aria-hidden="true" />

        <div className="home-entry-copy">
          <p className="eyebrow">KumikoRoom</p>
          <h1 id="home-title" className="home-title">
            KumikoRoom
          </h1>
          <p className="home-lede">放学后的练习室，雨声和谱架都还在原位。</p>

          <div className={`connection-strip connection-strip--${connectionStatus.tone}`}>
            <div>
              <strong>{connectionStatus.label}</strong>
              <span>{connectionStatus.detail}</span>
            </div>
            <i className="connection-dot" aria-hidden="true" />
          </div>

          <nav className="home-entry-actions" aria-label="主要入口">
            <a className="home-primary-link" href="/room">
              进入聊天
            </a>
            <a className="home-secondary-link" href="/studio">
              打开资料室
            </a>
          </nav>
        </div>
      </section>
    </main>
  );
}

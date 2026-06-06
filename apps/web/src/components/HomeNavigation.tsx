import type { ConnectionStatus } from "../lib/connectionStatus";

interface HomeNavigationProps {
  connectionStatus: ConnectionStatus;
}

const navigationItems = [
  {
    title: "对话",
    action: "打开对话工作区",
    body: "继续今天的聊天，也可以把听歌时想到的话先放这里。",
    href: "/room",
    mark: "rose"
  },
  {
    title: "音乐日记",
    action: "记录今天听到的东西",
    body: "给歌曲、心情和片段留一个轻量入口，后面再接播放器。",
    href: "/room",
    mark: "fog"
  },
  {
    title: "创作资料",
    action: "打开工程和灵感",
    body: "整理 FLP、Demo、歌词片段和下一步计划。",
    href: "/studio",
    mark: "plain"
  },
  {
    title: "本地工程",
    action: "查看待接入状态",
    body: "后续接入本地文件扫描、工程卡片和打开工程操作。",
    href: "/studio",
    mark: "fog"
  }
];

export function HomeNavigation({ connectionStatus }: HomeNavigationProps) {
  return (
    <main className="home-shell" aria-label="KumikoRoom 导航">
      <section className="home-panel home-panel--intro">
        <p className="eyebrow">KumikoRoom</p>
        <h1>KumikoRoom</h1>
        <p className="home-lede">把对话、音乐日记和创作资料放在一个安静入口里，今天的想法可以先从这里开始。</p>

        <div className={`connection-pill connection-pill--${connectionStatus.tone}`}>
          <span>{connectionStatus.label}</span>
          <p>{connectionStatus.detail}</p>
        </div>
      </section>

      <section className="home-panel home-panel--routes" aria-labelledby="home-routes-heading">
        <div className="panel-heading">
          <div>
            <p className="eyebrow">Start</p>
            <h2 id="home-routes-heading">今天从哪里开始？</h2>
          </div>
          <span className="soft-badge">今日入口</span>
        </div>

        <div className="route-grid">
          {navigationItems.map((item) => (
            <a className="route-card" data-mark={item.mark} href={item.href} key={item.title} aria-label={`${item.title} ${item.action}`}>
              <span className="route-card__mark" aria-hidden="true" />
              <strong>{item.title}</strong>
              <span>{item.action}</span>
              <p>{item.body}</p>
            </a>
          ))}
        </div>
      </section>
    </main>
  );
}

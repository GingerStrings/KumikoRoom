const studioTabs = ["工程", "素材", "笔记"];

export function StudioEntry() {
  return (
    <main className="studio-workbench" aria-label="资料室">
      <section className="studio-window">
        <aside className="studio-shelf" aria-label="资料分类">
          <div className="studio-brand">
            <p className="eyebrow">KumikoRoom</p>
            <h1>资料室</h1>
          </div>

          <nav className="studio-tabs" aria-label="资料分类">
            {studioTabs.map((tab) => (
              <button type="button" key={tab} data-active={tab === "工程" ? "true" : undefined}>
                {tab}
              </button>
            ))}
          </nav>

          <div className="studio-links">
            <a className="studio-link" href="/room">
              回到聊天
            </a>
            <a className="studio-link" href="/">
              回到入口
            </a>
          </div>
        </aside>

        <section className="studio-desk" aria-label="资料内容">
          <header className="studio-desk__header">
            <div>
              <span>工程</span>
              <strong>本地资料</strong>
            </div>
            <input className="studio-search" type="search" placeholder="搜索资料" aria-label="搜索资料" />
          </header>

          <div className="studio-body">
            <div className="studio-empty">
              <p className="eyebrow">Local</p>
              <h2>还没有接入本地资料。</h2>
              <p>未连接本地目录</p>
              <a className="studio-soft-action" href="/room">
                继续聊天
              </a>
            </div>

            <aside className="studio-character" aria-label="资料状态">
              <div className="studio-character__figure" aria-hidden="true" />
              <div className="studio-note">
                <strong>素材来源</strong>
                <span>未连接</span>
              </div>
            </aside>
          </div>
        </section>
      </section>
    </main>
  );
}

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
              回到房间
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
              <div className="studio-empty-paper">
                <p className="eyebrow">Empty</p>
                <h2>还没有接入本地工程。</h2>
                <p>之后这里可以放工程文件、音频素材和写作笔记。当前先保持清爽，不用假内容把页面填满。</p>
                <a className="studio-soft-action" href="/room">
                  先回到房间
                </a>
              </div>
            </div>

            <aside className="studio-character" aria-label="角色侧栏">
              <div className="studio-character__figure" aria-hidden="true" />
              <div className="studio-note">
                <strong>当前空间</strong>
                <span>这里更像一个轻资料柜，承担整理入口和状态提示。</span>
              </div>
            </aside>
          </div>
        </section>
      </section>
    </main>
  );
}

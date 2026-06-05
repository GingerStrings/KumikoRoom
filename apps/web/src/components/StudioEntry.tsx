const studioSections = [
  {
    title: "工程架",
    body: "这里会汇总本地音乐工程、主 FLP、状态和标签。"
  },
  {
    title: "工程档案",
    body: "每个工程会展示文件、FLP 元数据、打开工程和打开文件夹入口。"
  },
  {
    title: "创作笔记",
    body: "歌词、想法、下一步待办会和工程关联。"
  },
  {
    title: "Demo 音频",
    body: "粗混、参考导出和相关音频会在这里播放。"
  }
];

export function StudioEntry() {
  return (
    <main className="studio-shell">
      <header className="studio-header">
        <div>
          <p className="room-kicker">KumikoRoom</p>
          <h1>创作资料室</h1>
        </div>
        <a className="studio-back-link" href="/room">
          回到陪伴房间
        </a>
      </header>

      <section className="studio-grid" aria-label="创作资料室模块">
        {studioSections.map((section) => (
          <article className="studio-module" key={section.title}>
            <h2>{section.title}</h2>
            <p>{section.body}</p>
          </article>
        ))}
      </section>
    </main>
  );
}

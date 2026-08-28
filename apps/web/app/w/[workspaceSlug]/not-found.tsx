import Link from "next/link";

export default function WorkspaceNotFound() {
  const titleId = "workspace-not-found-title";
  const bodyId = "workspace-not-found-body";
  return (
    <main className="workspace">
      <div className="workspace__frame workspace__frame--status">
        <section
          aria-describedby={bodyId}
          aria-labelledby={titleId}
          aria-live="polite"
          className="status-screen"
          role="alert"
        >
          <span className="status-screen__eyebrow">Workspace not found</span>
          <h1 id={titleId}>找不到这个工作区</h1>
          <p id={bodyId}>这个工作区链接不存在，或者已经被归档/移除。你可以返回首页后重新选择工作区。</p>
          <div className="state-callout">
            <span className="state-callout__eyebrow">Routing state</span>
            <strong>优先确认链接和当前工作区选择，再继续进入主工作台。</strong>
            <p>如果这是别人分享给你的链接，先检查它是否仍对应一个有效工作区。</p>
          </div>
          <Link className="button button--primary" href="/">
            返回首页
          </Link>
        </section>
      </div>
    </main>
  );
}

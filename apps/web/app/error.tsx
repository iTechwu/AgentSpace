"use client";

import { useEffect } from "react";

export default function Error({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  const titleId = "workspace-error-title";
  const bodyId = "workspace-error-body";
  useEffect(() => {
    console.error(error);
  }, [error]);

  return (
    <main className="workspace">
      <div className="workspace__frame workspace__frame--status">
        <section
          aria-describedby={bodyId}
          aria-labelledby={titleId}
          aria-live="assertive"
          className="status-screen"
          role="alert"
        >
          <span className="status-screen__eyebrow">Workspace error</span>
          <h1 id={titleId}>工作台暂时没有响应</h1>
          <p id={bodyId}>
            协作窗口和员工市场的数据层刚刚中断了一次，请重新加载当前视图；如果问题持续，再回到原料入口检查最近一次操作。
          </p>
          <div className="state-callout state-callout--error">
            <span className="state-callout__eyebrow">Error state</span>
            <strong>先恢复当前视图，再排查最近一次导致失败的动作。</strong>
            <p>这样能优先验证问题是否只是瞬时中断，而不是继续在损坏状态里操作。</p>
          </div>
          <button className="button button--primary" type="button" onClick={reset}>
            重新载入
          </button>
        </section>
      </div>
    </main>
  );
}

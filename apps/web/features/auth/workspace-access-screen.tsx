import Link from "next/link";
import type { StoredWorkspaceRecord } from "@dofe-agent/db";
import { buildWorkspacePath } from "./workspace-paths";

export function WorkspaceAccessScreen({
  availableWorkspaces,
  workspaceSlug,
}: {
  availableWorkspaces: StoredWorkspaceRecord[];
  workspaceSlug: string;
}) {
  const fallbackWorkspace = availableWorkspaces[0];
  const titleId = "workspace-access-title";
  const bodyId = "workspace-access-body";

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
          <span className="status-screen__eyebrow">Workspace access</span>
          <h1 id={titleId}>你没有这个工作区的访问权限</h1>
          <p id={bodyId}>
            当前账号不属于工作区 <code>{workspaceSlug}</code>。
            {fallbackWorkspace
              ? " 你可以先返回自己有权限的工作区。"
              : " 当前账号还没有任何可用工作区。"}
          </p>
          {fallbackWorkspace ? (
            <Link className="button button--primary" href={buildWorkspacePath(fallbackWorkspace.slug, "/im")}>
              打开 {fallbackWorkspace.name}
            </Link>
          ) : (
            <Link className="button button--primary" href="/">
              返回首页
            </Link>
          )}
        </section>
      </div>
    </main>
  );
}

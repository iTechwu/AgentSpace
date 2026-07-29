import type { Metadata } from "next";
import type { ReactNode } from "react";
import { redirect } from "next/navigation";
import { getCurrentUser } from "@/features/auth/server-auth";
import {
  getMonthStartIso,
  listAllManagedAgentRuntimesSync,
  listAuditLogsSync,
  listRuntimeCostSummariesSync,
  listWorkspacesSync,
} from "@dofe-agent/db";
import { PLATFORM_AUDIT_WORKSPACE_ID } from "@dofe-agent/services";

export const metadata: Metadata = {
  title: "平台运维控制台",
};

export const dynamic = "force-dynamic";

interface WorkspaceSummary {
  readonly workspaceId: string;
  readonly slug: string;
  readonly name: string;
  readonly managedRuntimeCount: number;
  readonly onlineRuntimeCount: number;
  readonly needsAttentionRuntimeCount: number;
  readonly periodActualCostUsd: number;
}

export default async function PlatformConsolePage(): Promise<ReactNode> {
  const user = await getCurrentUser();
  if (!user?.isPlatformAdmin) {
    redirect("/");
  }

  // Cross-team, read-only aggregation. Platform admins inherit team admin
  // capabilities without being written into any team membership; this view
  // never mutates and preserves real operator identity in the platform audit.
  const since = getMonthStartIso();
  const workspaces = listWorkspacesSync().filter((workspace) => workspace.id.startsWith("sso-"));
  const ssoWorkspaceIds = new Set(workspaces.map((workspace) => workspace.id));

  const runtimes = listAllManagedAgentRuntimesSync().filter((runtime) => ssoWorkspaceIds.has(runtime.workspaceId));

  const costByWorkspace = new Map<string, number>();
  for (const workspace of workspaces) {
    let total = 0;
    for (const summary of listRuntimeCostSummariesSync(since, workspace.id)) {
      total += summary.totalActualCostUsd ?? 0;
    }
    costByWorkspace.set(workspace.id, total);
  }

  const runtimesByWorkspace = new Map<string, typeof runtimes>();
  for (const runtime of runtimes) {
    const list = runtimesByWorkspace.get(runtime.workspaceId) ?? [];
    list.push(runtime);
    runtimesByWorkspace.set(runtime.workspaceId, list);
  }

  const summaries: WorkspaceSummary[] = workspaces
    .map((workspace) => {
      const list = runtimesByWorkspace.get(workspace.id) ?? [];
      return {
        workspaceId: workspace.id,
        slug: workspace.slug,
        name: workspace.name,
        managedRuntimeCount: list.length,
        onlineRuntimeCount: list.filter((runtime) => runtime.status === "online").length,
        needsAttentionRuntimeCount: list.filter(
          (runtime) => runtime.provisioningState === "needs_attention" || runtime.provisioningState === "credential_recovering",
        ).length,
        periodActualCostUsd: costByWorkspace.get(workspace.id) ?? 0,
      };
    })
    .sort((a, b) => b.managedRuntimeCount - a.managedRuntimeCount || b.periodActualCostUsd - a.periodActualCostUsd);

  const totalRuntimeCount = runtimes.length;
  const totalNeedsAttention = summaries.reduce((total, summary) => total + summary.needsAttentionRuntimeCount, 0);
  const totalPeriodCost = summaries.reduce((total, summary) => total + summary.periodActualCostUsd, 0);

  const recentAudit = listAuditLogsSync(PLATFORM_AUDIT_WORKSPACE_ID, {
    source: "platform_admin",
    limit: 8,
  });

  return (
    <main className="platform-console-page">
      <header className="platform-console-header">
        <div>
          <h1>平台运维控制台</h1>
          <p>跨团队只读运维视图；操作保留真实操作者，团队侧以“平台运维”匿名展示。</p>
        </div>
        <a className="platform-console-header__audit-link" href="/platform/audit">
          查看完整平台审计 →
        </a>
      </header>

      <section className="platform-console-stats" aria-label="Overview">
        <div className="platform-console-stat">
          <span className="platform-console-stat__label">工作区</span>
          <strong className="platform-console-stat__value">{workspaces.length}</strong>
        </div>
        <div className="platform-console-stat">
          <span className="platform-console-stat__label">受管 Runtime</span>
          <strong className="platform-console-stat__value">{totalRuntimeCount}</strong>
        </div>
        <div className="platform-console-stat">
          <span className="platform-console-stat__label">需关注 Runtime</span>
          <strong className="platform-console-stat__value">{totalNeedsAttention}</strong>
        </div>
        <div className="platform-console-stat">
          <span className="platform-console-stat__label">本周期实际成本</span>
          <strong className="platform-console-stat__value">¥{totalPeriodCost.toFixed(4)}</strong>
        </div>
      </section>

      <section className="platform-console-section">
        <h2>工作区</h2>
        {summaries.length === 0 ? (
          <p className="platform-console-empty">暂无 SSO 工作区。</p>
        ) : (
          <div className="platform-console-table" role="table">
            <div className="platform-console-row platform-console-row--header" role="row">
              <span role="columnheader">工作区</span>
              <span role="columnheader">受管 Runtime</span>
              <span role="columnheader">在线</span>
              <span role="columnheader">需关注</span>
              <span role="columnheader">本周期实际成本</span>
            </div>
            {summaries.map((summary) => (
              <div className="platform-console-row" role="row" key={summary.workspaceId}>
                <span role="cell">{summary.name}</span>
                <span role="cell">{summary.managedRuntimeCount}</span>
                <span role="cell">{summary.onlineRuntimeCount}</span>
                <span role="cell">{summary.needsAttentionRuntimeCount > 0 ? `⚠ ${summary.needsAttentionRuntimeCount}` : "0"}</span>
                <span role="cell">¥{summary.periodActualCostUsd.toFixed(4)}</span>
              </div>
            ))}
          </div>
        )}
      </section>

      <section className="platform-console-section">
        <h2>最近平台审计</h2>
        {recentAudit.length === 0 ? (
          <p className="platform-console-empty">暂无平台审计事件。</p>
        ) : (
          <ul className="platform-console-audit">
            {recentAudit.map((entry) => (
              <li className="platform-console-audit__item" key={entry.id}>
                <strong>{entry.title}</strong>
                {entry.note ? <span>{entry.note}</span> : null}
                <time>{entry.createdAt}</time>
              </li>
            ))}
          </ul>
        )}
      </section>
    </main>
  );
}

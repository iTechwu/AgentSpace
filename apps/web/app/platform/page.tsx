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
import {
  PlatformConsoleClient,
  type PlatformWorkspaceSummary,
} from "@/features/platform/platform-console-client";

export const metadata: Metadata = {
  title: "平台运维控制台",
};

export const dynamic = "force-dynamic";

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

  const summaries: PlatformWorkspaceSummary[] = workspaces
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

  const recentAudit = listAuditLogsSync(PLATFORM_AUDIT_WORKSPACE_ID, {
    source: "platform_admin",
    limit: 8,
  });

  const periodLabel = new Intl.DateTimeFormat("zh-CN", {
    year: "numeric",
    month: "long",
    timeZone: "Asia/Shanghai",
  }).format(new Date(since));

  return (
    <PlatformConsoleClient
      operator={{ displayName: user.displayName, email: user.email }}
      periodLabel={periodLabel}
      recentAudit={recentAudit}
      workspaces={summaries}
    />
  );
}

import { listAuditLogsSync } from "@dofe-agent/db";
import { notFound } from "next/navigation";
import { AuditLogView, parseAuditLogFilters } from "@/features/audit/audit-log-view";
import { hasWorkspaceRole } from "@/features/auth/workspace-permissions";
import { buildWorkspacePath } from "@/features/auth/workspace-paths";
import { getWorkspacePageContext } from "../_lib/workspace-page-context";

export const dynamic = "force-dynamic";

export default async function WorkspaceAuditPage({ params, searchParams }: { params: Promise<{ workspaceSlug: string }>; searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const { workspaceSlug } = await params;
  const context = await getWorkspacePageContext(workspaceSlug);
  if (!hasWorkspaceRole(context.currentMembership.role, "admin")) notFound();
  const filters = parseAuditLogFilters(await searchParams);
  const logs = listAuditLogsSync(context.currentWorkspace.id, { ...filters, limit: 500 });
  return <section className="mx-auto max-w-6xl space-y-5 p-6"><header><h1 className="text-xl font-semibold">Audit log</h1><p className="mt-1 text-sm text-neutral-500">Workspace operations and runtime execution events.</p></header><AuditLogView logs={logs} filters={filters} clearHref={buildWorkspacePath(workspaceSlug, "/audit")} /></section>;
}

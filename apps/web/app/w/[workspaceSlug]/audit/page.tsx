import { listAuditLogsSync } from "@dofe-agent/db";
import { notFound } from "next/navigation";
import { AuditLogView } from "@/features/audit/audit-log-view";
import { parseAuditLogFilters } from "@/features/audit/audit-log-filters";
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
  return <AuditLogView logs={logs} filters={filters} clearHref={buildWorkspacePath(workspaceSlug, "/audit")} />;
}

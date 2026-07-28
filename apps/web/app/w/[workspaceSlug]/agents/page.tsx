import { AgentsPageClient } from "@/features/agents/agents-page-client";
import { WorkspaceInitialModuleData } from "@/features/dashboard/workspace-initial-module-data";
import { loadWorkspaceModuleDataWithMeta } from "@/features/dashboard/workspace-module-loaders";
import { buildWorkspacePath } from "@/features/auth/workspace-paths";
import {
  getRuntimeManagementPath,
  isLegacyRuntimeManagementRequest,
} from "@/features/runtimes/runtime-navigation";
import { resolveAgentRuntimeMode } from "@dofe-agent/services";
import { redirect } from "next/navigation";
import { getWorkspacePageContext } from "../_lib/workspace-page-context";

export const dynamic = "force-dynamic";

export default async function WorkspaceAgentsPage({
  params,
  searchParams,
}: {
  params: Promise<{ workspaceSlug: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { workspaceSlug } = await params;
  const workspaceContext = await getWorkspacePageContext(workspaceSlug);
  const requestedSearchParams = await searchParams;
  const requestedMode = Array.isArray(requestedSearchParams.mode)
    ? requestedSearchParams.mode[0]
    : requestedSearchParams.mode;
  const runtimeMode = resolveAgentRuntimeMode();
  if (isLegacyRuntimeManagementRequest(runtimeMode, requestedMode)) {
    redirect(buildWorkspacePath(
      workspaceContext.currentWorkspace.slug,
      getRuntimeManagementPath(runtimeMode),
    ));
  }
  const result = await loadWorkspaceModuleDataWithMeta(
    "agents",
    workspaceContext.currentWorkspace.id,
    {
      id: workspaceContext.currentUser.id,
      displayName: workspaceContext.currentUser.displayName,
      email: workspaceContext.currentUser.email,
      role: workspaceContext.currentMembership.role,
    },
  );
  return (
    <WorkspaceInitialModuleData
      moduleData={result.data}
      serverDurationMs={result.meta.durationMs}
      workspaceId={workspaceContext.currentWorkspace.id}
    >
      <AgentsPageClient data={result.data.data} />
    </WorkspaceInitialModuleData>
  );
}

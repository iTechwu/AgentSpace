import { listManagedRuntimeTasksSync } from "@dofe-agent/services";
import { getWorkspacePageContext } from "../_lib/workspace-page-context";
import { hasWorkspaceRole } from "@/features/auth/workspace-permissions";
import { RuntimesPageClient } from "@/features/runtimes/runtimes-page-client";

export const dynamic = "force-dynamic";

export default async function WorkspaceRuntimesPage({
  params,
}: {
  params: Promise<{ workspaceSlug: string }>;
}) {
  const { workspaceSlug } = await params;
  const workspaceContext = await getWorkspacePageContext(workspaceSlug);
  const isAdmin = hasWorkspaceRole(workspaceContext.currentMembership.role, "admin");

  const tasks = isAdmin
    ? listManagedRuntimeTasksSync({
        workspaceId: workspaceContext.currentWorkspace.id,
        actorUserId: workspaceContext.currentUser.id,
      })
    : [];

  return (
    <RuntimesPageClient
      workspaceSlug={workspaceContext.currentWorkspace.slug}
      isAdmin={isAdmin}
      initialTasks={tasks}
    />
  );
}

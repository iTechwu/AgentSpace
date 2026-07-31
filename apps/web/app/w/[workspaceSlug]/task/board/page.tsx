import { WorkspaceInitialModuleData } from "@/features/dashboard/workspace-initial-module-data";
import { loadWorkspaceModuleDataWithMeta } from "@/features/dashboard/workspace-module-loaders";
import { TaskBoardPageClient } from "@/features/task-board/task-board-page-client";
import { getWorkspacePageContext } from "../../_lib/workspace-page-context";

export const dynamic = "force-dynamic";

export default async function WorkspaceTaskBoardPage({
  params,
}: {
  params: Promise<{ workspaceSlug: string }>;
}) {
  const { workspaceSlug } = await params;
  const workspaceContext = await getWorkspacePageContext(workspaceSlug);
  const result = await loadWorkspaceModuleDataWithMeta(
    "task-board",
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
      <TaskBoardPageClient data={result.data.data} workspaceSlug={workspaceContext.currentWorkspace.slug} />
    </WorkspaceInitialModuleData>
  );
}

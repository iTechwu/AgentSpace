import { TaskBoardPageClient } from "@/features/task-board/task-board-page-client";
import { renderWorkspaceModule } from "../../_lib/render-workspace-module";

export const dynamic = "force-dynamic";

export default async function WorkspaceTaskBoardPage({
  params,
}: {
  params: Promise<{ workspaceSlug: string }>;
}) {
  const { workspaceSlug } = await params;
  return renderWorkspaceModule(workspaceSlug, "task-board", (data, workspaceContext) => (
    <TaskBoardPageClient data={data.data} workspaceSlug={workspaceContext.currentWorkspace.slug} />
  ), { withViewer: true });
}

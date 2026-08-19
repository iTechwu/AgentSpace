import type { Metadata } from "next";
import { TaskBoardPageClient } from "@/features/task-board/task-board-page-client";
import { renderWorkspaceModule } from "../../_lib/render-workspace-module";

export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "任务看板",
  description: "以看板视角跟进任务的执行进度。",
};

export default async function WorkspaceTaskBoardPage({
  params,
}: {
  params: Promise<{ workspaceSlug: string }>;
}) {
  const { workspaceSlug } = await params;
  return renderWorkspaceModule(workspaceSlug, "task-board", (data, workspaceContext) => (
    <TaskBoardPageClient data={data.data} workspaceSlug={workspaceContext.currentWorkspace.id} />
  ), { withViewer: true });
}

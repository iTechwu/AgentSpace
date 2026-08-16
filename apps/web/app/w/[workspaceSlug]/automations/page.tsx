import { WorkflowListClient } from "@/features/workflows/workflow-list-client";
import { renderWorkspaceModule } from "../_lib/render-workspace-module";

export const dynamic = "force-dynamic";

export default async function WorkspaceAutomationsPage({
  params,
}: {
  params: Promise<{ workspaceSlug: string }>;
}) {
  const { workspaceSlug } = await params;
  return renderWorkspaceModule(workspaceSlug, "automations", (data, workspaceContext) => (
    <WorkflowListClient
      data={data.data}
      workspaceId={workspaceContext.currentWorkspace.id}
      workspaceSlug={workspaceSlug}
    />
  ));
}

import { notFound } from "next/navigation";
import { WorkflowBuilderClient } from "@/features/workflows/workflow-builder-client";
import { getWorkflowBuilderPageData } from "@/features/workflows/workflow-data";
import { getWorkspacePageContext } from "../../_lib/workspace-page-context";

export const dynamic = "force-dynamic";

export default async function EditWorkflowPage({
  params,
}: {
  params: Promise<{ workspaceSlug: string; workflowId: string }>;
}) {
  const { workspaceSlug, workflowId } = await params;
  const context = await getWorkspacePageContext(workspaceSlug);
  const data = getWorkflowBuilderPageData(context.currentWorkspace.id, workflowId, {
    userId: context.currentUser.id,
    displayName: context.currentUser.displayName,
  });
  if (!data?.workflow) notFound();
  return <WorkflowBuilderClient channels={data.channels} employees={data.employees} entry="automations" initial={data.workflow} members={data.members} ownerLabel={data.ownerLabel} workspaceSlug={workspaceSlug} />;
}

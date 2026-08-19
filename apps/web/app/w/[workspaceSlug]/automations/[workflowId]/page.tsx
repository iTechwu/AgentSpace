import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { WorkflowBuilderClient } from "@/features/workflows/workflow-builder-client";
import { getWorkflowBuilderPageDataAsync } from "@/features/workflows/workflow-data";
import { getWorkspacePageContext } from "../../_lib/workspace-page-context";

export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "编排详情",
  description: "查看与编辑单个工作流编排。",
};

export default async function EditWorkflowPage({
  params,
}: {
  params: Promise<{ workspaceSlug: string; workflowId: string }>;
}) {
  const { workspaceSlug, workflowId } = await params;
  const context = await getWorkspacePageContext(workspaceSlug);
  const data = await getWorkflowBuilderPageDataAsync(context.currentWorkspace.id, workflowId, {
    userId: context.currentUser.id,
    displayName: context.currentUser.displayName,
  });
  if (!data?.workflow) notFound();
  return <WorkflowBuilderClient channels={data.channels} employees={data.employees} entry="automations" initial={data.workflow} members={data.members} ownerLabel={data.ownerLabel} workspaceSlug={context.currentWorkspace.id} />;
}

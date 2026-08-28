import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { WorkflowRunClient } from "@/features/workflows/workflow-run-client";
import { getWorkflowRunPageData } from "@/features/workflows/workflow-data";
import { getWorkspacePageContext } from "../../../_lib/workspace-page-context";

export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "编排执行详情",
  description: "查看编排运行的过程、日志与结果。",
};

export default async function WorkflowRunPage({
  params,
}: {
  params: Promise<{ workspaceSlug: string; runId: string }>;
}) {
  const { workspaceSlug, runId } = await params;
  const context = await getWorkspacePageContext(workspaceSlug);
  const data = getWorkflowRunPageData(context.currentWorkspace.id, runId, {
    userId: context.currentUser.id,
    role: context.currentMembership.role,
  });
  if (!data) notFound();
  return <WorkflowRunClient data={data} workspaceId={context.currentWorkspace.id} workspaceSlug={context.currentWorkspace.id} />;
}

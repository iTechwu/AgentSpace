import type { Metadata } from "next";
import { WorkflowBuilderClient } from "@/features/workflows/workflow-builder-client";
import { getWorkflowBuilderPageDataAsync } from "@/features/workflows/workflow-data";
import type { WorkflowBuilderEntry } from "@/features/workflows/workflow-types";
import { getWorkspacePageContext } from "../../_lib/workspace-page-context";

export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "新建编排",
  description: "从零创建新的工作流编排。",
};

export default async function NewWorkflowPage({
  params,
  searchParams,
}: {
  params: Promise<{ workspaceSlug: string }>;
  searchParams: Promise<{ entry?: string }>;
}) {
  const [{ workspaceSlug }, query] = await Promise.all([params, searchParams]);
  const context = await getWorkspacePageContext(workspaceSlug);
  const data = (await getWorkflowBuilderPageDataAsync(context.currentWorkspace.id, undefined, {
    userId: context.currentUser.id,
    displayName: context.currentUser.displayName,
  }))!;
  return <WorkflowBuilderClient channels={data.channels} employees={data.employees} entry={normalizeEntry(query.entry)} members={data.members} ownerLabel={data.ownerLabel} workspaceSlug={workspaceSlug} />;
}

function normalizeEntry(value: string | undefined): WorkflowBuilderEntry {
  return value === "calendar" || value === "task-board" ? value : "automations";
}

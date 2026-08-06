import { WorkflowBuilderClient } from "@/features/workflows/workflow-builder-client";
import { getWorkflowBuilderPageData } from "@/features/workflows/workflow-data";
import type { WorkflowBuilderEntry } from "@/features/workflows/workflow-types";
import { getWorkspacePageContext } from "../../_lib/workspace-page-context";

export const dynamic = "force-dynamic";

export default async function NewWorkflowPage({
  params,
  searchParams,
}: {
  params: Promise<{ workspaceSlug: string }>;
  searchParams: Promise<{ entry?: string }>;
}) {
  const [{ workspaceSlug }, query] = await Promise.all([params, searchParams]);
  const context = await getWorkspacePageContext(workspaceSlug);
  const data = getWorkflowBuilderPageData(context.currentWorkspace.id)!;
  return <WorkflowBuilderClient employees={data.employees} entry={normalizeEntry(query.entry)} workspaceSlug={workspaceSlug} />;
}

function normalizeEntry(value: string | undefined): WorkflowBuilderEntry {
  return value === "calendar" || value === "task-board" ? value : "automations";
}

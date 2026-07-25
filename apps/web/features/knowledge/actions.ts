"use server";

import {
  createKnowledgePageSync,
  createKnowledgePageFromSharedDocumentSync,
  setKnowledgePageAssignedEmployeesSync,
  setKnowledgePageAssignmentModeSync,
  updateKnowledgePageSync,
  moveKnowledgePageSync,
  deleteKnowledgePageSync,
  materialToKnowledgePageSync,
} from "@dofe-agent/services";
import type { KnowledgeAssignmentMode } from "@dofe-agent/domain/workspace";
import { requireCurrentWorkspaceContext } from "@/features/auth/server-workspace";
import { assertWorkspaceRoleForContext } from "@/features/auth/workspace-permissions";
import { revalidateWorkspacePath, revalidateWorkspacePaths } from "@/features/auth/workspace-revalidation";

export async function createKnowledgePageAction(input: {
  title: string;
  parentId?: string | null;
  contentMarkdown?: string;
  tags?: string[];
  assignmentMode?: KnowledgeAssignmentMode;
  assignedEmployeeNames?: string[];
}): Promise<void> {
  const workspaceContext = await requireCurrentWorkspaceContext();
  assertWorkspaceRoleForContext(workspaceContext, "admin");
  createKnowledgePageSync({
    ...input,
    createdBy: workspaceContext.currentUser.displayName,
  }, workspaceContext.currentWorkspace.id);
  revalidateWorkspacePath("/knowledge", workspaceContext.currentWorkspace.slug);
}

export async function updateKnowledgePageAction(
  id: string,
  input: {
    title?: string;
    contentMarkdown?: string;
    tags?: string[];
  },
): Promise<void> {
  const workspaceContext = await requireCurrentWorkspaceContext();
  assertWorkspaceRoleForContext(workspaceContext, "admin");
  updateKnowledgePageSync(id, input, workspaceContext.currentWorkspace.id);
  revalidateWorkspacePath("/knowledge", workspaceContext.currentWorkspace.slug);
}

export async function moveKnowledgePageAction(
  id: string,
  input: {
    parentId: string | null;
    sortOrder?: number;
  },
): Promise<void> {
  const workspaceContext = await requireCurrentWorkspaceContext();
  assertWorkspaceRoleForContext(workspaceContext, "admin");
  moveKnowledgePageSync(id, input, workspaceContext.currentWorkspace.id);
  revalidateWorkspacePath("/knowledge", workspaceContext.currentWorkspace.slug);
}

export async function deleteKnowledgePageAction(id: string): Promise<void> {
  const workspaceContext = await requireCurrentWorkspaceContext();
  assertWorkspaceRoleForContext(workspaceContext, "admin");
  deleteKnowledgePageSync(id, workspaceContext.currentWorkspace.id);
  revalidateWorkspacePath("/knowledge", workspaceContext.currentWorkspace.slug);
}

export async function materialToKnowledgePageAction(
  materialId: string,
  parentId?: string | null,
): Promise<void> {
  const workspaceContext = await requireCurrentWorkspaceContext();
  assertWorkspaceRoleForContext(workspaceContext, "admin");
  materialToKnowledgePageSync(materialId, parentId, workspaceContext.currentWorkspace.id);
  revalidateWorkspacePath("/knowledge", workspaceContext.currentWorkspace.slug);
}

export async function createKnowledgePageFromDocumentAction(input: {
  sourceType: "attachment" | "channelDocument";
  sourceId: string;
  parentId?: string | null;
  assignmentMode?: KnowledgeAssignmentMode;
  assignedEmployeeNames?: string[];
}): Promise<string> {
  const workspaceContext = await requireCurrentWorkspaceContext();
  assertWorkspaceRoleForContext(workspaceContext, "admin");
  const page = createKnowledgePageFromSharedDocumentSync({
    ...input,
    createdBy: workspaceContext.currentUser.displayName,
    createdByType: "human",
  }, workspaceContext.currentWorkspace.id);
  revalidateWorkspacePath("/knowledge", workspaceContext.currentWorkspace.slug);
  return page.id;
}

export async function setKnowledgePageAssignmentsAction(input: {
  pageId: string;
  assignmentMode: KnowledgeAssignmentMode;
  assignedEmployeeNames: string[];
}): Promise<void> {
  const workspaceContext = await requireCurrentWorkspaceContext();
  assertWorkspaceRoleForContext(workspaceContext, "admin");
  const actor = workspaceContext.currentUser.displayName.trim() || "system";

  setKnowledgePageAssignmentModeSync(
    input.pageId,
    input.assignmentMode,
    actor,
    workspaceContext.currentWorkspace.id,
  );
  if (input.assignmentMode === "selected_agents") {
    setKnowledgePageAssignedEmployeesSync(
      input.pageId,
      input.assignedEmployeeNames,
      actor,
      workspaceContext.currentWorkspace.id,
    );
  }

  revalidateWorkspacePaths(workspaceContext.currentWorkspace.slug, ["/knowledge", "/agents"]);
}

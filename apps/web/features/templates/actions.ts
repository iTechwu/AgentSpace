"use server";

import {
  createTemplateSync,
  updateTemplateSync,
  deleteTemplateSync,
} from "@dofe-agent/services";
import type { Template } from "@dofe-agent/domain/workspace";
import { requireCurrentWorkspaceContext } from "@/features/auth/server-workspace";
import { assertWorkspaceRoleForContext } from "@/features/auth/workspace-permissions";
import { revalidateWorkspacePath } from "@/features/auth/workspace-revalidation";

export async function createTemplateAction(input: {
  category: Template["category"];
  name: string;
  description?: string;
  configJson: string;
}): Promise<void> {
  const workspaceContext = await requireCurrentWorkspaceContext();
  assertWorkspaceRoleForContext(workspaceContext, "admin");
  createTemplateSync(input, workspaceContext.currentWorkspace.id);
  revalidateWorkspacePath("/templates", workspaceContext.currentWorkspace.slug);
}

export async function updateTemplateAction(
  id: string,
  input: {
    name?: string;
    description?: string;
    configJson?: string;
  },
): Promise<void> {
  const workspaceContext = await requireCurrentWorkspaceContext();
  assertWorkspaceRoleForContext(workspaceContext, "admin");
  updateTemplateSync(id, input, workspaceContext.currentWorkspace.id);
  revalidateWorkspacePath("/templates", workspaceContext.currentWorkspace.slug);
}

export async function deleteTemplateAction(id: string): Promise<void> {
  const workspaceContext = await requireCurrentWorkspaceContext();
  assertWorkspaceRoleForContext(workspaceContext, "admin");
  deleteTemplateSync(id, workspaceContext.currentWorkspace.id);
  revalidateWorkspacePath("/templates", workspaceContext.currentWorkspace.slug);
}

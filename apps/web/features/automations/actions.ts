"use server";

import {
  createAutomationRuleSync,
  updateAutomationRuleSync,
  toggleAutomationRuleSync,
  deleteAutomationRuleSync,
  stopAutoContinuationSync,
} from "@dofe-agent/services";
import type { AutomationTrigger, AutomationCondition, AutomationAction } from "@dofe-agent/domain/workspace";
import { requireCurrentWorkspaceContext } from "@/features/auth/server-workspace";
import { assertWorkspaceRoleForContext } from "@/features/auth/workspace-permissions";
import { revalidateWorkspacePath, revalidateWorkspacePaths } from "@/features/auth/workspace-revalidation";

export async function createAutomationRuleAction(input: {
  name: string;
  description?: string;
  trigger: AutomationTrigger;
  conditions?: AutomationCondition[];
  actions: AutomationAction[];
}): Promise<void> {
  const workspaceContext = await requireCurrentWorkspaceContext();
  assertWorkspaceRoleForContext(workspaceContext, "admin");
  createAutomationRuleSync(input, workspaceContext.currentWorkspace.id);
  revalidateWorkspacePath("/automations", workspaceContext.currentWorkspace.slug);
}

export async function updateAutomationRuleAction(
  id: string,
  input: {
    name?: string;
    description?: string;
    trigger?: AutomationTrigger;
    conditions?: AutomationCondition[];
    actions?: AutomationAction[];
  },
): Promise<void> {
  const workspaceContext = await requireCurrentWorkspaceContext();
  assertWorkspaceRoleForContext(workspaceContext, "admin");
  updateAutomationRuleSync(id, input, workspaceContext.currentWorkspace.id);
  revalidateWorkspacePath("/automations", workspaceContext.currentWorkspace.slug);
}

export async function toggleAutomationRuleAction(
  id: string,
  enabled: boolean,
): Promise<void> {
  const workspaceContext = await requireCurrentWorkspaceContext();
  assertWorkspaceRoleForContext(workspaceContext, "admin");
  toggleAutomationRuleSync(id, enabled, workspaceContext.currentWorkspace.id);
  revalidateWorkspacePath("/automations", workspaceContext.currentWorkspace.slug);
}

export async function deleteAutomationRuleAction(id: string): Promise<void> {
  const workspaceContext = await requireCurrentWorkspaceContext();
  assertWorkspaceRoleForContext(workspaceContext, "admin");
  deleteAutomationRuleSync(id, workspaceContext.currentWorkspace.id);
  revalidateWorkspacePath("/automations", workspaceContext.currentWorkspace.slug);
}

export async function stopAutoContinuationAction(input: {
  channelName: string;
  agentId: string;
  contactId?: string;
}): Promise<void> {
  const workspaceContext = await requireCurrentWorkspaceContext();
  assertWorkspaceRoleForContext(workspaceContext, "member");
  stopAutoContinuationSync({
    channelName: input.channelName,
    agentId: input.agentId,
    contactId: input.contactId,
    workspaceId: workspaceContext.currentWorkspace.id,
    requestedByDisplayName: workspaceContext.currentUser.displayName.trim() || "你",
  });
  revalidateWorkspacePaths(workspaceContext.currentWorkspace.slug, ["/automations", "/im", "/inbox", "/agents"]);
}

"use server";

import { deleteBudgetSync, toggleBudgetSync, tryRecordWorkspaceAuditEventSync, upsertBudgetSync } from "@dofe-agent/services";
import { readBudgetByIdSync, type BudgetAction, type BudgetPeriod, type BudgetScope } from "@dofe-agent/db";
import { requireCurrentWorkspaceContext } from "@/features/auth/server-workspace";
import { assertWorkspaceRoleForContext } from "@/features/auth/workspace-permissions";
import { revalidateWorkspacePath } from "@/features/auth/workspace-revalidation";

export async function upsertBudgetAction(input: {
  scope: BudgetScope;
  scopeId: string;
  limitUsd: number;
  period: BudgetPeriod;
  action: BudgetAction;
  warningThreshold: number;
}): Promise<void> {
  const workspaceContext = await requireCurrentWorkspaceContext();
  assertWorkspaceRoleForContext(workspaceContext, "admin");
  upsertBudgetSync({
    ...input,
    scopeId: input.scope === "workspace" ? workspaceContext.currentWorkspace.id : input.scopeId,
    createdBy: workspaceContext.currentUser.displayName.trim(),
    workspaceId: workspaceContext.currentWorkspace.id,
  });
  tryRecordWorkspaceAuditEventSync({
    workspaceId: workspaceContext.currentWorkspace.id,
    title: "Budget updated",
    note: `Budget scope "${input.scope}" was updated by ${workspaceContext.currentUser.displayName}.`,
    code: "workspace.budget_upserted",
    data: {
      actorType: "session_user",
      resourceType: "budget",
      scope: input.scope,
      scopeId: input.scopeId,
    },
  });
  revalidateWorkspacePath("/costs", workspaceContext.currentWorkspace.slug);
}

export async function toggleBudgetAction(id: string, enabled: boolean): Promise<void> {
  const workspaceContext = await requireCurrentWorkspaceContext();
  assertWorkspaceRoleForContext(workspaceContext, "admin");
  const budget = readBudgetByIdSync(id, workspaceContext.currentWorkspace.id);
  if (!budget) {
    throw new Error("Forbidden.");
  }
  toggleBudgetSync(id, enabled, workspaceContext.currentWorkspace.id);
  tryRecordWorkspaceAuditEventSync({
    workspaceId: workspaceContext.currentWorkspace.id,
    title: enabled ? "Budget enabled" : "Budget disabled",
    note: `Budget "${id}" was ${enabled ? "enabled" : "disabled"} by ${workspaceContext.currentUser.displayName}.`,
    code: enabled ? "workspace.budget_enabled" : "workspace.budget_disabled",
    data: {
      actorType: "session_user",
      resourceType: "budget",
      resourceId: id,
    },
  });
  revalidateWorkspacePath("/costs", workspaceContext.currentWorkspace.slug);
}

export async function deleteBudgetAction(id: string): Promise<void> {
  const workspaceContext = await requireCurrentWorkspaceContext();
  assertWorkspaceRoleForContext(workspaceContext, "admin");
  const budget = readBudgetByIdSync(id, workspaceContext.currentWorkspace.id);
  if (!budget) {
    throw new Error("Forbidden.");
  }
  deleteBudgetSync(id, workspaceContext.currentWorkspace.id);
  tryRecordWorkspaceAuditEventSync({
    workspaceId: workspaceContext.currentWorkspace.id,
    title: "Budget deleted",
    note: `Budget "${id}" was deleted by ${workspaceContext.currentUser.displayName}.`,
    code: "workspace.budget_deleted",
    data: {
      actorType: "session_user",
      resourceType: "budget",
      resourceId: id,
    },
  });
  revalidateWorkspacePath("/costs", workspaceContext.currentWorkspace.slug);
}

"use server";

import { deleteBudgetSync, toggleBudgetSync, tryRecordWorkspaceAuditEventSync, upsertBudgetSync } from "@dofe-agent/services";
import { readBudgetByIdSync, type BudgetAction, type BudgetPeriod, type BudgetScope } from "@dofe-agent/db";
import { requireCurrentWorkspaceContext } from "@/features/auth/server-workspace";
import { assertWorkspaceRoleForContext } from "@/features/auth/workspace-permissions";
import { revalidateWorkspacePath } from "@/features/auth/workspace-revalidation";
import { listManagedRuntimesForWorkspaceSync, syncRuntimeCredentialUsageAsync } from "@dofe-agent/services";
import { resolveAgentRuntimeMode } from "@dofe-agent/services";

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

export async function reconcileWorkspaceUsageAction(): Promise<{
  reconciledCount: number;
  unallocatedCount: number;
  skippedCount: number;
  totalRemoteCount: number;
}> {
  const workspaceContext = await requireCurrentWorkspaceContext();
  assertWorkspaceRoleForContext(workspaceContext, "admin");
  if (resolveAgentRuntimeMode() !== "remote") {
    throw new Error("costs.remote_mode_required");
  }

  const runtimes = listManagedRuntimesForWorkspaceSync({
    workspaceId: workspaceContext.currentWorkspace.id,
    actorUserId: workspaceContext.currentUser.id,
  });

  const totals = {
    reconciledCount: 0,
    unallocatedCount: 0,
    skippedCount: 0,
    totalRemoteCount: 0,
  };

  for (const runtime of runtimes) {
    const result = await syncRuntimeCredentialUsageAsync({
      workspaceId: workspaceContext.currentWorkspace.id,
      runtimeId: runtime.id,
    });
    totals.reconciledCount += result.reconciledCount;
    totals.unallocatedCount += result.unallocatedCount;
    totals.skippedCount += result.skippedCount;
    totals.totalRemoteCount += result.totalRemoteCount;
  }

  tryRecordWorkspaceAuditEventSync({
    workspaceId: workspaceContext.currentWorkspace.id,
    title: "Workspace usage reconciled",
    note: `Reconciled ${totals.reconciledCount}, unallocated ${totals.unallocatedCount}, skipped ${totals.skippedCount} of ${totals.totalRemoteCount} remote entries.`,
    code: "workspace.usage_reconciled",
    data: {
      actorType: "session_user",
      resourceType: "workspace",
      ...totals,
    },
  });

  revalidateWorkspacePath("/costs", workspaceContext.currentWorkspace.slug);
  return totals;
}

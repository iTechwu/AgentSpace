"use server";

import type { RuntimeAppCatalogSource, RuntimeAppOperationType } from "@dofe-agent/db";
import {
  requestRuntimeAppOperationSync,
  syncCliHubCatalog,
  syncRuntimeAppSkill,
} from "@dofe-agent/services";
import { requireCurrentWorkspaceContext } from "@/features/auth/server-workspace";
import { assertWorkspaceRoleForContext } from "@/features/auth/workspace-permissions";
import { revalidateWorkspacePaths } from "@/features/auth/workspace-revalidation";
import {
  actionToastResult,
  successToast,
  type ActionToastResult,
} from "@/shared/lib/toast-action";

export async function refreshRuntimeAppCatalogAction(): Promise<ActionToastResult<void>> {
  const workspaceContext = await requireCurrentWorkspaceContext();
  assertWorkspaceRoleForContext(workspaceContext, "admin");
  const result = await syncCliHubCatalog();
  revalidateWorkspacePaths(workspaceContext.currentWorkspace.slug, ["/market", "/agents"]);
  return actionToastResult(
    undefined,
    successToast(
      result.status === "fresh"
        ? `目录已刷新，当前 ${result.itemCount} 个应用。`
        : `目录刷新失败，继续展示缓存的 ${result.itemCount} 个应用。`,
      result.status === "fresh"
        ? `Catalog refreshed with ${result.itemCount} apps.`
        : `Catalog refresh failed; showing ${result.itemCount} cached apps.`,
    ),
  );
}

export async function requestRuntimeAppOperationAction(input: {
  runtimeId: string;
  source: RuntimeAppCatalogSource;
  name: string;
  operation: RuntimeAppOperationType;
  confirmHighRisk?: boolean;
}): Promise<ActionToastResult<void>> {
  const workspaceContext = await requireCurrentWorkspaceContext();
  assertWorkspaceRoleForContext(workspaceContext, "admin");
  requestRuntimeAppOperationSync({
    workspaceId: workspaceContext.currentWorkspace.id,
    runtimeId: input.runtimeId.trim(),
    source: input.source,
    name: input.name.trim(),
    operation: input.operation,
    actorUserId: workspaceContext.currentUser.id,
    confirmHighRisk: input.confirmHighRisk,
  });
  revalidateWorkspacePaths(workspaceContext.currentWorkspace.slug, ["/market", "/agents"]);
  return actionToastResult(
    undefined,
    successToast("Runtime app 操作已排队。", "Runtime app operation queued."),
  );
}

export async function syncRuntimeAppSkillAction(input: {
  runtimeId: string;
  source: RuntimeAppCatalogSource;
  name: string;
}): Promise<ActionToastResult<void>> {
  const workspaceContext = await requireCurrentWorkspaceContext();
  assertWorkspaceRoleForContext(workspaceContext, "admin");
  const result = await syncRuntimeAppSkill({
    workspaceId: workspaceContext.currentWorkspace.id,
    runtimeId: input.runtimeId.trim(),
    source: input.source,
    name: input.name.trim(),
  });
  revalidateWorkspacePaths(workspaceContext.currentWorkspace.slug, ["/market", "/agents", "/skills"]);
  return actionToastResult(
    undefined,
    successToast(
      result.status === "not_available" ? (result.warning ?? "暂时没有可导入的 SKILL.md。") : "Runtime app skill 已同步。",
      result.status === "not_available" ? (result.warning ?? "No SKILL.md is available to import yet.") : "Runtime app skill synced.",
    ),
  );
}

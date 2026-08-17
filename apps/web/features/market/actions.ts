"use server";

import type {
  CapabilityDeploymentMode,
  CapabilityPackageKind,
  CapabilityRequestedAction,
  RuntimeAppArtifactKind,
  RuntimeAppCatalogSource,
  RuntimeAppOperationType,
} from "@dofe-agent/db";
import { approveCapabilityRequestSync, cancelCapabilityRequestSync, rejectCapabilityRequestSync, submitCapabilityRequestSync, switchCapabilityImplementationSync, type CapabilityImplementation } from "@dofe-agent/services/capabilities";
import { createWorkspaceRuntimeAppRelease, requestRuntimeAppOperationSync, syncCliHubCatalog, syncRuntimeAppSkill } from "@dofe-agent/services/skills";
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
  revalidateWorkspacePaths(workspaceContext.currentWorkspace.slug, ["/market", "/agents", "/runtimes"]);
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

export interface CreateWorkspaceRuntimeAppReleaseActionInput {
  slug: string;
  displayName: string;
  description?: string;
  category?: string;
  homepage?: string;
  artifactKind: RuntimeAppArtifactKind;
  artifactName: string;
  version: string;
  entryPoint: string;
}

export async function createWorkspaceRuntimeAppReleaseAction(
  input: CreateWorkspaceRuntimeAppReleaseActionInput,
): Promise<ActionToastResult<void>> {
  const workspaceContext = await requireCurrentWorkspaceContext();
  assertWorkspaceRoleForContext(workspaceContext, "admin");
  await createWorkspaceRuntimeAppRelease({
    workspaceId: workspaceContext.currentWorkspace.id,
    actorUserId: workspaceContext.currentUser.id,
    ...input,
  });
  revalidateWorkspacePaths(workspaceContext.currentWorkspace.slug, ["/market", "/agents", "/runtimes"]);
  return actionToastResult(undefined, successToast("工作区私有 CLI 已发布。", "Workspace-private CLI release published."));
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
  revalidateWorkspacePaths(workspaceContext.currentWorkspace.slug, ["/market", "/agents", "/runtimes"]);
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
  revalidateWorkspacePaths(workspaceContext.currentWorkspace.slug, ["/market", "/agents", "/runtimes", "/skills"]);
  return actionToastResult(
    undefined,
    successToast(
      result.status === "not_available" ? (result.warning ?? "暂时没有可导入的 SKILL.md。") : "Runtime app skill 已同步。",
      result.status === "not_available" ? (result.warning ?? "No SKILL.md is available to import yet.") : "Runtime app skill synced.",
    ),
  );
}

export interface SubmitCapabilityRequestActionInput {
  runtimeId: string;
  packageKind: CapabilityPackageKind;
  packageSource: string;
  packageSlug: string;
  packageDisplayName: string;
  deploymentMode: CapabilityDeploymentMode;
  // parse 走独立的 /knowledge/upload 路由，不在市场页提交
  requestedAction: Exclude<CapabilityRequestedAction, "parse">;
  priority?: "normal" | "urgent";
  message?: string;
}

export interface SubmitCapabilityRequestActionResult {
  capabilityRequestId: string;
  nextAction: string;
  dispatchedOperationId: string | null;
}

/**
 * Submit a unified capability request. The browser only submits identifiers;
 * the server decides the deployment mode, dispatches to the right subsystem
 * (CLI install / MCP connect / managed service provision) and returns the
 * persisted task envelope. The page reloads from the same source of truth.
 */
export async function submitCapabilityRequestAction(
  input: SubmitCapabilityRequestActionInput,
): Promise<ActionToastResult<SubmitCapabilityRequestActionResult>> {
  const workspaceContext = await requireCurrentWorkspaceContext();
  const result = submitCapabilityRequestSync({
    workspaceId: workspaceContext.currentWorkspace.id,
    runtimeId: input.runtimeId.trim(),
    actorUserId: workspaceContext.currentUser.id,
    packageKind: input.packageKind,
    packageSource: input.packageSource.trim(),
    packageSlug: input.packageSlug.trim(),
    packageDisplayName: input.packageDisplayName.trim() || input.packageSlug.trim(),
    deploymentMode: input.deploymentMode,
    requestedAction: input.requestedAction,
    priority: input.priority ?? "normal",
    message: input.message ?? "",
  });
  revalidateWorkspacePaths(workspaceContext.currentWorkspace.slug, ["/market", "/agents", "/runtimes"]);
  return actionToastResult(
    {
      capabilityRequestId: result.capabilityRequest.id,
      nextAction: result.nextAction,
      dispatchedOperationId: result.dispatchedOperationId ?? null,
    },
    successToast(
      result.nextAction === "wait_for_approval"
        ? "已提交管理员部署申请。"
        : result.nextAction === "wait_for_operation"
        ? "任务已创建，正在执行。"
        : "能力请求已记录。",
      result.nextAction === "wait_for_approval"
        ? "Submitted an admin deployment request."
        : result.nextAction === "wait_for_operation"
        ? "Task created and running."
        : "Capability request recorded.",
    ),
  );
}

export interface SwitchCapabilityImplementationActionInput {
  runtimeId: string;
  packageKind: CapabilityPackageKind;
  packageSource: string;
  packageSlug: string;
  packageDisplayName: string;
  targetImplementation: CapabilityImplementation;
}

/** Switch a capability to an alternative implementation (docs §4.5). The panel
 *  renders this control only when the projection actually offers an
 *  alternative; the action submits the capability through the normal approval →
 *  dispatch pipeline with the alternative implementation's deployment mode. */
export async function switchCapabilityImplementationAction(
  input: SwitchCapabilityImplementationActionInput,
): Promise<ActionToastResult<SubmitCapabilityRequestActionResult>> {
  const workspaceContext = await requireCurrentWorkspaceContext();
  const result = switchCapabilityImplementationSync({
    workspaceId: workspaceContext.currentWorkspace.id,
    runtimeId: input.runtimeId.trim(),
    actorUserId: workspaceContext.currentUser.id,
    packageKind: input.packageKind,
    packageSource: input.packageSource.trim(),
    packageSlug: input.packageSlug.trim(),
    packageDisplayName: input.packageDisplayName.trim() || input.packageSlug.trim(),
    targetImplementation: input.targetImplementation,
  });
  revalidateWorkspacePaths(workspaceContext.currentWorkspace.slug, ["/market", "/agents", "/runtimes"]);
  return actionToastResult(
    {
      capabilityRequestId: result.capabilityRequest.id,
      nextAction: result.nextAction,
      dispatchedOperationId: result.dispatchedOperationId ?? null,
    },
    successToast("已提交切换为备选实现方式。", "Switched to the alternative implementation."),
  );
}

export interface DecideCapabilityRequestActionInput {
  requestId: string;
  decision: "approved" | "rejected";
  reason?: string;
}

export interface DecideCapabilityRequestActionResult {
  capabilityRequestId: string;
  nextAction: string;
  dispatchedOperationId: string | null;
  status: string;
}

/**
 * Admin decision on a pending capability request. Approve dispatches to the
 * underlying subsystem; reject requires a user-facing reason.
 */
export async function cancelCapabilityRequestAction(input: {
  requestId: string;
  reason?: string;
}): Promise<ActionToastResult<void>> {
  const workspaceContext = await requireCurrentWorkspaceContext();
  cancelCapabilityRequestSync({
    requestId: input.requestId,
    workspaceId: workspaceContext.currentWorkspace.id,
    actorUserId: workspaceContext.currentUser.id,
    reason: input.reason,
  });
  revalidateWorkspacePaths(workspaceContext.currentWorkspace.slug, ["/market", "/agents", "/runtimes"]);
  return actionToastResult(undefined, successToast("能力请求已取消。", "Capability request cancelled."));
}

export async function decideCapabilityRequestAction(
  input: DecideCapabilityRequestActionInput,
): Promise<ActionToastResult<DecideCapabilityRequestActionResult>> {
  const workspaceContext = await requireCurrentWorkspaceContext();
  assertWorkspaceRoleForContext(workspaceContext, "admin");
  if (input.decision === "approved") {
    const result = approveCapabilityRequestSync({
      requestId: input.requestId,
      workspaceId: workspaceContext.currentWorkspace.id,
      actorUserId: workspaceContext.currentUser.id,
      decisionReason: input.reason,
    });
    revalidateWorkspacePaths(workspaceContext.currentWorkspace.slug, ["/market", "/agents", "/runtimes"]);
    return actionToastResult(
      {
        capabilityRequestId: result.capabilityRequest.id,
        nextAction: result.nextAction,
        dispatchedOperationId: result.dispatchedOperationId ?? null,
        status: result.capabilityRequest.status,
      },
      successToast(
        result.nextAction === "wait_for_operation"
          ? "已批准并触发执行。"
          : "已批准。",
        result.nextAction === "wait_for_operation"
          ? "Approved and dispatched."
          : "Approved.",
      ),
    );
  }
  if (!input.reason?.trim()) {
    throw new Error("拒绝时必须填写用户可理解的原因。");
  }
  const rejected = rejectCapabilityRequestSync({
    requestId: input.requestId,
    workspaceId: workspaceContext.currentWorkspace.id,
    actorUserId: workspaceContext.currentUser.id,
    decisionReason: input.reason,
  });
  revalidateWorkspacePaths(workspaceContext.currentWorkspace.slug, ["/market", "/agents", "/runtimes"]);
  return actionToastResult(
    {
      capabilityRequestId: input.requestId,
      nextAction: "none",
      dispatchedOperationId: null,
      status: rejected?.status ?? "rejected",
    },
    successToast("已拒绝申请。", "Request rejected."),
  );
}

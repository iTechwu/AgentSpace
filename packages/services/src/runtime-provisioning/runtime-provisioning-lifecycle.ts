// 运行时生命周期终态：停止/删除、清理完成/失败与清理请求续跑。
import {
  completeManagedRuntimeCleanupRequestSync as completeManagedRuntimeCleanupRequestRecordSync,
  completeRuntimeProvisioningCancellationSync,
  deleteAgentRuntimeSync,
  failManagedRuntimeCleanupRequestSync as failManagedRuntimeCleanupRequestRecordSync,
  markRuntimeCredentialReconciliationTargetDrainingSync,
  readAgentRuntimeSync,
  readManagedRuntimeCleanupRequestSync,
  readRuntimeProvisioningTaskSync,
  recordAuditLogSync,
  requestManagedRuntimeCleanupSync,
  updateAgentRuntimeManagedFieldsSync,
} from "@dofe-agent/db";
import type {
  AgentRuntimeRecord,
} from "@dofe-agent/db";
import {
  getRuntimeCredentialVault,
} from "./credential-vault.ts";
import {
  assertOpenMontageRuntimePurgeableAsync,
  assertOpenMontageRuntimePurgeableSync,
} from "../openmontage/purge-guard.ts";
import {
  DEFAULT_CLEANUP_TIMEOUT_MS,
  assertCanManageManagedRuntimes,
  assertRemoteRuntimeMode,
  resolveManagedRuntimeScopeSync,
} from "./runtime-provisioning-capacity.ts";
import type {
  ManagedRuntimeActor,
} from "./runtime-provisioning-capacity.ts";
import {
  resolveCredentialReconciliationRetireAfter,
  safeRevokeCredential,
} from "./runtime-provisioning-pipeline.ts";

export interface StopManagedRuntimeInput extends ManagedRuntimeActor {
  runtimeId: string;
  reason?: string;
}

export async function stopManagedRuntimeAsync(input: StopManagedRuntimeInput): Promise<AgentRuntimeRecord> {
  assertRemoteRuntimeMode();
  assertCanManageManagedRuntimes(input);
  const runtime = readAgentRuntimeSync(input.runtimeId);
  if (!runtime || runtime.workspaceId !== input.workspaceId) {
    throw new Error("managed_runtime.runtime_not_found");
  }
  if (runtime.provisioningState !== "managed" && runtime.provisioningState !== "draining") {
    throw new Error("managed_runtime.not_a_managed_runtime");
  }
  // Close admission before waiting for remote usage to drain. A blocked guard
  // intentionally leaves the runtime in this durable state so a daemon
  // heartbeat cannot make it eligible for another task before an admin retry.
  if (runtime.provisioningState !== "draining") {
    updateAgentRuntimeManagedFieldsSync({
      runtimeId: runtime.id,
      workspaceId: input.workspaceId,
      provisioningState: "draining",
      allowNewEmployeeSharing: false,
    });
  }
  await assertOpenMontageRuntimePurgeableAsync({
    workspaceId: input.workspaceId,
    runtimeId: runtime.id,
  });
  const scope = resolveManagedRuntimeScopeSync(input.workspaceId);
  if (runtime.managedCredentialId) {
    await safeRevokeCredential({
      credentialId: runtime.managedCredentialId,
      tenantId: scope.tenantId,
      teamId: scope.teamId,
      reason: input.reason ?? "stopped",
      idempotencyKey: `revoke:${runtime.managedCredentialId}:${input.reason ?? "stopped"}`,
      audit: { actorId: input.actorUserId },
    });
    markRuntimeCredentialReconciliationTargetDrainingSync({
      workspaceId: input.workspaceId,
      runtimeId: runtime.id,
      runtimeCredentialId: runtime.managedCredentialId,
      retireAfter: resolveCredentialReconciliationRetireAfter(),
    });
  }
  if (runtime.credentialSecretRef) {
    getRuntimeCredentialVault().forget(runtime.credentialSecretRef, {
      tenantId: scope.tenantId,
      teamId: scope.teamId,
      runtimeId: runtime.id,
    });
  }
  if (runtime.daemonConnectionId) {
    requestManagedRuntimeCleanupSync({
      runtimeId: runtime.id,
      workspaceId: input.workspaceId,
      daemonConnectionId: runtime.daemonConnectionId,
      runtimeType: runtime.provider,
    });
  }
  const updated = updateAgentRuntimeManagedFieldsSync({
    runtimeId: runtime.id,
    workspaceId: input.workspaceId,
    provisioningState: "legacy",
    managedCredentialId: "",
    credentialSecretRef: "",
    credentialConfigRef: "",
  });
  recordAuditLogSync({
    workspaceId: input.workspaceId,
    title: "Managed runtime stopped",
    note: `Runtime ${runtime.id} stopped and credential revoked`,
    code: "runtime.stopped",
    source: "runtime_lifecycle",
    data: { runtimeId: runtime.id, actorId: input.actorUserId },
  });
  return updated ?? runtime;
}

export async function deleteManagedRuntimeAsync(input: StopManagedRuntimeInput): Promise<void> {
  assertRemoteRuntimeMode();
  assertCanManageManagedRuntimes(input);
  const runtime = readAgentRuntimeSync(input.runtimeId);
  if (!runtime || runtime.workspaceId !== input.workspaceId) {
    throw new Error("managed_runtime.runtime_not_found");
  }
  if (runtime.provisioningState !== "managed" && runtime.provisioningState !== "draining") {
    throw new Error("managed_runtime.not_a_managed_runtime");
  }
  if (runtime.provisioningState !== "draining") {
    updateAgentRuntimeManagedFieldsSync({
      runtimeId: runtime.id,
      workspaceId: input.workspaceId,
      provisioningState: "draining",
      allowNewEmployeeSharing: false,
    });
  }
  // Keep the billing/attribution ledger intact before revoking the credential
  // or scheduling daemon cleanup.
  await assertOpenMontageRuntimePurgeableAsync({
    workspaceId: input.workspaceId,
    runtimeId: runtime.id,
  });
  const scope = resolveManagedRuntimeScopeSync(input.workspaceId);
  if (runtime.managedCredentialId) {
    await safeRevokeCredential({
      credentialId: runtime.managedCredentialId,
      tenantId: scope.tenantId,
      teamId: scope.teamId,
      reason: input.reason ?? "deleted",
      idempotencyKey: `revoke:${runtime.managedCredentialId}:${input.reason ?? "deleted"}`,
      audit: { actorId: input.actorUserId },
    });
    markRuntimeCredentialReconciliationTargetDrainingSync({
      workspaceId: input.workspaceId,
      runtimeId: runtime.id,
      runtimeCredentialId: runtime.managedCredentialId,
      retireAfter: resolveCredentialReconciliationRetireAfter(),
    });
  }
  if (runtime.credentialSecretRef) {
    getRuntimeCredentialVault().forget(runtime.credentialSecretRef, {
      tenantId: scope.tenantId,
      teamId: scope.teamId,
      runtimeId: runtime.id,
    });
  }
  if (runtime.daemonConnectionId) {
    requestManagedRuntimeCleanupSync({
      runtimeId: runtime.id,
      workspaceId: input.workspaceId,
      daemonConnectionId: runtime.daemonConnectionId,
      runtimeType: runtime.provider,
      deleteRuntimeOnSuccess: true,
    });
    updateAgentRuntimeManagedFieldsSync({
      runtimeId: runtime.id,
      workspaceId: input.workspaceId,
      status: "offline",
    });
  } else {
    deleteAgentRuntimeSync({ runtimeId: runtime.id, workspaceId: input.workspaceId });
  }
  recordAuditLogSync({
    workspaceId: input.workspaceId,
    title: runtime.daemonConnectionId ? "Managed runtime deletion scheduled" : "Managed runtime deleted",
    note: runtime.daemonConnectionId
      ? `Runtime ${runtime.id} will be deleted after node cleanup succeeds`
      : `Runtime ${runtime.id} deleted`,
    code: runtime.daemonConnectionId ? "runtime.delete_scheduled" : "runtime.deleted",
    source: "runtime_lifecycle",
    data: { runtimeId: runtime.id, actorId: input.actorUserId },
  });
}

export function completeManagedRuntimeCleanupSync(
  requestId: string,
  result?: Record<string, unknown>,
) {
  const request = readManagedRuntimeCleanupRequestSync(requestId);
  if (!request) return null;
  const completed = completeManagedRuntimeCleanupRequestRecordSync(requestId, "succeeded", result);
  if (!completed || completed.status !== "succeeded") return completed;

  let cleanupStatus: "succeeded" | "failed" = "succeeded";
  const cleanupResult: Record<string, unknown> = { ...(result ?? {}) };
  if (completed.deleteRuntimeOnSuccess) {
    try {
      assertOpenMontageRuntimePurgeableSync({
        workspaceId: completed.workspaceId,
        runtimeId: completed.runtimeId,
      });
      deleteAgentRuntimeSync({ runtimeId: completed.runtimeId, workspaceId: completed.workspaceId });
      cleanupResult.removedRuntimeId = completed.runtimeId;
    } catch (error) {
      cleanupStatus = "failed";
      cleanupResult.runtimeDeleteError = error instanceof Error ? error.message : String(error);
    }
  }
  const linkedTask = completed.provisioningTaskId
    ? readRuntimeProvisioningTaskSync(completed.provisioningTaskId, completed.workspaceId)
    : null;
  if (completed.provisioningTaskId && linkedTask?.status === "cancelling") {
    completeRuntimeProvisioningCancellationSync({
      id: completed.provisioningTaskId,
      workspaceId: completed.workspaceId,
      cleanupStatus,
      cleanupResult,
    });
  }
  return completed;
}

export function failManagedRuntimeCleanupSync(
  requestId: string,
  errorCode?: string,
  errorMessage?: string,
) {
  const failed = failManagedRuntimeCleanupRequestRecordSync(requestId, errorCode, errorMessage);
  const linkedTask = failed?.provisioningTaskId
    ? readRuntimeProvisioningTaskSync(failed.provisioningTaskId, failed.workspaceId)
    : null;
  if (failed?.status === "failed" && failed.provisioningTaskId && linkedTask?.status === "cancelling") {
    completeRuntimeProvisioningCancellationSync({
      id: failed.provisioningTaskId,
      workspaceId: failed.workspaceId,
      cleanupStatus: "failed",
      cleanupResult: {
        errorCode: failed.lastErrorCode,
        errorMessage: failed.lastErrorMessage,
      },
    });
  }
  return failed;
}

// ─── Pipeline driver ─────────────────────────────────────────────────────────

export async function resumeManagedRuntimeCleanupRequestsAsync(): Promise<{
  staleFailed: number;
}> {
  assertRemoteRuntimeMode();
  const { listStaleManagedRuntimeCleanupRequestsSync } = await import(
    "@dofe-agent/db"
  );
  const stale = listStaleManagedRuntimeCleanupRequestsSync(DEFAULT_CLEANUP_TIMEOUT_MS);
  for (const request of stale) {
    failManagedRuntimeCleanupSync(
      request.id,
      "cleanup.timeout",
      `Cleanup request timed out after ${DEFAULT_CLEANUP_TIMEOUT_MS}ms`,
    );
  }
  return { staleFailed: stale.length };
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

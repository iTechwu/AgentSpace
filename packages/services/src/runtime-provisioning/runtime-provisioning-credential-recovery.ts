// 凭证恢复状态机：provider 失败处理、冷却/租约、恢复续跑与状态查询。
import {
  createRuntimeCredentialRecoveryTaskSync,
  listDueRuntimeCredentialRecoveryTasksSync,
  markRuntimeCredentialReconciliationTargetDrainingSync,
  markRuntimeCredentialRecoveryFailedSync,
  markRuntimeCredentialRecoverySucceededSync,
  readAgentRuntimeSync,
  readRuntimeCredentialRecoveryTaskByIdempotencyKeySync,
  readRuntimeCredentialRecoveryTaskSync,
  recordAuditLogSync,
  requeueStaleRuntimeCredentialRecoveryTasksSync,
  startRuntimeCredentialRecoveryAttemptSync,
  updateAgentRuntimeManagedFieldsSync,
  upsertActiveRuntimeCredentialReconciliationTargetSync,
} from "@dofe-agent/db";
import type {
  AgentRuntimeRecord,
  RuntimeCredentialRecoveryTaskRecord,
} from "@dofe-agent/db";
import {
  notifyWorkspaceAdminsSync,
} from "../notifications/notifications.ts";
import {
  getRuntimeCredentialVault,
} from "./credential-vault.ts";
import type {
  ModelsInternalRuntimeCredential,
} from "@dofe/models-sdk";
import {
  assertCanManageManagedRuntimes,
  assertRemoteRuntimeMode,
  resolveManagedRuntimeScopeSync,
} from "./runtime-provisioning-capacity.ts";
import type {
  ManagedRuntimeActor,
} from "./runtime-provisioning-capacity.ts";
import {
  resolveCredentialReconciliationRetireAfter,
} from "./runtime-provisioning-pipeline.ts";
import { clientProvider } from "./runtime-provisioning-models-client.ts";

const CREDENTIAL_RECOVERY_MAX_ATTEMPTS = 3;

const CREDENTIAL_RECOVERY_COOLDOWN_MS = 60_000;

const CREDENTIAL_RECOVERY_LEASE_MS = 5 * 60_000;

export interface HandleManagedRuntimeProviderFailureInput {
  workspaceId: string;
  runtimeId: string;
  sourceTaskId: string;
  reportedCredentialId: string;
  errorCode?: string;
  now?: Date;
}

export type ManagedRuntimeProviderFailureResult =
  | { status: "ignored"; reason: "not_credential_invalid" | "runtime_not_managed" | "stale_credential" }
  | { status: "in_progress" | "cooldown" | "retry_scheduled" | "needs_attention"; task: RuntimeCredentialRecoveryTaskRecord }
  | { status: "recovered"; task: RuntimeCredentialRecoveryTaskRecord; runtime: AgentRuntimeRecord };

function transitionCredentialRecoveryToNeedsAttentionSync(input: {
  workspaceId: string;
  runtime: AgentRuntimeRecord;
  task: RuntimeCredentialRecoveryTaskRecord;
}): ManagedRuntimeProviderFailureResult {
  updateAgentRuntimeManagedFieldsSync({
    runtimeId: input.runtime.id,
    workspaceId: input.workspaceId,
    provisioningState: "needs_attention",
    status: "offline",
  });
  notifyWorkspaceAdminsSync({
    workspaceId: input.workspaceId,
    title: "Runtime credential recovery needs attention",
    body: `Automatic credential recovery failed ${input.task.attemptCount} times for runtime "${input.runtime.name}". Check models availability and contact platform operations.`,
    type: "runtime.credential_recovery_failed",
    severity: "critical",
    resourceType: "runtime",
    resourceId: input.runtime.id,
    actionHref: "/runtimes",
    dedupeKey: `runtime.credential_recovery_failed:${input.workspaceId}:${input.runtime.id}:${input.task.credentialId}`,
    metadata: {
      runtimeId: input.runtime.id,
      runtimeCredentialId: input.task.credentialId,
      recoveryTaskId: input.task.id,
      attemptCount: input.task.attemptCount,
    },
  });
  recordAuditLogSync({
    workspaceId: input.workspaceId,
    title: "Runtime credential recovery failed",
    note: `Automatic recovery exhausted for runtime ${input.runtime.id}`,
    code: "runtime_credential.recovery_failed",
    source: "runtime_credential",
    data: {
      runtimeId: input.runtime.id,
      runtimeCredentialId: input.task.credentialId,
      recoveryTaskId: input.task.id,
      attemptCount: input.task.attemptCount,
      maxAttempts: input.task.maxAttempts,
    },
  });
  return { status: "needs_attention", task: input.task };
}

/**
 * Trusted daemon boundary for automatic credential recovery. Only the
 * structured auth-invalid code can enter this workflow; billing, policy,
 * model and rate-limit failures are deliberately excluded.
 */

export async function handleManagedRuntimeProviderFailureAsync(
  input: HandleManagedRuntimeProviderFailureInput,
): Promise<ManagedRuntimeProviderFailureResult> {
  if (input.errorCode !== "provider.auth_invalid") {
    return { status: "ignored", reason: "not_credential_invalid" };
  }
  assertRemoteRuntimeMode();
  const runtime = readAgentRuntimeSync(input.runtimeId);
  if (
    !runtime ||
    runtime.workspaceId !== input.workspaceId ||
    !runtime.managedCredentialId ||
    (runtime.provisioningState !== "managed" && runtime.provisioningState !== "credential_recovering")
  ) {
    return { status: "ignored", reason: "runtime_not_managed" };
  }
  if (runtime.managedCredentialId !== input.reportedCredentialId) {
    const completedTask = readRuntimeCredentialRecoveryTaskByIdempotencyKeySync(
      input.workspaceId,
      `credential-recovery:${runtime.id}:${input.reportedCredentialId}`,
    );
    if (completedTask && (completedTask.status === "queued" || completedTask.status === "running")) {
      markRuntimeCredentialRecoverySucceededSync({
        id: completedTask.id,
        workspaceId: input.workspaceId,
        now: (input.now ?? new Date()).toISOString(),
      });
    }
    return { status: "ignored", reason: "stale_credential" };
  }

  const now = input.now ?? new Date();
  const nowIso = now.toISOString();
  const idempotencyKey = `credential-recovery:${runtime.id}:${input.reportedCredentialId}`;
  let task = createRuntimeCredentialRecoveryTaskSync({
    workspaceId: input.workspaceId,
    runtimeId: runtime.id,
    sourceTaskId: input.sourceTaskId,
    credentialId: input.reportedCredentialId,
    idempotencyKey,
    maxAttempts: CREDENTIAL_RECOVERY_MAX_ATTEMPTS,
    now: nowIso,
  });
  if (task.status === "succeeded") {
    return { status: "ignored", reason: "stale_credential" };
  }
  if (task.status === "failed") {
    return { status: "needs_attention", task };
  }
  if (task.status === "running") {
    return { status: "in_progress", task };
  }
  if (task.cooldownUntil && task.cooldownUntil > nowIso) {
    return { status: "cooldown", task };
  }

  const started = startRuntimeCredentialRecoveryAttemptSync({
    id: task.id,
    workspaceId: input.workspaceId,
    now: nowIso,
  });
  if (!started) {
    task = readRuntimeCredentialRecoveryTaskSync(task.id, input.workspaceId) ?? task;
    return { status: task.status === "running" ? "in_progress" : "cooldown", task };
  }
  task = started;
  updateAgentRuntimeManagedFieldsSync({
    runtimeId: runtime.id,
    workspaceId: input.workspaceId,
    provisioningState: "credential_recovering",
    status: "offline",
  });
  try {
    if (task.attemptCount === 1) {
      recordAuditLogSync({
        workspaceId: input.workspaceId,
        title: "Runtime credential recovery started",
        note: `Automatic recovery started for runtime ${runtime.id}`,
        code: "runtime_credential.recovery_started",
        source: "runtime_credential",
        data: {
          runtimeId: runtime.id,
          runtimeCredentialId: input.reportedCredentialId,
          sourceTaskId: input.sourceTaskId,
          recoveryTaskId: task.id,
        },
      });
    }
    const scope = resolveManagedRuntimeScopeSync(input.workspaceId);
    const result = await clientProvider().runtimeCredentials.rotate({
      params: { id: input.reportedCredentialId },
      body: {
        tenantId: scope.tenantId,
        teamId: scope.teamId,
        idempotencyKey: task.idempotencyKey,
        reason: "gateway-rejected",
        audit: { taskId: task.id },
      },
    });
    if (!result.secretIssued || !result.secret?.apiKey) {
      throw new Error("managed_runtime.recovery_no_secret");
    }
    const vault = getRuntimeCredentialVault();
    const oldSecretRef = runtime.credentialSecretRef;
    const credentialScope = {
      tenantId: scope.tenantId,
      teamId: scope.teamId,
      runtimeId: runtime.id,
    };
    const newSecret = vault.store(result.credential.id, result.secret.apiKey, credentialScope);
    markRuntimeCredentialReconciliationTargetDrainingSync({
      workspaceId: input.workspaceId,
      runtimeId: runtime.id,
      runtimeCredentialId: input.reportedCredentialId,
      retireAfter: resolveCredentialReconciliationRetireAfter(),
    });
    upsertActiveRuntimeCredentialReconciliationTargetSync({
      workspaceId: input.workspaceId,
      runtimeId: runtime.id,
      runtimeCredentialId: result.credential.id,
    });
    const updated = updateAgentRuntimeManagedFieldsSync({
      runtimeId: runtime.id,
      workspaceId: input.workspaceId,
      provisioningState: "managed",
      status: "online",
      managedCredentialId: result.credential.id,
      credentialSecretRef: newSecret.secretRef,
    });
    if (!updated) {
      vault.forget(newSecret.secretRef, credentialScope);
      throw new Error("managed_runtime.recovery_runtime_update_failed");
    }
    if (oldSecretRef) {
      vault.forget(oldSecretRef, credentialScope);
    }
    const succeeded = markRuntimeCredentialRecoverySucceededSync({
      id: task.id,
      workspaceId: input.workspaceId,
      now: nowIso,
    }) ?? task;
    recordAuditLogSync({
      workspaceId: input.workspaceId,
      title: "Runtime credential recovered",
      note: `Automatic recovery completed for runtime ${runtime.id}`,
      code: "runtime_credential.recovered",
      source: "runtime_credential",
      data: {
        runtimeId: runtime.id,
        previousCredentialId: input.reportedCredentialId,
        newCredentialId: result.credential.id,
        recoveryTaskId: task.id,
        attemptCount: task.attemptCount,
      },
    });
    return { status: "recovered", task: succeeded, runtime: updated };
  } catch {
    const currentRuntime = readAgentRuntimeSync(runtime.id);
    if (
      currentRuntime?.provisioningState === "managed" &&
      currentRuntime.managedCredentialId &&
      currentRuntime.managedCredentialId !== input.reportedCredentialId
    ) {
      const succeeded = markRuntimeCredentialRecoverySucceededSync({
        id: task.id,
        workspaceId: input.workspaceId,
        now: nowIso,
      }) ?? task;
      return { status: "recovered", task: succeeded, runtime: currentRuntime };
    }
    const cooldownUntil = new Date(now.getTime() + CREDENTIAL_RECOVERY_COOLDOWN_MS).toISOString();
    const failed = markRuntimeCredentialRecoveryFailedSync({
      id: task.id,
      workspaceId: input.workspaceId,
      errorCode: "managed_runtime.credential_recovery_failed",
      errorMessage: "The model service did not complete credential recovery.",
      cooldownUntil,
      now: nowIso,
    }) ?? task;
    const terminal = failed.status === "failed";
    if (terminal) {
      return transitionCredentialRecoveryToNeedsAttentionSync({
        workspaceId: input.workspaceId,
        runtime,
        task: failed,
      });
    }
    recordAuditLogSync({
      workspaceId: input.workspaceId,
      title: "Runtime credential recovery retry scheduled",
      note: `Automatic recovery retry ${failed.attemptCount}/${failed.maxAttempts} scheduled for runtime ${runtime.id}`,
      code: "runtime_credential.recovery_retry_scheduled",
      source: "runtime_credential",
      data: {
        runtimeId: runtime.id,
        runtimeCredentialId: input.reportedCredentialId,
        recoveryTaskId: task.id,
        attemptCount: failed.attemptCount,
        maxAttempts: failed.maxAttempts,
        cooldownUntil: failed.cooldownUntil,
      },
    });
    return { status: "retry_scheduled", task: failed };
  }
}

export async function resumePendingRuntimeCredentialRecoveriesAsync(input: {
  workspaceId: string;
  now?: Date;
}): Promise<ManagedRuntimeProviderFailureResult[]> {
  assertRemoteRuntimeMode();
  const now = input.now ?? new Date();
  const expired = requeueStaleRuntimeCredentialRecoveryTasksSync({
    workspaceId: input.workspaceId,
    staleBefore: new Date(now.getTime() - CREDENTIAL_RECOVERY_LEASE_MS).toISOString(),
    now: now.toISOString(),
  });
  const results: ManagedRuntimeProviderFailureResult[] = [];
  for (const task of expired.filter((candidate) => candidate.status === "failed")) {
    const runtime = readAgentRuntimeSync(task.runtimeId);
    if (!runtime || runtime.workspaceId !== input.workspaceId) continue;
    if (
      runtime.provisioningState === "managed" &&
      runtime.managedCredentialId &&
      runtime.managedCredentialId !== task.credentialId
    ) {
      const succeeded = markRuntimeCredentialRecoverySucceededSync({
        id: task.id,
        workspaceId: input.workspaceId,
        now: now.toISOString(),
      }) ?? task;
      results.push({ status: "recovered", task: succeeded, runtime });
      continue;
    }
    results.push(transitionCredentialRecoveryToNeedsAttentionSync({
      workspaceId: input.workspaceId,
      runtime,
      task,
    }));
  }
  const due = listDueRuntimeCredentialRecoveryTasksSync({
    workspaceId: input.workspaceId,
    now: now.toISOString(),
  });
  for (const task of due) {
    results.push(await handleManagedRuntimeProviderFailureAsync({
      workspaceId: task.workspaceId,
      runtimeId: task.runtimeId,
      sourceTaskId: task.sourceTaskId,
      reportedCredentialId: task.credentialId,
      errorCode: "provider.auth_invalid",
      now,
    }));
  }
  return results;
}

export interface GetManagedRuntimeCredentialStatusInput extends ManagedRuntimeActor {
  runtimeId: string;
}

export async function getManagedRuntimeCredentialStatusAsync(
  input: GetManagedRuntimeCredentialStatusInput,
): Promise<ModelsInternalRuntimeCredential | null> {
  assertRemoteRuntimeMode();
  assertCanManageManagedRuntimes(input);
  const runtime = readAgentRuntimeSync(input.runtimeId);
  if (!runtime || runtime.workspaceId !== input.workspaceId) {
    throw new Error("managed_runtime.runtime_not_found");
  }
  if (!runtime.managedCredentialId) {
    return null;
  }
  const scope = resolveManagedRuntimeScopeSync(input.workspaceId);
  const client = clientProvider();
  const credential = await client.runtimeCredentials.get({
    params: { id: runtime.managedCredentialId },
    query: { tenantId: scope.tenantId, teamId: scope.teamId },
  });
  recordAuditLogSync({
    workspaceId: input.workspaceId,
    title: "Runtime credential status checked",
    note: `Credential ${credential.id} status is ${credential.status}`,
    code: "runtime_credential.status_checked",
    source: "runtime_credential",
    data: {
      runtimeId: runtime.id,
      runtimeCredentialId: credential.id,
      status: credential.status,
      actorId: input.actorUserId,
    },
  });
  return credential;
}

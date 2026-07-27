/**
 * Managed Runtime provisioning service (Phase 2).
 *
 * Drives a durable, stage-tracked, idempotent RuntimeProvisioningTask through:
 *   request_credential → prepare_node → (pull_image/install_cli skipped in
 *   Phase 2) → write_credential → health_check → ready
 *
 * Credential plaintext is returned by models exactly once and is held only in
 * the RuntimeCredentialVault (never the DB/logs). Re-submission of the same
 * idempotency key returns the existing task without re-issuing a key. All
 * mutations require workspace Owner/Admin (server-side enforced here).
 */
import {
  advanceRuntimeProvisioningTaskStageSync,
  appendRuntimeProvisioningEventSync,
  claimManagedProvisioningStageSync,
  completeManagedProvisioningStageSync,
  completeRuntimeProvisioningCancellationSync,
  createRuntimeCredentialRecoveryTaskSync,
  createManagedAgentRuntimeSync,
  createRuntimeProvisioningTaskSync,
  deleteAgentRuntimeSync,
  failManagedProvisioningStageSync,
  getDatabase,
  getMonthStartIso,
  listEmployeeRuntimeBindingsSync,
  listRuntimeCostSummariesSync,
  listRuntimeProvisioningTaskEventsSync,
  listTokenUsageSync,
  listDueRuntimeCredentialRecoveryTasksSync,
  listRuntimeProvisioningTasksSync,
  listRetryingRuntimeProvisioningTasksReadySync,
  listRunningProvisioningTasksTimedOutSync,
  markDaemonOfflineSync,
  markStaleDaemonsOfflineSync,
  markRuntimeProvisioningTaskCancellingSync,
  markRuntimeProvisioningTaskFailedSync,
  markRuntimeProvisioningTaskReadySync,
  markRuntimeCredentialRecoveryFailedSync,
  markRuntimeCredentialRecoverySucceededSync,
  requeueStaleRuntimeCredentialRecoveryTasksSync,
  readAgentRuntimeSync,
  readRuntimeCredentialRecoveryTaskByIdempotencyKeySync,
  readRuntimeProvisioningTaskSync,
  readRuntimeCredentialRecoveryTaskSync,
  readWorkspaceSsoBindingSync,
  recordAuditLogSync,
  requestManagedRuntimeCleanupSync,
  resetRuntimeProvisioningTaskForRetrySync,
  startRuntimeCredentialRecoveryAttemptSync,
  timeoutRunningNodeStagesSync,
  updateAgentRuntimeManagedFieldsSync,
  type AgentRuntimeRecord,
  type RuntimeProvisioningTaskRecord,
  type RuntimeCredentialRecoveryTaskRecord,
  type WorkspaceSsoBindingRecord,
} from "@dofe-agent/db";
import { isDaemonProvider, resolveProviderProtocols, type DaemonProvider } from "@dofe-agent/domain";
import { getModelsInternalClient } from "../models/client.ts";
import { resolveAgentRuntimeMode } from "../config/deployment.ts";
import { isWorkspaceAdminOrOwnerSync } from "../runtime-access/runtime-access.ts";
import { tryRecordWorkspaceAuditEventSync } from "../shared/audit.ts";
import { notifyWorkspaceAdminsSync } from "../notifications/notifications.ts";
import {
  getRuntimeCredentialVault,
  type RuntimeCredentialVault,
} from "./credential-vault.ts";
import {
  buildManagedProvisioningCommandContext,
  buildManagedProvisioningStageCommands,
  type ManagedProvisioningCommand,
} from "./provider-templates.ts";
import type {
  ModelsInternalRuntimeCredential,
  ModelsInternalRotateRuntimeCredentialRequest,
  ModelsInternalRevokeRuntimeCredentialRequest,
} from "@dofe/models-sdk";

const MANAGED_RUNTIME_NAME_PREFIX = "Managed";

const DEFAULT_TASK_TIMEOUT_MS = 30 * 60 * 1000;
const DEFAULT_STAGE_TIMEOUT_MS = 10 * 60 * 1000;
const DEFAULT_CLEANUP_TIMEOUT_MS = 10 * 60 * 1000;
const RETRY_BACKOFF_BASE_MS = 15_000;
const RETRY_BACKOFF_MAX_MS = 5 * 60 * 1000;

function computeRetryBackoffMs(retryCount: number): number {
  const jitter = Math.random() * 0.4 + 0.8;
  return Math.min(RETRY_BACKOFF_MAX_MS, RETRY_BACKOFF_BASE_MS * 2 ** retryCount) * jitter;
}

// ─── Role + scope resolution ────────────────────────────────────────────────

export interface ManagedRuntimeActor {
  workspaceId: string;
  actorUserId: string;
}

function assertCanManageManagedRuntimes(input: ManagedRuntimeActor): void {
  if (
    !isWorkspaceAdminOrOwnerSync({
      workspaceId: input.workspaceId,
      userId: input.actorUserId,
    })
  ) {
    throw new Error("Only workspace owners and admins can manage managed runtimes.");
  }
}

function assertRemoteRuntimeMode(): void {
  if (resolveAgentRuntimeMode() !== "remote") {
    throw new Error("managed_runtime.remote_mode_required");
  }
}

/**
 * Managed runtimes bill to a models.dofe.ai (tenantId, teamId), so the
 * workspace must be SSO team-scoped. Tenant-only workspaces (no teamId) are
 * rejected.
 */
export function resolveManagedRuntimeScopeSync(
  workspaceId: string,
): { binding: WorkspaceSsoBindingRecord; tenantId: string; teamId: string } {
  const binding = readWorkspaceSsoBindingSync(workspaceId);
  if (!binding) {
    throw new Error("managed_runtime.sso_binding_required");
  }
  if (!binding.teamId) {
    throw new Error("managed_runtime.team_scoped_workspace_required");
  }
  return { binding, tenantId: binding.tenantId, teamId: binding.teamId };
}

// ─── Public API ──────────────────────────────────────────────────────────────

export interface RequestManagedRuntimeInput extends ManagedRuntimeActor {
  provider: DaemonProvider;
  defaultModel?: string;
  protocols?: string[];
  allowedModels?: string[];
  idempotencyKey: string;
  targetServer?: string;
  name?: string;
}

export function requestManagedRuntimeProvisioningSync(
  input: RequestManagedRuntimeInput,
): RuntimeProvisioningTaskRecord {
  assertRemoteRuntimeMode();
  assertCanManageManagedRuntimes(input);
  resolveManagedRuntimeScopeSync(input.workspaceId);
  const protocols = input.protocols?.length
    ? input.protocols
    : resolveProviderProtocols(input.provider);

  const task = createRuntimeProvisioningTaskSync({
    workspaceId: input.workspaceId,
    requestedByUserId: input.actorUserId,
    idempotencyKey: input.idempotencyKey,
    runtimeType: input.provider,
    protocols,
    requestedName: input.name,
    requestedModel: input.defaultModel,
    allowedModels: input.allowedModels,
    targetServer: input.targetServer,
  });

  tryRecordWorkspaceAuditEventSync({
    workspaceId: input.workspaceId,
    title: "Managed runtime provisioning requested",
    note: `Requested ${input.provider} runtime (task ${task.id})`,
    code: "runtime.provision_requested",
    data: { runtimeType: input.provider, taskId: task.id, actorId: input.actorUserId },
  });

  // Fire-and-forget: the task row is durable, so the pipeline keeps running
  // after the caller leaves the page. Errors are written back to the task.
  void runProvisioningPipeline(task.id, input.workspaceId, {
    name: input.name,
    allowedModels: input.allowedModels,
  }).catch((error) => {
    markRuntimeProvisioningTaskFailedSync({
      id: task.id,
      workspaceId: input.workspaceId,
      stage: "pending",
      errorCode: "pipeline_unhandled_error",
      errorMessage: error instanceof Error ? error.message : String(error),
    });
  });

  return task;
}

export type PublicRuntimeProvisioningTaskRecord = Omit<
  RuntimeProvisioningTaskRecord,
  "secretRef" | "configRef"
> & { credentialConfigured: boolean };

export interface PublicManagedRuntimeRecord {
  id: string;
  status: AgentRuntimeRecord["status"];
  provisioningState: AgentRuntimeRecord["provisioningState"];
  protocols: string[];
  defaultModel?: string;
  credentialConfigured: boolean;
}

export interface RuntimeProvisioningTaskDetail {
  task: PublicRuntimeProvisioningTaskRecord;
  events: ReturnType<typeof listRuntimeProvisioningTaskEventsSync>;
  runtime?: PublicManagedRuntimeRecord;
}

export function getRuntimeProvisioningTaskDetailSync(input: ManagedRuntimeActor & {
  taskId: string;
}): RuntimeProvisioningTaskDetail {
  assertRemoteRuntimeMode();
  assertCanManageManagedRuntimes(input);
  const task = readRuntimeProvisioningTaskSync(input.taskId, input.workspaceId);
  if (!task) {
    throw new Error("managed_runtime.task_not_found");
  }
  const events = listRuntimeProvisioningTaskEventsSync(task.id);
  const runtime = task.runtimeId ? readAgentRuntimeSync(task.runtimeId) ?? undefined : undefined;
  return {
    task: toPublicRuntimeProvisioningTask(task),
    events,
    runtime: runtime ? toPublicManagedRuntime(runtime) : undefined,
  };
}

export function retryRuntimeProvisioningTaskSync(
  input: ManagedRuntimeActor & { taskId: string },
): RuntimeProvisioningTaskRecord {
  assertRemoteRuntimeMode();
  assertCanManageManagedRuntimes(input);
  const task = readRuntimeProvisioningTaskSync(input.taskId, input.workspaceId);
  if (!task) {
    throw new Error("managed_runtime.task_not_found");
  }
  if (task.status !== "failed" && task.status !== "retrying") {
    throw new Error("managed_runtime.only_failed_tasks_can_retry");
  }
  if (task.retryCount >= task.maxRetries) {
    throw new Error(`managed_runtime.retry_limit_reached (${task.maxRetries})`);
  }
  const reset = resetRuntimeProvisioningTaskForRetrySync({
    id: task.id,
    workspaceId: input.workspaceId,
  });
  if (!reset) {
    throw new Error("managed_runtime.task_not_found");
  }
  tryRecordWorkspaceAuditEventSync({
    workspaceId: input.workspaceId,
    title: "Managed runtime provisioning retried",
    note: `Retry ${reset.retryCount}/${reset.maxRetries} for task ${reset.id}`,
    code: "runtime.provision_retry",
    data: { taskId: reset.id, retryCount: reset.retryCount, actorId: input.actorUserId },
  });
  void runProvisioningPipeline(reset.id, input.workspaceId).catch((error) => {
    markRuntimeProvisioningTaskFailedSync({
      id: reset.id,
      workspaceId: input.workspaceId,
      stage: "pending",
      errorCode: "pipeline_unhandled_error",
      errorMessage: error instanceof Error ? error.message : String(error),
    });
  });
  return reset;
}

export async function cancelRuntimeProvisioningTaskSync(
  input: ManagedRuntimeActor & { taskId: string; reason?: string },
): Promise<RuntimeProvisioningTaskRecord> {
  assertRemoteRuntimeMode();
  assertCanManageManagedRuntimes(input);
  const task = readRuntimeProvisioningTaskSync(input.taskId, input.workspaceId);
  if (!task) {
    throw new Error("managed_runtime.task_not_found");
  }
  const cancelling = markRuntimeProvisioningTaskCancellingSync({
    id: task.id,
    workspaceId: input.workspaceId,
  });
  if (!cancelling) {
    return task;
  }

  // Compensation: revoke the credential if one was issued, drop the runtime row.
  const cleanup = await compensateProvisioning(task);
  const finalized = completeRuntimeProvisioningCancellationSync({
    id: task.id,
    workspaceId: input.workspaceId,
    cleanupStatus: cleanup.ok ? "succeeded" : "failed",
    cleanupResult: cleanup.detail,
  });
  tryRecordWorkspaceAuditEventSync({
    workspaceId: input.workspaceId,
    title: "Managed runtime provisioning cancelled",
    note: `Task ${task.id} cancelled; cleanup ${cleanup.ok ? "succeeded" : "failed"}`,
    code: "runtime.provision_cancelled",
    data: { taskId: task.id, actorId: input.actorUserId },
  });
  return finalized ?? cancelling;
}

export function listManagedRuntimeTasksSync(
  input: ManagedRuntimeActor,
): PublicRuntimeProvisioningTaskRecord[] {
  assertRemoteRuntimeMode();
  assertCanManageManagedRuntimes(input);
  return listRuntimeProvisioningTasksSync(input.workspaceId).map(toPublicRuntimeProvisioningTask);
}

function toPublicRuntimeProvisioningTask(
  task: RuntimeProvisioningTaskRecord,
): PublicRuntimeProvisioningTaskRecord {
  const { secretRef, configRef, ...safeTask } = task;
  return {
    ...safeTask,
    credentialConfigured: Boolean(secretRef || configRef),
  };
}

function toPublicManagedRuntime(runtime: AgentRuntimeRecord): PublicManagedRuntimeRecord {
  return {
    id: runtime.id,
    status: runtime.status,
    provisioningState: runtime.provisioningState,
    protocols: runtime.protocols ?? [],
    defaultModel: runtime.defaultModel,
    credentialConfigured: Boolean(runtime.credentialSecretRef || runtime.credentialConfigRef),
  };
}

export function listManagedRuntimesForWorkspaceSync(
  input: ManagedRuntimeActor,
): ManagedRuntimeListItem[] {
  assertRemoteRuntimeMode();
  assertCanManageManagedRuntimes(input);
  const db = getDatabase();
  const rows = db.prepare(
    `SELECT id, name, provider, managed_credential_id AS managedCredentialId, status,
            provisioning_state AS provisioningState, protocols_json AS protocolsJson,
            default_model AS defaultModel, last_heartbeat_at AS lastHeartbeatAt
     FROM agent_runtime
     WHERE workspace_id = ? AND managed_credential_id IS NOT NULL
     ORDER BY created_at DESC`,
  ).all(input.workspaceId) as Array<{
    id: string;
    name: string;
    provider: string;
    managedCredentialId: string;
    status: string;
    provisioningState?: string;
    protocolsJson?: string;
    defaultModel?: string;
    lastHeartbeatAt?: string;
  }>;
  const bindingCountByRuntime = new Map<string, number>();
  for (const binding of listEmployeeRuntimeBindingsSync(input.workspaceId)) {
    bindingCountByRuntime.set(binding.runtimeId, (bindingCountByRuntime.get(binding.runtimeId) ?? 0) + 1);
  }
  const actualCostByRuntime = new Map(
    listRuntimeCostSummariesSync(getMonthStartIso(), input.workspaceId)
      .map((summary) => [summary.runtimeId, summary.totalActualCostUsd]),
  );
  const unallocatedCostByCredential = new Map<string, number>();
  for (const usage of listTokenUsageSync({ workspaceId: input.workspaceId, since: getMonthStartIso() })) {
    if (usage.billingStatus !== "unallocated" || !usage.runtimeCredentialId) continue;
    unallocatedCostByCredential.set(
      usage.runtimeCredentialId,
      (unallocatedCostByCredential.get(usage.runtimeCredentialId) ?? 0) + (usage.actualCostUsd ?? 0),
    );
  }
  return rows
    .filter((row) => isDaemonProvider(row.provider))
    .map((row) => ({
      id: row.id,
      name: row.name,
      provider: row.provider as DaemonProvider,
      managedCredentialId: row.managedCredentialId,
      status: row.status === "online" ? "online" : "offline",
      provisioningState: normalizeManagedRuntimeLifecycleState(row.provisioningState),
      protocols: parseStringArray(row.protocolsJson),
      defaultModel: row.defaultModel,
      assignedEmployeeCount: bindingCountByRuntime.get(row.id) ?? 0,
      lastHeartbeatAt: row.lastHeartbeatAt,
      periodActualCostUsd: actualCostByRuntime.get(row.id) ?? 0,
      unallocatedCostUsd: unallocatedCostByCredential.get(row.managedCredentialId) ?? 0,
    }));
}

export interface ManagedRuntimeListItem {
  id: string;
  name: string;
  provider: DaemonProvider;
  managedCredentialId: string;
  status: "online" | "offline";
  provisioningState: "managed" | "credential_recovering" | "needs_attention" | "legacy";
  protocols: string[];
  defaultModel?: string;
  assignedEmployeeCount: number;
  lastHeartbeatAt?: string;
  periodActualCostUsd: number;
  unallocatedCostUsd: number;
}

function parseStringArray(value: string | undefined): string[] {
  if (!value) return [];
  try {
    const parsed = JSON.parse(value) as unknown;
    return Array.isArray(parsed) ? parsed.filter((item): item is string => typeof item === "string") : [];
  } catch {
    return [];
  }
}

function normalizeManagedRuntimeLifecycleState(value: string | undefined): ManagedRuntimeListItem["provisioningState"] {
  if (value === "credential_recovering" || value === "needs_attention" || value === "legacy") return value;
  return "managed";
}

export interface RotateManagedRuntimeCredentialInput extends ManagedRuntimeActor {
  runtimeId: string;
  reason?: ModelsInternalRotateRuntimeCredentialRequest["reason"];
}

export async function rotateManagedRuntimeCredentialSync(
  input: RotateManagedRuntimeCredentialInput,
): Promise<AgentRuntimeRecord> {
  assertRemoteRuntimeMode();
  assertCanManageManagedRuntimes(input);
  const runtime = readAgentRuntimeSync(input.runtimeId);
  if (!runtime || runtime.workspaceId !== input.workspaceId) {
    throw new Error("managed_runtime.runtime_not_found");
  }
  if (runtime.provisioningState !== "managed" && runtime.provisioningState !== "needs_attention") {
    throw new Error("managed_runtime.not_a_managed_runtime");
  }
  if (!runtime.managedCredentialId) {
    throw new Error("managed_runtime.no_credential");
  }
  const scope = resolveManagedRuntimeScopeSync(input.workspaceId);
  const client = clientProvider();
  const credentialId = runtime.managedCredentialId;
  const reason = input.reason ?? "manual";
  const result = await client.runtimeCredentials.rotate({
    params: { id: credentialId },
    body: {
      tenantId: scope.tenantId,
      teamId: scope.teamId,
      idempotencyKey: `rotate:${credentialId}:${reason}`,
      reason,
      audit: { actorId: input.actorUserId },
    },
  });
  if (!result.secretIssued || !result.secret?.apiKey) {
    const today = new Date().toISOString().slice(0, 10);
    notifyWorkspaceAdminsSync({
      workspaceId: input.workspaceId,
      title: "Runtime credential rotation failed",
      body: `Credential rotation for ${runtime.provider} runtime "${runtime.name ?? runtime.id}" failed: the model service did not issue a new secret.`,
      type: "runtime.credential_rotation_failed",
      severity: "critical",
      resourceType: "workspace",
      resourceId: runtime.id,
      dedupeKey: `runtime.credential_rotation_failed:${input.workspaceId}:${runtime.id}:${today}`,
      metadata: {
        runtimeId: runtime.id,
        runtimeCredentialId: credentialId,
        runtimeType: runtime.provider,
      },
    });
    throw new Error("managed_runtime.rotate_no_secret");
  }
  const vault = getRuntimeCredentialVault();
  const oldSecretRef = runtime.credentialSecretRef;
  const credentialScope = { tenantId: scope.tenantId, teamId: scope.teamId, runtimeId: runtime.id };
  const newSecret = vault.store(result.credential.id, result.secret.apiKey, credentialScope);
  updateAgentRuntimeManagedFieldsSync({
    runtimeId: runtime.id,
    workspaceId: input.workspaceId,
    provisioningState: "managed",
    status: "online",
    managedCredentialId: result.credential.id,
    credentialSecretRef: newSecret.secretRef,
  });
  if (oldSecretRef) {
    vault.forget(oldSecretRef, credentialScope);
  }
  recordAuditLogSync({
    workspaceId: input.workspaceId,
    title: "Runtime credential rotated",
    note: `Credential rotated from ${credentialId} to ${result.credential.id}`,
    code: "runtime_credential.rotated",
    source: "runtime_credential",
    data: {
      runtimeId: runtime.id,
      previousCredentialId: credentialId,
      newCredentialId: result.credential.id,
      newKeyFingerprint: result.credential.keyFingerprint ?? "",
      reason,
      actorId: input.actorUserId,
    },
  });
  const updated = readAgentRuntimeSync(runtime.id);
  return updated ?? runtime;
}

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

export async function getManagedRuntimeCredentialStatusSync(
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

export interface StopManagedRuntimeInput extends ManagedRuntimeActor {
  runtimeId: string;
  reason?: string;
}

export async function stopManagedRuntimeSync(input: StopManagedRuntimeInput): Promise<AgentRuntimeRecord> {
  assertRemoteRuntimeMode();
  assertCanManageManagedRuntimes(input);
  const runtime = readAgentRuntimeSync(input.runtimeId);
  if (!runtime || runtime.workspaceId !== input.workspaceId) {
    throw new Error("managed_runtime.runtime_not_found");
  }
  if (runtime.provisioningState !== "managed") {
    throw new Error("managed_runtime.not_a_managed_runtime");
  }
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

export async function deleteManagedRuntimeSync(input: StopManagedRuntimeInput): Promise<void> {
  assertRemoteRuntimeMode();
  assertCanManageManagedRuntimes(input);
  const runtime = readAgentRuntimeSync(input.runtimeId);
  if (!runtime || runtime.workspaceId !== input.workspaceId) {
    throw new Error("managed_runtime.runtime_not_found");
  }
  if (runtime.provisioningState !== "managed") {
    throw new Error("managed_runtime.not_a_managed_runtime");
  }
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
  recordAuditLogSync({
    workspaceId: input.workspaceId,
    title: "Managed runtime deleted",
    note: `Runtime ${runtime.id} deleted`,
    code: "runtime.deleted",
    source: "runtime_lifecycle",
    data: { runtimeId: runtime.id, actorId: input.actorUserId },
  });
  deleteAgentRuntimeSync({ runtimeId: runtime.id, workspaceId: input.workspaceId });
}

// ─── Pipeline driver ─────────────────────────────────────────────────────────

export interface PipelineRunOptions {
  name?: string;
  allowedModels?: string[];
  /** Test seam: inject a models client. Defaults to the env-configured client. */
  modelsClient?: ModelsClientLike;
  /** Test seam: inject a vault. Defaults to the process vault. */
  vault?: RuntimeCredentialVault;
}

/** Minimal structural type over the SDK client surface the pipeline uses. */
export interface ModelsClientLike {
  models: {
    list(args: { query: { tenantId: string } }): Promise<{ list: unknown[] }>;
  };
  billing: {
    preflight(args: { body: { teamId: string; estimatedCharge: number } }): Promise<{
      allowed: boolean;
      availableBalance?: string | number | null;
      estimatedCharge?: string | number | null;
      currency?: string;
      code?: string;
      message?: string;
    }>;
  };
  runtimeCredentials: {
    create(args: { body: Record<string, unknown> }): Promise<ModelsCreateResult>;
    get(args: { params: { id: string }; query: { tenantId: string; teamId: string } }): Promise<ModelsInternalRuntimeCredential>;
    rotate(args: { params: { id: string }; body: ModelsInternalRotateRuntimeCredentialRequest }): Promise<ModelsCreateResult>;
    revoke(args: { params: { id: string }; body: ModelsInternalRevokeRuntimeCredentialRequest }): Promise<{ ok: boolean }>;
    models(args: { params: { id: string }; query?: { protocol?: string; tenantId?: string; teamId?: string } }): Promise<{ list: unknown[]; total: number }>;
  };
}

export interface ModelsCreateResult {
  credential: { id: string; keyFingerprint?: string };
  secret?: { apiKey: string };
  secretIssued: boolean;
}

/** Indirection so tests can swap the client without touching env. */
let clientProvider: () => ModelsClientLike = () =>
  getModelsInternalClient() as unknown as ModelsClientLike;

export function setProvisioningModelsClientProviderForTests(provider: () => ModelsClientLike): void {
  clientProvider = provider;
}

export interface ManagedRuntimeCreationPreflightResult {
  allowed: boolean;
  availableBalance?: string;
  estimatedCharge?: string;
  currency?: string;
  code?: string;
  message?: string;
}

export async function preflightManagedRuntimeCreationAsync(
  input: ManagedRuntimeActor & {
    provider: DaemonProvider;
    defaultModel?: string;
    estimatedCharge?: number;
  },
): Promise<ManagedRuntimeCreationPreflightResult> {
  assertRemoteRuntimeMode();
  assertCanManageManagedRuntimes(input);
  const scope = resolveManagedRuntimeScopeSync(input.workspaceId);
  try {
    await assertManagedRuntimeModelSelectionAsync({
      client: clientProvider(),
      tenantId: scope.tenantId,
      protocols: resolveProviderProtocols(input.provider),
      requestedModel: input.defaultModel,
    });
  } catch (error) {
    return {
      allowed: false,
      code: error instanceof Error ? error.message : "managed_runtime.model_catalog_unavailable",
      message: formatManagedRuntimePreflightError(error),
    };
  }
  const result = await clientProvider().billing.preflight({
    body: {
      teamId: scope.teamId,
      estimatedCharge: input.estimatedCharge ?? 0,
    },
  });
  return {
    allowed: result.allowed,
    availableBalance: normalizeBillingAmount(result.availableBalance),
    estimatedCharge: normalizeBillingAmount(result.estimatedCharge),
    currency: result.currency,
    code: result.code,
    message: result.message,
  };
}

function normalizeBillingAmount(value: string | number | null | undefined): string | undefined {
  return value == null ? undefined : String(value);
}

function formatManagedRuntimePreflightError(error: unknown): string {
  const code = error instanceof Error ? error.message : String(error);
  if (code === "managed_runtime.no_compatible_models") {
    return "No available model supports this runtime protocol.";
  }
  if (code === "managed_runtime.model_unavailable") {
    return "The selected model is unavailable or incompatible with this runtime.";
  }
  return "The model catalog could not be verified.";
}

export async function runProvisioningPipeline(
  taskId: string,
  workspaceId: string,
  options: PipelineRunOptions = {},
): Promise<void> {
  assertRemoteRuntimeMode();
  const client = options.modelsClient ?? clientProvider();
  const vault = options.vault ?? getRuntimeCredentialVault();

  const task = readRuntimeProvisioningTaskSync(taskId, workspaceId);
  if (!task || task.status === "succeeded" || task.status === "cancelled" || task.status === "cancelling") {
    return;
  }
  if (task.status === "retrying" && task.nextRetryAt && task.nextRetryAt > new Date().toISOString()) {
    return;
  }

  const scope = resolveManagedRuntimeScopeSync(workspaceId);
  const runtimeId = task.runtimeId ?? `runtime-managed-${generateId()}`;
  const allowedModels = task.allowedModels.length > 0 ? task.allowedModels : options.allowedModels ?? [];

  // Stage: request_credential (idempotent — skip if already issued)
  if (!task.runtimeCredentialId) {
    try {
      advanceStage(taskId, workspaceId, "request_credential", "running", 10);
      await assertManagedRuntimeModelSelectionAsync({
        client,
        tenantId: scope.tenantId,
        protocols: task.protocols,
        requestedModel: task.requestedModel,
      });
      const preflight = await client.billing.preflight({
        body: { teamId: scope.teamId, estimatedCharge: 0 },
      });
      if (!preflight.allowed) {
        const today = new Date().toISOString().slice(0, 10);
        notifyWorkspaceAdminsSync({
          workspaceId,
          title: "Insufficient balance for managed runtime",
          body: `Provisioning ${task.runtimeType} runtime "${runtimeId}" was rejected because the team balance is insufficient. Add credits or lower usage before retrying.`,
          type: "billing.insufficient_balance",
          severity: "critical",
          resourceType: "workspace",
          resourceId: runtimeId,
          dedupeKey: `billing.insufficient_balance:${workspaceId}:${today}`,
          metadata: { runtimeId, runtimeType: task.runtimeType, teamId: scope.teamId },
        });
        throw new Error("managed_runtime.balance_preflight_rejected");
      }
      const result = await client.runtimeCredentials.create({
        body: {
          tenantId: scope.tenantId,
          teamId: scope.teamId,
          runtimeId,
          runtimeType: task.runtimeType,
          protocols: task.protocols,
          allowedModels,
          defaultModel: task.requestedModel,
          idempotencyKey: task.idempotencyKey,
          audit: { actorId: task.requestedByUserId, taskId },
        },
      });
      let secretRef: string | undefined;
      if (result.secretIssued && result.secret?.apiKey) {
        secretRef = vault.store(result.credential.id, result.secret.apiKey, {
          tenantId: scope.tenantId,
          teamId: scope.teamId,
          runtimeId,
        }).secretRef;
      } else if (task.secretRef) {
        secretRef = task.secretRef;
      }
      advanceStage(taskId, workspaceId, "request_credential", "succeeded", 25, {
        runtimeCredentialId: result.credential.id,
        secretRef,
      });
      recordAuditLogSync({
        workspaceId,
        title: "Runtime credential issued",
        note: `Credential ${result.credential.id} issued for runtime ${runtimeId}`,
        code: "runtime_credential.created",
        source: "runtime_credential",
        data: {
          runtimeCredentialId: result.credential.id,
          runtimeId,
          keyFingerprint: result.credential.keyFingerprint ?? "",
          secretIssued: result.secretIssued,
        },
      });
      task.runtimeCredentialId = result.credential.id;
      task.secretRef = secretRef;
    } catch (error) {
      return failTask(taskId, workspaceId, "request_credential", error);
    }
  }

  // Stage: prepare_node (create the managed runtime row; idempotent)
  let runtime = task.runtimeId ? readAgentRuntimeSync(task.runtimeId) : undefined;
  if (!runtime) {
    try {
      advanceStage(taskId, workspaceId, "prepare_node", "running", 35);
      runtime = createManagedAgentRuntimeSync({
        id: runtimeId,
        workspaceId,
        provider: task.runtimeType,
        name: task.requestedName ?? options.name ?? `${MANAGED_RUNTIME_NAME_PREFIX} ${task.runtimeType}`,
        protocols: task.protocols,
        defaultModel: task.requestedModel,
        managedCredentialId: task.runtimeCredentialId!,
        credentialSecretRef: task.secretRef,
        provisioningTaskId: taskId,
      });
      advanceStage(taskId, workspaceId, "prepare_node", "succeeded", 45, {
        runtimeId: runtime.id,
      });
    } catch (error) {
      return failTask(taskId, workspaceId, "prepare_node", error);
    }
  }

  // After prepare_node, move into the node-driven stage pipeline.
  if (task.stage === "prepare_node" || task.stage === "pending") {
    advanceStage(taskId, workspaceId, "pull_image", "pending", 50, {
      runtimeId: runtime.id,
    });
    return;
  }

  // Stage: pull_image / install_cli / write_credential / health_check are driven
  // by the managed node. The server advances to pull_image pending and then waits
  // for daemon stage reports. resumePendingProvisioningTasksSync re-enters here
  // once a node stage has been reported succeeded.
  if (
    task.stage === "pull_image" ||
    task.stage === "install_cli" ||
    task.stage === "write_credential" ||
    task.stage === "health_check"
  ) {
    if (task.stageStatus !== "succeeded") {
      // Nothing the server can do until the node reports back.
      return;
    }
  }

  // Stage: write_credential is a no-op server-side in Phase 3; the node writes
  // the credential profile. If we reach this point, the node has already
  // reported it succeeded, so we only need to advance to health_check pending.
  if (task.stage === "write_credential") {
    advanceStage(taskId, workspaceId, "health_check", "pending", 85);
    return;
  }

  // Stage: health_check (node-level gateway/protocol check)
  if (task.stage === "health_check") {
    finalizeManagedRuntimeProvisioningSync({ taskId, workspaceId, runtimeId: runtime.id });
    return;
  }

  // Stage: pull_image / install_cli should not be reached here unless the node
  // already reported them succeeded. Advance to the next stage.
  if (task.stage === "pull_image") {
    advanceStage(taskId, workspaceId, "install_cli", "pending", 60);
    return;
  }
  if (task.stage === "install_cli") {
    advanceStage(taskId, workspaceId, "write_credential", "pending", 75);
    return;
  }

  // Stage: ready
  finalizeManagedRuntimeProvisioningSync({ taskId, workspaceId, runtimeId: runtime.id });
}

export function finalizeManagedRuntimeProvisioningSync(input: {
  taskId: string;
  workspaceId: string;
  runtimeId: string;
}): RuntimeProvisioningTaskRecord | null {
  markRuntimeProvisioningTaskReadySync({
    id: input.taskId,
    workspaceId: input.workspaceId,
    runtimeId: input.runtimeId,
  });
  updateAgentRuntimeManagedFieldsSync({
    runtimeId: input.runtimeId,
    workspaceId: input.workspaceId,
    provisioningState: "managed",
    status: "online",
  });
  const task = readRuntimeProvisioningTaskSync(input.taskId, input.workspaceId);
  tryRecordWorkspaceAuditEventSync({
    workspaceId: input.workspaceId,
    title: "Managed runtime ready",
    note: `Runtime ${input.runtimeId} is provisioned`,
    code: "runtime.created",
    data: { runtimeId: input.runtimeId, runtimeCredentialId: task?.runtimeCredentialId ?? "" },
  });
  return task;
}

/**
 * Re-drive tasks left running by a process restart or an offline node. Safe to
 * call periodically; finished/cancelled tasks are skipped.
 */
export async function resumePendingProvisioningTasksSync(workspaceId?: string): Promise<{
  timedOutNodeStages: number;
  timedOutNodeStagesRetried: number;
  timedOutNodeStagesFailed: number;
  timedOutTasks: number;
  resetRetries: number;
  driven: number;
}> {
  assertRemoteRuntimeMode();
  markStaleDaemonsOfflineSync({ workspaceId });

  const {
    timedOut: timedOutNodeStages,
    retried: timedOutNodeStagesRetried,
    failed: timedOutNodeStagesFailed,
  } = timeoutRunningNodeStagesSync();

  const timedOutTasks = listRunningProvisioningTasksTimedOutSync(workspaceId);
  for (const task of timedOutTasks) {
    markRuntimeProvisioningTaskFailedSync({
      id: task.id,
      workspaceId: task.workspaceId,
      stage: task.stage,
      errorCode: "provisioning.task_timeout",
      errorMessage: `Task timed out after ${task.taskTimeoutMs ?? DEFAULT_TASK_TIMEOUT_MS}ms`,
    });
  }

  const readyRetries = listRetryingRuntimeProvisioningTasksReadySync(workspaceId);
  for (const task of readyRetries) {
    resetRuntimeProvisioningTaskForRetrySync({
      id: task.id,
      workspaceId: task.workspaceId,
    });
  }

  const tasks = listRuntimeProvisioningTasksSync(workspaceId, {
    statuses: ["queued", "running", "retrying"],
  });
  let driven = 0;
  for (const task of tasks) {
    if (task.status === "retrying" && task.nextRetryAt && task.nextRetryAt > new Date().toISOString()) {
      continue;
    }
    driven += 1;
    await runProvisioningPipeline(task.id, task.workspaceId).catch((error) => {
      markRuntimeProvisioningTaskFailedSync({
        id: task.id,
        workspaceId: task.workspaceId,
        stage: task.stage,
        errorCode: "pipeline_resume_error",
        errorMessage: error instanceof Error ? error.message : String(error),
      });
    });
  }

  return {
    timedOutNodeStages,
    timedOutNodeStagesRetried,
    timedOutNodeStagesFailed,
    timedOutTasks: timedOutTasks.length,
    resetRetries: readyRetries.length,
    driven,
  };
}

export async function resumeManagedRuntimeCleanupRequestsSync(): Promise<{
  staleFailed: number;
}> {
  assertRemoteRuntimeMode();
  const { failManagedRuntimeCleanupRequestSync, listStaleManagedRuntimeCleanupRequestsSync } = await import(
    "@dofe-agent/db"
  );
  const stale = listStaleManagedRuntimeCleanupRequestsSync(DEFAULT_CLEANUP_TIMEOUT_MS);
  for (const request of stale) {
    failManagedRuntimeCleanupRequestSync(
      request.id,
      "cleanup.timeout",
      `Cleanup request timed out after ${DEFAULT_CLEANUP_TIMEOUT_MS}ms`,
    );
  }
  return { staleFailed: stale.length };
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function advanceStage(
  taskId: string,
  workspaceId: string,
  stage: RuntimeProvisioningTaskRecord["stage"],
  status: RuntimeProvisioningTaskRecord["stageStatus"],
  progressPercent: number,
  fields?: { runtimeId?: string; runtimeCredentialId?: string; secretRef?: string },
): void {
  advanceRuntimeProvisioningTaskStageSync({
    id: taskId,
    workspaceId,
    stage,
    status,
    progressPercent,
    ...fields,
  });
}

function recordSkipped(
  taskId: string,
  stage: RuntimeProvisioningTaskRecord["stage"],
  progressPercent: number,
): void {
  appendRuntimeProvisioningEventSync({
    taskId,
    stage,
    status: "skipped",
    progressPercent,
    title: `Stage ${stage} skipped (Phase 3)`,
    summary: "Node-side image/CLI install is realised in Phase 3.",
    severity: "info",
  });
}

function failTask(
  taskId: string,
  workspaceId: string,
  stage: RuntimeProvisioningTaskRecord["stage"],
  error: unknown,
): void {
  markRuntimeProvisioningTaskFailedSync({
    id: taskId,
    workspaceId,
    stage,
    errorCode: error instanceof Error ? error.name : "pipeline_error",
    errorMessage: error instanceof Error ? error.message : String(error),
    allowRetry: isRetryableProvisioningError(error),
  });
}

function isRetryableProvisioningError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return ![
    "managed_runtime.balance_preflight_rejected",
    "managed_runtime.no_compatible_models",
    "managed_runtime.model_unavailable",
    "managed_runtime.models_not_configured",
  ].some((code) => message.includes(code));
}

async function compensateProvisioning(
  task: RuntimeProvisioningTaskRecord,
): Promise<{ ok: boolean; detail: Record<string, unknown> }> {
  const detail: Record<string, unknown> = {};
  let ok = true;
  if (task.runtimeCredentialId) {
    try {
      const scope = resolveManagedRuntimeScopeSync(task.workspaceId);
      await safeRevokeCredential({
        credentialId: task.runtimeCredentialId,
        tenantId: scope.tenantId,
        teamId: scope.teamId,
        reason: "provisioning_cancelled",
        idempotencyKey: `revoke:${task.runtimeCredentialId}:provisioning_cancelled:${task.id}`,
        audit: { actorId: task.requestedByUserId, taskId: task.id },
      });
      detail.revokedCredentialId = task.runtimeCredentialId;
    } catch (error) {
      ok = false;
      detail.revokeError = error instanceof Error ? error.message : String(error);
    }
  }
  if (task.runtimeId) {
    const runtime = readAgentRuntimeSync(task.runtimeId);
    if (runtime?.daemonConnectionId) {
      try {
        requestManagedRuntimeCleanupSync({
          runtimeId: runtime.id,
          workspaceId: task.workspaceId,
          daemonConnectionId: runtime.daemonConnectionId,
          runtimeType: runtime.provider,
        });
        detail.cleanupRequested = true;
      } catch (error) {
        ok = false;
        detail.cleanupRequestError = error instanceof Error ? error.message : String(error);
      }
    }
    try {
      deleteAgentRuntimeSync({ runtimeId: task.runtimeId, workspaceId: task.workspaceId });
      detail.removedRuntimeId = task.runtimeId;
    } catch (error) {
      ok = false;
      detail.runtimeCleanupError = error instanceof Error ? error.message : String(error);
    }
  }
  return { ok, detail };
}

async function assertManagedRuntimeModelSelectionAsync(input: {
  client: ModelsClientLike;
  tenantId: string;
  protocols: string[];
  requestedModel?: string;
}): Promise<void> {
  const response = await input.client.models.list({ query: { tenantId: input.tenantId } });
  const available = response.list.filter((item) => {
    const model = item as {
      supportedProtocols?: string[];
      isEnabled?: boolean;
      isDeprecated?: boolean;
    };
    return (
      model.isEnabled !== false &&
      model.isDeprecated !== true &&
      (model.supportedProtocols ?? []).some((protocol) => input.protocols.includes(protocol))
    );
  });
  if (available.length === 0) {
    throw new Error("managed_runtime.no_compatible_models");
  }
  if (!input.requestedModel) return;
  const selected = available.some((item) => {
    const model = item as { alias?: string; id?: string; model?: string };
    return [model.alias, model.id, model.model].includes(input.requestedModel);
  });
  if (!selected) {
    throw new Error("managed_runtime.model_unavailable");
  }
}

async function safeRevokeCredential(input: {
  credentialId: string;
  tenantId: string;
  teamId: string;
  reason: string;
  idempotencyKey: string;
  audit?: { actorId?: string; taskId?: string };
}): Promise<void> {
  const client = clientProvider();
  await client.runtimeCredentials.revoke({
    params: { id: input.credentialId },
    body: {
      tenantId: input.tenantId,
      teamId: input.teamId,
      reason: input.reason,
      idempotencyKey: input.idempotencyKey,
      audit: input.audit,
    },
  });
}

function generateId(): string {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

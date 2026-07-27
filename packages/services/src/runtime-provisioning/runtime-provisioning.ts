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
  createManagedAgentRuntimeSync,
  createRuntimeProvisioningTaskSync,
  deleteAgentRuntimeSync,
  failManagedProvisioningStageSync,
  getDatabase,
  listRuntimeProvisioningTaskEventsSync,
  listRuntimeProvisioningTasksSync,
  markRuntimeProvisioningTaskCancellingSync,
  markRuntimeProvisioningTaskFailedSync,
  markRuntimeProvisioningTaskReadySync,
  readAgentRuntimeSync,
  readRuntimeProvisioningTaskSync,
  readWorkspaceSsoBindingSync,
  recordAuditLogSync,
  requestManagedRuntimeCleanupSync,
  resetRuntimeProvisioningTaskForRetrySync,
  resetStalledManagedProvisioningStagesSync,
  updateAgentRuntimeManagedFieldsSync,
  type AgentRuntimeRecord,
  type RuntimeProvisioningTaskRecord,
  type WorkspaceSsoBindingRecord,
} from "@dofe-agent/db";
import { resolveProviderProtocols, type DaemonProvider } from "@dofe-agent/domain";
import { getModelsInternalClient } from "../models/client.ts";
import { resolveAgentRuntimeMode } from "../config/deployment.ts";
import { isWorkspaceAdminOrOwnerSync } from "../runtime-access/runtime-access.ts";
import { tryRecordWorkspaceAuditEventSync } from "../shared/audit.ts";
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
    requestedModel: input.defaultModel,
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

export interface RuntimeProvisioningTaskDetail {
  task: RuntimeProvisioningTaskRecord;
  events: ReturnType<typeof listRuntimeProvisioningTaskEventsSync>;
  runtime?: AgentRuntimeRecord;
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
  return { task, events, runtime };
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
  if (task.status !== "failed") {
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
): RuntimeProvisioningTaskRecord[] {
  assertRemoteRuntimeMode();
  assertCanManageManagedRuntimes(input);
  return listRuntimeProvisioningTasksSync(input.workspaceId);
}

export function listManagedRuntimesForWorkspaceSync(
  input: ManagedRuntimeActor,
): Array<{ id: string; managedCredentialId: string }> {
  assertRemoteRuntimeMode();
  assertCanManageManagedRuntimes(input);
  const db = getDatabase();
  const rows = db.prepare(
    `SELECT id, managed_credential_id AS managedCredentialId
     FROM agent_runtime
     WHERE workspace_id = ? AND managed_credential_id IS NOT NULL
     ORDER BY created_at DESC`,
  ).all(input.workspaceId) as Array<{ id: string; managedCredentialId: string }>;
  return rows;
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
  if (runtime.provisioningState !== "managed") {
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
    throw new Error("managed_runtime.rotate_no_secret");
  }
  const vault = getRuntimeCredentialVault();
  const oldSecretRef = runtime.credentialSecretRef;
  const newSecret = vault.store(result.credential.id, result.secret.apiKey);
  updateAgentRuntimeManagedFieldsSync({
    runtimeId: runtime.id,
    workspaceId: input.workspaceId,
    managedCredentialId: result.credential.id,
    credentialSecretRef: newSecret.secretRef,
  });
  if (oldSecretRef) {
    vault.forget(oldSecretRef);
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
  if (runtime.managedCredentialId) {
    const scope = resolveManagedRuntimeScopeSync(input.workspaceId);
    await safeRevokeCredential({
      credentialId: runtime.managedCredentialId,
      tenantId: scope.tenantId,
      teamId: scope.teamId,
      reason: input.reason ?? "stopped",
      idempotencyKey: `revoke:${runtime.managedCredentialId}:${input.reason ?? "stopped"}`,
      audit: { actorId: input.actorUserId },
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
  if (runtime.managedCredentialId) {
    const scope = resolveManagedRuntimeScopeSync(input.workspaceId);
    await safeRevokeCredential({
      credentialId: runtime.managedCredentialId,
      tenantId: scope.tenantId,
      teamId: scope.teamId,
      reason: input.reason ?? "deleted",
      idempotencyKey: `revoke:${runtime.managedCredentialId}:${input.reason ?? "deleted"}`,
      audit: { actorId: input.actorUserId },
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
  billing: {
    preflight(args: { body: { teamId: string; estimatedCharge: number } }): Promise<{ allowed: boolean }>;
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

export async function runProvisioningPipeline(
  taskId: string,
  workspaceId: string,
  options: PipelineRunOptions = {},
): Promise<void> {
  assertRemoteRuntimeMode();
  const client = options.modelsClient ?? clientProvider();
  const vault = options.vault ?? getRuntimeCredentialVault();

  const task = readRuntimeProvisioningTaskSync(taskId, workspaceId);
  if (!task || task.status === "succeeded" || task.status === "cancelled") {
    return;
  }

  const scope = resolveManagedRuntimeScopeSync(workspaceId);
  const runtimeId = task.runtimeId ?? `runtime-managed-${generateId()}`;
  const allowedModels = options.allowedModels ?? [];

  // Stage: request_credential (idempotent — skip if already issued)
  if (!task.runtimeCredentialId) {
    try {
      advanceStage(taskId, workspaceId, "request_credential", "running", 10);
      const preflight = await client.billing.preflight({
        body: { teamId: scope.teamId, estimatedCharge: 0 },
      });
      if (!preflight.allowed) {
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
        secretRef = vault.store(result.credential.id, result.secret.apiKey).secretRef;
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
        name: options.name ?? `${MANAGED_RUNTIME_NAME_PREFIX} ${task.runtimeType}`,
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
export async function resumePendingProvisioningTasksSync(workspaceId?: string): Promise<void> {
  assertRemoteRuntimeMode();
  resetStalledManagedProvisioningStagesSync();
  const tasks = listRuntimeProvisioningTasksSync(workspaceId, {
    statuses: ["queued", "running"],
  });
  for (const task of tasks) {
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
  });
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

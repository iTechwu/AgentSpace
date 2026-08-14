// 7 阶段供给状态机：preflight/计费预检、阶段推进、补偿、finalize 与任务续跑。
import {
  advanceRuntimeProvisioningTaskStageSync,
  createManagedAgentRuntimeSync,
  createRuntimeProvisioningTaskSync,
  deleteAgentRuntimeSync,
  listRetryingRuntimeProvisioningTasksReadySync,
  listRunningProvisioningTasksTimedOutSync,
  listRuntimeProvisioningTasksAcrossWorkspacesSync,
  listRuntimeProvisioningTasksSync,
  markRuntimeCredentialReconciliationTargetDrainingSync,
  markRuntimeProvisioningTaskFailedSync,
  markRuntimeProvisioningTaskReadySync,
  markStaleDaemonsOfflineSync,
  readAgentRuntimeSync,
  readRuntimeProvisioningTaskSync,
  recordAuditLogSync,
  requestManagedRuntimeCleanupSync,
  resetRuntimeProvisioningTaskForRetrySync,
  timeoutRunningNodeStagesSync,
  updateAgentRuntimeManagedFieldsSync,
  upsertActiveRuntimeCredentialReconciliationTargetSync,
} from "@dofe-agent/db";
import type {
  RuntimeProvisioningTaskRecord,
} from "@dofe-agent/db";
import {
  resolveProviderProtocols,
} from "@dofe-agent/domain";
import type {
  DaemonProvider,
} from "@dofe-agent/domain";
import {
  isExecutionLanguageModel,
} from "../models/execution-models.ts";
import {
  tryRecordWorkspaceAuditEventSync,
} from "../shared/audit.ts";
import {
  notifyWorkspaceAdminsSync,
} from "../notifications/notifications.ts";
import {
  getRuntimeCredentialVault,
} from "./credential-vault.ts";
import type {
  RuntimeCredentialVault,
} from "./credential-vault.ts";
import {
  resolveManagedRuntimeGatewayBaseUrl,
} from "./provider-templates.ts";
import {
  assertOpenMontageRuntimePurgeableAsync,
} from "../openmontage/purge-guard.ts";
import {
  DEFAULT_CREDENTIAL_RECONCILIATION_RETENTION_MS,
  DEFAULT_TASK_TIMEOUT_MS,
  MANAGED_RUNTIME_NAME_PREFIX,
  assertCanManageManagedRuntimes,
  assertRemoteRuntimeMode,
  findReusableManagedRuntime,
  resolveManagedRuntimeAllowedModels,
  resolveManagedRuntimeDefaultModel,
  resolveManagedRuntimeScopeSync,
} from "./runtime-provisioning-capacity.ts";
import type {
  EnsureManagedRuntimeCapacityInput,
  ManagedRuntimeActor,
  ManagedRuntimeCapacityResult,
  RequestManagedRuntimeInput,
} from "./runtime-provisioning-capacity.ts";
import type {
  ModelsClientLike,
} from "./runtime-provisioning-models-client.ts";
import { clientProvider } from "./runtime-provisioning-models-client.ts";

export interface PipelineRunOptions {
  name?: string;
  allowedModels?: string[];
  /** When false, the created runtime refuses new employee binds (default true). */
  allowNewEmployeeSharing?: boolean;
  /** Test seam: inject a models client. Defaults to the env-configured client. */
  modelsClient?: ModelsClientLike;
  /** Test seam: inject a vault. Defaults to the process vault. */
  vault?: RuntimeCredentialVault;
}

/** Indirection so tests can swap the client without touching env. */

export interface ManagedRuntimeCreationPreflightResult {
  allowed: boolean;
  reusableRuntime?: { id: string; name: string };
  availableBalance?: string;
  estimatedCharge?: string;
  currency?: string;
  code?: string;
  message?: string;
}

const DEFAULT_MANAGED_RUNTIME_PREFLIGHT_CHARGE = 0.01;

function resolveManagedRuntimePreflightCharge(requestedCharge?: number): number {
  if (typeof requestedCharge === "number" && Number.isFinite(requestedCharge) && requestedCharge > 0) {
    return requestedCharge;
  }
  const configured = Number.parseFloat(process.env.MANAGED_RUNTIME_PREFLIGHT_CHARGE_USD ?? "");
  return Number.isFinite(configured) && configured > 0
    ? configured
    : DEFAULT_MANAGED_RUNTIME_PREFLIGHT_CHARGE;
}

function buildManagedRuntimeBillingPreflightBody(
  scope: { tenantId: string; teamId: string },
  requestId: string,
  estimatedCharge: number,
) {
  return {
    scope: {
      tenantId: scope.tenantId,
      ssoTeamId: scope.teamId,
      teamId: null,
      requestId,
      source: "admin" as const,
    },
    estimatedCharge,
    reserve: false as const,
  };
}

export async function preflightManagedRuntimeCreationAsync(
  input: ManagedRuntimeActor & {
    provider: DaemonProvider;
    defaultModel?: string;
    estimatedCharge?: number;
    forceProvisioning?: boolean;
  },
): Promise<ManagedRuntimeCreationPreflightResult> {
  assertRemoteRuntimeMode();
  assertCanManageManagedRuntimes(input);
  const defaultModel = resolveManagedRuntimeDefaultModel(input.provider, input.defaultModel);
  if (!input.forceProvisioning) {
    const reusable = findReusableManagedRuntime({ ...input, defaultModel });
    if (reusable) {
      return {
        allowed: true,
        reusableRuntime: { id: reusable.id, name: reusable.name },
      };
    }
  }
  resolveManagedRuntimeGatewayBaseUrl();
  const scope = resolveManagedRuntimeScopeSync(input.workspaceId);
  try {
    await assertManagedRuntimeModelSelectionAsync({
      client: clientProvider(),
      tenantId: scope.tenantId,
      protocols: resolveProviderProtocols(input.provider),
      requestedModel: defaultModel,
    });
  } catch (error) {
    return {
      allowed: false,
      code: error instanceof Error ? error.message : "managed_runtime.model_catalog_unavailable",
      message: formatManagedRuntimePreflightError(error),
    };
  }
  const result = await clientProvider().billing.preflightByScope({
    body: buildManagedRuntimeBillingPreflightBody(
      scope,
      `managed-runtime-preflight:${input.workspaceId}:${input.provider}`,
      resolveManagedRuntimePreflightCharge(input.estimatedCharge),
    ),
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
  resolveManagedRuntimeGatewayBaseUrl();
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
  const allowedModels = resolveManagedRuntimeAllowedModels(
    task.runtimeType,
    task.allowedModels.length > 0 ? task.allowedModels : options.allowedModels,
  );

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
      const preflight = await client.billing.preflightByScope({
        body: buildManagedRuntimeBillingPreflightBody(
          scope,
          task.id,
          resolveManagedRuntimePreflightCharge(),
        ),
      });
      if (!preflight.allowed) {
        const today = new Date().toISOString().slice(0, 10);
        notifyWorkspaceAdminsSync({
          workspaceId,
          title: "Insufficient balance for managed runtime",
          body: `Provisioning ${task.runtimeType} runtime "${runtimeId}" was rejected because the tenant balance is insufficient. Add credits or lower usage before retrying.`,
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
        allowNewEmployeeSharing: options.allowNewEmployeeSharing,
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
  // for daemon stage reports. resumePendingProvisioningTasksAsync re-enters here
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
  if (task?.runtimeCredentialId) {
    upsertActiveRuntimeCredentialReconciliationTargetSync({
      workspaceId: input.workspaceId,
      runtimeId: input.runtimeId,
      runtimeCredentialId: task.runtimeCredentialId,
    });
  }
  tryRecordWorkspaceAuditEventSync({
    workspaceId: input.workspaceId,
    title: "Managed runtime ready",
    note: `Runtime ${input.runtimeId} is provisioned`,
    code: "runtime.created",
    data: { runtimeId: input.runtimeId, runtimeCredentialId: task?.runtimeCredentialId ?? "" },
  });
  return task;
}

export function resolveCredentialReconciliationRetireAfter(
  environment: NodeJS.ProcessEnv = process.env,
  now = new Date(),
): string {
  const configuredDays = Number.parseInt(
    environment.MANAGED_RUNTIME_CREDENTIAL_RECONCILIATION_RETENTION_DAYS ?? "",
    10,
  );
  const retentionMs = Number.isFinite(configuredDays) && configuredDays > 0
    ? configuredDays * 24 * 60 * 60 * 1_000
    : DEFAULT_CREDENTIAL_RECONCILIATION_RETENTION_MS;
  return new Date(now.getTime() + retentionMs).toISOString();
}

/**
 * Re-drive tasks left running by a process restart or an offline node. Safe to
 * call periodically; finished/cancelled tasks are skipped.
 */

export async function resumePendingProvisioningTasksAsync(workspaceId?: string): Promise<{
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

  const tasks = workspaceId
    ? listRuntimeProvisioningTasksSync(workspaceId, {
        statuses: ["queued", "running", "retrying"],
      })
    : listRuntimeProvisioningTasksAcrossWorkspacesSync({
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

export async function compensateProvisioning(
  task: RuntimeProvisioningTaskRecord,
): Promise<{ ok: boolean; pending: boolean; detail: Record<string, unknown> }> {
  const detail: Record<string, unknown> = {};
  let ok = true;
  let pending = false;
  if (task.runtimeId) {
    try {
      await assertOpenMontageRuntimePurgeableAsync({
        workspaceId: task.workspaceId,
        runtimeId: task.runtimeId,
      });
    } catch (error) {
      detail.runtimePurgeGuardError = error instanceof Error ? error.message : String(error);
      return { ok: false, pending: false, detail };
    }
  }
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
      if (task.runtimeId) {
        markRuntimeCredentialReconciliationTargetDrainingSync({
          workspaceId: task.workspaceId,
          runtimeId: task.runtimeId,
          runtimeCredentialId: task.runtimeCredentialId,
          retireAfter: resolveCredentialReconciliationRetireAfter(),
        });
      }
      detail.revokedCredentialId = task.runtimeCredentialId;
    } catch (error) {
      if (isModelsCredentialNotFoundError(error)) {
        detail.credentialAlreadyRevoked = task.runtimeCredentialId;
      } else {
        ok = false;
        detail.revokeError = error instanceof Error ? error.message : String(error);
      }
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
          provisioningTaskId: task.id,
          deleteRuntimeOnSuccess: true,
        });
        detail.cleanupRequested = true;
        pending = true;
      } catch (error) {
        ok = false;
        detail.cleanupRequestError = error instanceof Error ? error.message : String(error);
      }
    }
    if (!pending) {
      try {
        deleteAgentRuntimeSync({ runtimeId: task.runtimeId, workspaceId: task.workspaceId });
        detail.removedRuntimeId = task.runtimeId;
      } catch (error) {
        ok = false;
        detail.runtimeCleanupError = error instanceof Error ? error.message : String(error);
      }
    }
  }
  return { ok, pending: pending && ok, detail };
}

function isModelsCredentialNotFoundError(error: unknown): boolean {
  if (typeof error === "object" && error !== null) {
    const status = (error as { status?: unknown }).status;
    if (status === 404) return true;
  }
  return error instanceof Error && /\bnot found\b/i.test(error.message);
}

export async function assertManagedRuntimeModelSelectionAsync(input: {
  client: ModelsClientLike;
  tenantId: string;
  protocols: string[];
  requestedModel?: string;
}): Promise<void> {
  const response = await input.client.models.list({ query: { tenantId: input.tenantId } });
  const available = response.list.filter((item) => {
    const model = item as {
      modelType?: string;
      supportedProtocols?: string[];
      isEnabled?: boolean;
      isDeprecated?: boolean;
    };
    const compatibleProtocols = (model.supportedProtocols ?? []).filter((protocol) =>
      input.protocols.includes(protocol),
    );
    return (
      isExecutionLanguageModel(model) &&
      model.isEnabled !== false &&
      model.isDeprecated !== true &&
      compatibleProtocols.length > 0
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

export async function safeRevokeCredential(input: {
  credentialId: string;
  tenantId: string;
  teamId: string;
  reason: string;
  idempotencyKey: string;
  audit?: { actorId?: string; taskId?: string };
}): Promise<void> {
  const client = clientProvider();
  try {
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
  } catch (error) {
    if (!isModelsCredentialNotFoundError(error)) {
      throw error;
    }
  }
}

function generateId(): string {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

export function ensureManagedRuntimeCapacitySync(
  input: EnsureManagedRuntimeCapacityInput,
): ManagedRuntimeCapacityResult {
  assertRemoteRuntimeMode();
  assertCanManageManagedRuntimes(input);

  if (!input.forceProvisioning) {
    const runtime = findReusableManagedRuntime(input);
    if (runtime) {
      tryRecordWorkspaceAuditEventSync({
        workspaceId: input.workspaceId,
        title: "Managed runtime capacity reused",
        note: `Reused ${runtime.provider} runtime ${runtime.id}`,
        code: "runtime.capacity_reused",
        data: { runtimeId: runtime.id, runtimeType: runtime.provider, actorId: input.actorUserId },
      });
      return { kind: "reused", runtimeId: runtime.id, runtimeName: runtime.name };
    }
  }

  return {
    kind: "provisioning",
    task: requestManagedRuntimeProvisioningSync(input),
  };
}

export function requestManagedRuntimeProvisioningSync(
  input: RequestManagedRuntimeInput,
): RuntimeProvisioningTaskRecord {
  assertRemoteRuntimeMode();
  resolveManagedRuntimeGatewayBaseUrl();
  assertCanManageManagedRuntimes(input);
  resolveManagedRuntimeScopeSync(input.workspaceId);
  const protocols = input.protocols?.length
    ? input.protocols
    : resolveProviderProtocols(input.provider);
  const defaultModel = resolveManagedRuntimeDefaultModel(input.provider, input.defaultModel);
  const allowedModels = resolveManagedRuntimeAllowedModels(input.provider, input.allowedModels);

  const task = createRuntimeProvisioningTaskSync({
    workspaceId: input.workspaceId,
    requestedByUserId: input.actorUserId,
    idempotencyKey: input.idempotencyKey,
    runtimeType: input.provider,
    protocols,
    requestedName: input.name,
    requestedModel: defaultModel,
    allowedModels,
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
    allowedModels,
    allowNewEmployeeSharing: input.allowNewEmployeeSharing,
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

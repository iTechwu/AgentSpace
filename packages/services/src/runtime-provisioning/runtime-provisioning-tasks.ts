// 供给任务与运行时列表查询、重试/取消与公开记录映射。
import {
  completeRuntimeProvisioningCancellationSync,
  getMonthStartIso,
  listEmployeeRuntimeBindingsSync,
  listManagedAgentRuntimesSync,
  listRuntimeCostSummariesSync,
  listRuntimeProvisioningTaskEventsSync,
  listRuntimeProvisioningTasksSync,
  listWorkspaceRuntimeDisplayNamesSync,
  listTokenUsageSync,
  markRuntimeProvisioningTaskCancellingSync,
  markRuntimeProvisioningTaskFailedSync,
  readAgentRuntimeSync,
  readRuntimeProvisioningTaskSync,
  resetRuntimeProvisioningTaskForRetrySync,
} from "@dofe-agent/db";
import type {
  AgentRuntimeRecord,
  RuntimeProvisioningTaskRecord,
} from "@dofe-agent/db";
import type {
  DaemonProvider,
  RuntimeProviderHealth,
} from "@dofe-agent/domain";
import {
  tryRecordWorkspaceAuditEventSync,
} from "../shared/audit.ts";
import {
  assertCanManageManagedRuntimes,
  assertRemoteRuntimeMode,
} from "./runtime-provisioning-capacity.ts";
import { normalizeRuntimeProviderHealth } from "../runtime-health/runtime-health.ts";
import type {
  ManagedRuntimeActor,
} from "./runtime-provisioning-capacity.ts";
import {
  compensateProvisioning,
  runProvisioningPipeline,
} from "./runtime-provisioning-pipeline.ts";

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
  providerHealth?: PublicRuntimeProviderHealth;
}

export type PublicRuntimeProviderHealth = Pick<
  RuntimeProviderHealth,
  | "runtimeStatus"
  | "providerHealth"
  | "providerUsable"
  | "providerHealthReason"
  | "lastHealthCheckedAt"
  | "lastProviderErrorCode"
>;

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

export async function cancelRuntimeProvisioningTaskAsync(
  input: ManagedRuntimeActor & { taskId: string; reason?: string },
): Promise<RuntimeProvisioningTaskRecord> {
  assertRemoteRuntimeMode();
  assertCanManageManagedRuntimes(input);
  const task = readRuntimeProvisioningTaskSync(input.taskId, input.workspaceId);
  if (!task) {
    throw new Error("managed_runtime.task_not_found");
  }
  if (task.status === "cancelling" || task.status === "cancelled") {
    return task;
  }
  const cancelling = markRuntimeProvisioningTaskCancellingSync({
    id: task.id,
    workspaceId: input.workspaceId,
  });
  if (!cancelling) {
    return task;
  }

  // A node-owned runtime remains in cancelling until its durable cleanup request
  // reaches a terminal state. This prevents runtime deletion from erasing work.
  const cleanup = await compensateProvisioning(task);
  if (cleanup.pending) {
    return readRuntimeProvisioningTaskSync(task.id, input.workspaceId) ?? cancelling;
  }
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
  const providerHealth = normalizeRuntimeProviderHealth({
    runtimeStatus: runtime.status,
    runtimeMetadata: parseRuntimeMetadata(runtime.metadataJson),
    lastError: runtime.lastError,
  });
  return {
    id: runtime.id,
    status: runtime.status,
    provisioningState: runtime.provisioningState,
    protocols: runtime.protocols ?? [],
    defaultModel: runtime.defaultModel,
    credentialConfigured: Boolean(runtime.credentialSecretRef || runtime.credentialConfigRef),
    providerHealth: toPublicRuntimeProviderHealth(providerHealth),
  };
}

function toPublicRuntimeProviderHealth(health: RuntimeProviderHealth): PublicRuntimeProviderHealth {
  return {
    runtimeStatus: health.runtimeStatus,
    providerHealth: health.providerHealth,
    providerUsable: health.providerUsable,
    providerHealthReason: health.providerHealthReason,
    lastHealthCheckedAt: health.lastHealthCheckedAt,
    lastProviderErrorCode: health.lastProviderErrorCode,
  };
}

export function listManagedRuntimesForWorkspaceSync(
  input: ManagedRuntimeActor,
): ManagedRuntimeListItem[] {
  assertRemoteRuntimeMode();
  assertCanManageManagedRuntimes(input);
  const rows = listManagedAgentRuntimesSync(input.workspaceId);
  const displayNames = new Map(
    listWorkspaceRuntimeDisplayNamesSync(input.workspaceId).map((record) => [record.runtimeId, record.displayName]),
  );
  const bindingCountByRuntime = new Map<string, number>();
  for (const binding of listEmployeeRuntimeBindingsSync(input.workspaceId)) {
    bindingCountByRuntime.set(binding.runtimeId, (bindingCountByRuntime.get(binding.runtimeId) ?? 0) + 1);
  }
  const runtimeCosts = new Map(
    listRuntimeCostSummariesSync(getMonthStartIso(), input.workspaceId)
      .map((summary) => [summary.runtimeId, summary]),
  );
  const credentialUsage = new Map<string, {
    pendingCount: number;
    unallocatedCount: number;
    unallocatedInputTokens: number;
    unallocatedOutputTokens: number;
    unallocatedEstimatedCostUsd: number;
    unallocatedActualCostUsd: number;
    unpricedCount: number;
    currencies: Set<string>;
  }>();
  for (const usage of listTokenUsageSync({ workspaceId: input.workspaceId, since: getMonthStartIso() })) {
    if (!usage.runtimeCredentialId) continue;
    const summary = credentialUsage.get(usage.runtimeCredentialId) ?? {
      pendingCount: 0,
      unallocatedCount: 0,
      unallocatedInputTokens: 0,
      unallocatedOutputTokens: 0,
      unallocatedEstimatedCostUsd: 0,
      unallocatedActualCostUsd: 0,
      unpricedCount: 0,
      currencies: new Set<string>(),
    };
    if (usage.currency?.trim()) summary.currencies.add(usage.currency.trim().toUpperCase());
    if (usage.billingStatus === "pending_reconciliation") summary.pendingCount += 1;
    if (usage.costUsd === 0 && usage.inputTokens + usage.outputTokens > 0) summary.unpricedCount += 1;
    if (usage.billingStatus === "unallocated") {
      summary.unallocatedCount += 1;
      summary.unallocatedInputTokens += usage.inputTokens;
      summary.unallocatedOutputTokens += usage.outputTokens;
      summary.unallocatedEstimatedCostUsd += usage.costUsd;
      summary.unallocatedActualCostUsd += usage.actualCostUsd ?? 0;
    }
    credentialUsage.set(usage.runtimeCredentialId, summary);
  }
  return rows
    .map((row) => {
      const attributed = runtimeCosts.get(row.id);
      const exceptional = credentialUsage.get(row.managedCredentialId!);
      const attributedInputTokens = attributed?.totalInputTokens ?? 0;
      const attributedOutputTokens = attributed?.totalOutputTokens ?? 0;
      const periodEstimatedCostUsd = (attributed?.totalCostUsd ?? 0) + (exceptional?.unallocatedEstimatedCostUsd ?? 0);
      return {
      id: row.id,
      name: row.name,
      displayName: displayNames.get(row.id),
      provider: row.provider,
      managedCredentialId: row.managedCredentialId!,
      status: row.status === "online" ? "online" : "offline",
      providerHealth: toPublicRuntimeProviderHealth(normalizeRuntimeProviderHealth({
        runtimeStatus: row.status,
        runtimeMetadata: parseRuntimeMetadata(row.metadataJson),
        lastError: row.lastError,
      })),
      provisioningState: normalizeManagedRuntimeLifecycleState(row.provisioningState),
      protocols: row.protocols ?? [],
      defaultModel: row.defaultModel,
      allowNewEmployeeSharing: row.allowNewEmployeeSharing,
      assignedEmployeeCount: bindingCountByRuntime.get(row.id) ?? 0,
      lastHeartbeatAt: row.lastHeartbeatAt,
      periodTaskCount: attributed?.taskCount ?? 0,
      periodInputTokens: attributedInputTokens + (exceptional?.unallocatedInputTokens ?? 0),
      periodOutputTokens: attributedOutputTokens + (exceptional?.unallocatedOutputTokens ?? 0),
      periodEstimatedCostUsd,
      periodCurrency: exceptional?.currencies.size === 1 ? [...exceptional.currencies][0] : undefined,
      periodActualCostUsd: (attributed?.totalActualCostUsd ?? 0) + (exceptional?.unallocatedActualCostUsd ?? 0),
      pendingUsageCount: exceptional?.pendingCount ?? 0,
      unallocatedUsageCount: exceptional?.unallocatedCount ?? 0,
      unpricedUsageCount: exceptional?.unpricedCount
        ?? (periodEstimatedCostUsd === 0 && attributedInputTokens + attributedOutputTokens > 0 ? 1 : 0),
      unallocatedCostUsd: exceptional?.unallocatedActualCostUsd ?? 0,
    };
    });
}

export interface ManagedRuntimeListItem {
  id: string;
  name: string;
  displayName?: string;
  provider: DaemonProvider;
  managedCredentialId: string;
  status: "online" | "offline";
  providerHealth?: PublicRuntimeProviderHealth;
  provisioningState: "managed" | "draining" | "credential_recovering" | "needs_attention" | "legacy";
  protocols: string[];
  defaultModel?: string;
  /** Whether additional AI employees may bind to this runtime. */
  allowNewEmployeeSharing?: boolean;
  assignedEmployeeCount: number;
  lastHeartbeatAt?: string;
  periodTaskCount?: number;
  periodInputTokens?: number;
  periodOutputTokens?: number;
  periodEstimatedCostUsd?: number;
  periodCurrency?: string;
  periodActualCostUsd: number;
  pendingUsageCount?: number;
  unallocatedUsageCount?: number;
  unpricedUsageCount?: number;
  unallocatedCostUsd: number;
}

function parseRuntimeMetadata(value: string): Record<string, unknown> {
  try {
    const parsed: unknown = JSON.parse(value);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : {};
  } catch {
    return {};
  }
}

function normalizeManagedRuntimeLifecycleState(value: string | null | undefined): ManagedRuntimeListItem["provisioningState"] {
  if (value === "draining" || value === "credential_recovering" || value === "needs_attention" || value === "legacy") return value;
  return "managed";
}

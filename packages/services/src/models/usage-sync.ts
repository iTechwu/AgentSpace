import {
  findTokenUsageByGatewayRequestIdSync,
  findTokenUsageByGatewayUsageIdSync,
  insertUnallocatedTokenUsageIfAbsentSync,
  listAllManagedAgentRuntimesSync,
  listRuntimeCredentialReconciliationTargetsSync,
  markTokenUsageReconciledSync,
  completeRuntimeCredentialReconciliationTargetSync,
  readOldestPendingTokenUsageTimestampForRuntimeCredentialSync,
  readRuntimeCredentialReconciliationTargetSync,
  readTokenUsageReconciliationCursorSync,
  recordAuditLogSync,
  recordRuntimeCredentialReconciliationFailureSync,
  recordRuntimeCredentialReconciliationSuccessSync,
  upsertActiveRuntimeCredentialReconciliationTargetSync,
  upsertTokenUsageReconciliationCursorSync,
} from "@dofe-agent/db";
import { readAgentRuntimeSync } from "@dofe-agent/db";
import { resolveAgentRuntimeMode } from "../config/deployment.ts";
import { getModelsInternalClient } from "./client.ts";
import {
  normalizeModelsUsageLogEntry,
  type NormalizedModelsUsageLogEntry,
} from "./models-usage-contract.ts";
import { resolveManagedRuntimeScopeSync } from "../runtime-provisioning/runtime-provisioning.ts";
import { notifyWorkspaceAdminsSync } from "../notifications/notifications.ts";

export interface SyncRuntimeCredentialUsageInput {
  workspaceId: string;
  runtimeId: string;
  runtimeCredentialId?: string;
  since?: string;
  until?: string;
  pageLimit?: number;
}

export interface SyncRuntimeCredentialUsageResult {
  reconciledCount: number;
  unallocatedCount: number;
  pendingCount?: number;
  skippedCount: number;
  totalRemoteCount: number;
  lastRemoteTimestamp?: string;
}

type ReconciliationUsageLogEntry = NormalizedModelsUsageLogEntry;

export interface ReconcileAllManagedRuntimeUsageResult {
  runtimeCount: number;
  failedRuntimeCount: number;
  reconciledCount: number;
  pendingCount: number;
  unallocatedCount: number;
  credentialTargetCount: number;
}

export async function reconcileAllManagedRuntimeUsageAsync(): Promise<ReconcileAllManagedRuntimeUsageResult> {
  const totals: ReconcileAllManagedRuntimeUsageResult = {
    runtimeCount: 0,
    failedRuntimeCount: 0,
    reconciledCount: 0,
    pendingCount: 0,
    unallocatedCount: 0,
    credentialTargetCount: 0,
  };
  if (resolveAgentRuntimeMode() !== "remote") return totals;

  const runtimes = listAllManagedAgentRuntimesSync();
  for (const runtime of runtimes) {
    if (!runtime.managedCredentialId) continue;
    upsertActiveRuntimeCredentialReconciliationTargetSync({
      workspaceId: runtime.workspaceId,
      runtimeId: runtime.id,
      runtimeCredentialId: runtime.managedCredentialId,
    });
  }
  totals.runtimeCount = new Set(runtimes.map((runtime) => `${runtime.workspaceId}:${runtime.id}`)).size;

  const targets = listRuntimeCredentialReconciliationTargetsSync();
  totals.credentialTargetCount = targets.length;
  for (const target of targets) {
    const cursor = readTokenUsageReconciliationCursorSync(target.workspaceId, target.runtimeCredentialId);
    const cursorOverlap = cursor
      ? new Date(new Date(cursor).getTime() - 24 * 60 * 60 * 1_000).toISOString()
      : undefined;
    const oldestPending = readOldestPendingTokenUsageTimestampForRuntimeCredentialSync(
      target.workspaceId,
      target.runtimeCredentialId,
    );
    const since = cursorOverlap && oldestPending
      ? (cursorOverlap < oldestPending ? cursorOverlap : oldestPending)
      : cursorOverlap ?? oldestPending;
    try {
      const result = await syncRuntimeCredentialUsageAsync({
        workspaceId: target.workspaceId,
        runtimeId: target.runtimeId,
        runtimeCredentialId: target.runtimeCredentialId,
        since,
      });
      totals.reconciledCount += result.reconciledCount;
      totals.pendingCount += result.pendingCount ?? 0;
      totals.unallocatedCount += result.unallocatedCount;
      if (result.lastRemoteTimestamp) {
        upsertTokenUsageReconciliationCursorSync(
          target.workspaceId,
          target.runtimeCredentialId,
          result.lastRemoteTimestamp,
        );
      } else {
        recordRuntimeCredentialReconciliationSuccessSync({
          workspaceId: target.workspaceId,
          runtimeCredentialId: target.runtimeCredentialId,
        });
      }
      if (
        target.state === "draining"
        && target.retireAfter
        && target.retireAfter <= new Date().toISOString()
        && !readOldestPendingTokenUsageTimestampForRuntimeCredentialSync(
          target.workspaceId,
          target.runtimeCredentialId,
        )
      ) {
        completeRuntimeCredentialReconciliationTargetSync(
          target.workspaceId,
          target.runtimeCredentialId,
        );
      }
    } catch (error) {
      totals.failedRuntimeCount += 1;
      recordRuntimeCredentialReconciliationFailureSync({
        workspaceId: target.workspaceId,
        runtimeCredentialId: target.runtimeCredentialId,
        error,
      });
      const today = new Date().toISOString().slice(0, 10);
      notifyWorkspaceAdminsSync({
        workspaceId: target.workspaceId,
        title: "Usage reconciliation failed",
        body: `Usage reconciliation failed for runtime credential ${target.runtimeCredentialId}. The maintenance worker will retry automatically.`,
        type: "usage.reconciliation_failed",
        severity: "warning",
        resourceType: "workspace",
        resourceId: target.runtimeId,
        actionHref: "/costs",
        dedupeKey: `usage.reconciliation_failed:${target.workspaceId}:${target.runtimeCredentialId}:${today}`,
        metadata: {
          runtimeId: target.runtimeId,
          runtimeCredentialId: target.runtimeCredentialId,
          error: error instanceof Error ? error.message : String(error),
        },
      });
    }
  }
  return totals;
}

/**
 * Pull usage logs from models.dofe.ai for a single RuntimeCredential and
 * reconcile them against local `token_usage` rows.
 *
 * - Match the stable remote usage ID first, then fall back to the gateway request ID.
 * - Keep provisional or unknown remote billing states pending until a known terminal state arrives.
 * - Insert unmatched terminal charges as `unallocated` so the team can investigate them.
 * - Skip rows only when their current remote facts already match (idempotent).
 */
export async function syncRuntimeCredentialUsageAsync(
  input: SyncRuntimeCredentialUsageInput,
): Promise<SyncRuntimeCredentialUsageResult> {
  if (resolveAgentRuntimeMode() !== "remote") {
    throw new Error("usage_sync.remote_mode_required");
  }

  const runtime = readAgentRuntimeSync(input.runtimeId);
  if (runtime && runtime.workspaceId !== input.workspaceId) {
    throw new Error("usage_sync.runtime_not_found");
  }
  const requestedTarget = input.runtimeCredentialId
    ? readRuntimeCredentialReconciliationTargetSync(input.workspaceId, input.runtimeCredentialId)
    : null;
  const runtimeCredentialId = input.runtimeCredentialId ?? runtime?.managedCredentialId;
  if (!runtimeCredentialId) {
    throw new Error("usage_sync.not_a_managed_runtime");
  }
  if (
    input.runtimeCredentialId
    && input.runtimeCredentialId !== runtime?.managedCredentialId
    && requestedTarget?.runtimeId !== input.runtimeId
  ) {
    throw new Error("usage_sync.credential_target_not_found");
  }
  if (!runtime && requestedTarget?.runtimeId !== input.runtimeId) {
    throw new Error("usage_sync.runtime_not_found");
  }

  const scope = resolveManagedRuntimeScopeSync(input.workspaceId);
  const client = getModelsInternalClient();

  recordAuditLogSync({
    workspaceId: input.workspaceId,
    title: "Usage reconciliation started",
    note: `Starting reconciliation for runtime credential ${runtimeCredentialId}.`,
    code: "usage.reconciliation_started",
    source: "runtime_lifecycle",
    data: {
      actorType: "system",
      resourceType: "runtime",
      resourceId: input.runtimeId,
      runtimeCredentialId,
      since: input.since,
      until: input.until,
    },
  });

  const result: SyncRuntimeCredentialUsageResult = {
    reconciledCount: 0,
    unallocatedCount: 0,
    pendingCount: 0,
    skippedCount: 0,
    totalRemoteCount: 0,
  };

  let page = 1;
  const limit = Math.min(Math.max(input.pageLimit ?? 100, 1), 500);
  let hasMore = true;

  while (hasMore) {
    const response = await client.usage.tenantLogs({
      params: { tenantId: scope.tenantId },
      query: {
        runtimeCredentialId,
        startDate: input.since,
        endDate: input.until,
        page,
        limit,
      },
    });

    const entries = (response.list ?? []).map(normalizeModelsUsageLogEntry);
    hasMore = entries.length === limit;
    page += 1;

    for (const entry of entries) {
      result.totalRemoteCount += 1;
      if (entry.requestId) {
        if (!result.lastRemoteTimestamp || entry.timestamp > result.lastRemoteTimestamp) {
          result.lastRemoteTimestamp = entry.timestamp;
        }
      }
      reconcileRuntimeCredentialUsageEntrySync(input.workspaceId, runtimeCredentialId, entry, result);
    }
  }

  recordAuditLogSync({
    workspaceId: input.workspaceId,
    title: "Usage reconciliation completed",
    note: `Reconciled ${result.reconciledCount}, unallocated ${result.unallocatedCount}, skipped ${result.skippedCount} of ${result.totalRemoteCount} remote log entries.`,
    code: "usage.reconciliation_completed",
    source: "runtime_lifecycle",
    data: {
      actorType: "system",
      resourceType: "runtime",
      resourceId: input.runtimeId,
      runtimeCredentialId,
      ...result,
    },
  });

  if (result.unallocatedCount > 0) {
    const today = new Date().toISOString().slice(0, 10);
    notifyWorkspaceAdminsSync({
      workspaceId: input.workspaceId,
      title: "Usage reconciliation discrepancy detected",
      body: `Reconciliation found ${result.unallocatedCount} unallocated charge(s) for runtime "${runtime?.name ?? input.runtimeId}". Review the cost overview to investigate missing attribution.`,
      type: "usage.reconciliation_discrepancy",
      severity: "warning",
      resourceType: "workspace",
      resourceId: input.runtimeId,
      actionHref: "/costs",
      dedupeKey: `usage.reconciliation_discrepancy:${input.workspaceId}:${input.runtimeId}:${today}`,
      metadata: {
        unallocatedCount: result.unallocatedCount,
        runtimeId: input.runtimeId,
        runtimeCredentialId,
      },
    });
  }

  return result;
}

export function reconcileRuntimeCredentialUsageEntrySync(
  workspaceId: string,
  runtimeCredentialId: string,
  entry: ReconciliationUsageLogEntry,
  result: SyncRuntimeCredentialUsageResult,
): void {
  const gatewayRequestId = entry.requestId;
  if (!gatewayRequestId) {
    result.skippedCount += 1;
    return;
  }

  const existing = (entry.id ? findTokenUsageByGatewayUsageIdSync(entry.id, workspaceId) : null)
    ?? findTokenUsageByGatewayRequestIdSync(gatewayRequestId, workspaceId);
  if (existing) {
    if (
      existing.runtimeCredentialId
      && existing.runtimeCredentialId !== runtimeCredentialId
    ) {
      throw new Error("usage_sync.gateway_request_runtime_credential_mismatch");
    }
    const remoteStatus = resolveRemoteBillingStatus(entry.billingStatus, Boolean(existing.taskQueueId));
    if (
      existing.billingStatus === remoteStatus
      && existing.actualCostUsd === parseCost(entry.totalCost)
      && existing.modelId === (entry.model.trim() || existing.modelId)
      && existing.inputTokens === normalizeRemoteTokenCount(entry.inputTokens, existing.inputTokens)
      && existing.outputTokens === normalizeRemoteTokenCount(entry.outputTokens, existing.outputTokens)
    ) {
      result.skippedCount += 1;
      return;
    }
    markTokenUsageReconciledSync(existing.id, {
      actualCostUsd: parseCost(entry.totalCost),
      currency: entry.currency,
      gatewayRequestId,
      gatewayUsageId: entry.id,
      protocol: entry.protocol,
      modelId: entry.model.trim() || existing.modelId,
      inputTokens: normalizeRemoteTokenCount(entry.inputTokens, existing.inputTokens),
      outputTokens: normalizeRemoteTokenCount(entry.outputTokens, existing.outputTokens),
      cacheTokens: normalizeRemoteTokenCount(entry.cacheTokens, existing.cacheTokens),
      requestStartedAt: entry.startedAt ?? entry.timestamp,
      requestEndedAt: entry.endedAt ?? entry.timestamp,
      sourceUpdatedAt: entry.updatedAt ?? entry.timestamp,
      billingStatus: remoteStatus,
    });
    if (remoteStatus === "pending_reconciliation") result.pendingCount = (result.pendingCount ?? 0) + 1;
    else result.reconciledCount += 1;
    return;
  }

  const remoteStatus = resolveRemoteBillingStatus(entry.billingStatus, false) === "pending_reconciliation"
    ? "pending_reconciliation"
    : "unallocated";
  const inserted = insertUnallocatedTokenUsageIfAbsentSync({
    workspaceId,
    agentId: entry.employeeId ?? entry.runtimeId ?? "unknown",
    modelId: entry.model,
    runtimeCredentialId,
    gatewayRequestId,
    gatewayUsageId: entry.id,
    protocol: entry.protocol,
    inputTokens: entry.inputTokens ?? undefined,
    outputTokens: entry.outputTokens ?? undefined,
    cacheTokens: entry.cacheTokens ?? undefined,
    actualCostUsd: parseCost(entry.totalCost),
    currency: entry.currency,
    createdAt: entry.timestamp,
    requestStartedAt: entry.startedAt ?? entry.timestamp,
    requestEndedAt: entry.endedAt ?? entry.timestamp,
    sourceUpdatedAt: entry.updatedAt ?? entry.timestamp,
    billingStatus: remoteStatus,
  });
  if (inserted.inserted && remoteStatus === "pending_reconciliation") {
    result.pendingCount = (result.pendingCount ?? 0) + 1;
  } else if (inserted.inserted) result.unallocatedCount += 1;
  else result.skippedCount += 1;
}

function resolveRemoteBillingStatus(
  value: string | null | undefined,
  hasLocalTask: boolean,
): "pending_reconciliation" | "reconciled" | "unallocated" {
  const normalized = value?.trim().toLowerCase();
  if (normalized === "estimated" || normalized === "pending" || normalized === "pending_reconciliation") {
    return "pending_reconciliation";
  }
  if (!normalized || ["reconciled", "settled", "final", "billed", "charged", "completed"].includes(normalized)) {
    return hasLocalTask ? "reconciled" : "unallocated";
  }
  return "pending_reconciliation";
}

function parseCost(value: number | string | null | undefined): number {
  if (value == null) return 0;
  if (typeof value === "number") return value;
  const parsed = Number.parseFloat(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function normalizeRemoteTokenCount(value: number | null | undefined, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : fallback;
}

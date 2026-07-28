import {
  findTokenUsageByGatewayRequestIdSync,
  findTokenUsageByGatewayUsageIdSync,
  insertUnallocatedTokenUsageIfAbsentSync,
  listAllManagedAgentRuntimesSync,
  markTokenUsageReconciledSync,
  readOldestPendingTokenUsageTimestampForRuntimeCredentialSync,
  readTokenUsageReconciliationCursorSync,
  recordAuditLogSync,
  upsertTokenUsageReconciliationCursorSync,
} from "@dofe-agent/db";
import { readAgentRuntimeSync } from "@dofe-agent/db";
import type { ModelsInternalUsageLogEntry } from "@dofe/models-sdk";
import { resolveAgentRuntimeMode } from "../config/deployment.ts";
import { getModelsInternalClient } from "./client.ts";
import { resolveManagedRuntimeScopeSync } from "../runtime-provisioning/runtime-provisioning.ts";
import { notifyWorkspaceAdminsSync } from "../notifications/notifications.ts";

export interface SyncRuntimeCredentialUsageInput {
  workspaceId: string;
  runtimeId: string;
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

type ReconciliationUsageLogEntry = ModelsInternalUsageLogEntry & {
  cacheTokens?: number | null;
  startedAt?: string | null;
  endedAt?: string | null;
  updatedAt?: string | null;
};

export interface ReconcileAllManagedRuntimeUsageResult {
  runtimeCount: number;
  failedRuntimeCount: number;
  reconciledCount: number;
  pendingCount: number;
  unallocatedCount: number;
}

export async function reconcileAllManagedRuntimeUsageAsync(): Promise<ReconcileAllManagedRuntimeUsageResult> {
  const totals: ReconcileAllManagedRuntimeUsageResult = {
    runtimeCount: 0,
    failedRuntimeCount: 0,
    reconciledCount: 0,
    pendingCount: 0,
    unallocatedCount: 0,
  };
  if (resolveAgentRuntimeMode() !== "remote") return totals;

  for (const runtime of listAllManagedAgentRuntimesSync()) {
    if (!runtime.managedCredentialId) continue;
    totals.runtimeCount += 1;
    const cursor = readTokenUsageReconciliationCursorSync(runtime.workspaceId, runtime.managedCredentialId);
    const cursorOverlap = cursor
      ? new Date(new Date(cursor).getTime() - 24 * 60 * 60 * 1_000).toISOString()
      : undefined;
    const oldestPending = readOldestPendingTokenUsageTimestampForRuntimeCredentialSync(
      runtime.workspaceId,
      runtime.managedCredentialId,
    );
    const since = cursorOverlap && oldestPending
      ? (cursorOverlap < oldestPending ? cursorOverlap : oldestPending)
      : cursorOverlap ?? oldestPending;
    try {
      const result = await syncRuntimeCredentialUsageAsync({
        workspaceId: runtime.workspaceId,
        runtimeId: runtime.id,
        since,
      });
      totals.reconciledCount += result.reconciledCount;
      totals.pendingCount += result.pendingCount ?? 0;
      totals.unallocatedCount += result.unallocatedCount;
      if (result.lastRemoteTimestamp) {
        upsertTokenUsageReconciliationCursorSync(
          runtime.workspaceId,
          runtime.managedCredentialId,
          result.lastRemoteTimestamp,
        );
      }
    } catch {
      totals.failedRuntimeCount += 1;
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
  if (!runtime || runtime.workspaceId !== input.workspaceId) {
    throw new Error("usage_sync.runtime_not_found");
  }
  if (!runtime.managedCredentialId) {
    throw new Error("usage_sync.not_a_managed_runtime");
  }

  const scope = resolveManagedRuntimeScopeSync(input.workspaceId);
  const client = getModelsInternalClient();

  recordAuditLogSync({
    workspaceId: input.workspaceId,
    title: "Usage reconciliation started",
    note: `Starting reconciliation for runtime credential ${runtime.managedCredentialId}.`,
    code: "usage.reconciliation_started",
    source: "runtime_lifecycle",
    data: {
      actorType: "system",
      resourceType: "runtime",
      resourceId: runtime.id,
      runtimeCredentialId: runtime.managedCredentialId,
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
        runtimeCredentialId: runtime.managedCredentialId,
        startDate: input.since,
        endDate: input.until,
        page,
        limit,
      },
    });

    const entries = response.list ?? [];
    hasMore = entries.length === limit;
    page += 1;

    for (const entry of entries) {
      result.totalRemoteCount += 1;
      if (entry.requestId) {
        if (!result.lastRemoteTimestamp || entry.timestamp > result.lastRemoteTimestamp) {
          result.lastRemoteTimestamp = entry.timestamp;
        }
      }
      reconcileRuntimeCredentialUsageEntrySync(input.workspaceId, runtime.managedCredentialId, entry, result);
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
      resourceId: runtime.id,
      runtimeCredentialId: runtime.managedCredentialId,
      ...result,
    },
  });

  if (result.unallocatedCount > 0) {
    const today = new Date().toISOString().slice(0, 10);
    notifyWorkspaceAdminsSync({
      workspaceId: input.workspaceId,
      title: "Usage reconciliation discrepancy detected",
      body: `Reconciliation found ${result.unallocatedCount} unallocated charge(s) for runtime "${runtime.name ?? runtime.id}". Review the cost overview to investigate missing attribution.`,
      type: "usage.reconciliation_discrepancy",
      severity: "warning",
      resourceType: "workspace",
      resourceId: runtime.id,
      actionHref: "/costs",
      dedupeKey: `usage.reconciliation_discrepancy:${input.workspaceId}:${runtime.id}:${today}`,
      metadata: {
        unallocatedCount: result.unallocatedCount,
        runtimeId: runtime.id,
        runtimeCredentialId: runtime.managedCredentialId,
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

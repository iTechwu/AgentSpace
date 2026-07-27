import {
  findTokenUsageByGatewayRequestIdSync,
  insertUnallocatedTokenUsageSync,
  markTokenUsageReconciledSync,
  recordAuditLogSync,
} from "@dofe-agent/db";
import { readAgentRuntimeSync } from "@dofe-agent/db";
import type { ModelsInternalUsageLogEntry } from "@dofe/models-sdk";
import { resolveAgentRuntimeMode } from "../config/deployment.ts";
import { getModelsInternalClient } from "./client.ts";
import { resolveManagedRuntimeScopeSync } from "../runtime-provisioning/runtime-provisioning.ts";

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
  skippedCount: number;
  totalRemoteCount: number;
  lastRemoteTimestamp?: string;
}

/**
 * Pull usage logs from models.dofe.ai for a single RuntimeCredential and
 * reconcile them against local `token_usage` rows.
 *
 * - Matching `gateway_request_id` → mark as `reconciled` with actual cost.
 * - Unmatched gateway log → insert an `unallocated` row so the team can see
 *   charges that did not originate from a tracked local task.
 * - Already-reconciled rows are skipped (idempotent).
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
        result.lastRemoteTimestamp = entry.timestamp;
      }
      reconcileSingleEntry(input.workspaceId, runtime.managedCredentialId, entry, result);
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

  return result;
}

function reconcileSingleEntry(
  workspaceId: string,
  runtimeCredentialId: string,
  entry: ModelsInternalUsageLogEntry,
  result: SyncRuntimeCredentialUsageResult,
): void {
  const gatewayRequestId = entry.requestId;
  if (!gatewayRequestId) {
    result.skippedCount += 1;
    return;
  }

  const existing = findTokenUsageByGatewayRequestIdSync(gatewayRequestId, workspaceId);
  if (existing) {
    if (existing.billingStatus === "reconciled") {
      result.skippedCount += 1;
      return;
    }
    markTokenUsageReconciledSync(existing.id, {
      actualCostUsd: parseCost(entry.totalCost),
      currency: entry.currency,
      gatewayRequestId,
    });
    result.reconciledCount += 1;
    return;
  }

  insertUnallocatedTokenUsageSync({
    workspaceId,
    agentId: entry.employeeId ?? entry.runtimeId ?? "unknown",
    modelId: entry.model,
    runtimeCredentialId,
    gatewayRequestId,
    inputTokens: entry.inputTokens ?? undefined,
    outputTokens: entry.outputTokens ?? undefined,
    actualCostUsd: parseCost(entry.totalCost),
    currency: entry.currency,
    createdAt: entry.timestamp,
  });
  result.unallocatedCount += 1;
}

function parseCost(value: number | string | null | undefined): number {
  if (value == null) return 0;
  if (typeof value === "number") return value;
  const parsed = Number.parseFloat(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

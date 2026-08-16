// mcp-operations 域：MCP 操作生命周期（创建 / 认领 / 推进 / 完成 / 失败 / 健康检查）。
import { DEFAULT_WORKSPACE_ID, getDatabase, randomLikeId, withTransaction } from "../database.ts";
import { readOpenMontageMcpPurgeGuardSync } from "../openmontage-jobs.ts";
import { convergeCapabilityRequestFromMcpConnectionSync } from "../capability-requests.ts";
import type {
  McpConnectionOperationSource,
  McpConnectionOperationStage,
  McpConnectionOperationStatus,
  McpConnectionOperationType,
  McpConnectionStatus,
  McpErrorCode,
  RuntimeMcpOperationRecord,
} from "../types.ts";
import {
  MCP_OPERATION_COLUMNS,
  mapRuntimeMcpOperationRecord,
} from "./mcp-center-internal.ts";
import {
  upsertMcpDiscoverySnapshotSync,
} from "./mcp-discovery.ts";

export interface CreateMcpOperationInput {
  workspaceId?: string;
  runtimeId: string;
  connectionId: string;
  operation: McpConnectionOperationType;
  source?: McpConnectionOperationSource;
  requestedByUserId?: string;
  requestSnapshotJson?: string;
}

export interface CompleteMcpOperationInput {
  operationId: string;
  workspaceId?: string;
  safeStdoutTail?: string;
  safeStderrTail?: string;
  /** When present, advances the connection's next scheduled health check. */
  nextHealthCheckAt?: string;
  /** When present (typically for a `verify` operation), a discovery snapshot is written and the connection status is updated. */
  verification?: {
    status: McpConnectionStatus;
    protocolVersion?: string;
    toolsMetadataJson: string;
    toolsFingerprint: string;
    latencyMs?: number;
    discoveredAt?: string;
    errorCode?: McpErrorCode;
    errorMessage?: string;
  };
}

export interface FailMcpOperationInput {
  operationId: string;
  workspaceId?: string;
  safeStdoutTail?: string;
  safeStderrTail?: string;
  errorCode?: string;
  errorMessage: string;
  /** Connection status to apply on failure (defaults to "failed" for verify operations). */
  connectionStatus?: McpConnectionStatus;
  /** When present, advances the connection's next scheduled health check. */
  nextHealthCheckAt?: string;
  /** When present, updates the consecutive health-check failure counter. */
  healthCheckConsecutiveFailures?: number;
}

export function createMcpOperationSync(input: CreateMcpOperationInput): RuntimeMcpOperationRecord {
  const db = getDatabase();
  const workspaceId = input.workspaceId ?? DEFAULT_WORKSPACE_ID;
  const now = new Date().toISOString();
  const id = `mcp-op-${randomLikeId()}`;
  const connection = db.prepare(
    `SELECT id, runtime_id FROM runtime_mcp_connection WHERE id = ? AND workspace_id = ? AND runtime_id = ?`,
  ).get(input.connectionId, workspaceId, input.runtimeId) as Record<string, unknown> | undefined;
  if (!connection) {
    throw new Error(`MCP connection "${input.connectionId}" does not exist on runtime "${input.runtimeId}" in this workspace.`);
  }
  db.prepare(
    `INSERT INTO runtime_mcp_operation (
      id, workspace_id, runtime_id, connection_id, operation, source, status,
      request_snapshot_json, requested_by_user_id, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, 'pending', ?, ?, ?)`,
  ).run(
    id,
    workspaceId,
    input.runtimeId,
    input.connectionId,
    input.operation,
    input.source ?? "user_verify",
    input.requestSnapshotJson ?? "{}",
    input.requestedByUserId ?? null,
    now,
  );
  const record = readMcpOperationSync(id, workspaceId);
  if (!record) {
    throw new Error("Failed to create MCP operation.");
  }
  return record;
}

export function readMcpOperationSync(operationId: string, workspaceId = DEFAULT_WORKSPACE_ID): RuntimeMcpOperationRecord | null {
  const row = getDatabase().prepare(
    `${MCP_OPERATION_COLUMNS} FROM runtime_mcp_operation WHERE id = ? AND workspace_id = ?`,
  ).get(operationId, workspaceId) as Record<string, unknown> | undefined;
  return row ? mapRuntimeMcpOperationRecord(row) : null;
}

export function listMcpOperationsSync(options: {
  workspaceId?: string;
  runtimeId?: string;
  connectionId?: string;
  status?: McpConnectionOperationStatus;
  limit?: number;
} = {}): RuntimeMcpOperationRecord[] {
  const workspaceId = options.workspaceId ?? DEFAULT_WORKSPACE_ID;
  const where = ["workspace_id = ?"];
  const params: unknown[] = [workspaceId];
  if (options.runtimeId) {
    where.push("runtime_id = ?");
    params.push(options.runtimeId);
  }
  if (options.connectionId) {
    where.push("connection_id = ?");
    params.push(options.connectionId);
  }
  if (options.status) {
    where.push("status = ?");
    params.push(options.status);
  }
  const limit = Math.max(1, Math.min(options.limit ?? 100, 500));
  const rows = getDatabase().prepare(
    `${MCP_OPERATION_COLUMNS} FROM runtime_mcp_operation WHERE ${where.join(" AND ")} ORDER BY created_at DESC LIMIT ${limit}`,
  ).all(...params) as Array<Record<string, unknown>>;
  return rows.map(mapRuntimeMcpOperationRecord).filter((r): r is RuntimeMcpOperationRecord => r !== null);
}

export function listMcpOperationsForConnectionSync(connectionId: string, workspaceId = DEFAULT_WORKSPACE_ID, limit = 50): RuntimeMcpOperationRecord[] {
  return listMcpOperationsSync({ workspaceId, connectionId, limit });
}

/**
 * Fences all unfinished work for a connection before its configuration or
 * availability changes. A daemon may still report a cancelled operation, but
 * complete/fail will then be a no-op and cannot restore stale readiness.
 */
export function cancelUnfinishedMcpOperationsForConnectionSync(input: {
  connectionId: string;
  workspaceId?: string;
}): number {
  const workspaceId = input.workspaceId ?? DEFAULT_WORKSPACE_ID;
  const result = getDatabase().prepare(
    `UPDATE runtime_mcp_operation
     SET status = 'cancelled', completed_at = COALESCE(completed_at, ?)
     WHERE connection_id = ? AND workspace_id = ? AND status IN ('pending', 'claimed', 'running')`,
  ).run(new Date().toISOString(), input.connectionId, workspaceId);
  return result.changes;
}

export function claimNextMcpOperationForRuntimeSync(input: {
  workspaceId?: string;
  runtimeId: string;
}): RuntimeMcpOperationRecord | null {
  const db = getDatabase();
  const workspaceId = input.workspaceId ?? DEFAULT_WORKSPACE_ID;
  let claimedId: string | null = null;
  withTransaction(db, () => {
    // 1. Priority: user-initiated operations that require the connection to be
    //    queued for verification, plus removal operations.
    const userRow = db.prepare(
      `SELECT operation.id, operation.connection_id, operation.operation, operation.source
       FROM runtime_mcp_operation operation
       JOIN runtime_mcp_connection connection
         ON connection.id = operation.connection_id AND connection.workspace_id = operation.workspace_id
       WHERE operation.workspace_id = ? AND operation.runtime_id = ? AND operation.status = 'pending'
         AND (operation.operation = 'remove' OR connection.status = 'queued_verification')
       ORDER BY operation.created_at ASC LIMIT 1`,
    ).get(workspaceId, input.runtimeId) as Record<string, unknown> | undefined;
    const row = userRow ?? claimDueHealthCheckOperationSync(db, workspaceId, input.runtimeId);
    if (typeof row?.id !== "string") {
      return;
    }
    const result = db.prepare(
      `UPDATE runtime_mcp_operation SET status = 'claimed' WHERE id = ? AND status = 'pending'`,
    ).run(row.id);
    if (result.changes > 0) {
      if (row.operation !== "remove" && row.source !== "health_check") {
        const connectionResult = db.prepare(
          `UPDATE runtime_mcp_connection
           SET status = 'verifying', updated_at = ?
           WHERE id = ? AND workspace_id = ? AND status = 'queued_verification'`,
        ).run(new Date().toISOString(), row.connection_id, workspaceId);
        if (connectionResult.changes === 0) {
          db.prepare(
            `UPDATE runtime_mcp_operation SET status = 'cancelled', completed_at = ? WHERE id = ? AND status = 'claimed'`,
          ).run(new Date().toISOString(), row.id);
          return;
        }
      }
      claimedId = row.id;
    }
  });
  if (!claimedId) {
    return null;
  }
  return readMcpOperationSync(claimedId, workspaceId);
}

function claimDueHealthCheckOperationSync(
  db: ReturnType<typeof getDatabase>,
  workspaceId: string,
  runtimeId: string,
): Record<string, unknown> | undefined {
  return db.prepare(
    `SELECT operation.id, operation.connection_id, operation.operation, operation.source
     FROM runtime_mcp_operation operation
     JOIN runtime_mcp_connection connection
       ON connection.id = operation.connection_id AND connection.workspace_id = operation.workspace_id
     WHERE operation.workspace_id = ? AND operation.runtime_id = ? AND operation.status = 'pending'
       AND operation.source = 'health_check'
       AND connection.status = 'ready'
       AND connection.next_health_check_at <= ?
     ORDER BY connection.next_health_check_at ASC, operation.created_at ASC
     LIMIT 1`,
  ).get(workspaceId, runtimeId, new Date().toISOString()) as Record<string, unknown> | undefined;
}

/**
 * Schedules periodic health-check verify operations for ready connections whose
 * next check is due. Idempotent: skips connections that already have a pending
 * health-check operation. Returns the number of operations created.
 */
export function scheduleMcpHealthChecksSync(input: {
  workspaceId?: string;
  runtimeId?: string;
  now?: string;
} = {}): number {
  const db = getDatabase();
  const workspaceId = input.workspaceId ?? DEFAULT_WORKSPACE_ID;
  const now = input.now ?? new Date().toISOString();
  const runtimeFilter = input.runtimeId ? "AND connection.runtime_id = ?" : "";
  const params: unknown[] = [workspaceId, now];
  if (input.runtimeId) {
    params.push(input.runtimeId);
  }
  const dueRows = db.prepare(
    `SELECT
      connection.id AS connection_id,
      connection.runtime_id AS runtime_id
     FROM runtime_mcp_connection connection
     WHERE connection.workspace_id = ?
       AND connection.status = 'ready'
       AND (connection.next_health_check_at IS NULL OR connection.next_health_check_at <= ?)
       ${runtimeFilter}
       AND NOT EXISTS (
         SELECT 1 FROM runtime_mcp_operation operation
         WHERE operation.workspace_id = connection.workspace_id
           AND operation.connection_id = connection.id
           AND operation.source = 'health_check'
           AND operation.status IN ('pending', 'claimed', 'running')
       )
     ORDER BY connection.next_health_check_at ASC NULLS FIRST`,
  ).all(...params) as Array<{ connection_id: string; runtime_id: string }>;

  let created = 0;
  for (const row of dueRows) {
    try {
      createMcpOperationSync({
        workspaceId,
        runtimeId: row.runtime_id,
        connectionId: row.connection_id,
        operation: "verify",
        source: "health_check",
      });
      created += 1;
    } catch {
      // If a connection was removed or reconfigured between the select and the
      // insert, skip it and continue with the next row.
    }
  }
  return created;
}

export function startMcpOperationSync(operationId: string, workspaceId = DEFAULT_WORKSPACE_ID): RuntimeMcpOperationRecord {
  const db = getDatabase();
  const now = new Date().toISOString();
  db.prepare(
    `UPDATE runtime_mcp_operation
     SET status = 'running', stage = 'connecting', stage_updated_at = ?, started_at = COALESCE(started_at, ?)
     WHERE id = ? AND workspace_id = ? AND status = 'claimed'`,
  ).run(now, now, operationId, workspaceId);
  const record = readMcpOperationSync(operationId, workspaceId);
  if (!record) {
    throw new Error(`MCP operation "${operationId}" does not exist.`);
  }
  return record;
}

export function updateMcpOperationStageSync(input: {
  operationId: string;
  workspaceId?: string;
  stage: Exclude<McpConnectionOperationStage, "queued" | "completed">;
}): RuntimeMcpOperationRecord {
  const workspaceId = input.workspaceId ?? DEFAULT_WORKSPACE_ID;
  const now = new Date().toISOString();
  const allowedCurrentStages: Record<typeof input.stage, McpConnectionOperationStage[]> = {
    connecting: ["connecting"],
    negotiating: ["connecting", "negotiating"],
    discovering_tools: ["negotiating", "discovering_tools"],
    finalizing: ["connecting", "negotiating", "discovering_tools", "finalizing"],
  };
  const currentStages = allowedCurrentStages[input.stage];
  const placeholders = currentStages.map(() => "?").join(", ");
  const result = getDatabase().prepare(
    `UPDATE runtime_mcp_operation
     SET stage = ?, stage_updated_at = ?
     WHERE id = ? AND workspace_id = ? AND status = 'running' AND stage IN (${placeholders})`,
  ).run(input.stage, now, input.operationId, workspaceId, ...currentStages);
  const operation = readMcpOperationSync(input.operationId, workspaceId);
  if (!operation) throw new Error(`MCP operation "${input.operationId}" does not exist.`);
  if (result.changes === 0 && operation.stage !== input.stage) {
    throw new Error("mcp.stage_transition_invalid");
  }
  return operation;
}

export function completeMcpOperationSync(input: CompleteMcpOperationInput): RuntimeMcpOperationRecord {
  const db = getDatabase();
  const workspaceId = input.workspaceId ?? DEFAULT_WORKSPACE_ID;
  const now = new Date().toISOString();
  let completed: RuntimeMcpOperationRecord | null = null;
  withTransaction(db, () => {
    const update = db.prepare(
      `UPDATE runtime_mcp_operation
       SET status = 'succeeded', stage = 'completed', failed_stage = NULL, stage_updated_at = ?,
           safe_stdout_tail = ?, safe_stderr_tail = ?, completed_at = ?
       WHERE id = ? AND workspace_id = ? AND status = 'running'`,
    ).run(now, input.safeStdoutTail ?? null, input.safeStderrTail ?? null, now, input.operationId, workspaceId);
    completed = readMcpOperationSync(input.operationId, workspaceId);
    if (!completed) {
      throw new Error(`MCP operation "${input.operationId}" does not exist.`);
    }
    if (update.changes === 0) {
      return;
    }
    if (completed.operation === "remove") {
      const purgeGuard = readOpenMontageMcpPurgeGuardSync(workspaceId, completed.connectionId);
      if (!purgeGuard.purgeable) {
        throw new Error(
          `openmontage.purge_blocked:${purgeGuard.inFlightJobIds.join(",")}:${purgeGuard.unresolvedDelegationIds.join(",")}:${purgeGuard.unreconciledUsageCount}`,
        );
      }
      // Removing cascades live connection state. Historical tool audits retain
      // their immutable connection id and are purged only by retention policy.
      db.prepare(`DELETE FROM runtime_mcp_connection WHERE id = ? AND workspace_id = ?`).run(completed.connectionId, workspaceId);
      return;
    }
    if (input.verification) {
      const snap = upsertMcpDiscoverySnapshotSync({
        workspaceId,
        connectionId: completed.connectionId,
        protocolVersion: input.verification.protocolVersion,
        toolsMetadataJson: input.verification.toolsMetadataJson,
        toolsFingerprint: input.verification.toolsFingerprint,
        verificationLatencyMs: input.verification.latencyMs,
        discoveredAt: input.verification.discoveredAt ?? now,
      });
      db.prepare(
        `UPDATE runtime_mcp_connection
         SET status = ?, last_verified_at = ?, endpoint_fingerprint = ?,
             next_health_check_at = ?, health_check_consecutive_failures = 0,
             last_status = ?, last_error_code = ?, last_error_message = ?, updated_at = ?
         WHERE id = ? AND workspace_id = ?`,
      ).run(
        input.verification.status,
        now,
        snap.toolsFingerprint,
        input.nextHealthCheckAt ?? null,
        input.verification.status,
        input.verification.errorCode ?? null,
        input.verification.errorMessage ?? null,
        now,
        completed.connectionId,
        workspaceId,
      );
      // P1-1: converge the linked capability_request to the verify outcome.
      // ready/degraded means the server was reached and tools discovered —
      // provisioning succeeded; anything else (failed) is a provisioning failure.
      const verifyOk =
        input.verification.status === "ready" || input.verification.status === "degraded";
      convergeCapabilityRequestFromMcpConnectionSync({
        connectionId: completed.connectionId,
        workspaceId,
        outcome: verifyOk ? "succeeded" : "failed",
        errorCode: verifyOk ? undefined : input.verification.errorCode,
        errorMessage: verifyOk ? undefined : input.verification.errorMessage,
      });
      return;
    }
    // Non-verify completion (enable/disable): clear transient error state.
    db.prepare(
      `UPDATE runtime_mcp_connection SET last_error_code = NULL, last_error_message = NULL, updated_at = ? WHERE id = ? AND workspace_id = ?`,
    ).run(now, completed.connectionId, workspaceId);
  });
  if (!completed) {
    throw new Error(`MCP operation "${input.operationId}" does not exist.`);
  }
  return completed;
}

export function failMcpOperationSync(input: FailMcpOperationInput): RuntimeMcpOperationRecord {
  const db = getDatabase();
  const workspaceId = input.workspaceId ?? DEFAULT_WORKSPACE_ID;
  const now = new Date().toISOString();
  let failed: RuntimeMcpOperationRecord | null = null;
  withTransaction(db, () => {
    const update = db.prepare(
      `UPDATE runtime_mcp_operation
       SET status = 'failed', failed_stage = stage, stage_updated_at = ?,
           safe_stdout_tail = ?, safe_stderr_tail = ?, error_code = ?, error_message = ?, completed_at = ?
       WHERE id = ? AND workspace_id = ? AND status = 'running'`,
    ).run(
      now,
      input.safeStdoutTail ?? null,
      input.safeStderrTail ?? null,
      input.errorCode ?? null,
      input.errorMessage,
      now,
      input.operationId,
      workspaceId,
    );
    failed = readMcpOperationSync(input.operationId, workspaceId);
    if (!failed) {
      throw new Error(`MCP operation "${input.operationId}" does not exist.`);
    }
    if (update.changes === 0) {
      return;
    }
    if (failed.operation === "remove") {
      return;
    }
    const connectionStatus: McpConnectionStatus = input.connectionStatus ?? defaultConnectionStatusForFailedOperation(failed);
    const sets = ["status = ?", "last_status = ?", "last_error_code = ?", "last_error_message = ?", "updated_at = ?"];
    const params: unknown[] = [connectionStatus, connectionStatus, input.errorCode ?? null, input.errorMessage, now];
    if (input.nextHealthCheckAt !== undefined) {
      sets.push("next_health_check_at = ?");
      params.push(input.nextHealthCheckAt ?? null);
    }
    if (input.healthCheckConsecutiveFailures !== undefined) {
      sets.push("health_check_consecutive_failures = ?");
      params.push(input.healthCheckConsecutiveFailures);
    }
    params.push(failed.connectionId, workspaceId);
    db.prepare(
      `UPDATE runtime_mcp_connection SET ${sets.join(", ")} WHERE id = ? AND workspace_id = ?`,
    ).run(...params);
    // P1-1: a failed verify op means MCP provisioning failed — converge the
    // linked capability_request. Other op types (enable/disable/health-check)
    // do not close a request. remove ops already returned above.
    if (failed.operation === "verify") {
      convergeCapabilityRequestFromMcpConnectionSync({
        connectionId: failed.connectionId,
        workspaceId,
        outcome: "failed",
        errorCode: input.errorCode,
        errorMessage: input.errorMessage,
      });
    }
  });
  if (!failed) {
    throw new Error(`MCP operation "${input.operationId}" does not exist.`);
  }
  return failed;
}

function defaultConnectionStatusForFailedOperation(operation: RuntimeMcpOperationRecord): McpConnectionStatus {
  if (operation.source === "health_check") {
    // A periodic health check should not take a previously-ready connection
    // straight to failed; degradation lets operators see the issue and keeps
    // the failure surface bounded.
    return "degraded";
  }
  if (operation.operation === "verify") {
    return "failed";
  }
  return "degraded";
}

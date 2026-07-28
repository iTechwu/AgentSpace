import { getDatabase } from "./database.ts";

export type RuntimeCredentialReconciliationTargetState = "active" | "draining" | "completed";

export interface RuntimeCredentialReconciliationTargetRecord {
  workspaceId: string;
  runtimeId: string;
  runtimeCredentialId: string;
  state: RuntimeCredentialReconciliationTargetState;
  retireAfter?: string;
  lastRemoteTimestamp?: string;
  lastAttemptAt?: string;
  lastSuccessAt?: string;
  consecutiveFailures: number;
  lastError?: string;
  createdAt: string;
  updatedAt: string;
}

export function upsertActiveRuntimeCredentialReconciliationTargetSync(input: {
  workspaceId: string;
  runtimeId: string;
  runtimeCredentialId: string;
}): RuntimeCredentialReconciliationTargetRecord {
  const now = new Date().toISOString();
  getDatabase().prepare(
    `INSERT INTO runtime_credential_reconciliation_target (
       workspace_id, runtime_id, runtime_credential_id, state, created_at, updated_at
     ) VALUES (?, ?, ?, 'active', ?, ?)
     ON CONFLICT (workspace_id, runtime_credential_id) DO UPDATE SET
       runtime_id = EXCLUDED.runtime_id,
       state = 'active',
       retire_after = NULL,
       updated_at = EXCLUDED.updated_at`,
  ).run(input.workspaceId, input.runtimeId, input.runtimeCredentialId, now, now);
  return readRuntimeCredentialReconciliationTargetSync(input.workspaceId, input.runtimeCredentialId)!;
}

export function markRuntimeCredentialReconciliationTargetDrainingSync(input: {
  workspaceId: string;
  runtimeId: string;
  runtimeCredentialId: string;
  retireAfter: string;
}): RuntimeCredentialReconciliationTargetRecord {
  const now = new Date().toISOString();
  getDatabase().prepare(
    `INSERT INTO runtime_credential_reconciliation_target (
       workspace_id, runtime_id, runtime_credential_id, state, retire_after, created_at, updated_at
     ) VALUES (?, ?, ?, 'draining', ?, ?, ?)
     ON CONFLICT (workspace_id, runtime_credential_id) DO UPDATE SET
       runtime_id = EXCLUDED.runtime_id,
       state = 'draining',
       retire_after = EXCLUDED.retire_after,
       updated_at = EXCLUDED.updated_at`,
  ).run(input.workspaceId, input.runtimeId, input.runtimeCredentialId, input.retireAfter, now, now);
  return readRuntimeCredentialReconciliationTargetSync(input.workspaceId, input.runtimeCredentialId)!;
}

export function readRuntimeCredentialReconciliationTargetSync(
  workspaceId: string,
  runtimeCredentialId: string,
): RuntimeCredentialReconciliationTargetRecord | null {
  const row = getDatabase().prepare(
    `SELECT * FROM runtime_credential_reconciliation_target
     WHERE workspace_id = ? AND runtime_credential_id = ?`,
  ).get(workspaceId, runtimeCredentialId) as Record<string, unknown> | undefined;
  return row ? mapTarget(row) : null;
}

export function listRuntimeCredentialReconciliationTargetsSync(
  workspaceId?: string,
  states: RuntimeCredentialReconciliationTargetState[] = ["active", "draining"],
): RuntimeCredentialReconciliationTargetRecord[] {
  const statePlaceholders = states.map(() => "?").join(", ");
  const rows = workspaceId
    ? getDatabase().prepare(
        `SELECT * FROM runtime_credential_reconciliation_target
         WHERE workspace_id = ? AND state IN (${statePlaceholders})
         ORDER BY created_at, runtime_credential_id`,
      ).all(workspaceId, ...states)
    : getDatabase().prepare(
        `SELECT * FROM runtime_credential_reconciliation_target
         WHERE state IN (${statePlaceholders})
         ORDER BY created_at, runtime_credential_id`,
      ).all(...states);
  return (rows as Array<Record<string, unknown>>).map(mapTarget);
}

export function recordRuntimeCredentialReconciliationSuccessSync(input: {
  workspaceId: string;
  runtimeCredentialId: string;
  lastRemoteTimestamp?: string;
  now?: string;
}): void {
  const now = input.now ?? new Date().toISOString();
  getDatabase().prepare(
    `UPDATE runtime_credential_reconciliation_target
     SET last_remote_timestamp = CASE
           WHEN ? IS NULL THEN last_remote_timestamp
           WHEN last_remote_timestamp IS NULL OR last_remote_timestamp < ? THEN ?
           ELSE last_remote_timestamp
         END,
         last_attempt_at = ?,
         last_success_at = ?,
         consecutive_failures = 0,
         last_error = NULL,
         updated_at = ?
     WHERE workspace_id = ? AND runtime_credential_id = ?`,
  ).run(
    input.lastRemoteTimestamp ?? null,
    input.lastRemoteTimestamp ?? null,
    input.lastRemoteTimestamp ?? null,
    now,
    now,
    now,
    input.workspaceId,
    input.runtimeCredentialId,
  );
}

export function recordRuntimeCredentialReconciliationFailureSync(input: {
  workspaceId: string;
  runtimeCredentialId: string;
  error: unknown;
  now?: string;
}): void {
  const now = input.now ?? new Date().toISOString();
  const message = input.error instanceof Error ? input.error.message : String(input.error);
  getDatabase().prepare(
    `UPDATE runtime_credential_reconciliation_target
     SET last_attempt_at = ?,
         consecutive_failures = consecutive_failures + 1,
         last_error = ?,
         updated_at = ?
     WHERE workspace_id = ? AND runtime_credential_id = ?`,
  ).run(now, message.slice(0, 1_000), now, input.workspaceId, input.runtimeCredentialId);
}

export function completeRuntimeCredentialReconciliationTargetSync(
  workspaceId: string,
  runtimeCredentialId: string,
): void {
  getDatabase().prepare(
    `UPDATE runtime_credential_reconciliation_target
     SET state = 'completed', updated_at = ?
     WHERE workspace_id = ? AND runtime_credential_id = ?`,
  ).run(new Date().toISOString(), workspaceId, runtimeCredentialId);
}

export function readTokenUsageReconciliationCursorSync(
  workspaceId: string,
  runtimeCredentialId: string,
): string | undefined {
  const target = readRuntimeCredentialReconciliationTargetSync(workspaceId, runtimeCredentialId);
  if (target?.lastRemoteTimestamp) return target.lastRemoteTimestamp;
  const row = getDatabase().prepare(
    `SELECT last_remote_timestamp
     FROM token_usage_reconciliation_cursor
     WHERE workspace_id = ? AND runtime_credential_id = ?`,
  ).get(workspaceId, runtimeCredentialId) as { last_remote_timestamp?: string } | undefined;
  return row?.last_remote_timestamp;
}

export function upsertTokenUsageReconciliationCursorSync(
  workspaceId: string,
  runtimeCredentialId: string,
  lastRemoteTimestamp: string,
): void {
  const now = new Date().toISOString();
  getDatabase().prepare(
    `INSERT INTO token_usage_reconciliation_cursor (
      workspace_id, runtime_credential_id, last_remote_timestamp, updated_at
     ) VALUES (?, ?, ?, ?)
     ON CONFLICT (workspace_id, runtime_credential_id) DO UPDATE SET
       last_remote_timestamp = EXCLUDED.last_remote_timestamp,
       updated_at = EXCLUDED.updated_at`,
  ).run(workspaceId, runtimeCredentialId, lastRemoteTimestamp, now);
  recordRuntimeCredentialReconciliationSuccessSync({
    workspaceId,
    runtimeCredentialId,
    lastRemoteTimestamp,
    now,
  });
}

export function readOldestPendingTokenUsageTimestampForRuntimeCredentialSync(
  workspaceId: string,
  runtimeCredentialId: string,
): string | undefined {
  const row = getDatabase().prepare(
    `SELECT MIN(COALESCE(source_updated_at, request_ended_at, request_started_at, created_at)) AS oldest_timestamp
     FROM token_usage
     WHERE workspace_id = ?
       AND runtime_credential_id = ?
       AND billing_status = 'pending_reconciliation'`,
  ).get(workspaceId, runtimeCredentialId) as { oldest_timestamp?: string | null } | undefined;
  return row?.oldest_timestamp ?? undefined;
}

function mapTarget(row: Record<string, unknown>): RuntimeCredentialReconciliationTargetRecord {
  return {
    workspaceId: String(row.workspace_id),
    runtimeId: String(row.runtime_id),
    runtimeCredentialId: String(row.runtime_credential_id),
    state: row.state as RuntimeCredentialReconciliationTargetState,
    retireAfter: typeof row.retire_after === "string" ? row.retire_after : undefined,
    lastRemoteTimestamp: typeof row.last_remote_timestamp === "string" ? row.last_remote_timestamp : undefined,
    lastAttemptAt: typeof row.last_attempt_at === "string" ? row.last_attempt_at : undefined,
    lastSuccessAt: typeof row.last_success_at === "string" ? row.last_success_at : undefined,
    consecutiveFailures: Number(row.consecutive_failures) || 0,
    lastError: typeof row.last_error === "string" ? row.last_error : undefined,
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
  };
}

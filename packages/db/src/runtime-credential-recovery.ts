import { DEFAULT_WORKSPACE_ID, getDatabase, randomLikeId } from "./database.ts";
import type {
  RuntimeCredentialRecoveryTaskRecord,
  RuntimeCredentialRecoveryTaskStatus,
} from "./types.ts";

export interface CreateRuntimeCredentialRecoveryTaskInput {
  workspaceId?: string;
  runtimeId: string;
  sourceTaskId: string;
  credentialId: string;
  idempotencyKey: string;
  maxAttempts?: number;
  now?: string;
}

export function createRuntimeCredentialRecoveryTaskSync(
  input: CreateRuntimeCredentialRecoveryTaskInput,
): RuntimeCredentialRecoveryTaskRecord {
  const workspaceId = input.workspaceId ?? DEFAULT_WORKSPACE_ID;
  const existing = readRuntimeCredentialRecoveryTaskByIdempotencyKeySync(workspaceId, input.idempotencyKey);
  if (existing) return existing;
  const now = input.now ?? new Date().toISOString();
  const id = `runtime-credential-recovery-${randomLikeId()}`;
  try {
    getDatabase().prepare(
      `INSERT INTO runtime_credential_recovery_task (
         id, workspace_id, runtime_id, source_task_id, credential_id,
         idempotency_key, status, attempt_count, max_attempts,
         created_at, updated_at
       ) VALUES (?, ?, ?, ?, ?, ?, 'queued', 0, ?, ?, ?)`,
    ).run(
      id,
      workspaceId,
      input.runtimeId,
      input.sourceTaskId,
      input.credentialId,
      input.idempotencyKey,
      input.maxAttempts ?? 3,
      now,
      now,
    );
  } catch (error) {
    const raced = readRuntimeCredentialRecoveryTaskByIdempotencyKeySync(workspaceId, input.idempotencyKey);
    if (raced) return raced;
    throw error;
  }
  return readRuntimeCredentialRecoveryTaskSync(id, workspaceId)!;
}

export function readRuntimeCredentialRecoveryTaskSync(
  id: string,
  workspaceId?: string,
): RuntimeCredentialRecoveryTaskRecord | null {
  const row = (workspaceId
    ? getDatabase().prepare(
        "SELECT * FROM runtime_credential_recovery_task WHERE id = ? AND workspace_id = ?",
      ).get(id, workspaceId)
    : getDatabase().prepare(
        "SELECT * FROM runtime_credential_recovery_task WHERE id = ?",
      ).get(id)) as RawRecoveryTask | undefined;
  return row ? mapRecoveryTask(row) : null;
}

export function readRuntimeCredentialRecoveryTaskByIdempotencyKeySync(
  workspaceId: string,
  idempotencyKey: string,
): RuntimeCredentialRecoveryTaskRecord | null {
  const row = getDatabase().prepare(
    "SELECT * FROM runtime_credential_recovery_task WHERE workspace_id = ? AND idempotency_key = ?",
  ).get(workspaceId, idempotencyKey) as RawRecoveryTask | undefined;
  return row ? mapRecoveryTask(row) : null;
}

export function listDueRuntimeCredentialRecoveryTasksSync(input: {
  workspaceId?: string;
  now?: string;
  limit?: number;
}): RuntimeCredentialRecoveryTaskRecord[] {
  const workspaceId = input.workspaceId ?? DEFAULT_WORKSPACE_ID;
  const now = input.now ?? new Date().toISOString();
  const limit = Math.min(Math.max(input.limit ?? 10, 1), 100);
  const rows = getDatabase().prepare(
    `SELECT * FROM runtime_credential_recovery_task
     WHERE workspace_id = ? AND status = 'queued'
       AND attempt_count < max_attempts
       AND (cooldown_until IS NULL OR cooldown_until <= ?::timestamptz)
     ORDER BY created_at ASC
     LIMIT ?`,
  ).all(workspaceId, now, limit) as RawRecoveryTask[];
  return rows.map(mapRecoveryTask);
}

export function requeueStaleRuntimeCredentialRecoveryTasksSync(input: {
  workspaceId?: string;
  staleBefore: string;
  now?: string;
}): RuntimeCredentialRecoveryTaskRecord[] {
  const workspaceId = input.workspaceId ?? DEFAULT_WORKSPACE_ID;
  const now = input.now ?? new Date().toISOString();
  const rows = getDatabase().prepare(
    `UPDATE runtime_credential_recovery_task
     SET status = CASE WHEN attempt_count >= max_attempts THEN 'failed' ELSE 'queued' END,
         cooldown_until = CASE WHEN attempt_count >= max_attempts THEN NULL ELSE ?::timestamptz END,
         last_error_code = 'managed_runtime.recovery_lease_expired',
         last_error_message = 'The previous credential recovery attempt did not finish.',
         completed_at = CASE WHEN attempt_count >= max_attempts THEN ?::timestamptz ELSE NULL END,
         updated_at = ?
     WHERE workspace_id = ? AND status = 'running' AND updated_at <= ?::timestamptz
     RETURNING *`,
  ).all(now, now, now, workspaceId, input.staleBefore) as RawRecoveryTask[];
  return rows.map(mapRecoveryTask);
}

export function startRuntimeCredentialRecoveryAttemptSync(input: {
  id: string;
  workspaceId?: string;
  now?: string;
}): RuntimeCredentialRecoveryTaskRecord | null {
  const workspaceId = input.workspaceId ?? DEFAULT_WORKSPACE_ID;
  const now = input.now ?? new Date().toISOString();
  const result = getDatabase().prepare(
    `UPDATE runtime_credential_recovery_task
     SET status = 'running', attempt_count = attempt_count + 1,
         started_at = COALESCE(started_at, ?), updated_at = ?
     WHERE id = ? AND workspace_id = ? AND status = 'queued'
       AND attempt_count < max_attempts
       AND (cooldown_until IS NULL OR cooldown_until <= ?::timestamptz)`,
  ).run(now, now, input.id, workspaceId, now);
  return result.changes > 0 ? readRuntimeCredentialRecoveryTaskSync(input.id, workspaceId) : null;
}

export function markRuntimeCredentialRecoverySucceededSync(input: {
  id: string;
  workspaceId?: string;
  now?: string;
}): RuntimeCredentialRecoveryTaskRecord | null {
  const workspaceId = input.workspaceId ?? DEFAULT_WORKSPACE_ID;
  const now = input.now ?? new Date().toISOString();
  getDatabase().prepare(
    `UPDATE runtime_credential_recovery_task
     SET status = 'succeeded', cooldown_until = NULL,
         last_error_code = NULL, last_error_message = NULL,
         completed_at = ?, updated_at = ?
     WHERE id = ? AND workspace_id = ? AND status IN ('queued', 'running', 'failed')`,
  ).run(now, now, input.id, workspaceId);
  return readRuntimeCredentialRecoveryTaskSync(input.id, workspaceId);
}

export function markRuntimeCredentialRecoveryFailedSync(input: {
  id: string;
  workspaceId?: string;
  errorCode: string;
  errorMessage: string;
  cooldownUntil?: string;
  now?: string;
}): RuntimeCredentialRecoveryTaskRecord | null {
  const workspaceId = input.workspaceId ?? DEFAULT_WORKSPACE_ID;
  const now = input.now ?? new Date().toISOString();
  getDatabase().prepare(
    `UPDATE runtime_credential_recovery_task
     SET status = CASE WHEN attempt_count >= max_attempts THEN 'failed' ELSE 'queued' END,
         cooldown_until = CASE WHEN attempt_count >= max_attempts THEN NULL ELSE ?::timestamptz END,
         last_error_code = ?, last_error_message = ?,
         completed_at = CASE WHEN attempt_count >= max_attempts THEN ?::timestamptz ELSE NULL END,
         updated_at = ?
     WHERE id = ? AND workspace_id = ? AND status = 'running'`,
  ).run(
    input.cooldownUntil ?? null,
    input.errorCode,
    input.errorMessage,
    now,
    now,
    input.id,
    workspaceId,
  );
  return readRuntimeCredentialRecoveryTaskSync(input.id, workspaceId);
}

interface RawRecoveryTask extends Record<string, unknown> {
  id: string;
  workspaceId: string;
  runtimeId: string;
  sourceTaskId: string;
  credentialId: string;
  idempotencyKey: string;
  status: RuntimeCredentialRecoveryTaskStatus;
  attemptCount: number;
  maxAttempts: number;
  createdAt: string;
  updatedAt: string;
}

function mapRecoveryTask(row: RawRecoveryTask): RuntimeCredentialRecoveryTaskRecord {
  return {
    id: row.id,
    workspaceId: row.workspaceId,
    runtimeId: row.runtimeId,
    sourceTaskId: row.sourceTaskId,
    credentialId: row.credentialId,
    idempotencyKey: row.idempotencyKey,
    status: row.status,
    attemptCount: Number(row.attemptCount),
    maxAttempts: Number(row.maxAttempts),
    cooldownUntil: optionalString(row.cooldownUntil),
    lastErrorCode: optionalString(row.lastErrorCode),
    lastErrorMessage: optionalString(row.lastErrorMessage),
    startedAt: optionalString(row.startedAt),
    completedAt: optionalString(row.completedAt),
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

function optionalString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

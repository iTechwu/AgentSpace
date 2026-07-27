import type { DaemonProvider } from "@dofe-agent/domain";
import { DEFAULT_WORKSPACE_ID, getDatabase, randomLikeId, withTransaction } from "./database.ts";
import type {
  ManagedRuntimeCleanupRequestRecord,
  ManagedRuntimeCleanupRequestStatus,
} from "./types.ts";

export interface RequestManagedRuntimeCleanupInput {
  runtimeId: string;
  workspaceId?: string;
  daemonConnectionId: string;
  runtimeType: DaemonProvider;
}

export function requestManagedRuntimeCleanupSync(
  input: RequestManagedRuntimeCleanupInput,
): ManagedRuntimeCleanupRequestRecord {
  const workspaceId = input.workspaceId ?? DEFAULT_WORKSPACE_ID;
  const db = getDatabase();
  const now = new Date().toISOString();
  const id = `managed-runtime-cleanup-${randomLikeId()}`;

  db.prepare(
    `INSERT INTO managed_runtime_cleanup_request (
       id, workspace_id, runtime_id, daemon_connection_id, runtime_type,
       status, attempt_count, max_attempts, next_attempt_at, requested_at, created_at, updated_at
     ) VALUES (?, ?, ?, ?, ?, 'pending', 0, 3, ?, ?, ?, ?)`,
  ).run(
    id,
    workspaceId,
    input.runtimeId,
    input.daemonConnectionId,
    input.runtimeType,
    now,
    now,
    now,
    now,
  );

  return readManagedRuntimeCleanupRequestSync(id)!;
}

export function readManagedRuntimeCleanupRequestSync(
  id: string,
): ManagedRuntimeCleanupRequestRecord | null {
  const row = getDatabase()
    .prepare("SELECT * FROM managed_runtime_cleanup_request WHERE id = ?")
    .get(id) as RawManagedRuntimeCleanupRequest | undefined;
  return row ? mapManagedRuntimeCleanupRequest(row) : null;
}

export function listPendingManagedRuntimeCleanupRequestsForDaemonSync(
  daemonConnectionId: string,
): ManagedRuntimeCleanupRequestRecord[] {
  const rows = getDatabase()
    .prepare(
      `SELECT * FROM managed_runtime_cleanup_request
       WHERE daemon_connection_id = ? AND status = 'pending'
         AND (next_attempt_at IS NULL OR next_attempt_at <= ?)
       ORDER BY requested_at ASC`,
    )
    .all(daemonConnectionId, new Date().toISOString()) as RawManagedRuntimeCleanupRequest[];
  return rows.map(mapManagedRuntimeCleanupRequest);
}

export function markManagedRuntimeCleanupRequestRunningSync(id: string): ManagedRuntimeCleanupRequestRecord | null {
  const db = getDatabase();
  const now = new Date().toISOString();
  const result = db.prepare(
    `UPDATE managed_runtime_cleanup_request
     SET status = 'running', claimed_at = ?, updated_at = ?
     WHERE id = ? AND status = 'pending'
       AND (next_attempt_at IS NULL OR next_attempt_at <= ?)`,
  ).run(now, now, id, now);
  return result.changes === 1 ? readManagedRuntimeCleanupRequestSync(id) : null;
}

export function failManagedRuntimeCleanupRequestSync(
  id: string,
  errorCode?: string,
  errorMessage?: string,
): ManagedRuntimeCleanupRequestRecord | null {
  const db = getDatabase();
  const request = readManagedRuntimeCleanupRequestSync(id);
  if (!request) {
    return null;
  }
  if (request.status !== "running") {
    return request;
  }

  const now = new Date().toISOString();
  const nextAttemptCount = request.attemptCount + 1;
  if (nextAttemptCount < request.maxAttempts) {
    const nextAttemptAt = new Date(
      Date.now() + computeCleanupRetryAfterMs(request.attemptCount),
    ).toISOString();
    db.prepare(
      `UPDATE managed_runtime_cleanup_request
       SET status = 'pending',
           attempt_count = attempt_count + 1,
           next_attempt_at = ?,
           claimed_at = NULL,
           last_error_code = COALESCE(?, last_error_code),
           last_error_message = COALESCE(?, last_error_message),
           updated_at = ?
       WHERE id = ?`,
    ).run(nextAttemptAt, errorCode ?? null, errorMessage ?? null, now, id);
  } else {
    db.prepare(
      `UPDATE managed_runtime_cleanup_request
       SET status = 'failed',
           attempt_count = ?,
           completed_at = ?,
           last_error_code = COALESCE(?, last_error_code),
           last_error_message = COALESCE(?, last_error_message),
           updated_at = ?
       WHERE id = ?`,
    ).run(nextAttemptCount, now, errorCode ?? null, errorMessage ?? null, now, id);
  }
  return readManagedRuntimeCleanupRequestSync(id);
}

export function listDueManagedRuntimeCleanupRequestsSync(): ManagedRuntimeCleanupRequestRecord[] {
  const now = new Date().toISOString();
  const rows = getDatabase()
    .prepare(
      `SELECT * FROM managed_runtime_cleanup_request
       WHERE status = 'pending' AND next_attempt_at IS NOT NULL AND next_attempt_at <= ?
       ORDER BY next_attempt_at ASC`,
    )
    .all(now) as RawManagedRuntimeCleanupRequest[];
  return rows.map(mapManagedRuntimeCleanupRequest);
}

export function listStaleManagedRuntimeCleanupRequestsSync(
  timeoutMs: number,
): ManagedRuntimeCleanupRequestRecord[] {
  const cutoff = new Date(Date.now() - timeoutMs).toISOString();
  const rows = getDatabase()
    .prepare(
      `SELECT * FROM managed_runtime_cleanup_request
       WHERE status = 'running' AND claimed_at IS NOT NULL AND claimed_at <= ?
       ORDER BY claimed_at ASC`,
    )
    .all(cutoff) as RawManagedRuntimeCleanupRequest[];
  return rows.map(mapManagedRuntimeCleanupRequest);
}

export function requeueCleanupRequestsForOfflineDaemonSync(
  daemonConnectionId: string,
): { reclaimed: number } {
  const db = getDatabase();
  const rows = db
    .prepare(
      `SELECT * FROM managed_runtime_cleanup_request
       WHERE daemon_connection_id = ? AND status = 'running'`,
    )
    .all(daemonConnectionId) as RawManagedRuntimeCleanupRequest[];

  for (const row of rows) {
    failManagedRuntimeCleanupRequestSync(
      row.id,
      "cleanup.daemon_offline",
      `Daemon ${daemonConnectionId} went offline while cleanup was running`,
    );
  }

  return { reclaimed: rows.length };
}

function computeCleanupRetryAfterMs(attemptCount: number, baseMs = 15_000, maxMs = 5 * 60 * 1000): number {
  const jitter = Math.random() * 0.4 + 0.8;
  return Math.min(maxMs, baseMs * 2 ** attemptCount) * jitter;
}

export function completeManagedRuntimeCleanupRequestSync(
  id: string,
  status: Extract<ManagedRuntimeCleanupRequestStatus, "succeeded" | "failed">,
  result?: Record<string, unknown>,
): ManagedRuntimeCleanupRequestRecord | null {
  const db = getDatabase();
  const request = readManagedRuntimeCleanupRequestSync(id);
  if (!request || request.status === status) {
    return request;
  }
  if (request.status !== "running") {
    return request;
  }
  const now = new Date().toISOString();
  db.prepare(
    `UPDATE managed_runtime_cleanup_request
     SET status = ?, completed_at = ?, result_json = ?, updated_at = ?
     WHERE id = ? AND status = 'running'`,
  ).run(status, now, result ? JSON.stringify(result) : null, now, id);
  return readManagedRuntimeCleanupRequestSync(id);
}

type RawManagedRuntimeCleanupRequest = {
  id: string;
  workspace_id: string;
  runtime_id: string;
  daemon_connection_id: string;
  runtime_type: string;
  status: ManagedRuntimeCleanupRequestStatus;
  attempt_count: number;
  max_attempts: number;
  next_attempt_at: string | null;
  claimed_at: string | null;
  last_error_code: string | null;
  last_error_message: string | null;
  requested_at: string;
  completed_at: string | null;
  result_json: string | null;
  created_at: string;
  updated_at: string;
};

function mapManagedRuntimeCleanupRequest(
  row: RawManagedRuntimeCleanupRequest,
): ManagedRuntimeCleanupRequestRecord {
  return {
    id: row.id,
    workspaceId: row.workspace_id,
    runtimeId: row.runtime_id,
    daemonConnectionId: row.daemon_connection_id,
    runtimeType: row.runtime_type as DaemonProvider,
    status: row.status,
    attemptCount: row.attempt_count,
    maxAttempts: row.max_attempts,
    nextAttemptAt: row.next_attempt_at ?? undefined,
    claimedAt: row.claimed_at ?? undefined,
    lastErrorCode: row.last_error_code ?? undefined,
    lastErrorMessage: row.last_error_message ?? undefined,
    requestedAt: row.requested_at,
    completedAt: row.completed_at ?? undefined,
    resultJson: row.result_json ?? undefined,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

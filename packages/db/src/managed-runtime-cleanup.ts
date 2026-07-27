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
       status, requested_at, created_at, updated_at
     ) VALUES (?, ?, ?, ?, ?, 'pending', ?, ?, ?)`,
  ).run(
    id,
    workspaceId,
    input.runtimeId,
    input.daemonConnectionId,
    input.runtimeType,
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
       ORDER BY requested_at ASC`,
    )
    .all(daemonConnectionId) as RawManagedRuntimeCleanupRequest[];
  return rows.map(mapManagedRuntimeCleanupRequest);
}

export function markManagedRuntimeCleanupRequestRunningSync(id: string): ManagedRuntimeCleanupRequestRecord | null {
  const db = getDatabase();
  const now = new Date().toISOString();
  db.prepare(
    `UPDATE managed_runtime_cleanup_request
     SET status = 'running', updated_at = ?
     WHERE id = ? AND status = 'pending'`,
  ).run(now, id);
  return readManagedRuntimeCleanupRequestSync(id);
}

export function completeManagedRuntimeCleanupRequestSync(
  id: string,
  status: Extract<ManagedRuntimeCleanupRequestStatus, "succeeded" | "failed">,
  result?: Record<string, unknown>,
): ManagedRuntimeCleanupRequestRecord | null {
  const db = getDatabase();
  const now = new Date().toISOString();
  db.prepare(
    `UPDATE managed_runtime_cleanup_request
     SET status = ?, completed_at = ?, result_json = ?, updated_at = ?
     WHERE id = ?`,
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
    requestedAt: row.requested_at,
    completedAt: row.completed_at ?? undefined,
    resultJson: row.result_json ?? undefined,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

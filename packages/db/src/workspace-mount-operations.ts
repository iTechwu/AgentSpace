import { DEFAULT_WORKSPACE_ID, getDatabase, randomLikeId } from "./database.ts";

export type WorkspaceMountOperationStatus = "pending" | "claimed" | "running" | "completed" | "failed";

export interface WorkspaceMountOperationRecord {
  id: string;
  workspaceId: string;
  runtimeId: string;
  employeeName: string;
  headRevisionId?: string;
  status: WorkspaceMountOperationStatus;
  claimedAt?: string;
  completedAt?: string;
  errorCode?: string;
  errorMessage?: string;
  createdAt: string;
  updatedAt: string;
}

export interface CreateWorkspaceMountOperationInput {
  workspaceId?: string;
  runtimeId: string;
  employeeName: string;
  headRevisionId?: string;
}

const MOUNT_COLUMNS = `SELECT
  id, workspace_id AS workspaceId, runtime_id AS runtimeId, employee_name AS employeeName,
  head_revision_id AS headRevisionId, status, claimed_at AS claimedAt, completed_at AS completedAt,
  error_code AS errorCode, error_message AS errorMessage,
  created_at AS createdAt, updated_at AS updatedAt`;

export function createWorkspaceMountOperationSync(
  input: CreateWorkspaceMountOperationInput,
): WorkspaceMountOperationRecord {
  const db = getDatabase();
  const workspaceId = input.workspaceId ?? DEFAULT_WORKSPACE_ID;
  const id = `mount-${randomLikeId()}`;
  const now = new Date().toISOString();
  db.prepare(
    `INSERT INTO runtime_workspace_mount_operation (
      id, workspace_id, runtime_id, employee_name, head_revision_id, status,
      created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, 'pending', ?, ?)`,
  ).run(
    id,
    workspaceId,
    input.runtimeId.trim(),
    input.employeeName.trim(),
    input.headRevisionId?.trim() || null,
    now,
    now,
  );
  return readWorkspaceMountOperationSync(id, workspaceId)!;
}

export function readWorkspaceMountOperationSync(
  id: string,
  workspaceId = DEFAULT_WORKSPACE_ID,
): WorkspaceMountOperationRecord | null {
  const row = getDatabase().prepare(
    `${MOUNT_COLUMNS} FROM runtime_workspace_mount_operation WHERE id = ? AND workspace_id = ?`,
  ).get(id, workspaceId) as Record<string, unknown> | undefined;
  return row ? mapMountOperationRecord(row) : null;
}

export function claimNextWorkspaceMountOperationForRuntimeSync(
  runtimeId: string,
  workspaceId?: string,
): WorkspaceMountOperationRecord | null {
  const db = getDatabase();
  const now = new Date().toISOString();
  const row = db.prepare(
    `SELECT id FROM runtime_workspace_mount_operation
     WHERE runtime_id = ? AND status = 'pending'
     ${typeof workspaceId === "string" ? "AND workspace_id = ?" : ""}
     ORDER BY created_at ASC LIMIT 1`,
  ).get(...(typeof workspaceId === "string" ? [runtimeId, workspaceId] : [runtimeId])) as { id?: string } | undefined;
  if (!row?.id) {
    return null;
  }
  // CAS claim: only a pending op becomes claimed. If another worker won the race
  // between our SELECT and UPDATE, the row count is 0 and we must not report it
  // as ours.
  const result = db.prepare(
    `UPDATE runtime_workspace_mount_operation
     SET status = 'claimed', claimed_at = ?, updated_at = ?
     WHERE id = ? AND status = 'pending'`,
  ).run(now, now, row.id);
  if (result.changes === 0) {
    return null;
  }
  return readWorkspaceMountOperationSync(row.id, workspaceId ?? DEFAULT_WORKSPACE_ID)!;
}

export function startWorkspaceMountOperationSync(
  operationId: string,
  workspaceId = DEFAULT_WORKSPACE_ID,
): WorkspaceMountOperationRecord {
  const db = getDatabase();
  const now = new Date().toISOString();
  db.prepare(
    `UPDATE runtime_workspace_mount_operation SET status = 'running', updated_at = ?
     WHERE id = ? AND workspace_id = ?`,
  ).run(now, operationId, workspaceId);
  return readWorkspaceMountOperationSync(operationId, workspaceId)!;
}

export function completeWorkspaceMountOperationSync(input: {
  operationId: string;
  workspaceId?: string;
  headRevisionId?: string;
}): WorkspaceMountOperationRecord {
  const db = getDatabase();
  const workspaceId = input.workspaceId ?? DEFAULT_WORKSPACE_ID;
  const now = new Date().toISOString();
  const result = db.prepare(
    `UPDATE runtime_workspace_mount_operation
       SET status = 'completed', completed_at = ?, error_code = NULL, error_message = NULL, updated_at = ?
     WHERE id = ? AND workspace_id = ? AND status IN ('claimed', 'running')`,
  ).run(now, now, input.operationId, workspaceId);
  if (result.changes === 0) {
    throw new Error("Workspace mount operation is not in a completable state.");
  }
  return readWorkspaceMountOperationSync(input.operationId, workspaceId)!;
}

export function failWorkspaceMountOperationSync(input: {
  operationId: string;
  workspaceId?: string;
  errorCode?: string;
  errorMessage: string;
}): WorkspaceMountOperationRecord {
  const db = getDatabase();
  const workspaceId = input.workspaceId ?? DEFAULT_WORKSPACE_ID;
  const now = new Date().toISOString();
  const result = db.prepare(
    `UPDATE runtime_workspace_mount_operation
       SET status = 'failed', error_code = ?, error_message = ?, updated_at = ?
     WHERE id = ? AND workspace_id = ? AND status IN ('claimed', 'running')`,
  ).run(input.errorCode?.trim() || null, input.errorMessage, now, input.operationId, workspaceId);
  if (result.changes === 0) {
    throw new Error("Workspace mount operation is not in a failable state.");
  }
  return readWorkspaceMountOperationSync(input.operationId, workspaceId)!;
}

function mapMountOperationRecord(value: Record<string, unknown>): WorkspaceMountOperationRecord | null {
  if (
    typeof value.id !== "string" ||
    typeof value.workspaceId !== "string" ||
    typeof value.runtimeId !== "string" ||
    typeof value.employeeName !== "string" ||
    typeof value.status !== "string" ||
    typeof value.createdAt !== "string" ||
    typeof value.updatedAt !== "string"
  ) {
    return null;
  }
  return {
    id: value.id,
    workspaceId: value.workspaceId,
    runtimeId: value.runtimeId,
    employeeName: value.employeeName,
    headRevisionId: typeof value.headRevisionId === "string" ? value.headRevisionId : undefined,
    status: value.status as WorkspaceMountOperationStatus,
    claimedAt: typeof value.claimedAt === "string" ? value.claimedAt : undefined,
    completedAt: typeof value.completedAt === "string" ? value.completedAt : undefined,
    errorCode: typeof value.errorCode === "string" ? value.errorCode : undefined,
    errorMessage: typeof value.errorMessage === "string" ? value.errorMessage : undefined,
    createdAt: value.createdAt,
    updatedAt: value.updatedAt,
  };
}

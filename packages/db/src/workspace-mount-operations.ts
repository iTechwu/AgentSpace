import { DEFAULT_WORKSPACE_ID, getDatabase, randomLikeId, withTransaction } from "./database.ts";

export const WORKSPACE_MOUNT_OPERATION_LEASE_SECONDS = 120;

function leaseExpiryIso(now: Date): string {
  return new Date(now.getTime() + WORKSPACE_MOUNT_OPERATION_LEASE_SECONDS * 1000).toISOString();
}

export type WorkspaceMountOperationStatus = "pending" | "claimed" | "running" | "completed" | "failed";

export interface WorkspaceMountOperationRecord {
  id: string;
  workspaceId: string;
  runtimeId: string;
  employeeName: string;
  headRevisionId?: string;
  status: WorkspaceMountOperationStatus;
  claimedAt?: string;
  leaseExpiresAt?: string;
  claimGeneration: number;
  completedAt?: string;
  errorCode?: string;
  errorMessage?: string;
  /** Number of files materialized into the persistent runtime workspace. */
  materializedFiles?: number;
  /** Daemon-local path of the persistent runtime workspace (kept after mount). */
  mountedPath?: string;
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
  lease_expires_at AS leaseExpiresAt, claim_generation AS claimGeneration,
  error_code AS errorCode, error_message AS errorMessage,
  materialized_files AS materializedFiles, mounted_path AS mountedPath,
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
  now = new Date(),
): WorkspaceMountOperationRecord | null {
  const db = getDatabase();
  const resolvedWorkspaceId = workspaceId ?? DEFAULT_WORKSPACE_ID;
  let claimedId: string | null = null;
  withTransaction(db, () => {
    requeueExpiredWorkspaceMountOperationLeasesSync({
      workspaceId: resolvedWorkspaceId,
      runtimeId,
      now,
    });
    const row = db.prepare(
      `SELECT id FROM runtime_workspace_mount_operation
       WHERE runtime_id = ? AND workspace_id = ? AND status = 'pending'
       ORDER BY created_at ASC LIMIT 1`,
    ).get(runtimeId, resolvedWorkspaceId) as { id?: string } | undefined;
    if (!row?.id) {
      return;
    }
    const result = db.prepare(
      `UPDATE runtime_workspace_mount_operation
       SET status = 'claimed', claimed_at = ?, lease_expires_at = ?,
           claim_generation = claim_generation + 1, updated_at = ?
       WHERE id = ? AND status = 'pending'`,
    ).run(now.toISOString(), leaseExpiryIso(now), now.toISOString(), row.id);
    if (result.changes > 0) {
      claimedId = row.id;
    }
  });
  return claimedId ? readWorkspaceMountOperationSync(claimedId, resolvedWorkspaceId) : null;
}

export function startWorkspaceMountOperationSync(input: {
  operationId: string;
  claimGeneration: number;
  workspaceId?: string;
  now?: Date;
}): WorkspaceMountOperationRecord {
  const db = getDatabase();
  const workspaceId = input.workspaceId ?? DEFAULT_WORKSPACE_ID;
  const now = input.now ?? new Date();
  const result = db.prepare(
    `UPDATE runtime_workspace_mount_operation
     SET status = 'running', lease_expires_at = ?, updated_at = ?
     WHERE id = ? AND workspace_id = ? AND claim_generation = ?
       AND status = 'claimed' AND lease_expires_at > ?`,
  ).run(
    leaseExpiryIso(now),
    now.toISOString(),
    input.operationId,
    workspaceId,
    input.claimGeneration,
    now.toISOString(),
  );
  if (result.changes === 0) {
    const current = readWorkspaceMountOperationSync(input.operationId, workspaceId);
    if (
      current?.status === "running"
      && current.claimGeneration === input.claimGeneration
      && current.leaseExpiresAt
      && current.leaseExpiresAt > now.toISOString()
    ) {
      return current;
    }
    throw new Error("Workspace mount operation is not in a startable state.");
  }
  return readWorkspaceMountOperationSync(input.operationId, workspaceId)!;
}

export function renewWorkspaceMountOperationLeaseSync(input: {
  operationId: string;
  claimGeneration: number;
  workspaceId?: string;
  now?: Date;
}): boolean {
  const workspaceId = input.workspaceId ?? DEFAULT_WORKSPACE_ID;
  const now = input.now ?? new Date();
  const result = getDatabase().prepare(
    `UPDATE runtime_workspace_mount_operation SET lease_expires_at = ?, updated_at = ?
     WHERE id = ? AND workspace_id = ? AND claim_generation = ?
       AND status IN ('claimed', 'running') AND lease_expires_at > ?`,
  ).run(
    leaseExpiryIso(now),
    now.toISOString(),
    input.operationId,
    workspaceId,
    input.claimGeneration,
    now.toISOString(),
  );
  return result.changes > 0;
}

export function requeueExpiredWorkspaceMountOperationLeasesSync(input?: {
  workspaceId?: string;
  runtimeId?: string;
  now?: Date;
}): number {
  const workspaceId = input?.workspaceId ?? DEFAULT_WORKSPACE_ID;
  const now = input?.now ?? new Date();
  const result = getDatabase().prepare(
    `UPDATE runtime_workspace_mount_operation
     SET status = 'pending', claimed_at = NULL, lease_expires_at = NULL, updated_at = ?
     WHERE workspace_id = ? AND status IN ('claimed', 'running')
       AND lease_expires_at <= ?
       ${input?.runtimeId ? "AND runtime_id = ?" : ""}`,
  ).run(...(
    input?.runtimeId
      ? [now.toISOString(), workspaceId, now.toISOString(), input.runtimeId]
      : [now.toISOString(), workspaceId, now.toISOString()]
  ));
  return result.changes;
}

export function completeWorkspaceMountOperationSync(input: {
  operationId: string;
  workspaceId?: string;
  claimGeneration: number;
  headRevisionId?: string;
  materializedFiles: number;
  mountedPath: string;
  now?: Date;
}): WorkspaceMountOperationRecord {
  const db = getDatabase();
  const workspaceId = input.workspaceId ?? DEFAULT_WORKSPACE_ID;
  if (!Number.isSafeInteger(input.materializedFiles) || input.materializedFiles < 0) {
    throw new Error("Workspace mount materializedFiles must be a non-negative safe integer.");
  }
  const mountedPath = input.mountedPath.trim();
  if (!mountedPath) {
    throw new Error("Workspace mount mountedPath is required.");
  }
  const now = input.now ?? new Date();
  const result = db.prepare(
    `UPDATE runtime_workspace_mount_operation
       SET status = 'completed', completed_at = ?, error_code = NULL, error_message = NULL,
           materialized_files = ?, mounted_path = ?, lease_expires_at = NULL, updated_at = ?
     WHERE id = ? AND workspace_id = ? AND claim_generation = ?
       AND status = 'running' AND lease_expires_at > ?`,
  ).run(
    now.toISOString(),
    input.materializedFiles,
    mountedPath,
    now.toISOString(),
    input.operationId,
    workspaceId,
    input.claimGeneration,
    now.toISOString(),
  );
  if (result.changes === 0) {
    throw new Error("Workspace mount operation is not in a completable state.");
  }
  return readWorkspaceMountOperationSync(input.operationId, workspaceId)!;
}

export function failWorkspaceMountOperationSync(input: {
  operationId: string;
  workspaceId?: string;
  claimGeneration: number;
  errorCode?: string;
  errorMessage: string;
  now?: Date;
}): WorkspaceMountOperationRecord {
  const db = getDatabase();
  const workspaceId = input.workspaceId ?? DEFAULT_WORKSPACE_ID;
  const now = input.now ?? new Date();
  const result = db.prepare(
    `UPDATE runtime_workspace_mount_operation
       SET status = 'failed', error_code = ?, error_message = ?, completed_at = ?,
           lease_expires_at = NULL, updated_at = ?
     WHERE id = ? AND workspace_id = ? AND claim_generation = ?
       AND status IN ('claimed', 'running') AND lease_expires_at > ?`,
  ).run(
    input.errorCode?.trim() || null,
    input.errorMessage,
    now.toISOString(),
    now.toISOString(),
    input.operationId,
    workspaceId,
    input.claimGeneration,
    now.toISOString(),
  );
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
    leaseExpiresAt: readOptionalString(value.leaseExpiresAt ?? value.leaseexpiresat ?? value.lease_expires_at),
    claimGeneration: readClaimGeneration(value),
    completedAt: typeof value.completedAt === "string" ? value.completedAt : undefined,
    errorCode: typeof value.errorCode === "string" ? value.errorCode : undefined,
    errorMessage: typeof value.errorMessage === "string" ? value.errorMessage : undefined,
    materializedFiles: typeof value.materializedFiles === "number" ? value.materializedFiles : undefined,
    mountedPath: typeof value.mountedPath === "string" ? value.mountedPath : undefined,
    createdAt: value.createdAt,
    updatedAt: value.updatedAt,
  };
}

function readClaimGeneration(value: Record<string, unknown>): number {
  const raw = value.claimGeneration ?? value.claimgeneration ?? value.claim_generation;
  const parsed = typeof raw === "number" ? raw : typeof raw === "string" ? Number.parseInt(raw, 10) : 0;
  return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : 0;
}

function readOptionalString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

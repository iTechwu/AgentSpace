import { getDatabase, randomLikeId, DEFAULT_WORKSPACE_ID, withTransaction } from "./database.ts";
import type { ManagedSkillServiceOperationRecord } from "./types.ts";

const OPERATION_COLUMNS = `SELECT
  id, workspace_id AS workspaceId, runtime_id AS runtimeId, service_id AS serviceId,
  installation_id AS installationId, operation, status,
  error_code AS errorCode, error_message AS errorMessage,
  claimed_at AS claimedAt, completed_at AS completedAt,
  lease_expires_at, replaces_service_id,
  created_at AS createdAt`;

/** Lease duration for a claimed managed skill service operation. */
export const SKILL_SERVICE_OPERATION_LEASE_SECONDS = 120;

function leaseExpiryIso(now: Date): string {
  return new Date(now.getTime() + SKILL_SERVICE_OPERATION_LEASE_SECONDS * 1000).toISOString();
}

export interface CreateManagedSkillServiceOperationInput {
  workspaceId?: string;
  runtimeId: string;
  serviceId: string;
  installationId?: string;
  /** For a canary provision: the green managed service this instance replaces. */
  replacesServiceId?: string;
  operation: "provision" | "retire";
}

export function createManagedSkillServiceOperationSync(
  input: CreateManagedSkillServiceOperationInput,
): ManagedSkillServiceOperationRecord {
  const db = getDatabase();
  const workspaceId = input.workspaceId ?? DEFAULT_WORKSPACE_ID;
  const id = `svc-op-${randomLikeId()}`;
  const now = new Date().toISOString();
  db.prepare(
    `INSERT INTO managed_skill_service_operation (
      id, workspace_id, runtime_id, service_id, installation_id, replaces_service_id, operation, status,
      error_code, error_message, claimed_at, completed_at, lease_expires_at, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, 'pending', NULL, NULL, NULL, NULL, NULL, ?)`,
  ).run(
    id,
    workspaceId,
    input.runtimeId,
    input.serviceId,
    input.installationId?.trim() || null,
    input.replacesServiceId?.trim() || null,
    input.operation,
    now,
  );
  return readManagedSkillServiceOperationSync(id, workspaceId)!;
}

export function readManagedSkillServiceOperationSync(
  id: string,
  workspaceId = DEFAULT_WORKSPACE_ID,
): ManagedSkillServiceOperationRecord | null {
  const row = getDatabase().prepare(
    `${OPERATION_COLUMNS} FROM managed_skill_service_operation WHERE id = ? AND workspace_id = ?`,
  ).get(id, workspaceId) as Record<string, unknown> | undefined;
  return row ? mapOperationRecord(row) : null;
}

export function listManagedSkillServiceOperationsSync(options: {
  workspaceId?: string;
  runtimeId?: string;
  serviceId?: string;
  status?: string;
  limit?: number;
} = {}): ManagedSkillServiceOperationRecord[] {
  const workspaceId = options.workspaceId ?? DEFAULT_WORKSPACE_ID;
  const where = ["workspace_id = ?"];
  const params: unknown[] = [workspaceId];
  if (options.runtimeId) {
    where.push("runtime_id = ?");
    params.push(options.runtimeId);
  }
  if (options.serviceId) {
    where.push("service_id = ?");
    params.push(options.serviceId);
  }
  if (options.status) {
    where.push("status = ?");
    params.push(options.status);
  }
  const limit = Math.max(1, Math.min(options.limit ?? 100, 500));
  const rows = getDatabase().prepare(
    `${OPERATION_COLUMNS} FROM managed_skill_service_operation
     WHERE ${where.join(" AND ")} ORDER BY created_at ASC LIMIT ${limit}`,
  ).all(...params) as Array<Record<string, unknown>>;
  return rows.map(mapOperationRecord).filter((r): r is ManagedSkillServiceOperationRecord => r !== null);
}

/** Atomic claim: SELECT pending then UPDATE in one transaction (mirrors runtime-app ops). */
export function claimNextManagedSkillServiceOperationForRuntimeSync(input: {
  workspaceId?: string;
  runtimeId: string;
  now?: Date;
}): ManagedSkillServiceOperationRecord | null {
  const db = getDatabase();
  const workspaceId = input.workspaceId ?? DEFAULT_WORKSPACE_ID;
  const now = input.now ?? new Date();
  let claimedId: string | null = null;
  withTransaction(db, () => {
    const row = db.prepare(
      `SELECT id FROM managed_skill_service_operation
       WHERE workspace_id = ? AND runtime_id = ? AND status = 'pending'
       ORDER BY created_at ASC LIMIT 1`,
    ).get(workspaceId, input.runtimeId) as { id?: string } | undefined;
    if (typeof row?.id !== "string") {
      return;
    }
    const result = db.prepare(
      `UPDATE managed_skill_service_operation
       SET status = 'claimed', claimed_at = COALESCE(claimed_at, ?), lease_expires_at = ?
       WHERE id = ? AND status = 'pending'`,
    ).run(now.toISOString(), leaseExpiryIso(now), row.id);
    if (result.changes > 0) {
      claimedId = row.id;
    }
  });
  return claimedId ? readManagedSkillServiceOperationSync(claimedId, workspaceId) : null;
}

export function startManagedSkillServiceOperationSync(input: {
  operationId: string;
  workspaceId?: string;
  now?: Date;
}): boolean {
  const workspaceId = input.workspaceId ?? DEFAULT_WORKSPACE_ID;
  const now = input.now ?? new Date();
  const result = getDatabase().prepare(
    `UPDATE managed_skill_service_operation
     SET status = 'running', lease_expires_at = ?
     WHERE id = ? AND workspace_id = ? AND status = 'claimed' AND lease_expires_at > ?`,
  ).run(leaseExpiryIso(now), input.operationId, workspaceId, now.toISOString());
  return result.changes > 0;
}

export function renewManagedSkillServiceOperationLeaseSync(input: {
  operationId: string;
  workspaceId?: string;
  now?: Date;
}): boolean {
  const workspaceId = input.workspaceId ?? DEFAULT_WORKSPACE_ID;
  const now = input.now ?? new Date();
  const result = getDatabase().prepare(
    `UPDATE managed_skill_service_operation SET lease_expires_at = ?
     WHERE id = ? AND workspace_id = ? AND status IN ('claimed', 'running') AND lease_expires_at > ?`,
  ).run(leaseExpiryIso(now), input.operationId, workspaceId, now.toISOString());
  return result.changes > 0;
}

/** Crash recovery: re-queues operations whose lease expired while claimed/running. */
export function requeueExpiredManagedSkillServiceOperationLeasesSync(input?: {
  workspaceId?: string;
  now?: Date;
}): number {
  const now = (input?.now ?? new Date()).toISOString();
  const workspaceId = input?.workspaceId ?? DEFAULT_WORKSPACE_ID;
  const result = getDatabase().prepare(
    `UPDATE managed_skill_service_operation
     SET status = 'pending', claimed_at = NULL, lease_expires_at = NULL
     WHERE workspace_id = ? AND status IN ('claimed', 'running') AND lease_expires_at < ?`,
  ).run(workspaceId, now);
  return result.changes;
}

export function completeManagedSkillServiceOperationSync(input: {
  operationId: string;
  workspaceId?: string;
  errorCode?: string;
  errorMessage?: string;
  now?: Date;
}): boolean {
  const workspaceId = input.workspaceId ?? DEFAULT_WORKSPACE_ID;
  const now = input.now ?? new Date();
  const result = getDatabase().prepare(
    `UPDATE managed_skill_service_operation
     SET status = 'succeeded', error_code = ?, error_message = ?, completed_at = ?, lease_expires_at = NULL
     WHERE id = ? AND workspace_id = ? AND status IN ('claimed', 'running') AND lease_expires_at > ?`,
  ).run(input.errorCode ?? null, input.errorMessage ?? null, now.toISOString(), input.operationId, workspaceId, now.toISOString());
  return result.changes > 0;
}

export function failManagedSkillServiceOperationSync(input: {
  operationId: string;
  workspaceId?: string;
  errorCode: string;
  errorMessage: string;
  now?: Date;
}): boolean {
  const workspaceId = input.workspaceId ?? DEFAULT_WORKSPACE_ID;
  const now = input.now ?? new Date();
  const result = getDatabase().prepare(
    `UPDATE managed_skill_service_operation
     SET status = 'failed', error_code = ?, error_message = ?, completed_at = ?, lease_expires_at = NULL
     WHERE id = ? AND workspace_id = ? AND status IN ('claimed', 'running') AND lease_expires_at > ?`,
  ).run(input.errorCode, input.errorMessage, now.toISOString(), input.operationId, workspaceId, now.toISOString());
  return result.changes > 0;
}

function mapOperationRecord(value: Record<string, unknown>): ManagedSkillServiceOperationRecord | null {
  if (
    typeof value.id !== "string" ||
    typeof value.workspaceId !== "string" ||
    typeof value.runtimeId !== "string" ||
    typeof value.serviceId !== "string" ||
    typeof value.operation !== "string" ||
    typeof value.status !== "string" ||
    typeof value.createdAt !== "string"
  ) {
    return null;
  }
  return {
    id: value.id,
    workspaceId: value.workspaceId,
    runtimeId: value.runtimeId,
    serviceId: value.serviceId,
    installationId: typeof value.installationId === "string" ? value.installationId : undefined,
    replacesServiceId: typeof value.replacesServiceId === "string" ? value.replacesServiceId : undefined,
    operation: value.operation as ManagedSkillServiceOperationRecord["operation"],
    status: value.status as ManagedSkillServiceOperationRecord["status"],
    errorCode: typeof value.errorCode === "string" ? value.errorCode : undefined,
    errorMessage: typeof value.errorMessage === "string" ? value.errorMessage : undefined,
    claimedAt: typeof value.claimedAt === "string" ? value.claimedAt : undefined,
    completedAt: typeof value.completedAt === "string" ? value.completedAt : undefined,
    leaseExpiresAt: typeof value.leaseExpiresAt === "string" ? value.leaseExpiresAt : undefined,
    createdAt: value.createdAt,
  };
}

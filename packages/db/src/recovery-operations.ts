import { DEFAULT_WORKSPACE_ID, getDatabase, randomLikeId } from "./database.ts";
import { resolveStoredEmployeeIdSync } from "./workspace-employees.ts";
import type { EmployeeRecoveryOperationRecord, RecoveryPhase } from "./types.ts";

/* ------------------------------------------------------------------ */
/* Input interfaces                                                    */
/* ------------------------------------------------------------------ */

export interface CreateRecoveryOperationInput {
  workspaceId?: string;
  employeeName: string;
  fromGeneration?: number;
  toGeneration: number;
  targetRevisionId?: string;
  requestedByUserId?: string;
  contextJson?: string;
  actorUserId?: string;
  approvalState?: "pending" | "not_required";
}

/* ------------------------------------------------------------------ */
/* Column selector                                                     */
/* ------------------------------------------------------------------ */

const RECOVERY_COLUMNS = `SELECT
  id, workspace_id AS workspaceId, employee_id AS employeeId, employee_name AS employeeName,
  from_generation AS fromGeneration, to_generation AS toGeneration, phase,
  target_revision_id AS targetRevisionId, requested_by_user_id AS requestedByUserId,
  error_code AS errorCode, error_message AS errorMessage, context_json AS contextJson,
  provisioning_task_id AS provisioningTaskId, mount_operation_id AS mountOperationId,
  health_checked_at AS healthCheckedAt, approval_state AS approvalState,
  approved_by_user_id AS approvedByUserId, approved_at AS approvedAt, actor_user_id AS actorUserId,
  created_at AS createdAt, updated_at AS updatedAt`;

/* ------------------------------------------------------------------ */
/* Operations                                                          */
/* ------------------------------------------------------------------ */

export function createRecoveryOperationSync(input: CreateRecoveryOperationInput): EmployeeRecoveryOperationRecord {
  const db = getDatabase();
  const workspaceId = input.workspaceId ?? DEFAULT_WORKSPACE_ID;
  const employeeName = input.employeeName.trim();
  if (!employeeName) {
    throw new Error("Employee name is required.");
  }
  if (!input.toGeneration || input.toGeneration < 1) {
    throw new Error("Recovery operation to_generation must be a positive integer.");
  }
  const employeeId = resolveStoredEmployeeIdSync(employeeName, workspaceId);
  if (!employeeId) {
    throw new Error(`Employee "${employeeName}" not found in workspace ${workspaceId}.`);
  }
  const id = `recover-${randomLikeId()}`;
  const now = new Date().toISOString();
  db.prepare(
    `INSERT INTO employee_recovery_operation (
      id, workspace_id, employee_id, employee_name, from_generation, to_generation, phase,
      target_revision_id, requested_by_user_id, error_code, error_message, context_json,
      approval_state, actor_user_id, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, 'allocate', ?, ?, NULL, NULL, ?, ?, ?, ?, ?)`,
  ).run(
    id,
    workspaceId,
    employeeId,
    employeeName,
    input.fromGeneration ?? null,
    input.toGeneration,
    input.targetRevisionId?.trim() || null,
    input.requestedByUserId?.trim() || null,
    input.contextJson ?? "{}",
    input.approvalState ?? "not_required",
    input.actorUserId?.trim() || null,
    now,
    now,
  );
  return readRecoveryOperationSync(id, workspaceId)!;
}

export function readRecoveryOperationSync(
  id: string,
  workspaceId = DEFAULT_WORKSPACE_ID,
): EmployeeRecoveryOperationRecord | null {
  const row = getDatabase().prepare(
    `${RECOVERY_COLUMNS} FROM employee_recovery_operation WHERE id = ? AND workspace_id = ?`,
  ).get(id, workspaceId) as Record<string, unknown> | undefined;
  return row ? mapRecoveryRecord(row) : null;
}

export function listRecoveryOperationsSync(options: {
  employeeName?: string;
  workspaceId?: string;
  limit?: number;
}): EmployeeRecoveryOperationRecord[] {
  const workspaceId = options.workspaceId ?? DEFAULT_WORKSPACE_ID;
  const limit = Math.max(1, Math.min(options.limit ?? 50, 500));
  const where = ["workspace_id = ?"];
  const params: unknown[] = [workspaceId];
  if (options.employeeName) {
    where.push("employee_name = ?");
    params.push(options.employeeName.trim());
  }
  const rows = getDatabase().prepare(
    `${RECOVERY_COLUMNS} FROM employee_recovery_operation WHERE ${where.join(" AND ")} ORDER BY created_at DESC LIMIT ${limit}`,
  ).all(...params) as Array<Record<string, unknown>>;
  return rows.map(mapRecoveryRecord).filter((r): r is EmployeeRecoveryOperationRecord => r !== null);
}

/** Advance to the next phase; idempotent if already at/ past that phase. */
export function advanceRecoveryPhaseSync(input: {
  operationId: string;
  phase: RecoveryPhase;
  contextJson?: string;
  workspaceId?: string;
}): EmployeeRecoveryOperationRecord {
  const db = getDatabase();
  const workspaceId = input.workspaceId ?? DEFAULT_WORKSPACE_ID;
  const now = new Date().toISOString();
  const sets = ["phase = ?", "error_code = NULL", "error_message = NULL", "updated_at = ?"];
  const params: unknown[] = [input.phase, now];
  if (input.contextJson !== undefined) {
    sets.push("context_json = ?");
    params.push(input.contextJson);
  }
  params.push(input.operationId, workspaceId);
  const result = db.prepare(
    `UPDATE employee_recovery_operation SET ${sets.join(", ")} WHERE id = ? AND workspace_id = ?`,
  ).run(...params);
  if (result.changes === 0) {
    throw new Error(`Recovery operation "${input.operationId}" does not exist.`);
  }
  return readRecoveryOperationSync(input.operationId, workspaceId)!;
}

export function failRecoveryOperationSync(input: {
  operationId: string;
  errorCode?: string;
  errorMessage: string;
  phase?: RecoveryPhase;
  contextJson?: string;
  workspaceId?: string;
}): EmployeeRecoveryOperationRecord {
  const db = getDatabase();
  const workspaceId = input.workspaceId ?? DEFAULT_WORKSPACE_ID;
  const now = new Date().toISOString();
  const sets = ["phase = ?", "error_code = ?", "error_message = ?", "updated_at = ?"];
  const params: unknown[] = [input.phase ?? "failed", input.errorCode?.trim() || null, input.errorMessage, now];
  if (input.contextJson !== undefined) {
    sets.push("context_json = ?");
    params.push(input.contextJson);
  }
  params.push(input.operationId, workspaceId);
  const result = db.prepare(
    `UPDATE employee_recovery_operation SET ${sets.join(", ")} WHERE id = ? AND workspace_id = ?`,
  ).run(...params);
  if (result.changes === 0) {
    throw new Error(`Recovery operation "${input.operationId}" does not exist.`);
  }
  return readRecoveryOperationSync(input.operationId, workspaceId)!;
}

/**
 * Updates the operation context JSON without changing phase. Used by the async
 * recovery phases to record in-flight handles (provisioning task id, mount op
 * id, plan-created flag) while staying in the same phase across worker ticks.
 */
export function updateRecoveryContextSync(input: {
  operationId: string;
  workspaceId?: string;
  contextJson: string;
}): EmployeeRecoveryOperationRecord {
  const db = getDatabase();
  const workspaceId = input.workspaceId ?? DEFAULT_WORKSPACE_ID;
  db.prepare(
    `UPDATE employee_recovery_operation SET context_json = ?, updated_at = ?
     WHERE id = ? AND workspace_id = ?`,
  ).run(input.contextJson, new Date().toISOString(), input.operationId, workspaceId);
  const record = readRecoveryOperationSync(input.operationId, workspaceId);
  if (!record) {
    throw new Error(`Recovery operation "${input.operationId}" does not exist.`);
  }
  return record;
}

export function approveRecoveryOperationSync(input: {
  operationId: string;
  workspaceId?: string;
  approvedByUserId: string;
}): EmployeeRecoveryOperationRecord {
  const db = getDatabase();
  const workspaceId = input.workspaceId ?? DEFAULT_WORKSPACE_ID;
  const now = new Date().toISOString();
  db.prepare(
    `UPDATE employee_recovery_operation
       SET approval_state = 'approved', approved_by_user_id = ?, approved_at = ?, updated_at = ?
     WHERE id = ? AND workspace_id = ? AND approval_state = 'pending'`,
  ).run(input.approvedByUserId, now, now, input.operationId, workspaceId);
  return readRecoveryOperationSync(input.operationId, workspaceId)!;
}

export function rejectRecoveryOperationSync(input: {
  operationId: string;
  workspaceId?: string;
  approvedByUserId: string;
}): EmployeeRecoveryOperationRecord {
  const db = getDatabase();
  const workspaceId = input.workspaceId ?? DEFAULT_WORKSPACE_ID;
  const now = new Date().toISOString();
  db.prepare(
    `UPDATE employee_recovery_operation
       SET approval_state = 'rejected', approved_by_user_id = ?, approved_at = ?, updated_at = ?
     WHERE id = ? AND workspace_id = ? AND approval_state = 'pending'`,
  ).run(input.approvedByUserId, now, now, input.operationId, workspaceId);
  return readRecoveryOperationSync(input.operationId, workspaceId)!;
}

/* ------------------------------------------------------------------ */
/* Mapper                                                              */
/* ------------------------------------------------------------------ */

function mapRecoveryRecord(value: Record<string, unknown>): EmployeeRecoveryOperationRecord | null {
  if (
    typeof value.id !== "string" ||
    typeof value.workspaceId !== "string" ||
    typeof value.employeeId !== "string" ||
    typeof value.employeeName !== "string" ||
    typeof value.toGeneration !== "number" ||
    typeof value.phase !== "string" ||
    typeof value.contextJson !== "string" ||
    typeof value.createdAt !== "string" ||
    typeof value.updatedAt !== "string"
  ) {
    return null;
  }
  return {
    id: value.id,
    workspaceId: value.workspaceId,
    employeeId: value.employeeId,
    employeeName: value.employeeName,
    fromGeneration: typeof value.fromGeneration === "number" ? value.fromGeneration : undefined,
    toGeneration: value.toGeneration,
    phase: value.phase as RecoveryPhase,
    targetRevisionId: readOptionalString(value.targetRevisionId),
    requestedByUserId: readOptionalString(value.requestedByUserId),
    errorCode: readOptionalString(value.errorCode),
    errorMessage: readOptionalString(value.errorMessage),
    contextJson: value.contextJson,
    provisioningTaskId: readOptionalString(value.provisioningTaskId),
    mountOperationId: readOptionalString(value.mountOperationId),
    healthCheckedAt: readOptionalString(value.healthCheckedAt),
    approvalState: readOptionalApprovalState(value.approvalState),
    approvedByUserId: readOptionalString(value.approvedByUserId),
    approvedAt: readOptionalString(value.approvedAt),
    actorUserId: readOptionalString(value.actorUserId),
    createdAt: value.createdAt,
    updatedAt: value.updatedAt,
  };
}

function readOptionalApprovalState(value: unknown): EmployeeRecoveryOperationRecord["approvalState"] {
  return value === "pending" || value === "approved" || value === "rejected" || value === "not_required"
    ? value
    : undefined;
}

function readOptionalString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value : undefined;
}

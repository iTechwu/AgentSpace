import { DEFAULT_WORKSPACE_ID, getDatabase, randomLikeId, withTransaction } from "./database.ts";
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
  /** Number of admin approvals required before the worker can proceed. Default 1. */
  requiredApprovals?: number;
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
  approved_by_user_id AS approvedByUserId, approved_at AS approvedAt,
  required_approvals AS requiredApprovals, approval_count AS approvalCount, approvers_json AS approversJson,
  actor_user_id AS actorUserId,
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
  const requiredApprovals = Math.max(1, Math.min(input.requiredApprovals ?? 1, 5));
  db.prepare(
    `INSERT INTO employee_recovery_operation (
      id, workspace_id, employee_id, employee_name, from_generation, to_generation, phase,
      target_revision_id, requested_by_user_id, error_code, error_message, context_json,
      approval_state, required_approvals, approval_count, approvers_json, actor_user_id, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, 'allocate', ?, ?, NULL, NULL, ?, ?, ?, ?, ?, ?, ?, ?)`,
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
    requiredApprovals,
    0,
    "[]",
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
    const employeeId = resolveStoredEmployeeIdSync(options.employeeName.trim(), workspaceId);
    if (!employeeId) return [];
    where.push("employee_id = ?");
    params.push(employeeId);
  }
  const rows = getDatabase().prepare(
    `${RECOVERY_COLUMNS} FROM employee_recovery_operation WHERE ${where.join(" AND ")} ORDER BY created_at DESC LIMIT ${limit}`,
  ).all(...params) as Array<Record<string, unknown>>;
  return rows.map(mapRecoveryRecord).filter((r): r is EmployeeRecoveryOperationRecord => r !== null);
}

export function readActiveRecoveryOperationSync(options: {
  employeeName: string;
  workspaceId?: string;
}): EmployeeRecoveryOperationRecord | null {
  const workspaceId = options.workspaceId ?? DEFAULT_WORKSPACE_ID;
  const employeeId = resolveStoredEmployeeIdSync(options.employeeName.trim(), workspaceId);
  if (!employeeId) return null;
  const row = getDatabase().prepare(
    `${RECOVERY_COLUMNS} FROM employee_recovery_operation
     WHERE workspace_id = ? AND employee_id = ? AND phase NOT IN ('completed', 'failed')
     ORDER BY created_at DESC LIMIT 1`,
  ).get(workspaceId, employeeId) as Record<string, unknown> | undefined;
  return row ? mapRecoveryRecord(row) : null;
}

export interface ClaimedRecoveryOperation {
  id: string;
  workspaceId: string;
  leaseToken: string;
}

export function claimRecoveryOperationsForWorkerSync(input?: {
  workspaceId?: string;
  limit?: number;
  leaseSeconds?: number;
  excludeOperationIds?: string[];
}): ClaimedRecoveryOperation[] {
  const db = getDatabase();
  const limit = Math.max(1, Math.min(input?.limit ?? 25, 200));
  const now = new Date();
  const expiresAt = new Date(now.getTime() + Math.max(30, input?.leaseSeconds ?? 300) * 1000).toISOString();
  return withTransaction(db, () => {
    const params: unknown[] = [now.toISOString()];
    const workspaceClause = input?.workspaceId ? "AND workspace_id = ?" : "";
    if (input?.workspaceId) params.push(input.workspaceId);
    const excludedIds = (input?.excludeOperationIds ?? []).filter(Boolean);
    const excludeClause = excludedIds.length > 0
      ? `AND id NOT IN (${excludedIds.map(() => "?").join(", ")})`
      : "";
    params.push(...excludedIds);
    params.push(limit);
    const rows = db.prepare(
      `SELECT id, workspace_id AS workspaceId
       FROM employee_recovery_operation
       WHERE phase NOT IN ('completed', 'failed')
         AND (approval_state IS NULL OR approval_state IN ('not_required', 'approved'))
         AND (worker_lease_expires_at IS NULL OR worker_lease_expires_at <= ?)
         ${workspaceClause}
         ${excludeClause}
       ORDER BY created_at ASC
       LIMIT ?
       FOR UPDATE SKIP LOCKED`,
    ).all(...params) as Array<{ id: string; workspaceId: string }>;
    const claimed: ClaimedRecoveryOperation[] = [];
    for (const row of rows) {
      const leaseToken = `recovery-lease-${randomLikeId()}`;
      const result = db.prepare(
        `UPDATE employee_recovery_operation
           SET worker_lease_token = ?, worker_lease_expires_at = ?,
               worker_attempt = worker_attempt + 1, updated_at = ?
         WHERE id = ? AND workspace_id = ?
           AND phase NOT IN ('completed', 'failed')
           AND (worker_lease_expires_at IS NULL OR worker_lease_expires_at <= ?)`,
      ).run(leaseToken, expiresAt, now.toISOString(), row.id, row.workspaceId, now.toISOString());
      if (result.changes > 0) {
        claimed.push({ id: row.id, workspaceId: row.workspaceId, leaseToken });
      }
    }
    return claimed;
  });
}

export function releaseRecoveryOperationLeaseSync(input: {
  operationId: string;
  workspaceId?: string;
  leaseToken: string;
}): boolean {
  const workspaceId = input.workspaceId ?? DEFAULT_WORKSPACE_ID;
  const result = getDatabase().prepare(
    `UPDATE employee_recovery_operation
       SET worker_lease_token = NULL, worker_lease_expires_at = NULL, updated_at = ?
     WHERE id = ? AND workspace_id = ? AND worker_lease_token = ?`,
  ).run(new Date().toISOString(), input.operationId, workspaceId, input.leaseToken);
  return result.changes > 0;
}

/** Advance to the next phase; idempotent if already at/ past that phase. */
export function advanceRecoveryPhaseSync(input: {
  operationId: string;
  phase: RecoveryPhase;
  contextJson?: string;
  workspaceId?: string;
  workerLeaseToken?: string;
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
  const lease = recoveryMutationLeaseGuard(input.workerLeaseToken, now);
  params.push(input.operationId, workspaceId, ...lease.params);
  const result = db.prepare(
    `UPDATE employee_recovery_operation SET ${sets.join(", ")}
     WHERE id = ? AND workspace_id = ? ${lease.clause}`,
  ).run(...params);
  if (result.changes === 0) {
    throw new Error(`Recovery operation "${input.operationId}" changed or its worker lease was lost.`);
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
  workerLeaseToken?: string;
}): EmployeeRecoveryOperationRecord {
  const db = getDatabase();
  const workspaceId = input.workspaceId ?? DEFAULT_WORKSPACE_ID;
  return withTransaction(db, () => {
    const now = new Date().toISOString();
    const sets = ["phase = ?", "error_code = ?", "error_message = ?", "updated_at = ?"];
    const params: unknown[] = [input.phase ?? "failed", input.errorCode?.trim() || null, input.errorMessage, now];
    if (input.contextJson !== undefined) {
      sets.push("context_json = ?");
      params.push(input.contextJson);
    }
    const lease = recoveryMutationLeaseGuard(input.workerLeaseToken, now);
    params.push(input.operationId, workspaceId, ...lease.params);
    const result = db.prepare(
      `UPDATE employee_recovery_operation SET ${sets.join(", ")}
       WHERE id = ? AND workspace_id = ? ${lease.clause}`,
    ).run(...params);
    if (result.changes === 0) {
      throw new Error(`Recovery operation "${input.operationId}" changed or its worker lease was lost.`);
    }
    db.prepare(
      `UPDATE employee_runtime_binding SET status = 'needs_attention', updated_at = ?
       WHERE workspace_id = ? AND employee_id = (
         SELECT employee_id FROM employee_recovery_operation WHERE id = ? AND workspace_id = ?
       )`,
    ).run(now, workspaceId, input.operationId, workspaceId);
    return readRecoveryOperationSync(input.operationId, workspaceId)!;
  });
}

export function retryRecoveryOperationSync(input: {
  operationId: string;
  workspaceId?: string;
}): EmployeeRecoveryOperationRecord {
  const db = getDatabase();
  const workspaceId = input.workspaceId ?? DEFAULT_WORKSPACE_ID;
  const operation = readRecoveryOperationSync(input.operationId, workspaceId);
  if (!operation || operation.phase !== "failed" || operation.approvalState === "rejected") {
    throw new Error(`Recovery operation "${input.operationId}" is not retryable.`);
  }
  const active = db.prepare(
    `SELECT id FROM employee_recovery_operation
     WHERE workspace_id = ? AND employee_id = ? AND id <> ?
       AND phase NOT IN ('completed', 'failed') LIMIT 1`,
  ).get(workspaceId, operation.employeeId, operation.id) as { id?: string } | undefined;
  if (active?.id) {
    throw new Error(`Employee recovery "${active.id}" is already active.`);
  }
  let context: Record<string, unknown>;
  try {
    context = JSON.parse(operation.contextJson) as Record<string, unknown>;
  } catch {
    context = {};
  }
  const failedPhase = context.failedPhase;
  if (
    failedPhase !== "allocate"
    && failedPhase !== "mount_workspace"
    && failedPhase !== "install_skills"
    && failedPhase !== "resolve_secrets"
    && failedPhase !== "health_check"
    && failedPhase !== "activate"
  ) {
    throw new Error(`Recovery operation "${input.operationId}" has no retryable failed phase.`);
  }
  delete context.failedAt;
  delete context.failedPhase;
  delete context.waitingFor;
  if (failedPhase === "allocate") {
    delete context.provisioningTaskId;
  } else if (failedPhase === "mount_workspace") {
    delete context.mountOperationId;
  } else if (failedPhase === "install_skills") {
    delete context.plansCreated;
  }
  return withTransaction(db, () => {
    const now = new Date().toISOString();
    const result = db.prepare(
      `UPDATE employee_recovery_operation
         SET phase = ?, error_code = NULL, error_message = NULL, context_json = ?, updated_at = ?
       WHERE id = ? AND workspace_id = ? AND phase = 'failed'`,
    ).run(failedPhase, JSON.stringify(context), now, input.operationId, workspaceId);
    if (result.changes === 0) {
      throw new Error(`Recovery operation "${input.operationId}" changed while retrying.`);
    }
    db.prepare(
      `UPDATE employee_runtime_binding SET status = 'recovering', updated_at = ?
       WHERE workspace_id = ? AND employee_id = ?`,
    ).run(now, workspaceId, operation.employeeId);
    return readRecoveryOperationSync(input.operationId, workspaceId)!;
  });
}

export function completeRecoveryActivationSync(input: {
  operationId: string;
  runtimeId: string;
  expectedHeadRevisionId: string;
  contextJson: string;
  workspaceId?: string;
  workerLeaseToken?: string;
}): EmployeeRecoveryOperationRecord {
  const db = getDatabase();
  const workspaceId = input.workspaceId ?? DEFAULT_WORKSPACE_ID;
  return withTransaction(db, () => {
    const operation = readRecoveryOperationSync(input.operationId, workspaceId);
    if (!operation || operation.phase !== "activate") {
      throw new Error(`Recovery operation "${input.operationId}" is not ready to activate.`);
    }
    if (typeof operation.fromGeneration !== "number") {
      throw new Error("Recovery activation requires an existing binding generation.");
    }
    const runtime = db.prepare(
      "SELECT id FROM agent_runtime WHERE id = ? AND workspace_id = ?",
    ).get(input.runtimeId.trim(), workspaceId) as { id?: string } | undefined;
    if (!runtime?.id) {
      throw new Error(`Runtime "${input.runtimeId}" does not exist in workspace ${workspaceId}.`);
    }
    const workspace = db.prepare(
      `SELECT head_revision_id AS headRevisionId FROM employee_persistent_workspace
       WHERE workspace_id = ? AND employee_id = ?`,
    ).get(workspaceId, operation.employeeId) as { headRevisionId?: string | null } | undefined;
    if (workspace?.headRevisionId !== input.expectedHeadRevisionId) {
      throw new Error(
        `Workspace head changed after mount verification: expected ${input.expectedHeadRevisionId}, got ${workspace?.headRevisionId ?? "none"}.`,
      );
    }
    const now = new Date().toISOString();
    const binding = db.prepare(
      `UPDATE employee_runtime_binding
         SET runtime_id = ?, generation = ?, status = 'online', desired_provider = NULL, updated_at = ?
       WHERE workspace_id = ? AND employee_id = ? AND generation = ?`,
    ).run(
      input.runtimeId.trim(),
      operation.toGeneration,
      now,
      workspaceId,
      operation.employeeId,
      operation.fromGeneration,
    );
    if (binding.changes === 0) {
      throw new Error(
        `RECOVERY_ACTIVATION_CONFLICT: expected previous generation ${operation.fromGeneration}.`,
      );
    }
    const lease = recoveryMutationLeaseGuard(input.workerLeaseToken, now);
    const completed = db.prepare(
      `UPDATE employee_recovery_operation
         SET phase = 'completed', error_code = NULL, error_message = NULL,
             context_json = ?, updated_at = ?
       WHERE id = ? AND workspace_id = ? AND phase = 'activate' ${lease.clause}`,
    ).run(input.contextJson, now, input.operationId, workspaceId, ...lease.params);
    if (completed.changes === 0) {
      throw new Error(`Recovery operation "${input.operationId}" changed or its worker lease was lost during activation.`);
    }
    return readRecoveryOperationSync(input.operationId, workspaceId)!;
  });
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
  workerLeaseToken?: string;
}): EmployeeRecoveryOperationRecord {
  const db = getDatabase();
  const workspaceId = input.workspaceId ?? DEFAULT_WORKSPACE_ID;
  const now = new Date().toISOString();
  const lease = recoveryMutationLeaseGuard(input.workerLeaseToken, now);
  const result = db.prepare(
    `UPDATE employee_recovery_operation SET context_json = ?, updated_at = ?
     WHERE id = ? AND workspace_id = ? ${lease.clause}`,
  ).run(input.contextJson, now, input.operationId, workspaceId, ...lease.params);
  if (result.changes === 0) {
    throw new Error(`Recovery operation "${input.operationId}" changed or its worker lease was lost.`);
  }
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
  return withTransaction(db, () => {
    const operation = readRecoveryOperationSync(input.operationId, workspaceId);
    if (!operation) {
      throw new Error(`Recovery operation "${input.operationId}" does not exist.`);
    }
    if (operation.approvalState !== "pending") {
      throw new Error(`Recovery operation "${input.operationId}" is not pending approval.`);
    }
    const approvers = operation.approvers ?? [];
    if (approvers.some((a) => a.userId === input.approvedByUserId)) {
      throw new Error("You have already approved this recovery operation.");
    }
    const requiredApprovals = operation.requiredApprovals ?? 1;
    const nextCount = (operation.approvalCount ?? 0) + 1;
    const nextApprovers = [...approvers, { userId: input.approvedByUserId, approvedAt: new Date().toISOString() }];
    const now = new Date().toISOString();
    const isFullyApproved = nextCount >= requiredApprovals;
    db.prepare(
      `UPDATE employee_recovery_operation
         SET approval_count = ?, approvers_json = ?,
             approval_state = CASE WHEN ? THEN 'approved' ELSE 'pending' END,
             approved_by_user_id = ?, approved_at = ?, updated_at = ?
       WHERE id = ? AND workspace_id = ? AND approval_state = 'pending'`,
    ).run(
      nextCount,
      JSON.stringify(nextApprovers),
      isFullyApproved ? 1 : 0,
      input.approvedByUserId,
      now,
      now,
      input.operationId,
      workspaceId,
    );
    return readRecoveryOperationSync(input.operationId, workspaceId)!;
  });
}

export function rejectRecoveryOperationSync(input: {
  operationId: string;
  workspaceId?: string;
  approvedByUserId: string;
}): EmployeeRecoveryOperationRecord {
  const db = getDatabase();
  const workspaceId = input.workspaceId ?? DEFAULT_WORKSPACE_ID;
  return withTransaction(db, () => {
    const now = new Date().toISOString();
    const result = db.prepare(
      `UPDATE employee_recovery_operation
         SET approval_state = 'rejected', approved_by_user_id = ?, approved_at = ?,
             phase = 'failed', error_code = 'recovery_rejected',
             error_message = 'Recovery rejected by an administrator.', updated_at = ?
       WHERE id = ? AND workspace_id = ? AND approval_state = 'pending'`,
    ).run(input.approvedByUserId, now, now, input.operationId, workspaceId);
    if (result.changes === 0) {
      throw new Error(`Recovery operation "${input.operationId}" is not pending approval.`);
    }
    db.prepare(
      `UPDATE employee_runtime_binding SET status = 'needs_attention', updated_at = ?
       WHERE workspace_id = ? AND employee_id = (
         SELECT employee_id FROM employee_recovery_operation WHERE id = ? AND workspace_id = ?
       )`,
    ).run(now, workspaceId, input.operationId, workspaceId);
    return readRecoveryOperationSync(input.operationId, workspaceId)!;
  });
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
    requiredApprovals: typeof value.requiredApprovals === "number" ? value.requiredApprovals : undefined,
    approvalCount: typeof value.approvalCount === "number" ? value.approvalCount : undefined,
    approvers: readApproversJson(value.approversJson),
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

function readApproversJson(value: unknown): Array<{ userId: string; approvedAt: string }> | undefined {
  if (!Array.isArray(value)) return undefined;
  return value.filter((item): item is { userId: string; approvedAt: string } => {
    return (
      typeof item === "object" &&
      item !== null &&
      typeof (item as Record<string, unknown>).userId === "string" &&
      typeof (item as Record<string, unknown>).approvedAt === "string"
    );
  });
}

function readOptionalString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value : undefined;
}

function recoveryMutationLeaseGuard(
  workerLeaseToken: string | undefined,
  now: string,
): { clause: string; params: unknown[] } {
  const token = workerLeaseToken?.trim();
  if (token) {
    return {
      clause: "AND worker_lease_token = ? AND worker_lease_expires_at > ?",
      params: [token, now],
    };
  }
  return {
    clause: "AND (worker_lease_token IS NULL OR worker_lease_expires_at IS NULL OR worker_lease_expires_at <= ?)",
    params: [now],
  };
}

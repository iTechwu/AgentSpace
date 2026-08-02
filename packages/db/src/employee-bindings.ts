import { isDaemonProvider } from "@dofe-agent/domain";
import { getDatabase, withTransaction, DEFAULT_WORKSPACE_ID } from "./database.ts";
import { resolveStoredEmployeeIdSync } from "./workspace-employees.ts";
import type { EmployeeBindingStatus, EmployeeRuntimeBindingRecord } from "./types.ts";

export function bindEmployeeRuntimeSync(input: {
  workspaceId?: string;
  employeeName: string;
  runtimeId: string;
}): EmployeeRuntimeBindingRecord {
  const db = getDatabase();
  const workspaceId = input.workspaceId ?? DEFAULT_WORKSPACE_ID;
  const employeeName = input.employeeName.trim();
  const runtimeId = input.runtimeId.trim();
  const now = new Date().toISOString();

  if (!employeeName) {
    throw new Error("employeeName is required.");
  }
  if (!runtimeId) {
    throw new Error("runtimeId is required.");
  }

  const employeeId = resolveStoredEmployeeIdSync(employeeName, workspaceId);
  if (!employeeId) {
    throw new Error(`Employee "${employeeName}" does not exist.`);
  }

  const runtime = db
    .prepare(
      `SELECT
        id,
        provider,
        name
      FROM agent_runtime
      WHERE id = ? AND workspace_id = ?`,
    )
    .get(runtimeId, workspaceId) as Record<string, unknown> | undefined;
  if (!runtime || typeof runtime.provider !== "string" || typeof runtime.name !== "string") {
    throw new Error(`Runtime "${runtimeId}" does not exist.`);
  }

  // Each (re)bind atomically advances the binding generation (EAD-005). An
  // old runtime that comes back holds a stale generation and loses write rights.
  withTransaction(db, () => {
    const previous = db.prepare(
      `SELECT generation FROM employee_runtime_binding WHERE workspace_id = ? AND employee_id = ?`,
    ).get(workspaceId, employeeId) as { generation?: number } | undefined;
    const nextGeneration = typeof previous?.generation === "number" ? previous.generation + 1 : 1;

    db.prepare(
      `INSERT INTO employee_runtime_binding (
        workspace_id,
        employee_id,
        employee_name,
        runtime_id,
        status,
        generation,
        desired_provider,
        created_at,
        updated_at
      ) VALUES (?, ?, ?, ?, 'online', ?, ?, ?, ?)
      ON CONFLICT(workspace_id, employee_id) DO UPDATE SET
        employee_name = excluded.employee_name,
        runtime_id = excluded.runtime_id,
        status = 'online',
        generation = excluded.generation,
        desired_provider = excluded.desired_provider,
        updated_at = excluded.updated_at`,
    ).run(workspaceId, employeeId, employeeName, runtimeId, nextGeneration, runtime.provider, now, now);
  });

  return readEmployeeRuntimeBindingSync(employeeName, workspaceId)!;
}

/** Sets the EAD-002 binding status (offline/degraded/recovering/needs_attention/online). */
export function setEmployeeBindingStatusSync(
  employeeName: string,
  status: EmployeeBindingStatus,
  workspaceId = DEFAULT_WORKSPACE_ID,
): EmployeeRuntimeBindingRecord | null {
  const db = getDatabase();
  const employeeId = resolveStoredEmployeeIdSync(employeeName, workspaceId);
  if (!employeeId) return null;
  const now = new Date().toISOString();
  const result = db.prepare(
    `UPDATE employee_runtime_binding SET status = ?, updated_at = ?
     WHERE workspace_id = ? AND employee_id = ?`,
  ).run(status, now, workspaceId, employeeId);
  if (result.changes === 0) {
    return null;
  }
  return readEmployeeRuntimeBindingSync(employeeName, workspaceId);
}

/**
 * Reads the binding's current generation, used by the recovery orchestrator to
 * validate that an old runtime cannot write to a workspace it no longer owns.
 */
export function readEmployeeBindingGenerationSync(
  employeeName: string,
  workspaceId = DEFAULT_WORKSPACE_ID,
): number | undefined {
  const employeeId = resolveStoredEmployeeIdSync(employeeName, workspaceId);
  if (!employeeId) return undefined;
  const row = getDatabase().prepare(
    `SELECT generation FROM employee_runtime_binding WHERE workspace_id = ? AND employee_id = ?`,
  ).get(workspaceId, employeeId) as { generation?: number } | undefined;
  return typeof row?.generation === "number" ? row.generation : undefined;
}

/**
 * Strict write-lease guard (EAD-005). Throws unless the binding's current
 * generation EXACTLY equals `expectedGeneration`. Used by the output-promotion
 * and task-completion write paths so an old runtime (or a racing bind) cannot
 * publish into a workspace it no longer owns.
 */
export function assertEmployeeBindingGenerationSync(
  employeeName: string,
  expectedGeneration: number,
  workspaceId = DEFAULT_WORKSPACE_ID,
): number {
  const current = readEmployeeBindingGenerationSync(employeeName, workspaceId);
  if (typeof current !== "number") {
    throw new Error(`Employee "${employeeName.trim()}" has no runtime binding; cannot write.`);
  }
  if (current !== expectedGeneration) {
    throw new Error(
      `STALE_BINDING_GENERATION: current generation is ${current}, expected exactly ${expectedGeneration}. ` +
        `Only the current binding lease may write.`,
    );
  }
  return current;
}

/**
 * Recovery activation: atomically switches the CURRENT binding to the target
 * runtime AND the operation's target generation, and marks it online. This is
 * the ONLY step that promotes the provisional recovery to the live binding
 * (EAD-005: "原子切换 binding generation"). The old runtime keeps a stale
 * generation and loses write rights. Guarded against a concurrent rebind: the
 * expected previous generation must still be current, else it is a conflict.
 */
export function activateRecoveryBindingSync(input: {
  workspaceId?: string;
  employeeName: string;
  runtimeId: string;
  generation: number;
  expectedPreviousGeneration?: number;
}): EmployeeRuntimeBindingRecord {
  const db = getDatabase();
  const workspaceId = input.workspaceId ?? DEFAULT_WORKSPACE_ID;
  const employeeName = input.employeeName.trim();
  const runtimeId = input.runtimeId.trim();
  const employeeId = resolveStoredEmployeeIdSync(employeeName, workspaceId);
  const now = new Date().toISOString();

  if (!employeeName) {
    throw new Error("employeeName is required.");
  }
  if (!runtimeId) {
    throw new Error("runtimeId is required.");
  }
  if (!employeeId) {
    throw new Error(`Employee "${employeeName}" does not exist.`);
  }

  const runtime = getDatabase().prepare(
    `SELECT id FROM agent_runtime WHERE id = ? AND workspace_id = ?`,
  ).get(runtimeId, workspaceId) as { id?: string } | undefined;
  if (typeof runtime?.id !== "string") {
    throw new Error(`Runtime "${runtimeId}" does not exist in workspace ${workspaceId}.`);
  }

  const params: unknown[] = [runtimeId, input.generation, now, workspaceId, employeeId];
  let where = "WHERE workspace_id = ? AND employee_id = ?";
  if (input.expectedPreviousGeneration !== undefined) {
    where += " AND generation = ?";
    params.push(input.expectedPreviousGeneration);
  }

  const result = db.prepare(
    `UPDATE employee_runtime_binding
       SET runtime_id = ?, generation = ?, status = 'online', desired_provider = NULL, updated_at = ?
     ${where}`,
  ).run(...params);

  if (result.changes === 0) {
    if (input.expectedPreviousGeneration !== undefined) {
      const current = readEmployeeBindingGenerationSync(employeeName, workspaceId);
      throw new Error(
        `RECOVERY_ACTIVATION_CONFLICT: expected previous generation ${input.expectedPreviousGeneration}, ` +
          `got ${typeof current === "number" ? current : "none"}. A concurrent rebind invalidated this recovery.`,
      );
    }
    throw new Error(`Employee "${employeeName}" has no runtime binding to activate.`);
  }
  return readEmployeeRuntimeBindingSync(employeeName, workspaceId)!;
}

export function unbindEmployeeRuntimeSync(employeeName: string, workspaceId = DEFAULT_WORKSPACE_ID): boolean {
  const db = getDatabase();
  const employeeId = resolveStoredEmployeeIdSync(employeeName, workspaceId);
  if (!employeeId) return false;
  const result = db
    .prepare(
      `DELETE FROM employee_runtime_binding
       WHERE workspace_id = ? AND employee_id = ?`,
    )
    .run(workspaceId, employeeId);
  return result.changes > 0;
}

export function deleteEmployeeExecutionStateSync(
  employeeName: string,
  workspaceId = DEFAULT_WORKSPACE_ID,
): { removedBinding: boolean; removedQueuedTasks: number } {
  const db = getDatabase();
  const normalizedEmployeeName = employeeName.trim();
  const employeeId = resolveStoredEmployeeIdSync(normalizedEmployeeName, workspaceId);
  if (!employeeId) {
    return { removedBinding: false, removedQueuedTasks: 0 };
  }
  let removedBinding = false;
  let removedQueuedTasks = 0;

  withTransaction(db, () => {
    const bindingResult = db
      .prepare(
        `DELETE FROM employee_runtime_binding
         WHERE workspace_id = ? AND employee_id = ?`,
      )
      .run(workspaceId, employeeId);
    removedBinding = bindingResult.changes > 0;

    const queueResult = db
      .prepare(
        `DELETE FROM agent_task_queue
         WHERE workspace_id = ? AND agent_id = ?`,
      )
      .run(workspaceId, normalizedEmployeeName);
    removedQueuedTasks = Number(queueResult.changes);
  });

  return { removedBinding, removedQueuedTasks };
}

export function readEmployeeRuntimeBindingSync(
  employeeName: string,
  workspaceId = DEFAULT_WORKSPACE_ID,
): EmployeeRuntimeBindingRecord | null {
  const db = getDatabase();
  const employeeId = resolveStoredEmployeeIdSync(employeeName, workspaceId);
  if (!employeeId) return null;
  const row = db
    .prepare(
      `SELECT
        erb.workspace_id AS workspaceId,
        erb.employee_id AS employeeId,
        erb.employee_name AS employeeName,
        erb.runtime_id AS runtimeId,
        ar.provider AS provider,
        ar.name AS runtimeName,
        erb.status AS status,
        erb.generation AS generation,
        erb.desired_provider AS desiredProvider,
        erb.created_at AS boundAt,
        erb.updated_at AS updatedAt
      FROM employee_runtime_binding erb
      JOIN agent_runtime ar ON ar.id = erb.runtime_id
      WHERE erb.workspace_id = ? AND erb.employee_id = ?`,
    )
    .get(workspaceId, employeeId) as Record<string, unknown> | undefined;

  return row ? mapEmployeeRuntimeBindingRecord(row) : null;
}

export function listEmployeeRuntimeBindingsSync(workspaceId = DEFAULT_WORKSPACE_ID): EmployeeRuntimeBindingRecord[] {
  const db = getDatabase();
  const rows = db
    .prepare(
      `SELECT
        erb.workspace_id AS workspaceId,
        erb.employee_id AS employeeId,
        erb.employee_name AS employeeName,
        erb.runtime_id AS runtimeId,
        ar.provider AS provider,
        ar.name AS runtimeName,
        erb.status AS status,
        erb.generation AS generation,
        erb.desired_provider AS desiredProvider,
        erb.created_at AS boundAt,
        erb.updated_at AS updatedAt
      FROM employee_runtime_binding erb
      JOIN agent_runtime ar ON ar.id = erb.runtime_id
      WHERE erb.workspace_id = ?
      ORDER BY erb.employee_name ASC`,
    )
    .all(workspaceId) as Array<Record<string, unknown>>;

  return rows
    .map((row) => mapEmployeeRuntimeBindingRecord(row))
    .filter((row): row is EmployeeRuntimeBindingRecord => row !== null);
}

function mapEmployeeRuntimeBindingRecord(value: Record<string, unknown>): EmployeeRuntimeBindingRecord | null {
  if (
    typeof value.workspaceId !== "string" ||
    typeof value.employeeId !== "string" ||
    typeof value.employeeName !== "string" ||
    typeof value.runtimeId !== "string" ||
    !isDaemonProvider(value.provider as string) ||
    typeof value.runtimeName !== "string" ||
    typeof value.status !== "string" ||
    typeof value.generation !== "number" ||
    typeof value.boundAt !== "string" ||
    typeof value.updatedAt !== "string"
  ) {
    return null;
  }

  return {
    workspaceId: value.workspaceId,
    employeeId: value.employeeId,
    employeeName: value.employeeName,
    runtimeId: value.runtimeId,
    provider: value.provider as EmployeeRuntimeBindingRecord["provider"],
    runtimeName: value.runtimeName,
    status: value.status as EmployeeBindingStatus,
    generation: value.generation,
    desiredProvider: readOptionalString(value.desiredProvider),
    boundAt: value.boundAt,
    updatedAt: value.updatedAt,
  };
}

function readOptionalString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value : undefined;
}

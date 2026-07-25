import type { ActiveEmployee } from "@dofe-agent/domain/workspace";
import { DEFAULT_WORKSPACE_ID, getDatabase, withTransaction } from "./database.ts";

export function listStoredEmployeesSync(workspaceId = DEFAULT_WORKSPACE_ID): ActiveEmployee[] {
  const db = getDatabase();
  const rows = db.prepare(
    `SELECT
      name,
      role,
      remark_name AS remarkName,
      owner_user_id AS ownerUserId,
      origin,
      summary,
      traits_json AS traitsJson,
      fit,
      status,
      instructions,
      channel_member_access AS channelMemberAccess,
      created_at AS createdAt,
      updated_at AS updatedAt
     FROM workspace_employee
     WHERE workspace_id = ?
     ORDER BY LOWER(name) ASC, name ASC`,
  ).all(workspaceId) as Array<Record<string, unknown>>;

  return rows
    .map(mapStoredEmployeeRecord)
    .filter((employee): employee is ActiveEmployee => employee !== null);
}

export function readStoredEmployeeSync(employeeName: string, workspaceId = DEFAULT_WORKSPACE_ID): ActiveEmployee | null {
  return listStoredEmployeesSync(workspaceId).find((employee) => employee.name === employeeName) ?? null;
}

export function createStoredEmployeeSync(employee: ActiveEmployee, workspaceId = DEFAULT_WORKSPACE_ID): ActiveEmployee {
  const db = getDatabase();
  const now = new Date().toISOString();
  db.prepare(
    `INSERT INTO workspace_employee (
      workspace_id,
      name,
      role,
      remark_name,
      owner_user_id,
      origin,
      summary,
      traits_json,
      fit,
      status,
      instructions,
      channel_member_access,
      version,
      created_at,
      updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?)`,
  ).run(
    workspaceId,
    employee.name,
    employee.role,
    employee.remarkName ?? null,
    employee.ownerUserId ?? null,
    employee.origin,
    employee.summary,
    JSON.stringify(employee.traits),
    employee.fit,
    employee.status,
    employee.instructions ?? "",
    employee.channelMemberAccess ?? (employee.ownerUserId ? "disabled" : "enabled"),
    now,
    now,
  );

  return readStoredEmployeeSync(employee.name, workspaceId) ?? employee;
}

export function updateStoredEmployeeSync(employeeName: string, next: ActiveEmployee, workspaceId = DEFAULT_WORKSPACE_ID): ActiveEmployee | null {
  const db = getDatabase();
  const now = new Date().toISOString();
  const result = db.prepare(
    `UPDATE workspace_employee
     SET role = ?,
         remark_name = ?,
         owner_user_id = ?,
         origin = ?,
         summary = ?,
         traits_json = ?,
         fit = ?,
         status = ?,
         instructions = ?,
         channel_member_access = ?,
         version = version + 1,
         updated_at = ?
     WHERE workspace_id = ? AND name = ?`,
  ).run(
    next.role,
    next.remarkName ?? null,
    next.ownerUserId ?? null,
    next.origin,
    next.summary,
    JSON.stringify(next.traits),
    next.fit,
    next.status,
    next.instructions ?? "",
    next.channelMemberAccess ?? (next.ownerUserId ? "disabled" : "enabled"),
    now,
    workspaceId,
    employeeName,
  );
  if (result.changes === 0) {
    return null;
  }

  return readStoredEmployeeSync(next.name, workspaceId);
}

export function deleteStoredEmployeeSync(employeeName: string, workspaceId = DEFAULT_WORKSPACE_ID): boolean {
  const db = getDatabase();
  const result = db.prepare(
    `DELETE FROM workspace_employee
     WHERE workspace_id = ? AND name = ?`,
  ).run(workspaceId, employeeName);
  return result.changes > 0;
}

export function replaceStoredEmployeesSync(employees: ActiveEmployee[], workspaceId = DEFAULT_WORKSPACE_ID): void {
  const db = getDatabase();
  withTransaction(db, () => {
    db.prepare("DELETE FROM workspace_employee WHERE workspace_id = ?").run(workspaceId);
    for (const employee of employees) {
      createStoredEmployeeSync(employee, workspaceId);
    }
  });
}

function mapStoredEmployeeRecord(row: Record<string, unknown>): ActiveEmployee | null {
  if (
    typeof row.name !== "string" ||
    typeof row.role !== "string" ||
    typeof row.origin !== "string" ||
    typeof row.summary !== "string" ||
    typeof row.fit !== "string"
  ) {
    return null;
  }

  return {
    name: row.name,
    role: row.role,
    remarkName: typeof row.remarkName === "string" ? row.remarkName : undefined,
    ownerUserId: typeof row.ownerUserId === "string" ? row.ownerUserId : undefined,
    origin: row.origin,
    summary: row.summary,
    traits: parseStringArray(typeof row.traitsJson === "string" ? row.traitsJson : "[]"),
    fit: row.fit,
    skillIds: [],
    channels: [],
    status: row.status === "active" ? "active" : "active",
    instructions: typeof row.instructions === "string" ? row.instructions : "",
    channelMemberAccess:
      row.channelMemberAccess === "enabled" || row.channelMemberAccess === "disabled"
        ? row.channelMemberAccess
        : typeof row.ownerUserId === "string" && row.ownerUserId.trim().length > 0
          ? "disabled"
          : "enabled",
  };
}

function parseStringArray(json: string): string[] {
  try {
    const parsed = JSON.parse(json) as unknown;
    return Array.isArray(parsed) ? parsed.filter((item): item is string => typeof item === "string") : [];
  } catch {
    return [];
  }
}

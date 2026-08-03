import { createHash } from "node:crypto";
import { DEFAULT_WORKSPACE_ID, getDatabase, randomLikeId } from "./database.ts";
import { recordAuditLogSync } from "./audit-log.ts";
import type {
  EmployeeDataLegalHoldRecord,
  EmployeeDataLegalHoldResourceType,
} from "./types.ts";

export interface CreateEmployeeDataLegalHoldInput {
  workspaceId?: string;
  employeeId?: string;
  resourceType: EmployeeDataLegalHoldResourceType;
  resourceId: string;
  reason: string;
  /** Legal case / ticket reference (e.g. "LEG-2026-0142"). */
  caseReference?: string;
  createdByUserId?: string;
  createdByDisplayName?: string;
  expiresAt?: string;
}

const HOLD_COLUMNS = `SELECT
  id, workspace_id AS workspaceId, employee_id AS employeeId,
  resource_type AS resourceType, resource_id AS resourceId, reason,
  case_reference AS caseReference,
  created_by_user_id AS createdByUserId, created_by_display_name AS createdByDisplayName,
  created_at AS createdAt, expires_at AS expiresAt, released_at AS releasedAt,
  released_by_user_id AS releasedByUserId, release_reason AS releaseReason`;

export function createEmployeeDataLegalHoldSync(
  input: CreateEmployeeDataLegalHoldInput,
): EmployeeDataLegalHoldRecord {
  const workspaceId = input.workspaceId ?? DEFAULT_WORKSPACE_ID;
  const resourceId = input.resourceId.trim().toLowerCase();
  const reason = input.reason.trim();
  if (!resourceId) throw new Error("Legal hold resource id is required.");
  if (!reason) throw new Error("Legal hold reason is required.");
  if (input.expiresAt && (!Number.isFinite(Date.parse(input.expiresAt)) || Date.parse(input.expiresAt) <= Date.now())) {
    throw new Error("Legal hold expiration must be in the future.");
  }
  assertLegalHoldResourceExists(workspaceId, input.resourceType, resourceId, input.employeeId);
  const id = `legal-hold-${randomLikeId()}`;
  const now = new Date().toISOString();
  getDatabase().prepare(
    `INSERT INTO employee_data_legal_hold (
       id, workspace_id, employee_id, resource_type, resource_id, reason,
       case_reference, created_by_user_id, created_by_display_name, created_at, expires_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    id,
    workspaceId,
    input.employeeId ?? null,
    input.resourceType,
    resourceId,
    reason,
    input.caseReference?.trim() || null,
    input.createdByUserId ?? null,
    input.createdByDisplayName ?? null,
    now,
    input.expiresAt ?? null,
  );
  recordAuditLogSync({
    workspaceId,
    title: "Employee data legal hold created",
    note: `Legal hold ${id} was created for ${input.resourceType} ${resourceId}.`,
    code: "employee.data_legal_hold_created",
    data: {
      actorType: "session_user",
      actorUserId: input.createdByUserId,
      resourceType: input.resourceType,
      resourceId,
      employeeId: input.employeeId,
      legalHoldId: id,
      expiresAt: input.expiresAt,
    },
  });
  return readEmployeeDataLegalHoldSync(id, workspaceId)!;
}

export function releaseEmployeeDataLegalHoldSync(input: {
  id: string;
  workspaceId?: string;
  releasedByUserId?: string;
  releaseReason: string;
}): EmployeeDataLegalHoldRecord {
  const workspaceId = input.workspaceId ?? DEFAULT_WORKSPACE_ID;
  const releaseReason = input.releaseReason.trim();
  if (!releaseReason) throw new Error("Legal hold release reason is required.");
  const now = new Date().toISOString();
  const result = getDatabase().prepare(
    `UPDATE employee_data_legal_hold
        SET released_at = ?, released_by_user_id = ?, release_reason = ?
      WHERE id = ? AND workspace_id = ? AND released_at IS NULL`,
  ).run(now, input.releasedByUserId ?? null, releaseReason, input.id, workspaceId);
  if (result.changes === 0) throw new Error(`Active legal hold "${input.id}" does not exist.`);
  const hold = readEmployeeDataLegalHoldSync(input.id, workspaceId)!;
  recordAuditLogSync({
    workspaceId,
    title: "Employee data legal hold released",
    note: `Legal hold ${input.id} was released.`,
    code: "employee.data_legal_hold_released",
    data: {
      actorType: "session_user",
      actorUserId: input.releasedByUserId,
      resourceType: hold.resourceType,
      resourceId: hold.resourceId,
      employeeId: hold.employeeId,
      legalHoldId: hold.id,
    },
  });
  return hold;
}

export function readEmployeeDataLegalHoldSync(
  id: string,
  workspaceId = DEFAULT_WORKSPACE_ID,
): EmployeeDataLegalHoldRecord | null {
  const row = getDatabase().prepare(
    `${HOLD_COLUMNS} FROM employee_data_legal_hold WHERE id = ? AND workspace_id = ?`,
  ).get(id, workspaceId) as Record<string, unknown> | undefined;
  return row ? mapLegalHoldRecord(row) : null;
}

export function listEmployeeDataLegalHoldsSync(options: {
  workspaceId?: string;
  employeeId?: string;
  activeOnly?: boolean;
  limit?: number;
} = {}): EmployeeDataLegalHoldRecord[] {
  const workspaceId = options.workspaceId ?? DEFAULT_WORKSPACE_ID;
  const limit = Math.max(1, Math.min(options.limit ?? 200, 500));
  const where = ["workspace_id = ?"];
  const params: unknown[] = [workspaceId];
  if (options.employeeId) {
    where.push("employee_id = ?");
    params.push(options.employeeId);
  }
  if (options.activeOnly) {
    where.push("released_at IS NULL", "(expires_at IS NULL OR expires_at > NOW())");
  }
  const rows = getDatabase().prepare(
    `${HOLD_COLUMNS} FROM employee_data_legal_hold WHERE ${where.join(" AND ")}
      ORDER BY created_at DESC LIMIT ${limit}`,
  ).all(...params) as Array<Record<string, unknown>>;
  return rows.map(mapLegalHoldRecord).filter((row): row is EmployeeDataLegalHoldRecord => row !== null);
}

function assertLegalHoldResourceExists(
  workspaceId: string,
  resourceType: EmployeeDataLegalHoldResourceType,
  resourceId: string,
  employeeId?: string,
): void {
  const tableByType: Record<EmployeeDataLegalHoldResourceType, { table: string; idColumn: string }> = {
    employee_workspace: { table: "employee_persistent_workspace", idColumn: "id" },
    artifact: { table: "employee_artifact", idColumn: "id" },
    revision: { table: "employee_workspace_revision", idColumn: "id" },
    content_blob: { table: "content_blob", idColumn: "sha256" },
  };
  const target = tableByType[resourceType];
  const employeeFilter = employeeId && resourceType !== "content_blob" ? " AND employee_id = ?" : "";
  const params = employeeId && resourceType !== "content_blob"
    ? [workspaceId, resourceId, employeeId]
    : [workspaceId, resourceId];
  const exists = getDatabase().prepare(
    `SELECT 1 AS present FROM ${target.table}
      WHERE workspace_id = ? AND ${target.idColumn} = ?${employeeFilter}`,
  ).get(...params);
  if (!exists) throw new Error(`Legal hold resource "${resourceId}" does not exist in this workspace.`);
}

export interface EmployeeDataLegalHoldProof {
  workspaceId: string;
  exportedAt: string;
  /** The holds included in the proof (active retention obligations by default). */
  holds: EmployeeDataLegalHoldRecord[];
  /** sha256 over the exported hold identities — tamper-evident export fingerprint. */
  proofDigest: string;
}

/**
 * Produces a legal-export proof of the employee data legal holds in a workspace
 * (P1-6 导出能力). The proofDigest binds the exported set, so a legal team can
 * verify the export was not altered. Never includes raw resource contents.
 */
export function exportEmployeeDataLegalHoldProofSync(options: {
  workspaceId?: string;
  employeeId?: string;
  activeOnly?: boolean;
  limit?: number;
} = {}): EmployeeDataLegalHoldProof {
  const workspaceId = options.workspaceId ?? DEFAULT_WORKSPACE_ID;
  const holds = listEmployeeDataLegalHoldsSync({
    workspaceId,
    employeeId: options.employeeId,
    activeOnly: options.activeOnly ?? true,
    limit: options.limit,
  });
  const proofDigest = createHash("sha256")
    .update(
      JSON.stringify(
        holds.map((hold) => ({
          id: hold.id,
          resourceType: hold.resourceType,
          resourceId: hold.resourceId,
          employeeId: hold.employeeId,
          reason: hold.reason,
          caseReference: hold.caseReference,
          createdAt: hold.createdAt,
          releasedAt: hold.releasedAt,
        })),
      ),
    )
    .digest("hex");
  return { workspaceId, exportedAt: new Date().toISOString(), holds, proofDigest };
}

function mapLegalHoldRecord(value: Record<string, unknown>): EmployeeDataLegalHoldRecord | null {
  if (
    typeof value.id !== "string" ||
    typeof value.workspaceId !== "string" ||
    typeof value.resourceType !== "string" ||
    typeof value.resourceId !== "string" ||
    typeof value.reason !== "string" ||
    typeof value.createdAt !== "string"
  ) return null;
  return {
    id: value.id,
    workspaceId: value.workspaceId,
    employeeId: optionalString(value.employeeId),
    resourceType: value.resourceType as EmployeeDataLegalHoldResourceType,
    resourceId: value.resourceId,
    reason: value.reason,
    caseReference: optionalString(value.caseReference),
    createdByUserId: optionalString(value.createdByUserId),
    createdByDisplayName: optionalString(value.createdByDisplayName),
    createdAt: value.createdAt,
    expiresAt: optionalString(value.expiresAt),
    releasedAt: optionalString(value.releasedAt),
    releasedByUserId: optionalString(value.releasedByUserId),
    releaseReason: optionalString(value.releaseReason),
  };
}

function optionalString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

import { createHash } from "node:crypto";
import { DEFAULT_WORKSPACE_ID, getDatabase, randomLikeId, withTransaction } from "./database.ts";
import { resolveStoredEmployeeIdSync } from "./workspace-employees.ts";
import type {
  EmployeeArtifactRecord,
  EmployeePersistentWorkspaceRecord,
  EmployeeWorkspaceRevisionRecord,
  WorkspaceRevisionStatus,
} from "./types.ts";

/* ------------------------------------------------------------------ */
/* Input interfaces                                                    */
/* ------------------------------------------------------------------ */

export interface EnsureEmployeePersistentWorkspaceInput {
  workspaceId?: string;
  employeeName: string;
  retentionPolicyJson?: string;
}

export interface CreateWorkspaceRevisionInput {
  workspaceId?: string;
  employeeName: string;
  parentRevisionId?: string;
  manifestDigest: string;
  manifestJson: string;
  sourceTaskId?: string;
  status?: WorkspaceRevisionStatus;
  createdBy?: string;
  /** `task_output` (explicit attachments) or `workdir_snapshot` (workDir capture). */
  sourceKind?: string;
}

export interface PublishEmployeeArtifactInput {
  workspaceId?: string;
  employeeName: string;
  contentDigest: string;
  mediaType: string;
  fileName: string;
  sizeBytes: number;
  sourceTaskId?: string;
}

/* ------------------------------------------------------------------ */
/* Column selectors                                                    */
/* ------------------------------------------------------------------ */

const WORKSPACE_COLUMNS = `SELECT
  id, workspace_id AS workspaceId, employee_id AS employeeId, employee_name AS employeeName,
  head_revision_id AS headRevisionId, storage_ref AS storageRef,
  retention_policy_json AS retentionPolicyJson, storage_health AS storageHealth,
  last_snapshot_at AS lastSnapshotAt, created_at AS createdAt, updated_at AS updatedAt`;

const REVISION_COLUMNS = `SELECT
  id, workspace_id AS workspaceId, workspace_id_ref AS workspaceIdRef,
  employee_id AS employeeId, employee_name AS employeeName,
  parent_revision_id AS parentRevisionId, manifest_digest AS manifestDigest,
  manifest_json AS manifestJson, source_task_id AS sourceTaskId, status,
  source_kind AS sourceKind, created_by AS createdBy, created_at AS createdAt`;

const ARTIFACT_COLUMNS = `SELECT
  id, workspace_id AS workspaceId, workspace_id_ref AS workspaceIdRef,
  employee_id AS employeeId, employee_name AS employeeName,
  content_digest AS contentDigest, media_type AS mediaType,
  file_name AS fileName, size_bytes AS sizeBytes, source_task_id AS sourceTaskId,
  published_at AS publishedAt, deleted_at AS deletedAt`;

/* ------------------------------------------------------------------ */
/* Employee ID resolution                                              */
/* ------------------------------------------------------------------ */

function resolveEmployeeId(employeeName: string, workspaceId: string): string {
  const id = resolveStoredEmployeeIdSync(employeeName, workspaceId);
  if (!id) {
    throw new Error(`Employee "${employeeName}" does not exist in workspace "${workspaceId}".`);
  }
  return id;
}

/* ------------------------------------------------------------------ */
/* Persistent workspace                                                */
/* ------------------------------------------------------------------ */

export function ensureEmployeePersistentWorkspaceSync(
  input: EnsureEmployeePersistentWorkspaceInput,
): EmployeePersistentWorkspaceRecord {
  const db = getDatabase();
  const workspaceId = input.workspaceId ?? DEFAULT_WORKSPACE_ID;
  const employeeName = input.employeeName.trim();
  if (!employeeName) {
    throw new Error("Employee name is required.");
  }
  const existing = readEmployeePersistentWorkspaceSync(employeeName, workspaceId);
  if (existing) {
    return existing;
  }
  const employeeId = resolveEmployeeId(employeeName, workspaceId);
  const id = `ews-${randomLikeId()}`;
  const now = new Date().toISOString();
  withTransaction(db, () => {
    db.prepare(
      `INSERT INTO employee_persistent_workspace (
        id, workspace_id, employee_id, employee_name, head_revision_id, storage_ref,
        retention_policy_json, storage_health, last_snapshot_at, created_at, updated_at
      ) VALUES (?, ?, ?, ?, NULL, NULL, ?, 'unknown', NULL, ?, ?)`,
    ).run(id, workspaceId, employeeId, employeeName, input.retentionPolicyJson ?? "{}", now, now);
  });
  const record = readEmployeePersistentWorkspaceSync(employeeName, workspaceId);
  if (!record) {
    throw new Error("Failed to persist employee workspace.");
  }
  return record;
}

export function readEmployeePersistentWorkspaceSync(
  employeeName: string,
  workspaceId = DEFAULT_WORKSPACE_ID,
): EmployeePersistentWorkspaceRecord | null {
  const row = getDatabase().prepare(
    `${WORKSPACE_COLUMNS} FROM employee_persistent_workspace WHERE workspace_id = ? AND employee_name = ?`,
  ).get(workspaceId, employeeName.trim()) as Record<string, unknown> | undefined;
  return row ? mapWorkspaceRecord(row) : null;
}

export function readEmployeePersistentWorkspaceByIdSync(
  employeeId: string,
  workspaceId = DEFAULT_WORKSPACE_ID,
): EmployeePersistentWorkspaceRecord | null {
  const row = getDatabase().prepare(
    `${WORKSPACE_COLUMNS} FROM employee_persistent_workspace WHERE workspace_id = ? AND employee_id = ?`,
  ).get(workspaceId, employeeId) as Record<string, unknown> | undefined;
  return row ? mapWorkspaceRecord(row) : null;
}

export function listEmployeePersistentWorkspacesSync(
  workspaceId = DEFAULT_WORKSPACE_ID,
): EmployeePersistentWorkspaceRecord[] {
  const rows = getDatabase().prepare(
    `${WORKSPACE_COLUMNS} FROM employee_persistent_workspace WHERE workspace_id = ? ORDER BY employee_name ASC`,
  ).all(workspaceId) as Array<Record<string, unknown>>;
  return rows.map(mapWorkspaceRecord).filter((r): r is EmployeePersistentWorkspaceRecord => r !== null);
}

export function updateWorkspaceStorageHealthSync(input: {
  employeeName: string;
  workspaceId?: string;
  storageHealth: string;
  lastSnapshotAt?: string;
}): EmployeePersistentWorkspaceRecord {
  const db = getDatabase();
  const workspaceId = input.workspaceId ?? DEFAULT_WORKSPACE_ID;
  const now = new Date().toISOString();
  const sets = ["storage_health = ?", "updated_at = ?"];
  const params: unknown[] = [input.storageHealth, now];
  if (input.lastSnapshotAt !== undefined) {
    sets.push("last_snapshot_at = ?");
    params.push(input.lastSnapshotAt);
  }
  params.push(input.employeeName.trim(), workspaceId);
  const result = db.prepare(
    `UPDATE employee_persistent_workspace SET ${sets.join(", ")} WHERE employee_name = ? AND workspace_id = ?`,
  ).run(...params);
  if (result.changes === 0) {
    throw new Error(`Employee workspace for "${input.employeeName}" does not exist.`);
  }
  return readEmployeePersistentWorkspaceSync(input.employeeName, workspaceId)!;
}

/* ------------------------------------------------------------------ */
/* Revisions                                                           */
/* ------------------------------------------------------------------ */

export function createWorkspaceRevisionSync(input: CreateWorkspaceRevisionInput): EmployeeWorkspaceRevisionRecord {
  const db = getDatabase();
  const workspaceId = input.workspaceId ?? DEFAULT_WORKSPACE_ID;
  const employeeName = input.employeeName.trim();
  const workspace = ensureEmployeePersistentWorkspaceSync({ workspaceId, employeeName });
  const digest = input.manifestDigest.trim().toLowerCase();
  if (!digest) {
    throw new Error("Revision manifest digest is required.");
  }
  // Idempotent: same (workspace, digest) returns the existing revision.
  const existing = db.prepare(
    `${REVISION_COLUMNS} FROM employee_workspace_revision WHERE workspace_id_ref = ? AND manifest_digest = ?`,
  ).get(workspace.id, digest) as Record<string, unknown> | undefined;
  if (existing) {
    return mapRevisionRecord(existing)!;
  }
  const id = `ewr-${randomLikeId()}`;
  const now = new Date().toISOString();
  db.prepare(
    `INSERT INTO employee_workspace_revision (
      id, workspace_id, workspace_id_ref, employee_id, employee_name, parent_revision_id,
      manifest_digest, manifest_json, source_task_id, status, source_kind, created_by, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    id,
    workspaceId,
    workspace.id,
    workspace.employeeId,
    employeeName,
    input.parentRevisionId?.trim() || null,
    digest,
    input.manifestJson,
    input.sourceTaskId?.trim() || null,
    input.status ?? "pending",
    input.sourceKind?.trim() || "task_output",
    input.createdBy?.trim() || null,
    now,
  );
  return readWorkspaceRevisionSync(id, workspaceId)!;
}

export function readWorkspaceRevisionSync(
  revisionId: string,
  workspaceId = DEFAULT_WORKSPACE_ID,
): EmployeeWorkspaceRevisionRecord | null {
  const row = getDatabase().prepare(
    `${REVISION_COLUMNS} FROM employee_workspace_revision WHERE id = ? AND workspace_id = ?`,
  ).get(revisionId, workspaceId) as Record<string, unknown> | undefined;
  return row ? mapRevisionRecord(row) : null;
}

export function readHeadRevisionSync(
  employeeName: string,
  workspaceId = DEFAULT_WORKSPACE_ID,
): EmployeeWorkspaceRevisionRecord | null {
  const ws = readEmployeePersistentWorkspaceSync(employeeName, workspaceId);
  if (!ws?.headRevisionId) {
    return null;
  }
  return readWorkspaceRevisionSync(ws.headRevisionId, workspaceId);
}

export function listWorkspaceRevisionsSync(options: {
  employeeName: string;
  workspaceId?: string;
  limit?: number;
}): EmployeeWorkspaceRevisionRecord[] {
  const workspaceId = options.workspaceId ?? DEFAULT_WORKSPACE_ID;
  const limit = Math.max(1, Math.min(options.limit ?? 50, 200));
  const rows = getDatabase().prepare(
    `${REVISION_COLUMNS} FROM employee_workspace_revision
     WHERE workspace_id = ? AND employee_name = ? ORDER BY created_at DESC LIMIT ${limit}`,
  ).all(workspaceId, options.employeeName.trim()) as Array<Record<string, unknown>>;
  return rows.map(mapRevisionRecord).filter((r): r is EmployeeWorkspaceRevisionRecord => r !== null);
}

/**
 * Atomically promote a pending revision to committed and advance the workspace
 * head. Split-brain guard: the revision's parent must equal the current head
 * (or head must be empty for the first commit). Throws on conflict.
 */
export function commitWorkspaceRevisionSync(
  revisionId: string,
  workspaceId = DEFAULT_WORKSPACE_ID,
): EmployeeWorkspaceRevisionRecord {
  const db = getDatabase();
  const revision = readWorkspaceRevisionSync(revisionId, workspaceId);
  if (!revision) {
    throw new Error(`Workspace revision "${revisionId}" does not exist.`);
  }
  if (revision.status === "committed") {
    return revision;
  }
  const workspace = readEmployeePersistentWorkspaceSync(revision.employeeName, workspaceId);
  if (!workspace) {
    throw new Error(`Employee workspace for "${revision.employeeName}" does not exist.`);
  }
  if (workspace.headRevisionId && revision.parentRevisionId && workspace.headRevisionId !== revision.parentRevisionId) {
    throw new Error(
      `REVISION_CONFLICT: revision parent ${revision.parentRevisionId} does not match head ${workspace.headRevisionId}.`,
    );
  }
  const now = new Date().toISOString();
  withTransaction(db, () => {
    db.prepare(
      `UPDATE employee_workspace_revision SET status = 'committed' WHERE id = ? AND workspace_id = ?`,
    ).run(revisionId, workspaceId);
    db.prepare(
      `UPDATE employee_persistent_workspace
         SET head_revision_id = ?, storage_health = 'healthy', last_snapshot_at = ?, updated_at = ?
       WHERE id = ? AND workspace_id = ?`,
    ).run(revisionId, now, now, workspace.id, workspaceId);
  });
  return readWorkspaceRevisionSync(revisionId, workspaceId)!;
}

/** Restore an old revision produces a NEW head revision (never overwrites history). */
export function restoreWorkspaceRevisionSync(input: {
  employeeName: string;
  targetRevisionId: string;
  createdBy?: string;
  workspaceId?: string;
}): EmployeeWorkspaceRevisionRecord {
  const workspaceId = input.workspaceId ?? DEFAULT_WORKSPACE_ID;
  const target = readWorkspaceRevisionSync(input.targetRevisionId, workspaceId);
  if (!target) {
    throw new Error(`Target revision "${input.targetRevisionId}" does not exist.`);
  }
  const head = readHeadRevisionSync(input.employeeName, workspaceId);
  // The restored head carries the target's EXACT manifest (same content, same
  // file set) but a deterministic restore digest derived from the target's
  // digest. Determinism makes re-running the same restore idempotent
  // (createWorkspaceRevisionSync returns the existing restore revision), and
  // the marker keeps it traceable without duplicating content rows.
  const restoredDigest = sha256Hex(`${target.manifestDigest}#restore`);
  const restored = createWorkspaceRevisionSync({
    workspaceId,
    employeeName: input.employeeName,
    parentRevisionId: head?.id,
    manifestDigest: restoredDigest,
    manifestJson: target.manifestJson,
    status: "pending",
    createdBy: input.createdBy,
  });
  return commitWorkspaceRevisionSync(restored.id, workspaceId);
}

/* ------------------------------------------------------------------ */
/* Published artifacts                                                 */
/* ------------------------------------------------------------------ */

export function publishEmployeeArtifactSync(input: PublishEmployeeArtifactInput): EmployeeArtifactRecord {
  const db = getDatabase();
  const workspaceId = input.workspaceId ?? DEFAULT_WORKSPACE_ID;
  const workspace = ensureEmployeePersistentWorkspaceSync({ workspaceId, employeeName: input.employeeName });
  const id = `eart-${randomLikeId()}`;
  const now = new Date().toISOString();
  db.prepare(
    `INSERT INTO employee_artifact (
      id, workspace_id, workspace_id_ref, employee_id, employee_name, content_digest, media_type,
      file_name, size_bytes, source_task_id, published_at, deleted_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL)`,
  ).run(
    id,
    workspaceId,
    workspace.id,
    workspace.employeeId,
    input.employeeName.trim(),
    input.contentDigest.trim().toLowerCase(),
    input.mediaType,
    input.fileName.trim(),
    input.sizeBytes,
    input.sourceTaskId?.trim() || null,
    now,
  );
  return readEmployeeArtifactSync(id, workspaceId)!;
}

export function readEmployeeArtifactSync(
  id: string,
  workspaceId = DEFAULT_WORKSPACE_ID,
): EmployeeArtifactRecord | null {
  const row = getDatabase().prepare(
    `${ARTIFACT_COLUMNS} FROM employee_artifact WHERE id = ? AND workspace_id = ?`,
  ).get(id, workspaceId) as Record<string, unknown> | undefined;
  return row ? mapArtifactRecord(row) : null;
}

export function listEmployeeArtifactsSync(options: {
  employeeName: string;
  workspaceId?: string;
  includeDeleted?: boolean;
  limit?: number;
}): EmployeeArtifactRecord[] {
  const workspaceId = options.workspaceId ?? DEFAULT_WORKSPACE_ID;
  const limit = Math.max(1, Math.min(options.limit ?? 100, 500));
  const where = ["workspace_id = ?", "employee_name = ?"];
  const params: unknown[] = [workspaceId, options.employeeName.trim()];
  if (!options.includeDeleted) {
    where.push("deleted_at IS NULL");
  }
  const rows = getDatabase().prepare(
    `${ARTIFACT_COLUMNS} FROM employee_artifact WHERE ${where.join(" AND ")} ORDER BY published_at DESC LIMIT ${limit}`,
  ).all(...params) as Array<Record<string, unknown>>;
  return rows.map(mapArtifactRecord).filter((r): r is EmployeeArtifactRecord => r !== null);
}

export function softDeleteEmployeeArtifactSync(id: string, workspaceId = DEFAULT_WORKSPACE_ID): boolean {
  const now = new Date().toISOString();
  const result = getDatabase().prepare(
    `UPDATE employee_artifact SET deleted_at = ? WHERE id = ? AND workspace_id = ? AND deleted_at IS NULL`,
  ).run(now, id, workspaceId);
  return result.changes > 0;
}

export function listEmployeeArtifactDigestsSync(workspaceId = DEFAULT_WORKSPACE_ID): string[] {
  const rows = getDatabase().prepare(
    `SELECT DISTINCT content_digest FROM employee_artifact WHERE workspace_id = ? AND deleted_at IS NULL`,
  ).all(workspaceId) as Array<{ contentDigest?: string }>;
  return rows.map((row) => row.contentDigest).filter((d): d is string => typeof d === "string");
}

export function listWorkspaceRevisionDigestsSync(workspaceId = DEFAULT_WORKSPACE_ID): string[] {
  // Revisions embed per-file blob digests in manifest_json; the revision's own
  // manifest_digest is a content hash of the manifest, not a blob digest. For
  // orphan scanning we collect the actual blob digests referenced by committed
  // revision manifests.
  const rows = getDatabase().prepare(
    `SELECT manifest_json FROM employee_workspace_revision
      WHERE workspace_id = ? AND status = 'committed'`,
  ).all(workspaceId) as Array<{ manifestJson?: string }>;
  const digests = new Set<string>();
  for (const row of rows) {
    if (typeof row.manifestJson !== "string") {
      continue;
    }
    try {
      const manifest = JSON.parse(row.manifestJson) as { files?: Array<{ sha256?: string }> };
      for (const file of manifest.files ?? []) {
        if (typeof file.sha256 === "string" && file.sha256.length > 0) {
          digests.add(file.sha256);
        }
      }
    } catch {
      // Unparseable manifest is not a blob reference.
    }
  }
  return [...digests];
}

/* ------------------------------------------------------------------ */
/* Mappers                                                             */
/* ------------------------------------------------------------------ */

function mapWorkspaceRecord(value: Record<string, unknown>): EmployeePersistentWorkspaceRecord | null {
  if (
    typeof value.id !== "string" ||
    typeof value.workspaceId !== "string" ||
    typeof value.employeeId !== "string" ||
    typeof value.employeeName !== "string" ||
    typeof value.retentionPolicyJson !== "string" ||
    typeof value.storageHealth !== "string" ||
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
    headRevisionId: readOptionalString(value.headRevisionId),
    storageRef: readOptionalString(value.storageRef),
    retentionPolicyJson: value.retentionPolicyJson,
    storageHealth: value.storageHealth,
    lastSnapshotAt: readOptionalString(value.lastSnapshotAt),
    createdAt: value.createdAt,
    updatedAt: value.updatedAt,
  };
}

function mapRevisionRecord(value: Record<string, unknown>): EmployeeWorkspaceRevisionRecord | null {
  if (
    typeof value.id !== "string" ||
    typeof value.workspaceId !== "string" ||
    typeof value.workspaceIdRef !== "string" ||
    typeof value.employeeId !== "string" ||
    typeof value.employeeName !== "string" ||
    typeof value.manifestDigest !== "string" ||
    typeof value.manifestJson !== "string" ||
    typeof value.status !== "string" ||
    typeof value.createdAt !== "string"
  ) {
    return null;
  }
  return {
    id: value.id,
    workspaceId: value.workspaceId,
    workspaceIdRef: value.workspaceIdRef,
    employeeId: value.employeeId,
    employeeName: value.employeeName,
    parentRevisionId: readOptionalString(value.parentRevisionId),
    manifestDigest: value.manifestDigest,
    manifestJson: value.manifestJson,
    sourceTaskId: readOptionalString(value.sourceTaskId),
    status: value.status as WorkspaceRevisionStatus,
    sourceKind: typeof value.sourceKind === "string" ? value.sourceKind : "task_output",
    createdBy: readOptionalString(value.createdBy),
    createdAt: value.createdAt,
  };
}

function mapArtifactRecord(value: Record<string, unknown>): EmployeeArtifactRecord | null {
  if (
    typeof value.id !== "string" ||
    typeof value.workspaceId !== "string" ||
    typeof value.workspaceIdRef !== "string" ||
    typeof value.employeeId !== "string" ||
    typeof value.employeeName !== "string" ||
    typeof value.contentDigest !== "string" ||
    typeof value.mediaType !== "string" ||
    typeof value.fileName !== "string" ||
    typeof value.sizeBytes !== "number" ||
    typeof value.publishedAt !== "string"
  ) {
    return null;
  }
  return {
    id: value.id,
    workspaceId: value.workspaceId,
    workspaceIdRef: value.workspaceIdRef,
    employeeId: value.employeeId,
    employeeName: value.employeeName,
    contentDigest: value.contentDigest,
    mediaType: value.mediaType,
    fileName: value.fileName,
    sizeBytes: value.sizeBytes,
    sourceTaskId: readOptionalString(value.sourceTaskId),
    publishedAt: value.publishedAt,
    deletedAt: readOptionalString(value.deletedAt),
  };
}

export function deleteEmployeeDurabilityRecordsSync(
  employeeName: string,
  workspaceId = DEFAULT_WORKSPACE_ID,
): void {
  const db = getDatabase();
  const normalized = employeeName.trim();
  if (!normalized) {
    throw new Error("Employee name is required.");
  }

  // Persistent workspace rows cascade to revisions and artifacts via FK.
  db.prepare(
    `DELETE FROM employee_persistent_workspace
     WHERE workspace_id = ? AND employee_name = ?`,
  ).run(workspaceId, normalized);

  db.prepare(
    `DELETE FROM employee_runtime_binding
     WHERE workspace_id = ? AND employee_name = ?`,
  ).run(workspaceId, normalized);

  db.prepare(
    `DELETE FROM employee_recovery_operation
     WHERE workspace_id = ? AND employee_name = ?`,
  ).run(workspaceId, normalized);

  db.prepare(
    `DELETE FROM task_commit_journal
     WHERE workspace_id = ? AND employee_name = ?`,
  ).run(workspaceId, normalized);
}

function readOptionalString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value : undefined;
}

function sha256Hex(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

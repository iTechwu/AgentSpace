import { DEFAULT_WORKSPACE_ID, getDatabase, randomLikeId, withTransaction } from "./database.ts";
import { recordAuditLogSync } from "./audit-log.ts";
import { resolveStoredEmployeeIdSync } from "./workspace-employees.ts";
import type {
  EmployeeArtifactRecord,
  EmployeeDurabilityUsageRecord,
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
  restoredFromRevisionId?: string;
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
  source_kind AS sourceKind, restored_from_revision_id AS restoredFromRevisionId,
  created_by AS createdBy, created_at AS createdAt`;

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
  const employeeId = resolveStoredEmployeeIdSync(employeeName.trim(), workspaceId);
  if (!employeeId) return null;
  const row = getDatabase().prepare(
    `${WORKSPACE_COLUMNS} FROM employee_persistent_workspace WHERE workspace_id = ? AND employee_id = ?`,
  ).get(workspaceId, employeeId) as Record<string, unknown> | undefined;
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
  const employeeId = resolveEmployeeId(input.employeeName, workspaceId);
  const now = new Date().toISOString();
  const sets = ["storage_health = ?", "updated_at = ?"];
  const params: unknown[] = [input.storageHealth, now];
  if (input.lastSnapshotAt !== undefined) {
    sets.push("last_snapshot_at = ?");
    params.push(input.lastSnapshotAt);
  }
  params.push(employeeId, workspaceId);
  const result = db.prepare(
    `UPDATE employee_persistent_workspace SET ${sets.join(", ")} WHERE employee_id = ? AND workspace_id = ?`,
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
  const sourceKind = input.sourceKind?.trim() || "task_output";
  const restoredFromRevisionId = input.restoredFromRevisionId?.trim() || null;
  // Ordinary task publishes remain content-idempotent. History restore is the
  // exception: it must create a new graph node with the SAME truthful content
  // digest, keyed by target/source + parent rather than falsifying the digest.
  const existing = restoredFromRevisionId
    ? db.prepare(
        `${REVISION_COLUMNS} FROM employee_workspace_revision
         WHERE workspace_id_ref = ? AND manifest_digest = ? AND restored_from_revision_id = ?
           AND parent_revision_id IS NOT DISTINCT FROM ?`,
      ).get(workspace.id, digest, restoredFromRevisionId, input.parentRevisionId?.trim() || null) as Record<string, unknown> | undefined
    : db.prepare(
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
      manifest_digest, manifest_json, source_task_id, status, source_kind,
      restored_from_revision_id, created_by, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
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
    sourceKind,
    restoredFromRevisionId,
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
  const employeeId = resolveStoredEmployeeIdSync(options.employeeName.trim(), workspaceId);
  if (!employeeId) return [];
  const limit = Math.max(1, Math.min(options.limit ?? 50, 200));
  const rows = getDatabase().prepare(
    `${REVISION_COLUMNS} FROM employee_workspace_revision
     WHERE workspace_id = ? AND employee_id = ? ORDER BY created_at DESC LIMIT ${limit}`,
  ).all(workspaceId, employeeId) as Array<Record<string, unknown>>;
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
    // Only a pending revision can be committed; a concurrent commit changes 0 rows.
    const revisionUpdate = db.prepare(
      `UPDATE employee_workspace_revision SET status = 'committed' WHERE id = ? AND workspace_id = ? AND status = 'pending'`,
    ).run(revisionId, workspaceId);
    if (revisionUpdate.changes === 0) {
      throw new Error("REVISION_CONFLICT: revision is no longer pending.");
    }
    // Expected-head CAS: advance head only while it still equals the revision's
    // parent (or the workspace has no head yet). A concurrent commit that moved
    // head between our pre-check and here fails the update and rolls back.
    const headUpdate = db.prepare(
      `UPDATE employee_persistent_workspace
         SET head_revision_id = ?, storage_health = 'healthy', last_snapshot_at = ?, updated_at = ?
       WHERE id = ? AND workspace_id = ?
         AND (head_revision_id IS NULL OR head_revision_id = ?)`,
    ).run(revisionId, now, now, workspace.id, workspaceId, revision.parentRevisionId);
    if (headUpdate.changes === 0) {
      throw new Error(
        `REVISION_CONFLICT: revision parent ${revision.parentRevisionId ?? "none"} does not match head.`,
      );
    }
  });
  return readWorkspaceRevisionSync(revisionId, workspaceId)!;
}

/** Restore an old revision produces a NEW head revision (never overwrites history). */
export function restoreWorkspaceRevisionSync(input: {
  employeeName: string;
  targetRevisionId: string;
  createdBy?: string;
  workspaceId?: string;
  audit?: {
    actorId: string;
    actorDisplayName: string;
  };
}): EmployeeWorkspaceRevisionRecord {
  const workspaceId = input.workspaceId ?? DEFAULT_WORKSPACE_ID;
  const workspace = ensureEmployeePersistentWorkspaceSync({
    workspaceId,
    employeeName: input.employeeName,
  });
  const target = readWorkspaceRevisionSync(input.targetRevisionId, workspaceId);
  if (!target) {
    throw new Error(`Target revision "${input.targetRevisionId}" does not exist.`);
  }
  if (target.workspaceIdRef !== workspace.id || target.employeeId !== workspace.employeeId) {
    throw new Error(
      `Target revision "${input.targetRevisionId}" does not belong to employee "${input.employeeName}".`,
    );
  }
  if (target.status !== "committed") {
    throw new Error(`Target revision "${input.targetRevisionId}" is not committed.`);
  }
  const head = readHeadRevisionSync(input.employeeName, workspaceId);
  // Retrying the same request before any intervening commit is idempotent.
  if (head?.sourceKind === "history_restore" && head.restoredFromRevisionId === target.id) {
    return head;
  }
  const db = getDatabase();
  return withTransaction(db, () => {
    const activeRecovery = db.prepare(
      `SELECT id FROM employee_recovery_operation
       WHERE workspace_id = ? AND employee_id = ? AND phase NOT IN ('completed', 'failed')
       LIMIT 1`,
    ).get(workspaceId, workspace.employeeId) as { id?: string } | undefined;
    if (activeRecovery?.id) {
      throw new Error(
        `EMPLOYEE_RECOVERY_ACTIVE: cannot restore workspace history while recovery "${activeRecovery.id}" is active.`,
      );
    }
    const currentHead = readHeadRevisionSync(input.employeeName, workspaceId);
    if (currentHead?.id !== head?.id) {
      throw new Error("REVISION_CONFLICT: workspace head changed while preparing history restore.");
    }
    const restored = createWorkspaceRevisionSync({
      workspaceId,
      employeeName: input.employeeName,
      parentRevisionId: head?.id,
      manifestDigest: target.manifestDigest,
      manifestJson: target.manifestJson,
      status: "pending",
      createdBy: input.createdBy,
      sourceKind: "history_restore",
      restoredFromRevisionId: target.id,
    });
    // Fence every task claimed before this restore. The generation update and
    // head promotion commit together, so a task sees either the old lease/head
    // or the new lease/head, never a mixed state.
    db.prepare(
      `UPDATE employee_runtime_binding
          SET generation = generation + 1, updated_at = ?
        WHERE workspace_id = ? AND employee_id = ?`,
    ).run(new Date().toISOString(), workspaceId, workspace.employeeId);
    const committed = commitWorkspaceRevisionSync(restored.id, workspaceId);
    if (input.audit) {
      recordAuditLogSync({
        workspaceId,
        title: "Employee workspace revision restored",
        note: `${input.audit.actorDisplayName} restored revision "${target.id}" for "${input.employeeName}" as new head "${committed.id}".`,
        code: "employee.workspace_revision_restored",
        source: "runtime_lifecycle",
        data: {
          actorType: "session_user",
          actorId: input.audit.actorId,
          resourceType: "employee_workspace_revision",
          resourceId: committed.id,
          employeeId: workspace.employeeId,
          employeeName: input.employeeName,
          targetRevisionId: target.id,
          restoredRevisionId: committed.id,
        },
      });
    }
    return committed;
  });
}

/* ------------------------------------------------------------------ */
/* Published artifacts                                                 */
/* ------------------------------------------------------------------ */

export function publishEmployeeArtifactSync(input: PublishEmployeeArtifactInput): EmployeeArtifactRecord {
  const db = getDatabase();
  const workspaceId = input.workspaceId ?? DEFAULT_WORKSPACE_ID;
  const sourceTaskId = input.sourceTaskId?.trim() || null;
  const contentDigest = input.contentDigest.trim().toLowerCase();
  const fileName = input.fileName.trim();

  // Idempotent publish: a task retry re-promoting the same (task, digest, file)
  // returns the existing non-deleted artifact instead of duplicating it.
  if (sourceTaskId) {
    const existing = db.prepare(
      `${ARTIFACT_COLUMNS} FROM employee_artifact
       WHERE workspace_id = ? AND source_task_id = ? AND content_digest = ? AND file_name = ? AND deleted_at IS NULL`,
    ).get(workspaceId, sourceTaskId, contentDigest, fileName) as Record<string, unknown> | undefined;
    if (existing) {
      return mapArtifactRecord(existing)!;
    }
  }

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
    contentDigest,
    input.mediaType,
    fileName,
    input.sizeBytes,
    sourceTaskId,
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
  const employeeId = resolveStoredEmployeeIdSync(options.employeeName.trim(), workspaceId);
  if (!employeeId) return [];
  const limit = Math.max(1, Math.min(options.limit ?? 100, 500));
  const where = ["workspace_id = ?", "employee_id = ?"];
  const params: unknown[] = [workspaceId, employeeId];
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

/**
 * Hard-deletes soft-deleted artifacts whose deletion window has expired, and
 * returns the content digests freed so the caller can run orphan-blob GC. The
 * soft-delete recovery window is the lifecycle policy's backstop: a wrongly
 * deleted artifact can be restored only within it (D-12 "软删除恢复窗口").
 */
export function hardDeleteExpiredSoftDeletedArtifactsSync(
  workspaceId: string,
  deletedBefore: string,
  employeeId?: string,
): { removed: number; held: number; digests: string[] } {
  const db = getDatabase();
  const employeeFilter = employeeId ? "AND artifact.employee_id = ?" : "";
  const params = employeeId ? [workspaceId, deletedBefore, employeeId] : [workspaceId, deletedBefore];
  const rows = db.prepare(
    `SELECT artifact.id, artifact.content_digest AS contentDigest,
       EXISTS (
         SELECT 1 FROM employee_data_legal_hold hold
          WHERE hold.workspace_id = artifact.workspace_id
            AND hold.released_at IS NULL
            AND (hold.expires_at IS NULL OR hold.expires_at > NOW())
            AND (
              (hold.resource_type = 'artifact' AND hold.resource_id = artifact.id)
              OR (hold.resource_type = 'employee_workspace' AND hold.employee_id = artifact.employee_id)
            )
       ) AS held
     FROM employee_artifact artifact
     WHERE artifact.workspace_id = ? AND artifact.deleted_at IS NOT NULL AND artifact.deleted_at < ?
     ${employeeFilter}`,
  ).all(...params) as Array<{ id?: string; contentDigest?: string; held?: boolean }>;
  if (rows.length === 0) {
    return { removed: 0, held: 0, digests: [] };
  }
  const removable = rows.filter((row) => !row.held && typeof row.id === "string");
  if (removable.length === 0) {
    return { removed: 0, held: rows.length, digests: [] };
  }
  const placeholders = removable.map(() => "?").join(", ");
  const result = db.prepare(
    `DELETE FROM employee_artifact
     WHERE workspace_id = ? AND id IN (${placeholders})
       AND NOT EXISTS (
         SELECT 1 FROM employee_data_legal_hold hold
          WHERE hold.workspace_id = employee_artifact.workspace_id
            AND hold.released_at IS NULL
            AND (hold.expires_at IS NULL OR hold.expires_at > NOW())
            AND (
              (hold.resource_type = 'artifact' AND hold.resource_id = employee_artifact.id)
              OR (hold.resource_type = 'employee_workspace' AND hold.employee_id = employee_artifact.employee_id)
            )
       )`,
  ).run(workspaceId, ...removable.map((row) => row.id!));
  return {
    removed: result.changes,
    held: rows.length - result.changes,
    digests: removable
      .map((row) => row.contentDigest)
      .filter((digest): digest is string => typeof digest === "string"),
  };
}

export function listEmployeeArtifactDigestsSync(workspaceId = DEFAULT_WORKSPACE_ID): string[] {
  const rows = getDatabase().prepare(
    // Soft-deleted rows remain recoverable until lifecycle hard-deletes them,
    // so their bytes are still reachable and must not be collected as orphans.
    `SELECT DISTINCT content_digest FROM employee_artifact WHERE workspace_id = ?`,
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

/** Deduplicated bytes reachable from one employee's revisions and artifacts. */
export function readEmployeeDurabilityUsageSync(input: {
  workspaceId?: string;
  employeeId: string;
}): EmployeeDurabilityUsageRecord {
  const workspaceId = input.workspaceId ?? DEFAULT_WORKSPACE_ID;
  const db = getDatabase();
  const usage = db.prepare(
    `WITH reachable_digest AS (
       SELECT DISTINCT file ->> 'sha256' AS digest
         FROM employee_workspace_revision revision
         CROSS JOIN LATERAL jsonb_array_elements(revision.manifest_json -> 'files') AS file
        WHERE revision.workspace_id = ? AND revision.employee_id = ? AND revision.status = 'committed'
       UNION
       SELECT DISTINCT artifact.content_digest AS digest
         FROM employee_artifact artifact
        WHERE artifact.workspace_id = ? AND artifact.employee_id = ?
     )
     SELECT COUNT(blob.sha256) AS "blobCount", COALESCE(SUM(blob.size_bytes), 0) AS "totalBytes"
       FROM reachable_digest reachable
       JOIN content_blob blob ON blob.workspace_id = ? AND blob.sha256 = reachable.digest`,
  ).get(workspaceId, input.employeeId, workspaceId, input.employeeId, workspaceId) as {
    blobCount?: number;
    totalBytes?: number;
  } | undefined;
  const counts = db.prepare(
    `SELECT
       (SELECT COUNT(*) FROM employee_artifact WHERE workspace_id = ? AND employee_id = ?) AS "artifactCount",
       (SELECT COUNT(*) FROM employee_workspace_revision WHERE workspace_id = ? AND employee_id = ? AND status = 'committed') AS "revisionCount"`,
  ).get(workspaceId, input.employeeId, workspaceId, input.employeeId) as {
    artifactCount?: number;
    revisionCount?: number;
  } | undefined;
  return {
    workspaceId,
    employeeId: input.employeeId,
    blobCount: nonNegativeNumber(usage?.blobCount),
    totalBytes: nonNegativeNumber(usage?.totalBytes),
    artifactCount: nonNegativeNumber(counts?.artifactCount),
    revisionCount: nonNegativeNumber(counts?.revisionCount),
  };
}

function nonNegativeNumber(value: unknown): number {
  const parsed = typeof value === "number" ? value : Number(value);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : 0;
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
    restoredFromRevisionId: readOptionalString(
      value.restoredFromRevisionId ?? value.restoredfromrevisionid ?? value.restored_from_revision_id,
    ),
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
  const employeeId = resolveStoredEmployeeIdSync(normalized, workspaceId);
  if (!employeeId) return;

  // Persistent workspace rows cascade to revisions and artifacts via FK.
  db.prepare(
    `DELETE FROM employee_persistent_workspace
     WHERE workspace_id = ? AND employee_id = ?`,
  ).run(workspaceId, employeeId);

  db.prepare(
    `DELETE FROM employee_runtime_binding
     WHERE workspace_id = ? AND employee_id = ?`,
  ).run(workspaceId, employeeId);

  db.prepare(
    `DELETE FROM employee_recovery_operation
     WHERE workspace_id = ? AND employee_id = ?`,
  ).run(workspaceId, employeeId);

  db.prepare(
    `DELETE FROM task_commit_journal
     WHERE workspace_id = ? AND employee_id = ?`,
  ).run(workspaceId, employeeId);
}

function readOptionalString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value : undefined;
}

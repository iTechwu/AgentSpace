import { DEFAULT_WORKSPACE_ID, getDatabase, randomLikeId } from "./database.ts";
import type { BackupRestoreDrillRunRecord } from "./types.ts";

export interface CreateBackupRestoreDrillRunInput {
  workspaceId?: string;
  drillType?: BackupRestoreDrillRunRecord["drillType"];
  trigger: BackupRestoreDrillRunRecord["trigger"];
  /** external_restore drills: the PostgreSQL PITR restore point verified. */
  restorePointAt?: string;
  /** external_restore drills: the source backup/snapshot identifier. */
  sourceSnapshot?: string;
  /** external_restore drills: the scratch/isolated environment identifier. */
  restoreEnvironment?: string;
  /** external_restore drills: measured restore duration in milliseconds (RTO). */
  restoreDurationMs?: number;
}

const DRILL_COLUMNS = `SELECT
  id, workspace_id AS workspaceId, drill_type AS drillType, trigger,
  status, started_at AS startedAt, finished_at AS finishedAt,
  sample_count AS sampleCount, success_count AS successCount, failure_count AS failureCount,
  result_json AS resultJson, error_message AS errorMessage,
  restore_point_at AS restorePointAt, source_snapshot AS sourceSnapshot,
  restore_environment AS restoreEnvironment, restore_duration_ms AS restoreDurationMs,
  created_at AS createdAt, updated_at AS updatedAt`;

export function createBackupRestoreDrillRunSync(
  input: CreateBackupRestoreDrillRunInput,
): BackupRestoreDrillRunRecord {
  const db = getDatabase();
  const workspaceId = input.workspaceId ?? DEFAULT_WORKSPACE_ID;
  const id = `drill-${randomLikeId()}`;
  const now = new Date().toISOString();
  db.prepare(
    `INSERT INTO backup_restore_drill_run (
      id, workspace_id, drill_type, trigger, status, started_at,
      sample_count, success_count, failure_count, result_json, error_message,
      restore_point_at, source_snapshot, restore_environment, restore_duration_ms,
      created_at, updated_at
    ) VALUES (?, ?, ?, ?, 'running', ?, 0, 0, 0, '{}', NULL, ?, ?, ?, ?, ?, ?)`,
  ).run(
    id,
    workspaceId,
    input.drillType ?? "metadata",
    input.trigger,
    now,
    input.restorePointAt ?? null,
    input.sourceSnapshot?.trim() || null,
    input.restoreEnvironment?.trim() || null,
    typeof input.restoreDurationMs === "number" ? input.restoreDurationMs : null,
    now,
    now,
  );
  return readBackupRestoreDrillRunSync(id, workspaceId)!;
}

export function readBackupRestoreDrillRunSync(
  id: string,
  workspaceId = DEFAULT_WORKSPACE_ID,
): BackupRestoreDrillRunRecord | null {
  const row = getDatabase().prepare(
    `${DRILL_COLUMNS} FROM backup_restore_drill_run WHERE id = ? AND workspace_id = ?`,
  ).get(id, workspaceId) as Record<string, unknown> | undefined;
  return row ? mapDrillRunRecord(row) : null;
}

export function listBackupRestoreDrillRunsSync(options: {
  workspaceId?: string;
  limit?: number;
} = {}): BackupRestoreDrillRunRecord[] {
  const workspaceId = options.workspaceId ?? DEFAULT_WORKSPACE_ID;
  const limit = Math.max(1, Math.min(options.limit ?? 20, 500));
  const rows = getDatabase().prepare(
    `${DRILL_COLUMNS} FROM backup_restore_drill_run
     WHERE workspace_id = ? ORDER BY created_at DESC LIMIT ${limit}`,
  ).all(workspaceId) as Array<Record<string, unknown>>;
  return rows.map(mapDrillRunRecord).filter((r): r is BackupRestoreDrillRunRecord => r !== null);
}

export function completeBackupRestoreDrillRunSync(input: {
  id: string;
  workspaceId?: string;
  status: "completed" | "failed";
  sampleCount: number;
  successCount: number;
  failureCount: number;
  resultJson: string;
  errorMessage?: string;
}): BackupRestoreDrillRunRecord {
  const db = getDatabase();
  const workspaceId = input.workspaceId ?? DEFAULT_WORKSPACE_ID;
  const now = new Date().toISOString();
  db.prepare(
    `UPDATE backup_restore_drill_run
       SET status = ?, finished_at = ?, sample_count = ?, success_count = ?, failure_count = ?,
           result_json = ?, error_message = ?, updated_at = ?
     WHERE id = ? AND workspace_id = ?`,
  ).run(
    input.status,
    now,
    input.sampleCount,
    input.successCount,
    input.failureCount,
    input.resultJson,
    input.errorMessage?.trim() || null,
    now,
    input.id,
    workspaceId,
  );
  return readBackupRestoreDrillRunSync(input.id, workspaceId)!;
}

function mapDrillRunRecord(value: Record<string, unknown>): BackupRestoreDrillRunRecord | null {
  if (
    typeof value.id !== "string" ||
    typeof value.workspaceId !== "string" ||
    typeof value.drillType !== "string" ||
    typeof value.trigger !== "string" ||
    typeof value.status !== "string" ||
    typeof value.startedAt !== "string" ||
    typeof value.sampleCount !== "number" ||
    typeof value.successCount !== "number" ||
    typeof value.failureCount !== "number" ||
    typeof value.resultJson !== "string" ||
    typeof value.createdAt !== "string" ||
    typeof value.updatedAt !== "string"
  ) {
    return null;
  }
  return {
    id: value.id,
    workspaceId: value.workspaceId,
    drillType: value.drillType as BackupRestoreDrillRunRecord["drillType"],
    trigger: value.trigger as BackupRestoreDrillRunRecord["trigger"],
    status: value.status as BackupRestoreDrillRunRecord["status"],
    startedAt: value.startedAt,
    finishedAt: typeof value.finishedAt === "string" ? value.finishedAt : undefined,
    sampleCount: value.sampleCount,
    successCount: value.successCount,
    failureCount: value.failureCount,
    resultJson: value.resultJson,
    errorMessage: typeof value.errorMessage === "string" ? value.errorMessage : undefined,
    restorePointAt: readOptionalString(value.restorePointAt),
    sourceSnapshot: readOptionalString(value.sourceSnapshot),
    restoreEnvironment: readOptionalString(value.restoreEnvironment),
    restoreDurationMs: typeof value.restoreDurationMs === "number" ? value.restoreDurationMs : undefined,
    createdAt: value.createdAt,
    updatedAt: value.updatedAt,
  };
}

function readOptionalString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value : undefined;
}

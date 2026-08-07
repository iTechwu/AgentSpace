import { DEFAULT_WORKSPACE_ID, getDatabase, withTransaction } from "./database.ts";
import { resolveStoredEmployeeIdSync } from "./workspace-employees.ts";
import type { TaskCommitJournalRecord, TaskCommitState } from "./types.ts";

/* ------------------------------------------------------------------ */
/* Input interfaces                                                    */
/* ------------------------------------------------------------------ */

export interface UpsertTaskCommitJournalInput {
  taskId: string;
  workspaceId?: string;
  employeeName?: string;
  workspaceRevisionId?: string;
  artifactIdsJson?: string;
  commitState: TaskCommitState;
  errorCode?: string;
  errorMessage?: string;
  /** Increment only after an actual reconciliation attempt fails. */
  incrementAttempt?: boolean;
}

/* ------------------------------------------------------------------ */
/* Column selectors                                                    */
/* ------------------------------------------------------------------ */

const JOURNAL_COLUMNS = `SELECT
  task_id AS taskId, workspace_id AS workspaceId, employee_id AS employeeId,
  employee_name AS employeeName, workspace_revision_id AS workspaceRevisionId,
  artifact_ids_json AS artifactIdsJson, commit_state AS commitState, attempt,
  error_code AS errorCode, error_message AS errorMessage,
  created_at AS createdAt, updated_at AS updatedAt`;

/* ------------------------------------------------------------------ */
/* Upsert (idempotent, one row per task)                               */
/* ------------------------------------------------------------------ */

export function upsertTaskCommitJournalSync(input: UpsertTaskCommitJournalInput): TaskCommitJournalRecord {
  const db = getDatabase();
  const taskRow = db.prepare("SELECT workspace_id AS workspaceId FROM agent_task_queue WHERE id = ?").get(input.taskId) as { workspaceId?: unknown } | undefined;
  if (typeof taskRow?.workspaceId !== "string") throw new Error("task_commit_task_not_found");
  if (input.workspaceId !== undefined && input.workspaceId !== taskRow.workspaceId) {
    throw new Error("task_commit_workspace_mismatch");
  }
  const workspaceId = taskRow.workspaceId;
  const employeeName = input.employeeName?.trim();
  const employeeId = employeeName ? resolveStoredEmployeeIdSync(employeeName, workspaceId) : null;
  const now = new Date().toISOString();
  withTransaction(db, () => {
    db.prepare(
      `INSERT INTO task_commit_journal (
        task_id, workspace_id, employee_id, employee_name, workspace_revision_id, artifact_ids_json,
        commit_state, attempt, error_code, error_message, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT (task_id) DO UPDATE SET
        workspace_id = excluded.workspace_id,
        employee_id = COALESCE(excluded.employee_id, task_commit_journal.employee_id),
        employee_name = COALESCE(excluded.employee_name, task_commit_journal.employee_name),
        workspace_revision_id = COALESCE(excluded.workspace_revision_id, task_commit_journal.workspace_revision_id),
        artifact_ids_json = CASE
          WHEN ? = 1 THEN task_commit_journal.artifact_ids_json
          ELSE excluded.artifact_ids_json
        END,
        commit_state = excluded.commit_state,
        attempt = task_commit_journal.attempt + excluded.attempt,
        error_code = excluded.error_code,
        error_message = excluded.error_message,
        updated_at = excluded.updated_at`,
    ).run(
      input.taskId,
      workspaceId,
      employeeId,
      employeeName || null,
      input.workspaceRevisionId?.trim() || null,
      input.artifactIdsJson ?? "[]",
      input.commitState,
      input.incrementAttempt ? 1 : 0,
      input.errorCode?.trim() || null,
      input.errorMessage?.trim() || null,
      now,
      now,
      input.artifactIdsJson === undefined ? 1 : 0,
    );
  });
  const record = readTaskCommitJournalSync(input.taskId, workspaceId);
  if (!record) {
    throw new Error("Failed to persist task commit journal.");
  }
  return record;
}

export function readTaskCommitJournalSync(
  taskId: string,
  workspaceId = DEFAULT_WORKSPACE_ID,
): TaskCommitJournalRecord | null {
  const row = getDatabase().prepare(
    `${JOURNAL_COLUMNS} FROM task_commit_journal WHERE task_id = ? AND workspace_id = ?`,
  ).get(taskId, workspaceId) as Record<string, unknown> | undefined;
  return row ? mapTaskCommitJournalRecord(row) : null;
}

/** Tasks with unfinished commit/finalization work older than the threshold. */
export function listStaleCommitJournalsSync(options: {
  workspaceId?: string;
  staleBeforeSeconds?: number;
  now?: string;
  limit?: number;
} = {}): TaskCommitJournalRecord[] {
  const db = getDatabase();
  const limit = Math.max(1, Math.min(options.limit ?? 100, 500));
  const staleBeforeSeconds = options.staleBeforeSeconds ?? 300;
  const cutoff = new Date(
    Date.parse(options.now ?? new Date().toISOString()) - staleBeforeSeconds * 1000,
  ).toISOString();
  const workspaceId = options.workspaceId?.trim();
  const workspaceFilter = workspaceId ? "workspace_id = ? AND " : "";
  const rows = db.prepare(
    `${JOURNAL_COLUMNS} FROM task_commit_journal
     WHERE ${workspaceFilter}(
       commit_state = 'preparing'
       OR (
         commit_state = 'committed'
         AND EXISTS (
           SELECT 1 FROM agent_task_queue
            WHERE agent_task_queue.id = task_commit_journal.task_id
              AND agent_task_queue.status = 'committed'
         )
       )
     ) AND updated_at < ?
     ORDER BY updated_at ASC LIMIT ${limit}`,
  ).all(...(workspaceId ? [workspaceId, cutoff] : [cutoff])) as Array<Record<string, unknown>>;
  return rows.map(mapTaskCommitJournalRecord).filter((r): r is TaskCommitJournalRecord => r !== null);
}

export function listCommitJournalsForWorkspaceSync(
  workspaceId = DEFAULT_WORKSPACE_ID,
  limit = 100,
): TaskCommitJournalRecord[] {
  const clamped = Math.max(1, Math.min(limit, 500));
  const rows = getDatabase().prepare(
    `${JOURNAL_COLUMNS} FROM task_commit_journal WHERE workspace_id = ? ORDER BY updated_at DESC LIMIT ${clamped}`,
  ).all(workspaceId) as Array<Record<string, unknown>>;
  return rows.map(mapTaskCommitJournalRecord).filter((r): r is TaskCommitJournalRecord => r !== null);
}

/* ------------------------------------------------------------------ */
/* Mapper                                                              */
/* ------------------------------------------------------------------ */

function mapTaskCommitJournalRecord(value: Record<string, unknown>): TaskCommitJournalRecord | null {
  if (
    typeof value.taskId !== "string" ||
    typeof value.workspaceId !== "string" ||
    typeof value.artifactIdsJson !== "string" ||
    typeof value.commitState !== "string" ||
    typeof value.attempt !== "number" ||
    typeof value.createdAt !== "string" ||
    typeof value.updatedAt !== "string"
  ) {
    return null;
  }
  return {
    taskId: value.taskId,
    workspaceId: value.workspaceId,
    employeeId: readOptionalString(value.employeeId),
    employeeName: readOptionalString(value.employeeName),
    workspaceRevisionId: readOptionalString(value.workspaceRevisionId),
    artifactIdsJson: value.artifactIdsJson,
    commitState: value.commitState as TaskCommitState,
    attempt: value.attempt,
    errorCode: readOptionalString(value.errorCode),
    errorMessage: readOptionalString(value.errorMessage),
    createdAt: value.createdAt,
    updatedAt: value.updatedAt,
  };
}

function readOptionalString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value : undefined;
}

import { getDatabase, randomLikeId, withTransaction } from "../database.ts";
import type { WorkflowRunEventRecord } from "../types.ts";

export interface AppendWorkflowRunEventInput {
  workspaceId: string;
  runId: string;
  nodeRunId?: string;
  type: string;
  actorType: string;
  actorId?: string;
  severity?: string;
  dataJson?: string;
  now?: string;
}

export function appendWorkflowRunEventSync(input: AppendWorkflowRunEventInput): WorkflowRunEventRecord {
  const db = getDatabase();
  const now = input.now ?? new Date().toISOString();
  return withTransaction(db, () => {
    const sequenceRow = db.prepare(
      `UPDATE workflow_run SET current_sequence = current_sequence + 1, updated_at = ?
       WHERE id = ? AND workspace_id = ?
       RETURNING current_sequence AS "sequence"`,
    ).get(now, input.runId, input.workspaceId) as { sequence?: number } | undefined;
    if (typeof sequenceRow?.sequence !== "number") throw new Error("workflow_run_not_found");
    const id = `workflow-event-${randomLikeId()}`;
    db.prepare(
      `INSERT INTO workflow_run_event (
         id, workspace_id, run_id, node_run_id, sequence, type, actor_type, actor_id, severity, data_json, created_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      id,
      input.workspaceId,
      input.runId,
      input.nodeRunId ?? null,
      sequenceRow.sequence,
      input.type,
      input.actorType,
      input.actorId ?? null,
      input.severity ?? "info",
      input.dataJson ?? "{}",
      now,
    );
    const row = db.prepare(
      `SELECT id, workspace_id AS "workspaceId", run_id AS "runId", node_run_id AS "nodeRunId",
              sequence, type, actor_type AS "actorType", actor_id AS "actorId", severity,
              data_json AS "dataJson", created_at AS "createdAt"
       FROM workflow_run_event WHERE id = ? AND workspace_id = ?`,
    ).get(id, input.workspaceId) as Record<string, unknown> | undefined;
    if (!row) throw new Error("workflow_run_event_create_failed");
    return compactOptional(row) as unknown as WorkflowRunEventRecord;
  });
}

export function listWorkflowRunEventsSync(
  workspaceId: string,
  runId: string,
): WorkflowRunEventRecord[] {
  const rows = getDatabase().prepare(
    `SELECT id, workspace_id AS "workspaceId", run_id AS "runId", node_run_id AS "nodeRunId",
            sequence, type, actor_type AS "actorType", actor_id AS "actorId", severity,
            data_json AS "dataJson", created_at AS "createdAt"
     FROM workflow_run_event WHERE workspace_id = ? AND run_id = ? ORDER BY sequence ASC`,
  ).all(workspaceId, runId) as Array<Record<string, unknown>>;
  return rows.map((row) => compactOptional(row) as unknown as WorkflowRunEventRecord);
}

function compactOptional(row: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(row).filter(([, value]) => value !== null));
}

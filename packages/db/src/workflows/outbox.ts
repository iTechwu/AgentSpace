import { getDatabase, randomLikeId, withTransaction } from "../database.ts";
import type { WorkflowOutboxRecord } from "../types.ts";

export interface EnqueueWorkflowOutboxInput {
  workspaceId: string;
  aggregateType: string;
  aggregateId: string;
  eventType: string;
  payloadJson: string;
  availableAt?: string;
  now?: string;
}

export function enqueueWorkflowOutboxSync(input: EnqueueWorkflowOutboxInput): WorkflowOutboxRecord {
  const db = getDatabase();
  const now = input.now ?? new Date().toISOString();
  const id = `workflow-outbox-${randomLikeId()}`;
  db.prepare(
    `INSERT INTO workflow_outbox (
       id, workspace_id, aggregate_type, aggregate_id, event_type, payload_json,
       status, attempts, available_at, created_at
     ) VALUES (?, ?, ?, ?, ?, ?, 'pending', 0, ?, ?)`,
  ).run(id, input.workspaceId, input.aggregateType, input.aggregateId, input.eventType, input.payloadJson, input.availableAt ?? now, now);
  return readWorkflowOutboxSync(id, input.workspaceId)!;
}

export function readWorkflowOutboxSync(id: string, workspaceId: string): WorkflowOutboxRecord | null {
  const row = getDatabase().prepare(`${OUTBOX_SELECT} WHERE id = ? AND workspace_id = ?`)
    .get(id, workspaceId) as Record<string, unknown> | undefined;
  return row ? mapOutbox(row) : null;
}

export function claimWorkflowOutboxBatchSync(input: {
  workerId: string;
  now: string;
  limit: number;
  leaseSeconds: number;
  workspaceId?: string;
}): WorkflowOutboxRecord[] {
  const db = getDatabase();
  const claimed: WorkflowOutboxRecord[] = [];
  const limit = Math.max(1, Math.min(input.limit, 100));
  withTransaction(db, () => {
    const workspaceClause = input.workspaceId ? " AND workspace_id = ?" : "";
    const params = input.workspaceId ? [input.now, input.now, input.workspaceId, limit] : [input.now, input.now, limit];
    const rows = db.prepare(
      `SELECT id, workspace_id AS "workspaceId" FROM workflow_outbox
       WHERE status = 'pending' AND available_at <= ?
         AND (locked_at IS NULL OR locked_at < ?)
         ${workspaceClause}
       ORDER BY available_at ASC, created_at ASC
       LIMIT ?`,
    ).all(...params) as Array<{ id?: string; workspaceId?: string }>;
    const leaseUntil = new Date(Date.parse(input.now) + Math.max(1, input.leaseSeconds) * 1000).toISOString();
    for (const row of rows) {
      if (!row.id || !row.workspaceId) continue;
      const updated = db.prepare(
        `UPDATE workflow_outbox
            SET locked_at = ?, locked_by = ?, attempts = attempts + 1
          WHERE id = ? AND workspace_id = ? AND status = 'pending'
            AND (locked_at IS NULL OR locked_at < ?)
          RETURNING id`,
      ).get(leaseUntil, input.workerId, row.id, row.workspaceId, input.now) as { id?: string } | undefined;
      if (updated?.id) {
        const item = readWorkflowOutboxSync(row.id, row.workspaceId);
        if (item) claimed.push(item);
      }
    }
  });
  return claimed;
}

export function markWorkflowOutboxPublishedSync(id: string, workerId: string, workspaceId: string, now = new Date().toISOString()): void {
  const result = getDatabase().prepare(
    `UPDATE workflow_outbox SET status = 'published', published_at = ?, locked_at = NULL, locked_by = NULL
      WHERE id = ? AND workspace_id = ? AND status = 'pending' AND locked_by = ?`,
  ).run(now, id, workspaceId, workerId);
  if (result.changes !== 1) throw new Error("workflow_outbox_lease_conflict");
}

const OUTBOX_SELECT = `SELECT id, workspace_id AS "workspaceId", aggregate_type AS "aggregateType",
  aggregate_id AS "aggregateId", event_type AS "eventType", payload_json AS "payloadJson", status,
  attempts, available_at AS "availableAt", locked_at AS "lockedAt", locked_by AS "lockedBy",
  last_error AS "lastError", created_at AS "createdAt", published_at AS "publishedAt"
FROM workflow_outbox`;

function mapOutbox(row: Record<string, unknown>): WorkflowOutboxRecord {
  return Object.fromEntries(Object.entries(row).filter(([, value]) => value !== null)) as unknown as WorkflowOutboxRecord;
}

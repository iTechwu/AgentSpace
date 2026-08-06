import {
  enqueueWorkflowOutboxSync,
  getDatabase,
  readQueuedTaskSync,
  readWorkflowNodeRunSync,
  transitionWorkflowNodeRunSync,
  withTransaction,
} from "@dofe-agent/db";
import { failStaleWorkflowNodeSync } from "./coordinator.ts";
import { retryWorkflowNodeSync } from "./retries.ts";

export interface WorkflowRecoveryResult {
  readyNodeRunIds: string[];
  retriedNodeRunIds: string[];
  failedNodeRunIds: string[];
}

export function recoverStaleWorkflowWorkSync(input: {
  now: string;
  workerId: string;
  limit: number;
}): WorkflowRecoveryResult {
  const db = getDatabase();
  const result: WorkflowRecoveryResult = { readyNodeRunIds: [], retriedNodeRunIds: [], failedNodeRunIds: [] };
  const limit = Math.max(1, Math.min(input.limit, 100));
  const retryRows = db.prepare(
    `SELECT id, workspace_id AS "workspaceId" FROM workflow_node_run
     WHERE status = 'retry_wait' AND available_at <= ? ORDER BY available_at ASC LIMIT ?`,
  ).all(input.now, limit) as Array<{ id?: string; workspaceId?: string }>;
  for (const row of retryRows) {
    if (!row.id || !row.workspaceId) continue;
    const ready = transitionWorkflowNodeRunSync({ workspaceId: row.workspaceId, nodeRunId: row.id, from: ["retry_wait"], to: "ready", availableAt: input.now, now: input.now });
    if (!ready) continue;
    enqueueWorkflowOutboxSync({ workspaceId: row.workspaceId, aggregateType: "workflow_node_run", aggregateId: row.id, eventType: "workflow.node.ready", payloadJson: JSON.stringify({ nodeRunId: row.id }), now: input.now });
    result.readyNodeRunIds.push(row.id);
  }
  const staleBefore = new Date(Date.parse(input.now) - 5 * 60_000).toISOString();
  const queuedRows = db.prepare(
    `SELECT id, workspace_id AS "workspaceId" FROM workflow_node_run
     WHERE status = 'queued' AND updated_at < ? ORDER BY updated_at ASC LIMIT ?`,
  ).all(staleBefore, limit) as Array<{ id?: string; workspaceId?: string }>;
  for (const row of queuedRows) {
    if (!row.id || !row.workspaceId) continue;
    const node = readWorkflowNodeRunSync(row.id, row.workspaceId);
    const task = node?.taskQueueId ? readQueuedTaskSync(node.taskQueueId) : null;
    if (!node || (task && ["queued", "claimed", "running", "preparing_commit", "committed"].includes(task.status))) continue;
    withTransaction(db, () => {
      const failed = failStaleWorkflowNodeSync({ workspaceId: row.workspaceId!, nodeRunId: row.id!, actorId: input.workerId, now: input.now });
      if (failed.attemptCount < failed.maxAttempts) {
        retryWorkflowNodeSync({ workspaceId: row.workspaceId!, runId: failed.runId, nodeId: failed.nodeId, actorUserId: input.workerId, reason: "stale queue recovery", now: input.now });
        result.retriedNodeRunIds.push(row.id!);
      } else {
        result.failedNodeRunIds.push(row.id!);
      }
    });
  }
  return result;
}

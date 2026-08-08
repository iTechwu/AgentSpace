import {
  enqueueWorkflowOutboxSync,
  appendTaskMessageSync,
  failQueuedTaskSync,
  getDatabase,
  lockWorkflowRunForUpdateSync,
  markStaleDaemonsOfflineSync,
  readAgentRuntimeSync,
  readQueuedTaskSync,
  readWorkflowNodeRunSync,
  transitionWorkflowNodeRunSync,
  withTransaction,
} from "@dofe-agent/db";
import { failChannelDocumentRunStepSync } from "../documents/sync.ts";
import { formatConversationFailureSummary, replacePendingChannelMessageSync } from "../messages/messages.ts";
import { queueFeishuChannelReplyOutboxSync } from "../integrations/providers/feishu/index.ts";
import { updateTaskStatusSync } from "../tasks/tasks.ts";
import { upsertDirectConversationStateSync } from "../contacts/contacts.ts";
import { writeConversationExecutionWorkspaceStateSync } from "../shared/conversation-execution-workspaces.ts";
import { writeWorkspaceStateSync } from "../shared/state-io.ts";
import { failExhaustedReadyWorkflowNodeSync, failStaleWorkflowNodeSync } from "./coordinator.ts";
import { failWorkflowTaskIfLinkedSync, lockWorkflowRunForTaskIfLinkedSync } from "./completion.ts";
import { retryWorkflowNodeSync } from "./retries.ts";

export interface WorkflowRecoveryResult {
  readyNodeRunIds: string[];
  retriedNodeRunIds: string[];
  failedNodeRunIds: string[];
  orphanedTaskIds: string[];
  requeuedReadyNodeRunIds: string[];
}

export function recoverStaleWorkflowWorkSync(input: {
  now: string;
  workerId: string;
  limit: number;
}): WorkflowRecoveryResult {
  const db = getDatabase();
  const result: WorkflowRecoveryResult = {
    readyNodeRunIds: [],
    retriedNodeRunIds: [],
    failedNodeRunIds: [],
    orphanedTaskIds: [],
    requeuedReadyNodeRunIds: [],
  };
  const limit = Math.max(1, Math.min(input.limit, 100));
  markStaleDaemonsOfflineSync({ now: new Date(input.now) });
  const orphanedTasks = db.prepare(
    `SELECT q.id, q.workspace_id AS "workspaceId"
       FROM agent_task_queue q
       JOIN agent_runtime r ON r.id = q.runtime_id
       JOIN daemon_connection d ON d.id = r.daemon_connection_id
      WHERE q.status IN ('claimed', 'running')
        AND r.status = 'offline'
        AND d.status = 'offline'
      ORDER BY q.updated_at ASC
      LIMIT ?`,
  ).all(limit) as Array<{ id?: string; workspaceId?: string }>;
  for (const row of orphanedTasks) {
    if (!row.id || !row.workspaceId) continue;
    const recovered = withTransaction(db, () => {
      const task = readQueuedTaskSync(row.id!);
      if (!task || !["claimed", "running"].includes(task.status)) return null;
      const runtime = readAgentRuntimeSync(task.runtimeId);
      if (!runtime || runtime.status !== "offline" || !runtime.daemonConnectionId) return null;
      const daemonOffline = db.prepare(
        `SELECT 1 AS ok FROM daemon_connection
          WHERE id = ? AND status = 'offline'`,
      ).get(runtime.daemonConnectionId) as { ok?: number } | undefined;
      if (!daemonOffline?.ok) return null;
      const fence = lockWorkflowRunForTaskIfLinkedSync({
        workspaceId: row.workspaceId!,
        taskQueueId: row.id!,
      });
      if (fence.ignored) return null;
      const message = "The executing daemon went offline before the task completed.";
      failQueuedTaskSync({
        taskId: row.id!,
        errorText: message,
        errorCode: "workflow_runtime_offline",
      });
      const workflowFailure = failWorkflowTaskIfLinkedSync({
        workspaceId: row.workspaceId!,
        taskQueueId: row.id!,
        errorCode: "workflow_runtime_offline",
        errorText: message,
      });
      return { task, message, retryScheduled: workflowFailure.retryScheduled };
    });
    if (recovered) {
      result.orphanedTaskIds.push(row.id);
      if (!recovered.retryScheduled) projectOrphanedTaskFailure(recovered.task, recovered.message);
    }
  }
  const retryRows = db.prepare(
    `SELECT id, workspace_id AS "workspaceId" FROM workflow_node_run
     WHERE status = 'retry_wait' AND available_at <= ? ORDER BY available_at ASC LIMIT ?`,
  ).all(input.now, limit) as Array<{ id?: string; workspaceId?: string }>;
  for (const row of retryRows) {
    if (!row.id || !row.workspaceId) continue;
    const ready = withTransaction(db, () => {
      const candidate = readWorkflowNodeRunSync(row.id!, row.workspaceId!);
      if (!candidate || candidate.status !== "retry_wait") return null;
      if (!lockWorkflowRunForUpdateSync(candidate.runId, row.workspaceId!)) return null;
      const transitioned = transitionWorkflowNodeRunSync({ workspaceId: row.workspaceId!, nodeRunId: row.id!, from: ["retry_wait"], to: "ready", availableAt: input.now, now: input.now });
      if (!transitioned) return null;
      enqueueWorkflowOutboxSync({ workspaceId: row.workspaceId!, aggregateType: "workflow_node_run", aggregateId: row.id!, eventType: "workflow.node.ready", payloadJson: JSON.stringify({ nodeRunId: row.id }), now: input.now });
      return transitioned;
    });
    if (!ready) continue;
    result.readyNodeRunIds.push(row.id);
  }
  // 死信 ready 节点自愈（Spec #5）：workflow.node.ready 的 outbox 派发耗尽
  // WORKFLOW_OUTBOX_MAX_ATTEMPTS 后进入 dead_letter，节点永久卡在 ready——此前 recovery
  // 只扫 retry_wait/queued，不扫 ready，死信节点无人重新入队。这里找出「仍为 ready 且
  // 存在 dead_letter 派发记录、且当前无 pending 派发」的节点。
  //
  // 有界重试：第一条死信（deadLetterCount == 1）重新入队一条 outbox，给予一次新的重试预算；
  // 累计 >= 2 条死信（即重新入队后再次耗尽 8 次）则永久失败该节点，避免「8 次失败→重新入队→
  // 再 8 次」的无限重置循环导致 Run 永久卡在 ready。NOT EXISTS pending 保证跨恢复周期幂等。
  const deadLetterReadyRows = db.prepare(
    `SELECT n.id, n.workspace_id AS "workspaceId",
            (SELECT COUNT(*) FROM workflow_outbox o
              WHERE o.workspace_id = n.workspace_id
                AND o.aggregate_id = n.id
                AND o.event_type = 'workflow.node.ready'
                AND o.status = 'dead_letter') AS "deadLetterCount"
       FROM workflow_node_run n
      WHERE n.status = 'ready'
        AND EXISTS (
          SELECT 1 FROM workflow_outbox o
           WHERE o.workspace_id = n.workspace_id
             AND o.aggregate_id = n.id
             AND o.event_type = 'workflow.node.ready'
             AND o.status = 'dead_letter'
        )
        AND NOT EXISTS (
          SELECT 1 FROM workflow_outbox p
           WHERE p.workspace_id = n.workspace_id
             AND p.aggregate_id = n.id
             AND p.event_type = 'workflow.node.ready'
             AND p.status = 'pending'
        )
      ORDER BY n.updated_at ASC
      LIMIT ?`,
  ).all(limit) as Array<{ id?: string; workspaceId?: string; deadLetterCount?: number | string }>;
  for (const row of deadLetterReadyRows) {
    if (!row.id || !row.workspaceId) continue;
    const deadLetterCount = Number(row.deadLetterCount ?? 0);
    // 累计 >= 2 条死信：永久失败该节点，终结无限重置循环。
    if (deadLetterCount >= 2) {
      const failed = failExhaustedReadyWorkflowNodeSync({
        workspaceId: row.workspaceId,
        nodeRunId: row.id,
        actorId: input.workerId,
        now: input.now,
      });
      if (failed) result.failedNodeRunIds.push(row.id);
      continue;
    }
    const requeued = withTransaction(db, () => {
      const candidate = readWorkflowNodeRunSync(row.id!, row.workspaceId!);
      if (!candidate || candidate.status !== "ready") return null;
      // 二次确认无 pending 派发（扫描到取锁期间可能已被重新入队），避免重复入队。
      const pendingExists = db.prepare(
        `SELECT 1 AS ok FROM workflow_outbox
          WHERE workspace_id = ? AND aggregate_id = ? AND event_type = 'workflow.node.ready' AND status = 'pending'
          LIMIT 1`,
      ).get(row.workspaceId!, row.id!) as { ok?: number } | undefined;
      if (pendingExists?.ok) return null;
      enqueueWorkflowOutboxSync({
        workspaceId: row.workspaceId!,
        aggregateType: "workflow_node_run",
        aggregateId: row.id!,
        eventType: "workflow.node.ready",
        payloadJson: JSON.stringify({ nodeRunId: row.id }),
        now: input.now,
      });
      return true;
    });
    if (requeued) result.requeuedReadyNodeRunIds.push(row.id);
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
      if (!failed) return;
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

function projectOrphanedTaskFailure(
  task: NonNullable<ReturnType<typeof readQueuedTaskSync>>,
  message: string,
): void {
  const payload = parseRecoveryTaskPayload(task.inputJson);
  try {
    if (payload.taskId) updateTaskStatusSync(payload.taskId, "blocked", task.workspaceId);
    if (payload.orchestrationStepId) {
      writeWorkspaceStateSync(failChannelDocumentRunStepSync({
        queuedTaskId: task.id,
        errorText: message,
      }, task.workspaceId), task.workspaceId);
    }
    if (payload.channel) {
      const agentName = payload.assignee ?? task.agentId;
      const failureSummary = formatConversationFailureSummary({
        agentName,
        channelName: payload.channel,
        errorText: message,
        isDirectConversation: Boolean(payload.contactId),
      });
      replacePendingChannelMessageSync({
        channel: payload.channel,
        pendingSpeaker: agentName,
        pendingTaskId: task.id,
        speaker: "系统提示",
        role: "agent",
        summary: failureSummary,
        status: "error",
      }, task.workspaceId);
      try {
        queueFeishuChannelReplyOutboxSync({
          workspaceId: task.workspaceId,
          channelName: payload.channel,
          agentId: agentName,
          text: failureSummary,
          sourceDofeAgentMessageId: payload.sourceMessageId,
        });
      } catch {
        // External reply remains best effort, matching the regular fail route.
      }
      writeConversationExecutionWorkspaceStateSync({
        channelName: payload.channel,
        agentId: agentName,
        contactId: payload.contactId,
        lastTaskQueueId: task.id,
        lastError: message,
      }, task.workspaceId);
      if (payload.contactId) {
        upsertDirectConversationStateSync({ contactId: payload.contactId }, task.workspaceId);
      }
    }
  } catch (error) {
    appendTaskMessageSync({
      taskId: task.id,
      type: "status",
      content: `Offline task failure projection failed: ${error instanceof Error ? error.message : String(error)}`,
    });
  }
}

function parseRecoveryTaskPayload(inputJson: string): {
  taskId?: string;
  orchestrationStepId?: string;
  channel?: string;
  assignee?: string;
  contactId?: string;
  sourceMessageId?: string;
} {
  try {
    const value = JSON.parse(inputJson) as Record<string, unknown>;
    return Object.fromEntries(Object.entries(value).filter(([, item]) => typeof item === "string")) as {
      taskId?: string;
      orchestrationStepId?: string;
      channel?: string;
      assignee?: string;
      contactId?: string;
      sourceMessageId?: string;
    };
  } catch {
    return {};
  }
}

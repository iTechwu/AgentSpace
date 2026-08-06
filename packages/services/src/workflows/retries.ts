import {
  appendWorkflowRunEventSync,
  cancelQueuedTaskSync,
  enqueueWorkflowOutboxSync,
  listWorkflowNodeRunsSync,
  readWorkflowNodeRunSync,
  readWorkflowRunSync,
  transitionWorkflowNodeRunSync,
  transitionWorkflowRunSync,
  type WorkflowNodeRunRecord,
  type WorkflowRunRecord,
} from "@dofe-agent/db";

export interface RetryWorkflowNodeInput {
  workspaceId: string;
  runId: string;
  nodeId: string;
  actorUserId: string;
  reason: string;
  now?: string;
}

export interface ControlWorkflowRunInput {
  workspaceId: string;
  runId: string;
  actorUserId: string;
  reason: string;
  now?: string;
}

export function retryWorkflowNodeSync(input: RetryWorkflowNodeInput): WorkflowNodeRunRecord {
  const run = readWorkflowRunSync(input.runId, input.workspaceId);
  if (!run) throw new Error("workflow_run_not_found");
  const node = listWorkflowNodeRunsSync(input.workspaceId, input.runId).find((item) => item.nodeId === input.nodeId);
  if (!node) throw new Error("workflow_node_run_not_found");
  if (node.status !== "failed") throw new Error("workflow_node_not_retryable");
  const attempt = node.attemptCount + 1;
  if (attempt > node.maxAttempts) throw new Error("workflow_node_retry_exhausted");
  const now = input.now ?? new Date().toISOString();
  const availableAt = computeWorkflowRetryAvailableAt(now, attempt);
  const updated = transitionWorkflowNodeRunSync({
    workspaceId: input.workspaceId,
    nodeRunId: node.id,
    from: ["failed"],
    to: "retry_wait",
    attemptCount: attempt,
    availableAt,
    clearTaskQueueId: true,
    now,
  });
  if (!updated) throw new Error("workflow_node_retry_conflict");
  transitionWorkflowRunSync({ workspaceId: input.workspaceId, runId: run.id, from: ["failed"], to: "running", now });
  appendWorkflowRunEventSync({ workspaceId: input.workspaceId, runId: run.id, nodeRunId: node.id, type: "node.retry_scheduled", actorType: "human", actorId: input.actorUserId, dataJson: JSON.stringify({ reason: input.reason, attempt, availableAt }), now });
  enqueueWorkflowOutboxSync({ workspaceId: input.workspaceId, aggregateType: "workflow_node_run", aggregateId: node.id, eventType: "workflow.node.retry_wait", payloadJson: JSON.stringify({ nodeRunId: node.id, availableAt }), availableAt, now });
  return updated;
}

export function computeWorkflowRetryAvailableAt(now: string, attempt: number): string {
  const delaySeconds = Math.min(900, 5 * 2 ** Math.max(0, attempt - 2));
  return new Date(Date.parse(now) + delaySeconds * 1000).toISOString();
}

export function pauseWorkflowRunSync(input: ControlWorkflowRunInput): WorkflowRunRecord {
  return controlRun(input, ["created", "queued", "running", "waiting_approval"], "paused", "run.paused");
}

export function resumeWorkflowRunSync(input: ControlWorkflowRunInput): WorkflowRunRecord {
  const run = controlRun(input, ["paused"], "running", "run.resumed");
  enqueueWorkflowOutboxSync({ workspaceId: input.workspaceId, aggregateType: "workflow_run", aggregateId: run.id, eventType: "workflow.run.resumed", payloadJson: JSON.stringify({ runId: run.id }), now: input.now });
  return run;
}

export function cancelWorkflowRunSync(input: ControlWorkflowRunInput): WorkflowRunRecord {
  const now = input.now ?? new Date().toISOString();
  const current = readWorkflowRunSync(input.runId, input.workspaceId);
  if (!current) throw new Error("workflow_run_not_found");
  if (current.status === "cancelled") return current;
  const run = transitionWorkflowRunSync({
    workspaceId: input.workspaceId,
    runId: input.runId,
    from: ["created", "queued", "running", "waiting_approval", "paused", "failed"],
    to: "cancelled",
    finishedAt: now,
    now,
  });
  if (!run) throw new Error("workflow_run_control_conflict");
  for (const node of listWorkflowNodeRunsSync(input.workspaceId, input.runId)) {
    if (["succeeded", "failed", "skipped", "cancelled"].includes(node.status)) continue;
    if (node.taskQueueId) cancelQueuedTaskSync({ taskId: node.taskQueueId, errorText: input.reason });
    transitionWorkflowNodeRunSync({ workspaceId: input.workspaceId, nodeRunId: node.id, from: [node.status], to: "cancelled", finishedAt: now, now });
  }
  appendWorkflowRunEventSync({ workspaceId: input.workspaceId, runId: run.id, type: "run.cancelled", actorType: "human", actorId: input.actorUserId, dataJson: JSON.stringify({ reason: input.reason }), now });
  return readWorkflowRunSync(run.id, input.workspaceId)!;
}

function controlRun(input: ControlWorkflowRunInput, from: string[], to: string, eventType: string): WorkflowRunRecord {
  const now = input.now ?? new Date().toISOString();
  const run = transitionWorkflowRunSync({ workspaceId: input.workspaceId, runId: input.runId, from, to, now });
  if (!run) throw new Error("workflow_run_control_conflict");
  appendWorkflowRunEventSync({ workspaceId: input.workspaceId, runId: input.runId, type: eventType, actorType: "human", actorId: input.actorUserId, dataJson: JSON.stringify({ reason: input.reason }), now });
  return run;
}

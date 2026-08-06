import {
  appendWorkflowRunEventSync,
  cancelQueuedTaskSync,
  enqueueWorkflowOutboxSync,
  getDatabase,
  listWorkflowNodeRunsSync,
  readWorkflowNodeRunSync,
  readWorkflowRunSync,
  readWorkflowVersionSync,
  resetWorkflowDescendantNodeRunsForRetrySync,
  transitionWorkflowNodeRunSync,
  transitionWorkflowRunSync,
  withTransaction,
  type WorkflowNodeRunRecord,
  type WorkflowRunRecord,
} from "@dofe-agent/db";
import type { WorkflowGraphDefinition } from "@dofe-agent/domain";
import { collectWorkflowDescendantNodeIds } from "./coordinator.ts";

export interface RetryWorkflowNodeInput {
  workspaceId: string;
  runId: string;
  nodeId: string;
  actorUserId: string;
  reason: string;
  manualOverride?: boolean;
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
  return withTransaction(getDatabase(), () => {
    const run = readWorkflowRunSync(input.runId, input.workspaceId);
    if (!run) throw new Error("workflow_run_not_found");
    if (input.manualOverride && run.status !== "failed" && run.status !== "partially_succeeded") {
      throw new Error("workflow_run_control_conflict");
    }
    const node = listWorkflowNodeRunsSync(input.workspaceId, input.runId).find((item) => item.nodeId === input.nodeId);
    if (!node) throw new Error("workflow_node_run_not_found");
    if (node.status !== "failed" || node.nodeType !== "employee_task") throw new Error("workflow_node_not_retryable");
    const attempt = node.attemptCount + 1;
    if (!input.manualOverride && attempt > node.maxAttempts) throw new Error("workflow_node_retry_exhausted");
    const now = input.now ?? new Date().toISOString();
    const availableAt = computeWorkflowRetryAvailableAt(now, attempt);

    if (input.manualOverride) {
      const version = readWorkflowVersionSync(run.versionId, input.workspaceId);
      if (!version) throw new Error("workflow_version_not_found");
      const graph = JSON.parse(version.graphJson) as WorkflowGraphDefinition;
      const descendantNodeIds = new Set(collectWorkflowDescendantNodeIds(graph, node.nodeId));
      const descendantRunIds = listWorkflowNodeRunsSync(input.workspaceId, input.runId)
        .filter((candidate) => descendantNodeIds.has(candidate.nodeId))
        .map((candidate) => candidate.id);
      resetWorkflowDescendantNodeRunsForRetrySync({
        workspaceId: input.workspaceId,
        runId: run.id,
        nodeIds: descendantRunIds,
        now,
      });
    }

    const updated = transitionWorkflowNodeRunSync({
      workspaceId: input.workspaceId,
      nodeRunId: node.id,
      from: ["failed"],
      to: "retry_wait",
      attemptCount: attempt,
      maxAttempts: input.manualOverride ? Math.max(node.maxAttempts, attempt) : undefined,
      availableAt,
      clearTaskQueueId: true,
      clearError: true,
      clearFinishedAt: true,
      allowTerminalRetry: true,
      now,
    });
    if (!updated) throw new Error("workflow_node_retry_conflict");
    if (run.status === "failed" || run.status === "partially_succeeded") {
      const resumed = transitionWorkflowRunSync({
        workspaceId: input.workspaceId,
        runId: run.id,
        from: [run.status],
        to: "running",
        allowTerminalRetry: true,
        clearFinishedAt: true,
        now,
      });
      if (!resumed) throw new Error("workflow_run_control_conflict");
    }
    appendWorkflowRunEventSync({ workspaceId: input.workspaceId, runId: run.id, nodeRunId: node.id, type: "node.retry_scheduled", actorType: input.manualOverride ? "human" : "system", actorId: input.actorUserId, dataJson: JSON.stringify({ reason: input.reason, attempt, availableAt, manualOverride: input.manualOverride === true }), now });
    enqueueWorkflowOutboxSync({ workspaceId: input.workspaceId, aggregateType: "workflow_node_run", aggregateId: node.id, eventType: "workflow.node.retry_wait", payloadJson: JSON.stringify({ nodeRunId: node.id, availableAt }), availableAt, now });
    return updated;
  });
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
    from: ["created", "queued", "running", "waiting_approval", "paused"],
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

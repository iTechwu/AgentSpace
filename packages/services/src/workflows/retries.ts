import {
  appendWorkflowRunEventSync,
  cancelQueuedTaskSync,
  enqueueWorkflowOutboxSync,
  getDatabase,
  listWorkflowNodeRunsSync,
  lockWorkflowRunForUpdateSync,
  readWorkflowNodeRunSync,
  readQueuedTaskSync,
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
import { cancelPendingWorkflowApprovalsSync } from "./approvals.ts";
import { resolveWorkflowRunTerminalStatus } from "./coordinator.ts";

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
    const run = lockWorkflowRunForUpdateSync(input.runId, input.workspaceId);
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
      const descendantRunIds = collectWorkflowRetryResetNodeRunIds(
        graph,
        node.nodeId,
        listWorkflowNodeRunsSync(input.workspaceId, input.runId),
      );
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
  return withTransaction(getDatabase(), () => (
    controlRun(input, ["created", "queued", "running", "waiting_approval"], "paused", "run.paused")
  ));
}

export function resumeWorkflowRunSync(input: ControlWorkflowRunInput): WorkflowRunRecord {
  return withTransaction(getDatabase(), () => {
    const current = lockWorkflowRunForUpdateSync(input.runId, input.workspaceId);
    if (!current) throw new Error("workflow_run_not_found");
    const nodes = listWorkflowNodeRunsSync(input.workspaceId, input.runId);
    const version = readWorkflowVersionSync(current.versionId, input.workspaceId);
    if (!version) throw new Error("workflow_version_not_found");
    const targetStatus = resolveWorkflowResumeStatus(
      nodes,
      JSON.parse(version.graphJson) as WorkflowGraphDefinition,
    );
    const run = controlRun(input, ["paused"], targetStatus, "run.resumed");
    if (targetStatus === "running" || targetStatus === "waiting_approval") {
      enqueueWorkflowOutboxSync({ workspaceId: input.workspaceId, aggregateType: "workflow_run", aggregateId: run.id, eventType: "workflow.run.resumed", payloadJson: JSON.stringify({ runId: run.id }), now: input.now });
    }
    return run;
  });
}

export function cancelWorkflowRunSync(input: ControlWorkflowRunInput): WorkflowRunRecord {
  return withTransaction(getDatabase(), () => {
    const now = input.now ?? new Date().toISOString();
    const current = lockWorkflowRunForUpdateSync(input.runId, input.workspaceId);
    if (!current) throw new Error("workflow_run_not_found");
    if (current.status === "cancelled") return current;
    const cancellableStatuses = ["created", "queued", "running", "waiting_approval", "paused"];
    if (!cancellableStatuses.includes(current.status)) throw new Error("workflow_run_control_conflict");
    cancelPendingWorkflowApprovalsSync({
      workspaceId: input.workspaceId,
      runId: input.runId,
      reason: input.reason,
    });
    // The Run row serializes dispatch, completion, approval, retry, and cancellation for this aggregate.
    for (const node of listWorkflowNodeRunsSync(input.workspaceId, input.runId)) {
      if (["succeeded", "failed", "skipped", "cancelled"].includes(node.status)) continue;
      if (node.taskQueueId && readQueuedTaskSync(node.taskQueueId)) {
        cancelQueuedTaskSync({ taskId: node.taskQueueId, errorText: input.reason });
      }
      transitionWorkflowNodeRunSync({ workspaceId: input.workspaceId, nodeRunId: node.id, from: [node.status], to: "cancelled", finishedAt: now, now });
    }
    const run = transitionWorkflowRunSync({
      workspaceId: input.workspaceId,
      runId: input.runId,
      from: [current.status],
      to: "cancelled",
      finishedAt: now,
      now,
    });
    if (!run) throw new Error("workflow_run_control_conflict");
    appendWorkflowRunEventSync({ workspaceId: input.workspaceId, runId: run.id, type: "run.cancelled", actorType: "human", actorId: input.actorUserId, dataJson: JSON.stringify({ reason: input.reason }), now });
    return readWorkflowRunSync(run.id, input.workspaceId)!;
  });
}

export function resolveWorkflowResumeStatus(
  nodes: Array<Pick<WorkflowNodeRunRecord, "nodeId" | "nodeType" | "status" | "inputJson">>,
  graph: WorkflowGraphDefinition,
): "running" | "waiting_approval" | "succeeded" | "partially_succeeded" | "failed" {
  if (nodes.some((node) => node.status === "waiting_approval")) return "waiting_approval";
  if (nodes.some((node) => ["pending", "ready", "queued", "running", "retry_wait"].includes(node.status))) return "running";
  return resolveWorkflowRunTerminalStatus(nodes, graph);
}

export function collectWorkflowRetryResetNodeRunIds(
  graph: WorkflowGraphDefinition,
  retriedNodeId: string,
  nodeRuns: Array<Pick<WorkflowNodeRunRecord, "id" | "nodeId" | "nodeType" | "status">>,
): string[] {
  const byNodeId = new Map(nodeRuns.map((nodeRun) => [nodeRun.nodeId, nodeRun]));
  const resetIds: string[] = [];
  const visited = new Set<string>([retriedNodeId]);
  const pending = graph.edges.filter((edge) => edge.source === retriedNodeId).map((edge) => edge.target);
  while (pending.length > 0) {
    const nodeId = pending.shift();
    if (!nodeId || visited.has(nodeId)) continue;
    visited.add(nodeId);
    const nodeRun = byNodeId.get(nodeId);
    if (!nodeRun) continue;
    const blocksReplay = nodeRun.nodeType !== "join"
      && (nodeRun.status === "failed" || nodeRun.status === "cancelled");
    if (blocksReplay) continue;
    resetIds.push(nodeRun.id);
    pending.push(...graph.edges.filter((edge) => edge.source === nodeId).map((edge) => edge.target));
  }
  return resetIds;
}

function controlRun(input: ControlWorkflowRunInput, from: string[], to: string, eventType: string): WorkflowRunRecord {
  const now = input.now ?? new Date().toISOString();
  const run = transitionWorkflowRunSync({
    workspaceId: input.workspaceId,
    runId: input.runId,
    from,
    to,
    finishedAt: ["succeeded", "partially_succeeded", "failed"].includes(to) ? now : undefined,
    now,
  });
  if (!run) throw new Error("workflow_run_control_conflict");
  appendWorkflowRunEventSync({ workspaceId: input.workspaceId, runId: input.runId, type: eventType, actorType: "human", actorId: input.actorUserId, dataJson: JSON.stringify({ reason: input.reason }), now });
  return run;
}

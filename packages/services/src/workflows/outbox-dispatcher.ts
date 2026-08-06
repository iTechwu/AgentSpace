import {
  claimWorkflowOutboxBatchSync,
  readWorkflowNodeRunSync,
  listWorkflowNodeRunsSync,
  markWorkflowOutboxFailedSync,
  markWorkflowOutboxPublishedSync,
} from "@dofe-agent/db";
import { dispatchReadyWorkflowNodeSync } from "./dispatcher.ts";
import { createWorkflowApprovalSync, workflowApprovalInputFromNodeConfig } from "./approvals.ts";

export interface WorkflowOutboxDispatchResult {
  claimedOutboxIds: string[];
  publishedOutboxIds: string[];
  dispatchedTaskIds: string[];
  failedOutboxIds: string[];
}

export const WORKFLOW_OUTBOX_MAX_ATTEMPTS = 8;

export function dispatchWorkflowOutboxBatchSync(input: {
  workerId: string;
  limit: number;
  now?: string;
  workspaceId?: string;
}): WorkflowOutboxDispatchResult {
  const now = input.now ?? new Date().toISOString();
  const items = claimWorkflowOutboxBatchSync({ workerId: input.workerId, now, limit: input.limit, leaseSeconds: 60, workspaceId: input.workspaceId });
  const result: WorkflowOutboxDispatchResult = {
    claimedOutboxIds: items.map((item) => item.id),
    publishedOutboxIds: [],
    dispatchedTaskIds: [],
    failedOutboxIds: [],
  };
  for (const item of items) {
    try {
      const payload = parsePayload(item.payloadJson);
      if (item.eventType === "workflow.node.ready") {
        if (typeof payload.nodeRunId !== "string") throw new Error("workflow_outbox_payload_invalid");
        const dispatched = dispatchReadyWorkflowNodeByTypeSync({ workspaceId: item.workspaceId, nodeRunId: payload.nodeRunId, now });
        if (dispatched.taskQueueId) result.dispatchedTaskIds.push(dispatched.taskQueueId);
      } else if (item.eventType === "workflow.run.ready" || item.eventType === "workflow.run.resumed") {
        if (typeof payload.runId !== "string") throw new Error("workflow_outbox_payload_invalid");
        for (const node of listWorkflowNodeRunsSync(item.workspaceId, payload.runId).filter((candidate) => candidate.status === "ready")) {
          const dispatched = dispatchReadyWorkflowNodeByTypeSync({ workspaceId: item.workspaceId, nodeRunId: node.id, now });
          if (dispatched.taskQueueId) result.dispatchedTaskIds.push(dispatched.taskQueueId);
        }
      }
      markWorkflowOutboxPublishedSync(item.id, input.workerId, item.workspaceId, now);
      result.publishedOutboxIds.push(item.id);
    } catch (error) {
      markWorkflowOutboxFailedSync({
        id: item.id,
        workerId: input.workerId,
        workspaceId: item.workspaceId,
        error: workflowOutboxErrorCode(error),
        nextAvailableAt: computeWorkflowOutboxRetryAt(now, item.attempts),
        maxAttempts: WORKFLOW_OUTBOX_MAX_ATTEMPTS,
      });
      result.failedOutboxIds.push(item.id);
    }
  }
  return result;
}

export function computeWorkflowOutboxRetryAt(now: string, attempts: number): string {
  const delaySeconds = Math.min(900, 5 * 2 ** Math.max(0, attempts - 1));
  return new Date(Date.parse(now) + delaySeconds * 1_000).toISOString();
}

export function workflowOutboxErrorCode(error: unknown): string {
  const message = error instanceof Error ? error.message : "";
  return /^workflow_[a-z0-9_]+$/.test(message) ? message : "workflow_outbox_dispatch_failed";
}

function dispatchReadyWorkflowNodeByTypeSync(input: { workspaceId: string; nodeRunId: string; now: string }): { taskQueueId?: string } {
  const node = readWorkflowNodeRunSync(input.nodeRunId, input.workspaceId);
  if (!node) throw new Error("workflow_node_run_not_found");
  if (node.nodeType === "approval") {
    if (node.status !== "ready") return {};
    const approvalInput = workflowApprovalInputFromNodeConfig(parsePayload(node.inputJson));
    createWorkflowApprovalSync({
      workspaceId: input.workspaceId,
      runId: node.runId,
      nodeId: node.nodeId,
      ...approvalInput,
      now: input.now,
    });
    return {};
  }
  if (node.nodeType !== "employee_task") return {};
  return dispatchReadyWorkflowNodeSync(input);
}

function parsePayload(value: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(value) as unknown;
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) return parsed as Record<string, unknown>;
  } catch {
    // Normalize malformed payloads to a stable, non-sensitive dead-letter reason.
  }
  throw new Error("workflow_outbox_payload_invalid");
}

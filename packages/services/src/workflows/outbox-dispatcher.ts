import {
  claimWorkflowOutboxBatchSync,
  readWorkflowNodeRunSync,
  listWorkflowNodeRunsSync,
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
      if (item.eventType === "workflow.node.ready" && typeof payload.nodeRunId === "string") {
        const dispatched = dispatchReadyWorkflowNodeByTypeSync({ workspaceId: item.workspaceId, nodeRunId: payload.nodeRunId, now });
        if (dispatched.taskQueueId) result.dispatchedTaskIds.push(dispatched.taskQueueId);
      } else if ((item.eventType === "workflow.run.ready" || item.eventType === "workflow.run.resumed") && typeof payload.runId === "string") {
        for (const node of listWorkflowNodeRunsSync(item.workspaceId, payload.runId).filter((candidate) => candidate.status === "ready")) {
          const dispatched = dispatchReadyWorkflowNodeByTypeSync({ workspaceId: item.workspaceId, nodeRunId: node.id, now });
          if (dispatched.taskQueueId) result.dispatchedTaskIds.push(dispatched.taskQueueId);
        }
      }
      markWorkflowOutboxPublishedSync(item.id, input.workerId, item.workspaceId, now);
      result.publishedOutboxIds.push(item.id);
    } catch {
      result.failedOutboxIds.push(item.id);
    }
  }
  return result;
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
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed as Record<string, unknown> : {};
  } catch {
    return {};
  }
}

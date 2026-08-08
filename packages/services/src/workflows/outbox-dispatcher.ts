import {
  appendWorkflowRunEventSync,
  claimWorkflowOutboxBatchSync,
  getDatabase,
  lockWorkflowRunForUpdateSync,
  readWorkflowNodeRunSync,
  listWorkflowNodeRunsSync,
  markWorkflowOutboxFailedSync,
  markWorkflowOutboxPublishedSync,
  transitionWorkflowNodeRunSync,
  withTransaction,
} from "@dofe-agent/db";
import type { WorkflowNodeDefinition } from "@dofe-agent/domain";
import { dispatchReadyWorkflowNodeSync, isWorkflowRunDispatchBlocked } from "./dispatcher.ts";
import { createWorkflowApprovalSync, workflowApprovalInputFromNodeConfig } from "./approvals.ts";
import { validateWorkflowNodeForDispatchSync } from "./validation.ts";

export interface WorkflowOutboxDispatchResult {
  claimedOutboxIds: string[];
  publishedOutboxIds: string[];
  dispatchedTaskIds: string[];
  failedOutboxIds: string[];
  leaseConflictOutboxIds: string[];
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
    leaseConflictOutboxIds: [],
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
      // workflow_outbox_lease_conflict：本 worker 已丢失该条目租约（租约超时被另一 worker
      // 重新认领并处理，或派发耗时超过租约）。这是瞬态：不应消耗重试次数，更不能让
      // markWorkflowOutboxFailedSync 因同样的丢租约再次抛出该错误、逃出循环中断整批。
      // 跳过该条目，交由当前持有租约的 worker 处理，继续批内剩余条目。
      if (workflowOutboxErrorCode(error) === "workflow_outbox_lease_conflict") {
        result.leaseConflictOutboxIds.push(item.id);
        continue;
      }
      try {
        markWorkflowOutboxFailedSync({
          id: item.id,
          workerId: input.workerId,
          workspaceId: item.workspaceId,
          error: workflowOutboxErrorCode(error),
          nextAvailableAt: computeWorkflowOutboxRetryAt(now, item.attempts),
          maxAttempts: WORKFLOW_OUTBOX_MAX_ATTEMPTS,
        });
        result.failedOutboxIds.push(item.id);
      } catch (markError) {
        // 标记失败本身也可能丢租约（派发耗时超过 60s 租约、或条目已被另一 worker 重认领）。
        // 此第二层 lease_conflict 不得逃出 for 循环中断整批剩余条目——归入租约冲突，
        // 交由当前持有租约的 worker 处理，继续批内剩余项。非租约错误属异常，仍向上抛出。
        if (workflowOutboxErrorCode(markError) === "workflow_outbox_lease_conflict") {
          result.leaseConflictOutboxIds.push(item.id);
          continue;
        }
        throw markError;
      }
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
  return withTransaction(getDatabase(), () => dispatchReadyWorkflowNodeByTypeInTransactionSync(input));
}

function dispatchReadyWorkflowNodeByTypeInTransactionSync(input: { workspaceId: string; nodeRunId: string; now: string }): { taskQueueId?: string } {
  const candidate = readWorkflowNodeRunSync(input.nodeRunId, input.workspaceId);
  if (!candidate) throw new Error("workflow_node_run_not_found");
  const run = lockWorkflowRunForUpdateSync(candidate.runId, input.workspaceId);
  if (!run) throw new Error("workflow_run_not_found");
  const node = readWorkflowNodeRunSync(input.nodeRunId, input.workspaceId);
  if (!node) throw new Error("workflow_node_run_not_found");
  if (isWorkflowRunDispatchBlocked(run.status)) return {};
  if (node.nodeType === "approval") {
    if (node.status !== "ready") return {};
    const config = parsePayload(node.inputJson);
    const blocker = validateWorkflowNodeForDispatchSync(input.workspaceId, {
      id: node.nodeId,
      type: "approval",
      config,
    } satisfies WorkflowNodeDefinition);
    if (blocker) {
      const availableAt = new Date(Date.parse(input.now) + 60_000).toISOString();
      const waiting = transitionWorkflowNodeRunSync({
        workspaceId: input.workspaceId,
        nodeRunId: node.id,
        from: ["ready"],
        to: "retry_wait",
        availableAt,
        errorCode: blocker.code,
        errorMessage: blocker.detail,
        now: input.now,
      });
      if (waiting) {
        appendWorkflowRunEventSync({
          workspaceId: input.workspaceId,
          runId: run.id,
          nodeRunId: node.id,
          type: "node.dependency_blocked",
          actorType: "system",
          severity: "warning",
          dataJson: JSON.stringify({ code: blocker.code, availableAt }),
          now: input.now,
        });
      }
      return {};
    }
    const approvalInput = workflowApprovalInputFromNodeConfig(config);
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

import {
  appendWorkflowRunEventSync,
  claimWorkflowOutboxByIdSync,
  claimWorkflowOutboxBatchSync,
  fanOutWorkflowRunOutboxPrisma,
  getDatabase,
  lockWorkflowRunForUpdateSync,
  readWorkflowNodeRunSync,
  listWorkflowNodeRunsSync,
  markWorkflowOutboxFailedSync,
  markWorkflowOutboxFailedPrisma,
  markWorkflowOutboxPublishedSync,
  listPendingWorkflowOutboxPrisma,
  transitionWorkflowNodeRunSync,
  withTransaction,
  isWorkflowDispatcherPrismaWriteEnabled,
  isWorkflowDispatcherPrismaShadowWriteEnabled,
  type WorkflowDispatchObservability,
} from "@dofe-agent/db";
import type { WorkflowNodeDefinition } from "@dofe-agent/domain";
import {
  compareLegacyWorkflowDispatchShadow,
  dispatchReadyWorkflowNodePrisma,
  dispatchReadyWorkflowNodeSync,
  isWorkflowRunDispatchBlocked,
  previewReadyWorkflowNodePrisma,
  readLegacyWorkflowDispatchShadowSnapshot,
} from "./dispatcher.ts";
import { createWorkflowApprovalSync, workflowApprovalInputFromNodeConfig } from "./approvals.ts";
import { validateWorkflowNodeForDispatchSync } from "./validation.ts";
import { observeWorkflowPrismaWrite } from "./prisma-cutover-metrics.ts";

export interface WorkflowOutboxDispatchResult {
  claimedOutboxIds: string[];
  publishedOutboxIds: string[];
  dispatchedTaskIds: string[];
  failedOutboxIds: string[];
  leaseConflictOutboxIds: string[];
  observability?: WorkflowDispatchObservability;
}

function addShadowComparison(
  target: NonNullable<WorkflowDispatchObservability["shadowComparison"]>,
  source: NonNullable<WorkflowDispatchObservability["shadowComparison"]> | undefined,
): void {
  if (!source) return;
  target.comparedCount += source.comparedCount;
  target.mismatchCount += source.mismatchCount;
  if (source.diffFields?.length) {
    target.diffFields = [...new Set([...(target.diffFields ?? []), ...source.diffFields])].slice(0, 50);
  }
}

export const WORKFLOW_OUTBOX_MAX_ATTEMPTS = 8;

type ClaimedWorkflowOutboxItem = ReturnType<typeof claimWorkflowOutboxBatchSync>[number];

function dispatchClaimedWorkflowOutboxItemSync(
  item: ClaimedWorkflowOutboxItem,
  input: { workerId: string },
  now: string,
  result: WorkflowOutboxDispatchResult,
): void {
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
}

function recordClaimedWorkflowOutboxFailureSync(
  error: unknown,
  item: ClaimedWorkflowOutboxItem,
  input: { workerId: string },
  now: string,
  result: WorkflowOutboxDispatchResult,
): void {
  if (workflowOutboxErrorCode(error) === "workflow_outbox_lease_conflict") {
    result.leaseConflictOutboxIds.push(item.id);
    return;
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
    if (workflowOutboxErrorCode(markError) === "workflow_outbox_lease_conflict") {
      result.leaseConflictOutboxIds.push(item.id);
      return;
    }
    throw markError;
  }
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
    leaseConflictOutboxIds: [],
  };
  for (const item of items) {
    try {
      dispatchClaimedWorkflowOutboxItemSync(item, input, now, result);
    } catch (error) {
      recordClaimedWorkflowOutboxFailureSync(error, item, input, now, result);
    }
  }
  return result;
}

/**
 * Prisma dispatcher mode. `workflow.node.ready` is acknowledged by the same
 * transaction that claims the node and inserts the queue/router records. Run
 * events atomically fan out deterministic node-ready events before the parent
 * event is published; child events are dispatched by a subsequent batch.
 */
export async function dispatchWorkflowOutboxBatchPrisma(input: {
  workerId: string;
  limit: number;
  now?: string;
  workspaceId?: string;
}): Promise<WorkflowOutboxDispatchResult> {
  const now = input.now ?? new Date().toISOString();
  const items = await listPendingWorkflowOutboxPrisma({
    now,
    limit: input.limit,
    workspaceId: input.workspaceId,
    eventTypes: ["workflow.node.ready", "workflow.run.ready", "workflow.run.resumed"],
  });
  const result: WorkflowOutboxDispatchResult = {
    claimedOutboxIds: items.map((item) => item.id),
    publishedOutboxIds: [],
    dispatchedTaskIds: [],
    failedOutboxIds: [],
    leaseConflictOutboxIds: [],
    observability: {
      eventOrder: { comparedCount: 0, driftCount: 0 },
      shadowComparison: { comparedCount: 0, mismatchCount: 0, diffFields: [] },
    },
  };
  for (const item of items) {
    try {
      const payload = parsePayload(item.payloadJson);
      if (item.eventType === "workflow.node.ready") {
        if (typeof payload.nodeRunId !== "string") throw new Error("workflow_outbox_payload_invalid");
        const node = readWorkflowNodeRunSync(payload.nodeRunId, item.workspaceId);
        if (node?.nodeType !== "employee_task") {
          const claimed = claimWorkflowOutboxByIdSync({ id: item.id, workerId: input.workerId, workspaceId: item.workspaceId, now, leaseSeconds: 60 });
          if (!claimed) throw new Error("workflow_outbox_lease_conflict");
          const dispatched = dispatchReadyWorkflowNodeByTypeSync({ workspaceId: item.workspaceId, nodeRunId: payload.nodeRunId, now });
          if (dispatched.taskQueueId) result.dispatchedTaskIds.push(dispatched.taskQueueId);
          markWorkflowOutboxPublishedSync(item.id, input.workerId, item.workspaceId, now);
          result.publishedOutboxIds.push(item.id);
          continue;
        }
        const dispatched = await dispatchReadyWorkflowNodePrisma({
          workspaceId: item.workspaceId,
          nodeRunId: payload.nodeRunId,
          now,
          outbox: { id: item.id, workerId: input.workerId },
          atomicOutbox: true,
        });
        if (dispatched.taskQueueId) result.dispatchedTaskIds.push(dispatched.taskQueueId);
        const eventOrder = result.observability?.eventOrder;
        const shadowComparison = result.observability?.shadowComparison;
        if (eventOrder && shadowComparison && dispatched.observability) {
          eventOrder.comparedCount += dispatched.observability.eventOrder.comparedCount;
          eventOrder.driftCount += dispatched.observability.eventOrder.driftCount;
          addShadowComparison(shadowComparison, dispatched.observability.shadowComparison);
        }
      } else if (item.eventType === "workflow.run.ready" || item.eventType === "workflow.run.resumed") {
        if (typeof payload.runId !== "string") throw new Error("workflow_outbox_payload_invalid");
        await fanOutWorkflowRunOutboxPrisma({
          id: item.id,
          workerId: input.workerId,
          workspaceId: item.workspaceId,
          runId: payload.runId,
          now,
        });
      } else {
        throw new Error("workflow_outbox_event_unsupported");
      }
      if (!result.publishedOutboxIds.includes(item.id)) result.publishedOutboxIds.push(item.id);
    } catch (error) {
      if (workflowOutboxErrorCode(error) === "workflow_outbox_lease_conflict") {
        result.leaseConflictOutboxIds.push(item.id);
        continue;
      }
      try {
        await markWorkflowOutboxFailedPrisma({
          id: item.id,
          workerId: input.workerId,
          workspaceId: item.workspaceId,
          error: workflowOutboxErrorCode(error),
          nextAvailableAt: computeWorkflowOutboxRetryAt(now, item.attempts),
          maxAttempts: WORKFLOW_OUTBOX_MAX_ATTEMPTS,
          now,
        });
        result.failedOutboxIds.push(item.id);
      } catch (markError) {
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

/**
 * Shadow runner: preview the Prisma transaction (which always rolls back),
 * execute the legacy write, then compare the actual legacy rows to the preview
 * snapshot. Shadow failures are recorded as mismatches but never block legacy.
 */
export async function dispatchWorkflowOutboxBatchShadow(input: {
  workerId: string;
  limit: number;
  now?: string;
  workspaceId?: string;
}): Promise<WorkflowOutboxDispatchResult> {
  const now = input.now ?? new Date().toISOString();
  const items = claimWorkflowOutboxBatchSync({ workerId: input.workerId, now, limit: input.limit, leaseSeconds: 60, workspaceId: input.workspaceId });
  const result: WorkflowOutboxDispatchResult = {
    claimedOutboxIds: items.map((item) => item.id),
    publishedOutboxIds: [],
    dispatchedTaskIds: [],
    failedOutboxIds: [],
    leaseConflictOutboxIds: [],
    observability: {
      eventOrder: { comparedCount: 0, driftCount: 0 },
      shadowComparison: { comparedCount: 0, mismatchCount: 0, diffFields: [] },
    },
  };
  const observability = result.observability;
  if (!observability) return result;
  const shadowComparison = observability.shadowComparison;
  if (!shadowComparison) return result;
  for (const item of items) {
    const previews: Array<{ nodeRunId: string; snapshot: Parameters<typeof compareLegacyWorkflowDispatchShadow>[0] }> = [];
    try {
      const payload = parsePayload(item.payloadJson);
      const nodeRunIds = item.eventType === "workflow.node.ready" && typeof payload.nodeRunId === "string"
        ? [payload.nodeRunId]
        : (item.eventType === "workflow.run.ready" || item.eventType === "workflow.run.resumed") && typeof payload.runId === "string"
          ? listWorkflowNodeRunsSync(item.workspaceId, payload.runId).filter((node) => node.status === "ready" && node.nodeType === "employee_task").map((node) => node.id)
          : [];
      for (const nodeRunId of nodeRunIds) {
        const node = readWorkflowNodeRunSync(nodeRunId, item.workspaceId);
        if (!node || node.nodeType !== "employee_task" || node.status !== "ready") continue;
        try {
          const preview = await previewReadyWorkflowNodePrisma({ workspaceId: item.workspaceId, nodeRunId, now });
          previews.push({ nodeRunId, snapshot: preview.snapshot });
          if (preview.result.observability?.eventOrder) {
            observability.eventOrder.comparedCount += preview.result.observability.eventOrder.comparedCount;
            observability.eventOrder.driftCount += preview.result.observability.eventOrder.driftCount;
          }
        } catch (error) {
          addShadowComparison(shadowComparison, { comparedCount: 1, mismatchCount: 1, diffFields: [`shadow.preview_error:${workflowOutboxErrorCode(error)}`] });
        }
      }
    } catch (error) {
      addShadowComparison(shadowComparison, { comparedCount: 1, mismatchCount: 1, diffFields: [`shadow.preview_error:${workflowOutboxErrorCode(error)}`] });
    }

    try {
      dispatchClaimedWorkflowOutboxItemSync(item, input, now, result);
    } catch (error) {
      recordClaimedWorkflowOutboxFailureSync(error, item, input, now, result);
    }

    for (const preview of previews) {
      const legacyNode = readWorkflowNodeRunSync(preview.nodeRunId, item.workspaceId);
      const legacy = readLegacyWorkflowDispatchShadowSnapshot({
        workspaceId: item.workspaceId,
        result: { nodeRunId: preview.nodeRunId, taskQueueId: legacyNode?.taskQueueId, status: legacyNode?.status ?? "missing" },
      });
      addShadowComparison(shadowComparison, compareLegacyWorkflowDispatchShadow(preview.snapshot, legacy));
    }
  }
  return result;
}

export function dispatchWorkflowOutboxBatchAuto(input: {
  workerId: string;
  limit: number;
  now?: string;
  workspaceId?: string;
}): WorkflowOutboxDispatchResult | Promise<WorkflowOutboxDispatchResult> {
  return isWorkflowDispatcherPrismaWriteEnabled()
    ? observeWorkflowPrismaWrite(
        { domain: "workflow-dispatcher", operation: "outbox.batch" },
        () => dispatchWorkflowOutboxBatchPrisma(input),
        // 批次摘要：发布+失败条目计入分母（租约冲突未尝试写不计入），
        // 失败条目计入分子，批内结构化失败不再被记成成功样本。
        {
          summarizeResult: (result) => ({
            sampleCount: result.publishedOutboxIds.length + result.failedOutboxIds.length,
            errorCount: result.failedOutboxIds.length,
            eventOrder: result.observability?.eventOrder,
            shadowComparison: result.observability?.shadowComparison,
          }),
        },
      )
    : isWorkflowDispatcherPrismaShadowWriteEnabled()
      ? observeWorkflowPrismaWrite(
          { domain: "workflow-dispatcher", operation: "outbox.shadow-batch" },
          () => dispatchWorkflowOutboxBatchShadow(input),
          {
            summarizeResult: (result) => ({
              sampleCount: result.publishedOutboxIds.length + result.failedOutboxIds.length,
              errorCount: result.failedOutboxIds.length,
              eventOrder: result.observability?.eventOrder,
              shadowComparison: result.observability?.shadowComparison,
            }),
          },
        )
      : dispatchWorkflowOutboxBatchSync(input);
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

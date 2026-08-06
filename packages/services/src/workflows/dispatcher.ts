import {
  claimWorkflowNodeForDispatchSync,
  enqueueNativeTaskSync,
  getDatabase,
  appendWorkflowRunEventSync,
  listWorkflowNodeRunsSync,
  lockWorkflowRunForUpdateSync,
  readStoredEmployeeByIdSync,
  readWorkflowNodeRunSync,
  readWorkflowVersionSync,
  transitionWorkflowNodeRunSync,
  withTransaction,
  type WorkflowTaskMetadata,
} from "@dofe-agent/db";
import type { WorkflowGraphDefinition, WorkflowNodeDefinition } from "@dofe-agent/domain";
import { failWorkflowNodeBeforeDispatchSync } from "./coordinator.ts";
import { buildWorkflowNodeRuntimeContext, getWorkflowInputResolutionErrorCode, workflowNodeOutputFields } from "./inputs.ts";
import { validateWorkflowNodeForDispatchSync } from "./validation.ts";

export interface DispatchWorkflowNodeInput {
  workspaceId: string;
  nodeRunId: string;
  now?: string;
}

export interface DispatchWorkflowNodeResult {
  nodeRunId: string;
  taskQueueId?: string;
  status: string;
}

export function dispatchReadyWorkflowNodeSync(input: DispatchWorkflowNodeInput): DispatchWorkflowNodeResult {
  return withTransaction(getDatabase(), () => dispatchReadyWorkflowNodeInTransactionSync(input));
}

function dispatchReadyWorkflowNodeInTransactionSync(input: DispatchWorkflowNodeInput): DispatchWorkflowNodeResult {
  const candidate = readWorkflowNodeRunSync(input.nodeRunId, input.workspaceId);
  if (!candidate) throw new Error("workflow_node_run_not_found");
  const run = lockWorkflowRunForUpdateSync(candidate.runId, input.workspaceId);
  if (!run) throw new Error("workflow_run_not_found");
  const nodeRun = readWorkflowNodeRunSync(input.nodeRunId, input.workspaceId);
  if (!nodeRun) throw new Error("workflow_node_run_not_found");
  if (isWorkflowRunDispatchBlocked(run.status)) {
    return { nodeRunId: nodeRun.id, taskQueueId: nodeRun.taskQueueId, status: nodeRun.status };
  }
  if (nodeRun.status === "queued" && nodeRun.taskQueueId) {
    return { nodeRunId: nodeRun.id, taskQueueId: nodeRun.taskQueueId, status: nodeRun.status };
  }
  if (nodeRun.status !== "ready") {
    return { nodeRunId: nodeRun.id, taskQueueId: nodeRun.taskQueueId, status: nodeRun.status };
  }
  const now = input.now ?? new Date().toISOString();
  const version = readWorkflowVersionSync(run.versionId, input.workspaceId);
  if (!version) throw new Error("workflow_version_not_found");
  const graph = JSON.parse(version.graphJson) as WorkflowGraphDefinition;
  let runtimeContext;
  try {
    runtimeContext = buildWorkflowNodeRuntimeContext({
      graph,
      nodeId: nodeRun.nodeId,
      runInput: parseConfig(run.inputJson),
      nodeRuns: listWorkflowNodeRunsSync(input.workspaceId, run.id),
    });
  } catch (error) {
    const errorCode = getWorkflowInputResolutionErrorCode(error);
    if (!errorCode) throw error;
    const failed = failWorkflowNodeBeforeDispatchSync({
      workspaceId: input.workspaceId,
      nodeRunId: nodeRun.id,
      errorCode,
      now,
    });
    return { nodeRunId: failed.id, status: failed.status };
  }
  const config = runtimeContext.nodeConfig;
  const governance = parseConfig(version.governanceJson);
  const maxConcurrency = resolveWorkflowMaxConcurrency(governance.maxConcurrency);
  const blocker = validateWorkflowNodeForDispatchSync(input.workspaceId, {
    id: nodeRun.nodeId,
    type: "employee_task",
    employeeId: nodeRun.employeeId,
    config,
  } satisfies WorkflowNodeDefinition);
  if (blocker) {
    const availableAt = new Date(Date.parse(now) + 60_000).toISOString();
    const waiting = transitionWorkflowNodeRunSync({
      workspaceId: input.workspaceId,
      nodeRunId: nodeRun.id,
      from: ["ready"],
      to: "retry_wait",
      availableAt,
      errorCode: blocker.code,
      errorMessage: blocker.detail,
      now,
    });
    if (waiting) {
      appendWorkflowRunEventSync({
        workspaceId: input.workspaceId,
        runId: run.id,
        nodeRunId: nodeRun.id,
        type: "node.dependency_blocked",
        actorType: "system",
        severity: "warning",
        dataJson: JSON.stringify({ code: blocker.code, availableAt }),
        now,
      });
      return { nodeRunId: waiting.id, status: waiting.status };
    }
    const current = readWorkflowNodeRunSync(nodeRun.id, input.workspaceId)!;
    return { nodeRunId: current.id, taskQueueId: current.taskQueueId, status: current.status };
  }
  const claim = claimWorkflowNodeForDispatchSync({
    workspaceId: input.workspaceId,
    nodeRunId: nodeRun.id,
    maxConcurrency,
    now,
  });
  if (claim.reason === "concurrency_limited" && claim.nodeRun) {
    appendWorkflowRunEventSync({
      workspaceId: input.workspaceId,
      runId: run.id,
      nodeRunId: nodeRun.id,
      type: "node.concurrency_wait",
      actorType: "dispatcher",
      dataJson: JSON.stringify({ maxConcurrency, availableAt: claim.nodeRun.availableAt }),
      now,
    });
    return { nodeRunId: claim.nodeRun.id, status: claim.nodeRun.status };
  }
  const queued = claim.nodeRun;
  if (!queued) {
    const current = readWorkflowNodeRunSync(nodeRun.id, input.workspaceId)!;
    return { nodeRunId: current.id, taskQueueId: current.taskQueueId, status: current.status };
  }
  const employee = nodeRun.employeeId
    ? readStoredEmployeeByIdSync(nodeRun.employeeId, input.workspaceId)?.name
    : undefined;
  if (!employee) {
    rollbackReady(input, now);
    throw new Error("workflow_employee_not_ready");
  }
  const task = enqueueNativeTaskSync({
    workspaceId: input.workspaceId,
    taskId: nodeRun.id,
    assignee: employee,
    title: typeof config.title === "string"
      ? config.title
      : typeof config.instruction === "string" && config.instruction.trim()
        ? config.instruction.trim()
        : `Workflow node ${nodeRun.nodeId}`,
    channel: typeof config.channelName === "string" ? config.channelName : undefined,
    priority: config.priority === "low" || config.priority === "high" ? config.priority : "medium",
    triggerType: "workflow",
    metadata: { workflowNodeInput: runtimeContext.resolvedInput },
    workflow: {
      workflowId: run.workflowId,
      workflowVersionId: run.versionId,
      workflowRunId: run.id,
      workflowNodeId: nodeRun.nodeId,
      workflowNodeRunId: nodeRun.id,
      attempt: Math.max(1, nodeRun.attemptCount),
      artifactRefs: runtimeContext.artifactRefs,
      outputSchema: workflowNodeOutputSchema(config),
    } satisfies WorkflowTaskMetadata,
  });
  if (!task) {
    const availableAt = computeWorkflowQueueRetryAt(now);
    const waiting = transitionWorkflowNodeRunSync({
      workspaceId: input.workspaceId,
      nodeRunId: nodeRun.id,
      from: ["queued"],
      to: "retry_wait",
      availableAt,
      clearTaskQueueId: true,
      errorCode: "workflow_task_queue_unavailable",
      now,
    });
    if (!waiting) throw new Error("workflow_node_queue_retry_conflict");
    appendWorkflowRunEventSync({
      workspaceId: input.workspaceId,
      runId: run.id,
      nodeRunId: waiting.id,
      type: "node.queue_blocked",
      actorType: "dispatcher",
      severity: "warning",
      dataJson: JSON.stringify({ code: "workflow_task_queue_unavailable", availableAt }),
      now,
    });
    return { nodeRunId: waiting.id, status: waiting.status };
  }
  const updated = transitionWorkflowNodeRunSync({
    workspaceId: input.workspaceId,
    nodeRunId: nodeRun.id,
    from: ["queued"],
    to: "queued",
    taskQueueId: task.id,
    attemptCount: Math.max(1, nodeRun.attemptCount),
    now,
  });
  if (!updated) throw new Error("workflow_node_queue_link_conflict");
  return { nodeRunId: updated.id, taskQueueId: task.id, status: updated.status };
}

export function resolveWorkflowMaxConcurrency(value: unknown): number {
  return typeof value === "number" && Number.isInteger(value) && value >= 1 && value <= 20 ? value : 4;
}

export function workflowNodeOutputSchema(config: Record<string, unknown>): Record<string, unknown> {
  const fields = workflowNodeOutputFields(config);
  return {
    type: "object",
    required: fields,
    properties: Object.fromEntries(fields.map((field) => [field, {}])),
    additionalProperties: false,
  };
}

export function isWorkflowRunDispatchBlocked(status: string): boolean {
  return ["paused", "cancelled", "failed", "succeeded", "partially_succeeded"].includes(status);
}

export function computeWorkflowQueueRetryAt(now: string): string {
  return new Date(Date.parse(now) + 60_000).toISOString();
}

function rollbackReady(input: DispatchWorkflowNodeInput, now: string): void {
  transitionWorkflowNodeRunSync({
    workspaceId: input.workspaceId,
    nodeRunId: input.nodeRunId,
    from: ["queued"],
    to: "ready",
    availableAt: now,
    now,
  });
}

function parseConfig(value: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(value) as unknown;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed as Record<string, unknown> : {};
  } catch {
    return {};
  }
}

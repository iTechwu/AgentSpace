import {
  enqueueNativeTaskSync,
  readWorkflowNodeRunSync,
  readWorkflowRunSync,
  readWorkflowVersionSync,
  transitionWorkflowNodeRunSync,
  type WorkflowTaskMetadata,
} from "@dofe-agent/db";

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
  const nodeRun = readWorkflowNodeRunSync(input.nodeRunId, input.workspaceId);
  if (!nodeRun) throw new Error("workflow_node_run_not_found");
  const run = readWorkflowRunSync(nodeRun.runId, input.workspaceId);
  if (!run) throw new Error("workflow_run_not_found");
  if (["paused", "cancelled", "failed", "succeeded", "partially_succeeded"].includes(run.status)) {
    return { nodeRunId: nodeRun.id, taskQueueId: nodeRun.taskQueueId, status: nodeRun.status };
  }
  if (nodeRun.status === "queued" && nodeRun.taskQueueId) {
    return { nodeRunId: nodeRun.id, taskQueueId: nodeRun.taskQueueId, status: nodeRun.status };
  }
  if (nodeRun.status !== "ready") {
    return { nodeRunId: nodeRun.id, taskQueueId: nodeRun.taskQueueId, status: nodeRun.status };
  }
  const now = input.now ?? new Date().toISOString();
  const queued = transitionWorkflowNodeRunSync({
    workspaceId: input.workspaceId,
    nodeRunId: nodeRun.id,
    from: ["ready"],
    to: "queued",
    now,
  });
  if (!queued) {
    const current = readWorkflowNodeRunSync(nodeRun.id, input.workspaceId)!;
    return { nodeRunId: current.id, taskQueueId: current.taskQueueId, status: current.status };
  }
  const version = readWorkflowVersionSync(run.versionId, input.workspaceId);
  const config = parseConfig(nodeRun.inputJson);
  const employee = nodeRun.employeeNameSnapshot ?? nodeRun.employeeId;
  if (!employee) {
    rollbackReady(input, now);
    throw new Error("workflow_employee_not_ready");
  }
  const task = enqueueNativeTaskSync({
    workspaceId: input.workspaceId,
    taskId: nodeRun.id,
    assignee: employee,
    title: typeof config.title === "string" ? config.title : `Workflow node ${nodeRun.nodeId}`,
    channel: typeof config.channelName === "string" ? config.channelName : undefined,
    priority: config.priority === "low" || config.priority === "high" ? config.priority : "medium",
    triggerType: "workflow",
    metadata: { workflowNodeInput: config.input ?? {} },
    workflow: {
      workflowId: run.workflowId,
      workflowVersionId: run.versionId,
      workflowRunId: run.id,
      workflowNodeId: nodeRun.nodeId,
      workflowNodeRunId: nodeRun.id,
      attempt: Math.max(1, nodeRun.attemptCount),
      artifactRefs: [],
      outputSchema: version ? parseConfig(version.outputSchemaJson) : undefined,
    } satisfies WorkflowTaskMetadata,
  });
  if (!task) {
    rollbackReady(input, now);
    return { nodeRunId: nodeRun.id, status: "ready" };
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

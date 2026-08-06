import {
  advanceWorkflowTriggerSync,
  appendWorkflowRunEventSync,
  createWorkflowRunSync,
  enqueueWorkflowOutboxSync,
  listWorkflowNodeRunsSync,
  materializeWorkflowNodeRunsSync,
  readWorkflowDefinitionSync,
  readWorkflowVersionSync,
  transitionWorkflowNodeRunSync,
  transitionWorkflowRunSync,
  type WorkflowTriggerRecord,
} from "@dofe-agent/db";
import type { WorkflowGraphDefinition } from "@dofe-agent/domain";

export interface MaterializeWorkflowRunInput {
  workspaceId: string;
  trigger: WorkflowTriggerRecord;
  scheduledAt: string;
  createdBy?: string;
  inputJson?: string;
  now: string;
}

export function materializeWorkflowRunSync(input: MaterializeWorkflowRunInput): {
  runId: string;
  created: boolean;
} {
  const definition = readWorkflowDefinitionSync(input.trigger.workflowId, input.workspaceId);
  const versionId = definition?.activeVersionId;
  const version = versionId ? readWorkflowVersionSync(versionId, input.workspaceId) : null;
  if (!definition || !version) throw new Error("workflow_active_version_missing");
  const graph = JSON.parse(version.graphJson) as WorkflowGraphDefinition;
  const triggerKey = `${input.trigger.workflowId}:${input.trigger.id}:${input.scheduledAt}`;
  const run = createWorkflowRunSync({
    workspaceId: input.workspaceId,
    workflowId: input.trigger.workflowId,
    versionId: version.id,
    triggerId: input.trigger.id,
    triggerType: input.trigger.type,
    triggerKey,
    inputJson: input.inputJson ?? "{}",
    createdBy: input.createdBy,
    now: input.now,
  });
  const existingNodes = listWorkflowNodeRunsSync(input.workspaceId, run.id);
  if (existingNodes.length > 0) return { runId: run.id, created: false };

  const employees = new Map(
    graph.nodes.filter((node) => node.type === "employee_task" && node.employeeId).map((node) => [node.employeeId!, node.employeeId!]),
  );
  materializeWorkflowNodeRunsSync({
    workspaceId: input.workspaceId,
    runId: run.id,
    now: input.now,
    nodes: graph.nodes.map((node) => ({
      nodeId: node.id,
      nodeType: node.type,
      employeeId: node.employeeId,
      employeeNameSnapshot: node.employeeId ? employees.get(node.employeeId) : undefined,
      maxAttempts: typeof node.config.retry === "object" && node.config.retry && typeof (node.config.retry as { maxAttempts?: unknown }).maxAttempts === "number"
        ? (node.config.retry as { maxAttempts: number }).maxAttempts
        : 1,
      inputJson: JSON.stringify(node.config),
    })),
  });
  transitionWorkflowRunSync({ workspaceId: input.workspaceId, runId: run.id, from: ["created"], to: "queued", now: input.now });
  appendWorkflowRunEventSync({ workspaceId: input.workspaceId, runId: run.id, type: "run.created", actorType: "scheduler", dataJson: JSON.stringify({ triggerId: input.trigger.id }), now: input.now });
  enqueueWorkflowOutboxSync({ workspaceId: input.workspaceId, aggregateType: "workflow_run", aggregateId: run.id, eventType: "workflow.run.ready", payloadJson: JSON.stringify({ runId: run.id }), now: input.now });

  const incoming = new Set(graph.edges.map((edge) => edge.target));
  for (const node of graph.nodes) {
    if (!incoming.has(node.id)) {
      const nodeRun = listWorkflowNodeRunsSync(input.workspaceId, run.id).find((item) => item.nodeId === node.id);
      if (nodeRun) transitionWorkflowNodeRunSync({ workspaceId: input.workspaceId, nodeRunId: nodeRun.id, from: ["pending"], to: "ready", availableAt: input.now, now: input.now });
    }
  }
  return { runId: run.id, created: true };
}

export function releaseWorkflowTriggerLeaseSync(input: {
  trigger: WorkflowTriggerRecord;
  workerId: string;
  nextFireAt?: string | null;
  lastFireAt?: string | null;
  now: string;
  status?: string;
}): void {
  const result = advanceWorkflowTriggerSync({
    id: input.trigger.id,
    workspaceId: input.trigger.workspaceId,
    workerId: input.workerId,
    nextFireAt: input.nextFireAt,
    lastFireAt: input.lastFireAt,
    status: input.status,
    now: input.now,
  });
  if (!result) throw new Error("workflow_trigger_lease_conflict");
}

import {
  appendWorkflowRunEventSync,
  getDatabase,
  listWorkflowNodeRunsSync,
  readWorkflowNodeRunSync,
  readWorkflowNodeRunByApprovalIdSync,
  readWorkflowRunSync,
  readWorkflowVersionSync,
  enqueueWorkflowOutboxSync,
  transitionWorkflowNodeRunSync,
  transitionWorkflowRunSync,
  withTransaction,
  type WorkflowNodeRunRecord,
  type WorkflowRunRecord,
} from "@dofe-agent/db";
import type { WorkflowGraphDefinition } from "@dofe-agent/domain";
import { resolveWorkflowNodeInput } from "./inputs.ts";

export interface CompleteWorkflowNodeInput {
  workspaceId: string;
  nodeRunId: string;
  taskQueueId: string;
  output: Record<string, unknown>;
  artifactManifest?: unknown[];
  now?: string;
}

export function completeWorkflowNodeSync(input: CompleteWorkflowNodeInput): WorkflowRunRecord {
  const db = getDatabase();
  const now = input.now ?? new Date().toISOString();
  return withTransaction(db, () => {
    const nodeRun = readWorkflowNodeRunSync(input.nodeRunId, input.workspaceId);
    if (!nodeRun) throw new Error("workflow_node_run_not_found");
    const run = readWorkflowRunSync(nodeRun.runId, input.workspaceId);
    if (!run) throw new Error("workflow_run_not_found");
    if (nodeRun.status === "succeeded" || nodeRun.status === "failed" || nodeRun.status === "cancelled") return run;
    if (nodeRun.taskQueueId !== input.taskQueueId) throw new Error("workflow_task_queue_mismatch");
    const taskWorkspace = db.prepare("SELECT workspace_id AS workspaceId FROM agent_task_queue WHERE id = ?")
      .get(input.taskQueueId) as { workspaceId?: string } | undefined;
    if (taskWorkspace?.workspaceId !== input.workspaceId) throw new Error("workflow_cross_workspace_reference");
    const updated = transitionWorkflowNodeRunSync({
      workspaceId: input.workspaceId,
      nodeRunId: nodeRun.id,
      from: ["queued", "running"],
      to: "succeeded",
      outputJson: JSON.stringify(input.output),
      artifactManifestJson: JSON.stringify(input.artifactManifest ?? []),
      finishedAt: now,
      now,
    });
    if (!updated) return readWorkflowRunSync(run.id, input.workspaceId)!;
    appendWorkflowRunEventSync({ workspaceId: input.workspaceId, runId: run.id, nodeRunId: nodeRun.id, type: "node.succeeded", actorType: "daemon", dataJson: JSON.stringify({ taskQueueId: input.taskQueueId }), now });
    advanceDownstream({ workspaceId: input.workspaceId, run, completed: updated, now });
    return finalizeRunIfTerminal(input.workspaceId, run, now);
  });
}

export function failWorkflowNodeSync(input: {
  workspaceId: string;
  nodeRunId: string;
  taskQueueId: string;
  errorCode?: string;
  errorMessage?: string;
  now?: string;
}): WorkflowRunRecord {
  const db = getDatabase();
  const now = input.now ?? new Date().toISOString();
  return withTransaction(db, () => {
    const nodeRun = readWorkflowNodeRunSync(input.nodeRunId, input.workspaceId);
    if (!nodeRun) throw new Error("workflow_node_run_not_found");
    const run = readWorkflowRunSync(nodeRun.runId, input.workspaceId);
    if (!run) throw new Error("workflow_run_not_found");
    if (["succeeded", "failed", "cancelled"].includes(nodeRun.status)) return run;
    if (nodeRun.taskQueueId !== input.taskQueueId) throw new Error("workflow_task_queue_mismatch");
    const updated = transitionWorkflowNodeRunSync({
      workspaceId: input.workspaceId,
      nodeRunId: nodeRun.id,
      from: ["queued", "running", "retry_wait"],
      to: "failed",
      errorCode: input.errorCode,
      errorMessage: input.errorMessage,
      finishedAt: now,
      now,
    });
    if (updated) appendWorkflowRunEventSync({ workspaceId: input.workspaceId, runId: run.id, nodeRunId: nodeRun.id, type: "node.failed", actorType: "daemon", severity: "error", dataJson: JSON.stringify({ code: input.errorCode }), now });
    return finalizeRunIfTerminal(input.workspaceId, run, now);
  });
}

export function completeWorkflowApprovalNodeSync(input: {
  workspaceId: string;
  approvalId: string;
  actorUserId: string;
  approved: boolean;
  now?: string;
}): WorkflowRunRecord {
  const db = getDatabase();
  const now = input.now ?? new Date().toISOString();
  return withTransaction(db, () => {
    const nodeRun = readWorkflowNodeRunByApprovalIdSync(input.approvalId, input.workspaceId);
    if (!nodeRun) throw new Error("workflow_approval_not_linked");
    const run = readWorkflowRunSync(nodeRun.runId, input.workspaceId);
    if (!run) throw new Error("workflow_run_not_found");
    if (nodeRun.status !== "waiting_approval") return run;
    const updated = transitionWorkflowNodeRunSync({
      workspaceId: input.workspaceId,
      nodeRunId: nodeRun.id,
      from: ["waiting_approval"],
      to: input.approved ? "succeeded" : "failed",
      outputJson: input.approved ? JSON.stringify({ approved: true, actorUserId: input.actorUserId }) : undefined,
      errorCode: input.approved ? undefined : "workflow_approval_rejected",
      finishedAt: now,
      now,
    });
    if (!updated) return readWorkflowRunSync(run.id, input.workspaceId)!;
    appendWorkflowRunEventSync({
      workspaceId: input.workspaceId,
      runId: run.id,
      nodeRunId: nodeRun.id,
      type: input.approved ? "approval.approved" : "approval.rejected",
      actorType: "human",
      actorId: input.actorUserId,
      severity: input.approved ? "info" : "error",
      dataJson: JSON.stringify({ approvalId: input.approvalId }),
      now,
    });
    if (input.approved) advanceDownstream({ workspaceId: input.workspaceId, run, completed: updated, now });
    return finalizeRunIfTerminal(input.workspaceId, run, now);
  });
}

function advanceDownstream(input: { workspaceId: string; run: WorkflowRunRecord; completed: WorkflowNodeRunRecord; now: string }): void {
  const version = readWorkflowVersionSync(input.run.versionId, input.workspaceId);
  if (!version) throw new Error("workflow_version_not_found");
  const graph = JSON.parse(version.graphJson) as WorkflowGraphDefinition;
  const allRuns = listWorkflowNodeRunsSync(input.workspaceId, input.run.id);
  const byId = new Map(allRuns.map((node) => [node.nodeId, node]));
  for (const edge of graph.edges.filter((edge) => edge.source === input.completed.nodeId)) {
    const target = byId.get(edge.target);
    if (!target || target.status !== "pending") continue;
    const predecessors = graph.edges.filter((candidate) => candidate.target === target.nodeId).map((candidate) => byId.get(candidate.source)).filter((node): node is WorkflowNodeRunRecord => Boolean(node));
    const terminal = predecessors.every((node) => ["succeeded", "failed", "skipped", "cancelled"].includes(node.status));
    if (!terminal) continue;
    const success = predecessors.filter((node) => node.status === "succeeded");
    const targetConfig = parseConfig(target.inputJson);
    if (target.nodeType === "join") {
      const policy = targetConfig.policy === "allow_partial" ? "allow_partial" : "all_success";
      if (policy === "all_success" && success.length !== predecessors.length) {
        transitionWorkflowNodeRunSync({ workspaceId: input.workspaceId, nodeRunId: target.id, from: ["pending"], to: "failed", errorCode: "workflow_join_upstream_failed", finishedAt: input.now, now: input.now });
      } else if (success.length > 0) {
        const outputs = Object.fromEntries(success.map((node) => [node.nodeId, parseJson(node.outputJson)]));
        transitionWorkflowNodeRunSync({ workspaceId: input.workspaceId, nodeRunId: target.id, from: ["pending"], to: "succeeded", outputJson: JSON.stringify({ outputs }), finishedAt: input.now, now: input.now });
        appendWorkflowRunEventSync({ workspaceId: input.workspaceId, runId: input.run.id, nodeRunId: target.id, type: "join.succeeded", actorType: "coordinator", dataJson: JSON.stringify({ policy }), now: input.now });
        activateSuccessors(input, graph, byId, target.nodeId);
      }
    } else if (success.length === predecessors.length) {
      const predecessorOutputs = Object.fromEntries(predecessors.map((node) => [node.nodeId, parseRecord(node.outputJson)]));
      const resolved = resolveWorkflowNodeInput({ runInput: parseRecord(input.run.inputJson), nodeConfig: targetConfig, predecessorOutputs });
      transitionWorkflowNodeRunSync({ workspaceId: input.workspaceId, nodeRunId: target.id, from: ["pending"], to: "ready", availableAt: input.now, inputJson: JSON.stringify(resolved), now: input.now });
      enqueueWorkflowOutboxSync({ workspaceId: input.workspaceId, aggregateType: "workflow_node_run", aggregateId: target.id, eventType: "workflow.node.ready", payloadJson: JSON.stringify({ nodeRunId: target.id }), now: input.now });
    }
  }
}

function activateSuccessors(input: { workspaceId: string; run: WorkflowRunRecord; now: string }, graph: WorkflowGraphDefinition, byId: Map<string, WorkflowNodeRunRecord>, nodeId: string): void {
  for (const edge of graph.edges.filter((edge) => edge.source === nodeId)) {
    const target = byId.get(edge.target);
    if (!target || target.status !== "pending") continue;
    transitionWorkflowNodeRunSync({ workspaceId: input.workspaceId, nodeRunId: target.id, from: ["pending"], to: "ready", availableAt: input.now, now: input.now });
    enqueueWorkflowOutboxSync({ workspaceId: input.workspaceId, aggregateType: "workflow_node_run", aggregateId: target.id, eventType: "workflow.node.ready", payloadJson: JSON.stringify({ nodeRunId: target.id }), now: input.now });
  }
}

function finalizeRunIfTerminal(workspaceId: string, run: WorkflowRunRecord, now: string): WorkflowRunRecord {
  const nodes = listWorkflowNodeRunsSync(workspaceId, run.id);
  if (nodes.some((node) => ["pending", "ready", "queued", "running", "waiting_approval", "retry_wait"].includes(node.status))) {
    transitionWorkflowRunSync({ workspaceId, runId: run.id, from: ["created", "queued"], to: "running", now });
    return readWorkflowRunSync(run.id, workspaceId)!;
  }
  const failed = nodes.some((node) => node.status === "failed" || node.status === "cancelled");
  const partial = nodes.some((node) => node.status === "skipped");
  transitionWorkflowRunSync({ workspaceId, runId: run.id, from: ["created", "queued", "running"], to: failed ? (partial ? "partially_succeeded" : "failed") : "succeeded", finishedAt: now, now });
  return readWorkflowRunSync(run.id, workspaceId)!;
}

function parseConfig(value: string): Record<string, unknown> {
  const parsed = parseJson(value);
  return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed as Record<string, unknown> : {};
}

function parseJson(value?: string): unknown {
  try { return value ? JSON.parse(value) : {}; } catch { return {}; }
}

function parseRecord(value?: string): Record<string, unknown> {
  const parsed = parseJson(value);
  return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed as Record<string, unknown> : {};
}

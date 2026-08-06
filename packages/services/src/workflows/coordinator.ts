import {
  appendWorkflowRunEventSync,
  cancelQueuedTaskSync,
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
import {
  buildWorkflowNodeRuntimeContext,
  getWorkflowInputResolutionErrorCode,
  mergeWorkflowArtifactManifests,
} from "./inputs.ts";

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
    if (updated) {
      appendWorkflowRunEventSync({ workspaceId: input.workspaceId, runId: run.id, nodeRunId: nodeRun.id, type: "node.failed", actorType: "daemon", severity: "error", dataJson: JSON.stringify({ code: input.errorCode }), now });
      if (updated.attemptCount >= updated.maxAttempts) {
        advanceDownstream({ workspaceId: input.workspaceId, run, completed: updated, now });
      }
    }
    if (updated && updated.attemptCount < updated.maxAttempts) {
      return readWorkflowRunSync(run.id, input.workspaceId)!;
    }
    return finalizeRunIfTerminal(input.workspaceId, run, now);
  });
}

export function failStaleWorkflowNodeSync(input: {
  workspaceId: string;
  nodeRunId: string;
  actorId: string;
  now: string;
}): WorkflowNodeRunRecord {
  return withTransaction(getDatabase(), () => {
    const nodeRun = readWorkflowNodeRunSync(input.nodeRunId, input.workspaceId);
    if (!nodeRun) throw new Error("workflow_node_run_not_found");
    const run = readWorkflowRunSync(nodeRun.runId, input.workspaceId);
    if (!run) throw new Error("workflow_run_not_found");
    const failed = transitionWorkflowNodeRunSync({
      workspaceId: input.workspaceId,
      nodeRunId: nodeRun.id,
      from: ["queued"],
      to: "failed",
      clearTaskQueueId: true,
      errorCode: "workflow_stale_queue_recovered",
      errorMessage: "queued task disappeared before completion",
      finishedAt: input.now,
      now: input.now,
    });
    if (!failed) throw new Error("workflow_node_recovery_conflict");
    appendWorkflowRunEventSync({
      workspaceId: input.workspaceId,
      runId: run.id,
      nodeRunId: failed.id,
      type: "node.failed",
      actorType: "system",
      actorId: input.actorId,
      severity: "error",
      dataJson: JSON.stringify({ code: "workflow_stale_queue_recovered" }),
      now: input.now,
    });
    if (failed.attemptCount >= failed.maxAttempts) {
      advanceDownstream({ workspaceId: input.workspaceId, run, completed: failed, now: input.now });
      finalizeRunIfTerminal(input.workspaceId, run, input.now);
    }
    return failed;
  });
}

export function failWorkflowNodeBeforeDispatchSync(input: {
  workspaceId: string;
  nodeRunId: string;
  errorCode: "workflow_input_reference_missing" | "workflow_version_node_missing";
  now: string;
}): WorkflowNodeRunRecord {
  return withTransaction(getDatabase(), () => {
    const nodeRun = readWorkflowNodeRunSync(input.nodeRunId, input.workspaceId);
    if (!nodeRun) throw new Error("workflow_node_run_not_found");
    const run = readWorkflowRunSync(nodeRun.runId, input.workspaceId);
    if (!run) throw new Error("workflow_run_not_found");
    const failed = transitionWorkflowNodeRunSync({
      workspaceId: input.workspaceId,
      nodeRunId: nodeRun.id,
      from: ["ready"],
      to: "failed",
      errorCode: input.errorCode,
      finishedAt: input.now,
      now: input.now,
    });
    if (!failed) return readWorkflowNodeRunSync(nodeRun.id, input.workspaceId)!;
    appendWorkflowRunEventSync({
      workspaceId: input.workspaceId,
      runId: run.id,
      nodeRunId: failed.id,
      type: "node.failed",
      actorType: "dispatcher",
      severity: "error",
      dataJson: JSON.stringify({ code: input.errorCode }),
      now: input.now,
    });
    advanceDownstream({ workspaceId: input.workspaceId, run, completed: failed, now: input.now });
    finalizeRunIfTerminal(input.workspaceId, run, input.now);
    return failed;
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
    if (!input.approved) {
      for (const candidate of listWorkflowNodeRunsSync(input.workspaceId, run.id)) {
        if (candidate.id === updated.id || ["succeeded", "failed", "skipped", "cancelled"].includes(candidate.status)) continue;
        if (candidate.taskQueueId) {
          cancelQueuedTaskSync({ taskId: candidate.taskQueueId, errorText: "workflow_approval_rejected" });
        }
        transitionWorkflowNodeRunSync({
          workspaceId: input.workspaceId,
          nodeRunId: candidate.id,
          from: [candidate.status],
          to: "cancelled",
          errorCode: "workflow_approval_rejected",
          finishedAt: now,
          now,
        });
      }
      const failedRun = transitionWorkflowRunSync({
        workspaceId: input.workspaceId,
        runId: run.id,
        from: ["created", "queued", "running", "waiting_approval", "paused"],
        to: "failed",
        finishedAt: now,
        now,
      });
      if (!failedRun) throw new Error("workflow_run_control_conflict");
      appendWorkflowRunEventSync({
        workspaceId: input.workspaceId,
        runId: run.id,
        type: "run.failed",
        actorType: "coordinator",
        severity: "error",
        dataJson: JSON.stringify({ code: "workflow_approval_rejected" }),
        now,
      });
      return failedRun;
    }
    const hasOtherWaitingApproval = listWorkflowNodeRunsSync(input.workspaceId, run.id)
      .some((node) => node.id !== updated.id && node.status === "waiting_approval");
    if (!hasOtherWaitingApproval) {
      transitionWorkflowRunSync({ workspaceId: input.workspaceId, runId: run.id, from: ["waiting_approval"], to: "running", now });
    }
    advanceDownstream({ workspaceId: input.workspaceId, run, completed: updated, now });
    return finalizeRunIfTerminal(input.workspaceId, run, now);
  });
}

function advanceDownstream(input: { workspaceId: string; run: WorkflowRunRecord; completed: WorkflowNodeRunRecord; now: string }): void {
  const version = readWorkflowVersionSync(input.run.versionId, input.workspaceId);
  if (!version) throw new Error("workflow_version_not_found");
  const graph = JSON.parse(version.graphJson) as WorkflowGraphDefinition;
  const allRuns = listWorkflowNodeRunsSync(input.workspaceId, input.run.id);
  const byId = new Map(allRuns.map((node) => [node.nodeId, node]));
  const sources = [input.completed.nodeId];
  while (sources.length > 0) {
    const sourceId = sources.shift();
    if (!sourceId) continue;
    for (const edge of graph.edges.filter((candidate) => candidate.source === sourceId)) {
      const target = byId.get(edge.target);
      if (!target || target.status !== "pending") continue;
      const predecessors = graph.edges
        .filter((candidate) => candidate.target === target.nodeId)
        .map((candidate) => byId.get(candidate.source))
        .filter((node): node is WorkflowNodeRunRecord => Boolean(node));
      const targetConfig = parseConfig(target.inputJson);
      const policy = targetConfig.policy === "allow_partial" ? "allow_partial" : "all_success";
      const decision = decideWorkflowDownstreamTransition({
        nodeType: target.nodeType,
        policy,
        predecessorStatuses: predecessors.map((node) => node.status),
      });
      if (decision === "wait") continue;

      if (decision === "ready") {
        let runtimeContext;
        try {
          runtimeContext = buildWorkflowNodeRuntimeContext({
            graph,
            nodeId: target.nodeId,
            runInput: parseRecord(input.run.inputJson),
            nodeRuns: [...byId.values()],
          });
        } catch (error) {
          const errorCode = getWorkflowInputResolutionErrorCode(error);
          if (!errorCode) throw error;
          const failed = transitionWorkflowNodeRunSync({
            workspaceId: input.workspaceId,
            nodeRunId: target.id,
            from: ["pending"],
            to: "failed",
            errorCode,
            finishedAt: input.now,
            now: input.now,
          });
          if (failed) {
            byId.set(failed.nodeId, failed);
            appendWorkflowRunEventSync({
              workspaceId: input.workspaceId,
              runId: input.run.id,
              nodeRunId: failed.id,
              type: "node.failed",
              actorType: "coordinator",
              severity: "error",
              dataJson: JSON.stringify({ code: errorCode }),
              now: input.now,
            });
            sources.push(failed.nodeId);
          }
          continue;
        }
        const ready = transitionWorkflowNodeRunSync({
          workspaceId: input.workspaceId,
          nodeRunId: target.id,
          from: ["pending"],
          to: "ready",
          availableAt: input.now,
          inputJson: JSON.stringify({ ...targetConfig, input: runtimeContext.resolvedInput }),
          now: input.now,
        });
        if (ready) {
          byId.set(ready.nodeId, ready);
          enqueueWorkflowOutboxSync({ workspaceId: input.workspaceId, aggregateType: "workflow_node_run", aggregateId: target.id, eventType: "workflow.node.ready", payloadJson: JSON.stringify({ nodeRunId: target.id }), now: input.now });
        }
        continue;
      }

      if (decision === "succeed_join") {
        const succeeded = predecessors.filter((node) => node.status === "succeeded");
        const outputs = Object.fromEntries(succeeded.map((node) => [node.nodeId, parseJson(node.outputJson)]));
        const artifacts = mergeWorkflowArtifactManifests(succeeded.map((node) => node.artifactManifestJson));
        const joined = transitionWorkflowNodeRunSync({ workspaceId: input.workspaceId, nodeRunId: target.id, from: ["pending"], to: "succeeded", outputJson: JSON.stringify({ outputs }), artifactManifestJson: JSON.stringify(artifacts), finishedAt: input.now, now: input.now });
        if (joined) {
          byId.set(joined.nodeId, joined);
          appendWorkflowRunEventSync({ workspaceId: input.workspaceId, runId: input.run.id, nodeRunId: target.id, type: "join.succeeded", actorType: "coordinator", dataJson: JSON.stringify({ policy }), now: input.now });
          sources.push(joined.nodeId);
        }
        continue;
      }

      const failed = transitionWorkflowNodeRunSync({
        workspaceId: input.workspaceId,
        nodeRunId: target.id,
        from: ["pending"],
        to: target.nodeType === "join" ? "failed" : "skipped",
        errorCode: target.nodeType === "join" ? "workflow_join_upstream_failed" : "workflow_upstream_failed",
        finishedAt: input.now,
        now: input.now,
      });
      if (!failed) continue;
      byId.set(failed.nodeId, failed);
      appendWorkflowRunEventSync({
        workspaceId: input.workspaceId,
        runId: input.run.id,
        nodeRunId: target.id,
        type: target.nodeType === "join" ? "join.failed" : "node.skipped",
        actorType: "coordinator",
        severity: target.nodeType === "join" ? "error" : undefined,
        dataJson: JSON.stringify(target.nodeType === "join" ? { policy } : { reasonCode: "workflow_upstream_failed" }),
        now: input.now,
      });
      sources.push(failed.nodeId);
    }
  }
}

export function decideWorkflowDownstreamTransition(input: {
  nodeType: WorkflowNodeRunRecord["nodeType"];
  policy: "all_success" | "allow_partial";
  predecessorStatuses: WorkflowNodeRunRecord["status"][];
}): "wait" | "ready" | "succeed_join" | "fail" {
  const terminalStatuses = new Set(["succeeded", "failed", "skipped", "cancelled"]);
  if (!input.predecessorStatuses.every((status) => terminalStatuses.has(status))) return "wait";
  const succeeded = input.predecessorStatuses.filter((status) => status === "succeeded").length;
  if (input.nodeType !== "join") return succeeded === input.predecessorStatuses.length ? "ready" : "fail";
  if (input.policy === "all_success") return succeeded === input.predecessorStatuses.length ? "succeed_join" : "fail";
  return succeeded > 0 ? "succeed_join" : "fail";
}

export function collectWorkflowDescendantNodeIds(
  graph: WorkflowGraphDefinition,
  nodeId: string,
): string[] {
  const descendants: string[] = [];
  const visited = new Set<string>([nodeId]);
  const pending = graph.edges.filter((edge) => edge.source === nodeId).map((edge) => edge.target);
  while (pending.length > 0) {
    const current = pending.shift();
    if (!current || visited.has(current)) continue;
    visited.add(current);
    descendants.push(current);
    pending.push(...graph.edges.filter((edge) => edge.source === current).map((edge) => edge.target));
  }
  return descendants;
}

function finalizeRunIfTerminal(workspaceId: string, run: WorkflowRunRecord, now: string): WorkflowRunRecord {
  const nodes = listWorkflowNodeRunsSync(workspaceId, run.id);
  if (nodes.some((node) => ["pending", "ready", "queued", "running", "waiting_approval", "retry_wait"].includes(node.status))) {
    transitionWorkflowRunSync({ workspaceId, runId: run.id, from: ["created", "queued"], to: "running", now });
    return readWorkflowRunSync(run.id, workspaceId)!;
  }
  const version = readWorkflowVersionSync(run.versionId, workspaceId);
  if (!version) throw new Error("workflow_version_not_found");
  const terminalStatus = resolveWorkflowRunTerminalStatus(
    nodes,
    JSON.parse(version.graphJson) as WorkflowGraphDefinition,
  );
  transitionWorkflowRunSync({ workspaceId, runId: run.id, from: ["created", "queued", "running", "waiting_approval"], to: terminalStatus, finishedAt: now, now });
  return readWorkflowRunSync(run.id, workspaceId)!;
}

export function resolveWorkflowRunTerminalStatus(
  nodes: Array<Pick<WorkflowNodeRunRecord, "nodeId" | "nodeType" | "status" | "inputJson">>,
  graph: WorkflowGraphDefinition,
): "succeeded" | "partially_succeeded" | "failed" {
  const failures = nodes.filter((node) => node.status === "failed" || node.status === "cancelled");
  if (failures.length === 0) return "succeeded";
  const byNodeId = new Map(nodes.map((node) => [node.nodeId, node]));
  const acceptingPartialJoinIds = new Set(
    graph.nodes
      .filter((definition) => definition.type === "join" && definition.config.policy === "allow_partial")
      .filter((definition) => byNodeId.get(definition.id)?.status === "succeeded")
      .filter((definition) => {
        const predecessorStatuses = graph.edges
          .filter((edge) => edge.target === definition.id)
          .map((edge) => byNodeId.get(edge.source)?.status);
        return predecessorStatuses.some((status) => status !== "succeeded");
      })
      .map((definition) => definition.id),
  );
  if (acceptingPartialJoinIds.size === 0) return "failed";
  const everyFailureWasAccepted = failures.every((failure) => (
    collectWorkflowDescendantNodeIds(graph, failure.nodeId)
      .some((nodeId) => acceptingPartialJoinIds.has(nodeId))
  ));
  return everyFailureWasAccepted ? "partially_succeeded" : "failed";
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

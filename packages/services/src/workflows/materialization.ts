import {
  advanceWorkflowTriggerSync,
  appendWorkflowRunEventSync,
  createWorkflowRunSync,
  enqueueWorkflowOutboxSync,
  getDatabase,
  listStoredEmployeesSync,
  listWorkflowNodeRunsSync,
  lockWorkflowDefinitionForUpdateSync,
  lockWorkflowRunForUpdateSync,
  lockWorkflowTriggerForUpdateSync,
  materializeWorkflowNodeRunsSync,
  readWorkflowVersionSync,
  readWorkflowTriggerForWorkflowSync,
  recordAuditLogSync,
  transitionWorkflowNodeRunSync,
  transitionWorkflowRunSync,
  withTransaction,
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
  triggerAdvance?: {
    workerId: string;
    nextFireAt: string | null;
    status?: string;
    misfired?: boolean;
    outcome?: {
      code: "workflow.trigger.misfire_fire_once";
      reasonCode: string;
    };
  };
}

export interface MaterializeManualWorkflowRunInput {
  workspaceId: string;
  workflowId: string;
  idempotencyKey: string;
  createdBy: string;
  inputJson?: string;
  now?: string;
}

export function materializeManualWorkflowRunSync(input: MaterializeManualWorkflowRunInput): {
  runId: string;
  created: boolean;
} {
  return withTransaction(getDatabase(), () => {
    const now = input.now ?? new Date().toISOString();
    const definition = lockWorkflowDefinitionForUpdateSync(input.workflowId, input.workspaceId);
    if (!definition) throw new Error("workflow_definition_not_found");
    const trigger = readWorkflowTriggerForWorkflowSync(input.workflowId, input.workspaceId);
    assertManualWorkflowTriggerAvailable(definition.status, trigger);
    return materializeWorkflowRunSync({
      workspaceId: input.workspaceId,
      trigger,
      scheduledAt: input.idempotencyKey,
      createdBy: input.createdBy,
      inputJson: input.inputJson,
      now,
    });
  });
}

export function assertManualWorkflowTriggerAvailable(
  definitionStatus: string,
  trigger: Pick<WorkflowTriggerRecord, "type" | "status"> | null,
): asserts trigger is Pick<WorkflowTriggerRecord, "type" | "status"> & { type: "manual" } {
  if (definitionStatus !== "published") throw new Error("workflow_definition_not_published");
  if (!trigger || trigger.type !== "manual" || trigger.status !== "active") {
    throw new Error("workflow_manual_trigger_required");
  }
}

export function materializeWorkflowRunSync(input: MaterializeWorkflowRunInput): {
  runId: string;
  created: boolean;
} {
  return withTransaction(getDatabase(), () => {
    const definition = lockWorkflowDefinitionForUpdateSync(input.trigger.workflowId, input.workspaceId);
    if (!definition) throw new Error("workflow_definition_not_found");
    if (definition.status !== "published") throw new Error("workflow_definition_not_published");
    const currentTrigger = lockWorkflowTriggerForUpdateSync(input.trigger.id, input.workspaceId);
    assertWorkflowTriggerCanMaterialize(input.trigger, currentTrigger);
    const versionId = definition.activeVersionId;
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
      budgetJson: version.governanceJson,
      createdBy: input.createdBy,
      now: input.now,
    });
    const created = seedWorkflowRunNodesSync({
      workspaceId: input.workspaceId,
      runId: run.id,
      graph,
      now: input.now,
    });

    if (run.status === "created") {
      const nodeRuns = listWorkflowNodeRunsSync(input.workspaceId, run.id);
      const incoming = new Set(graph.edges.map((edge) => edge.target));
      for (const node of graph.nodes) {
        if (!incoming.has(node.id)) {
          const nodeRun = nodeRuns.find((item) => item.nodeId === node.id);
          if (nodeRun) transitionWorkflowNodeRunSync({ workspaceId: input.workspaceId, nodeRunId: nodeRun.id, from: ["pending"], to: "ready", availableAt: input.now, now: input.now });
        }
      }
      const queued = transitionWorkflowRunSync({ workspaceId: input.workspaceId, runId: run.id, from: ["created"], to: "queued", now: input.now });
      if (!queued) throw new Error("workflow_run_materialization_conflict");
      appendWorkflowRunEventSync({ workspaceId: input.workspaceId, runId: run.id, type: "run.created", actorType: "scheduler", dataJson: JSON.stringify({ triggerId: input.trigger.id }), now: input.now });
      appendWorkflowRunEventSync({
        workspaceId: input.workspaceId,
        runId: run.id,
        type: "trigger.fired",
        actorType: input.trigger.type === "schedule" ? "scheduler" : "system",
        actorId: input.createdBy,
        dataJson: JSON.stringify({
          triggerId: input.trigger.id,
          scheduledAt: input.scheduledAt,
          nextFireAt: input.triggerAdvance?.nextFireAt ?? null,
          misfirePolicy: input.trigger.misfirePolicy,
          misfired: input.triggerAdvance?.misfired === true,
        }),
        now: input.now,
      });
      enqueueWorkflowOutboxSync({ workspaceId: input.workspaceId, aggregateType: "workflow_run", aggregateId: run.id, eventType: "workflow.run.ready", payloadJson: JSON.stringify({ runId: run.id }), now: input.now });
    }
    if (input.triggerAdvance) {
      const advanced = advanceWorkflowTriggerSync({
        id: input.trigger.id,
        workspaceId: input.workspaceId,
        workerId: input.triggerAdvance.workerId,
        nextFireAt: input.triggerAdvance.nextFireAt,
        lastFireAt: input.scheduledAt,
        status: input.triggerAdvance.status,
        now: input.now,
      });
      if (!advanced) throw new Error("workflow_trigger_lease_conflict");
      if (input.triggerAdvance.outcome) {
        recordAuditLogSync({
          workspaceId: input.workspaceId,
          title: "Workflow trigger outcome",
          note: input.triggerAdvance.outcome.reasonCode,
          code: input.triggerAdvance.outcome.code,
          data: {
            workflowId: input.trigger.workflowId,
            triggerId: input.trigger.id,
            scheduledAt: input.scheduledAt,
            policy: input.trigger.misfirePolicy,
            reasonCode: input.triggerAdvance.outcome.reasonCode,
            occurredAt: input.now,
          },
        });
      }
    }
    return { runId: run.id, created };
  });
}

export function assertWorkflowTriggerCanMaterialize(
  claimed: WorkflowTriggerRecord,
  current: WorkflowTriggerRecord | null,
): void {
  if (!current || current.workflowId !== claimed.workflowId || current.status !== "active") {
    throw new Error("workflow_trigger_not_active");
  }
  if (current.type !== claimed.type) throw new Error("workflow_trigger_stale_snapshot");
  if (claimed.type === "schedule" && (
    !claimed.leaseOwner
    || current.leaseOwner !== claimed.leaseOwner
    || current.leaseExpiresAt !== claimed.leaseExpiresAt
  )) {
    throw new Error("workflow_trigger_lease_conflict");
  }
  if (claimed.type !== "schedule" && (
    current.updatedAt !== claimed.updatedAt
    || current.configJson !== claimed.configJson
  )) {
    throw new Error("workflow_trigger_stale_snapshot");
  }
}

const RERUN_TERMINAL_RUN_STATUSES = new Set(["succeeded", "partially_succeeded", "failed", "cancelled"]);

export interface RerunWorkflowRunInput {
  workspaceId: string;
  runId: string;
  idempotencyKey: string;
  createdBy: string;
  now?: string;
}

/**
 * 重跑一条已终结的运行：固定复用原运行落库时的版本（versionId）与输入快照
 * （inputJson），不受工作流后续重发布或触发器类型变更影响；不经过触发器租约
 * 与 manual-trigger 校验，因此定时/事件触发的运行也可由用户手动重跑。
 */
export function rerunWorkflowRunSync(input: RerunWorkflowRunInput): { runId: string; created: boolean } {
  return withTransaction(getDatabase(), () => {
    const now = input.now ?? new Date().toISOString();
    const original = lockWorkflowRunForUpdateSync(input.runId, input.workspaceId);
    if (!original) throw new Error("workflow_run_not_found");
    if (!RERUN_TERMINAL_RUN_STATUSES.has(original.status)) throw new Error("workflow_run_not_terminal");
    const definition = lockWorkflowDefinitionForUpdateSync(original.workflowId, input.workspaceId);
    if (!definition) throw new Error("workflow_definition_not_found");
    const version = readWorkflowVersionSync(original.versionId, input.workspaceId);
    if (!version) throw new Error("workflow_version_not_found");
    const graph = JSON.parse(version.graphJson) as WorkflowGraphDefinition;
    const run = createWorkflowRunSync({
      workspaceId: input.workspaceId,
      workflowId: original.workflowId,
      versionId: version.id,
      triggerType: "manual",
      triggerKey: `rerun:${original.id}:${input.idempotencyKey}`,
      inputJson: original.inputJson ?? "{}",
      budgetJson: version.governanceJson,
      createdBy: input.createdBy,
      now,
    });
    const created = seedWorkflowRunNodesSync({
      workspaceId: input.workspaceId,
      runId: run.id,
      graph,
      now,
    });
    if (run.status === "created") {
      const nodeRuns = listWorkflowNodeRunsSync(input.workspaceId, run.id);
      const incoming = new Set(graph.edges.map((edge) => edge.target));
      for (const node of graph.nodes) {
        if (!incoming.has(node.id)) {
          const nodeRun = nodeRuns.find((item) => item.nodeId === node.id);
          if (nodeRun) transitionWorkflowNodeRunSync({ workspaceId: input.workspaceId, nodeRunId: nodeRun.id, from: ["pending"], to: "ready", availableAt: now, now });
        }
      }
      const queued = transitionWorkflowRunSync({ workspaceId: input.workspaceId, runId: run.id, from: ["created"], to: "queued", now });
      if (!queued) throw new Error("workflow_run_materialization_conflict");
      appendWorkflowRunEventSync({ workspaceId: input.workspaceId, runId: run.id, type: "run.created", actorType: "scheduler", dataJson: JSON.stringify({ rerunFrom: original.id }), now });
      appendWorkflowRunEventSync({
        workspaceId: input.workspaceId,
        runId: run.id,
        type: "trigger.fired",
        actorType: "system",
        actorId: input.createdBy,
        dataJson: JSON.stringify({ rerunFrom: original.id, scheduledAt: now }),
        now,
      });
      enqueueWorkflowOutboxSync({ workspaceId: input.workspaceId, aggregateType: "workflow_run", aggregateId: run.id, eventType: "workflow.run.ready", payloadJson: JSON.stringify({ runId: run.id, rerunFrom: original.id }), now });
    }
    return { runId: run.id, created };
  });
}

/** 按 graph 物化运行节点（幂等：已存在节点则跳过），返回是否实际新建。 */
function seedWorkflowRunNodesSync(args: {
  workspaceId: string;
  runId: string;
  graph: WorkflowGraphDefinition;
  now: string;
}): boolean {
  const existingNodes = listWorkflowNodeRunsSync(args.workspaceId, args.runId);
  if (existingNodes.length > 0) return false;
  const employees = buildWorkflowEmployeeNameSnapshots(listStoredEmployeesSync(args.workspaceId));
  materializeWorkflowNodeRunsSync({
    workspaceId: args.workspaceId,
    runId: args.runId,
    now: args.now,
    nodes: args.graph.nodes.map((node) => ({
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
  return true;
}

export function buildWorkflowEmployeeNameSnapshots(
  employees: Array<{ id: string; name: string; remarkName?: string }>,
): Map<string, string> {
  return new Map(employees.map((employee) => [
    employee.id,
    employee.remarkName?.trim() || employee.name,
  ]));
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

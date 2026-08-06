import {
  getDatabase,
  listEmployeeRuntimeBindingsSync,
  listStoredEmployeesSync,
  listWorkflowDefinitionsSync,
  listWorkflowRunsSync,
  listWorkspaceMemberUsersSync,
  readWorkflowDefinitionSync,
  readWorkflowTriggerForWorkflowSync,
  readWorkflowVersionSync,
} from "@dofe-agent/db";
import type { WorkflowGraphDefinition, WorkflowRunStatus } from "@dofe-agent/domain";
import type {
  WorkflowBuilderPageData,
  WorkflowCenterPageData,
  WorkflowListItem,
} from "./workflow-types";

const WORKFLOW_RUN_STATUSES = new Set<WorkflowRunStatus>([
  "created",
  "queued",
  "running",
  "waiting_approval",
  "paused",
  "succeeded",
  "partially_succeeded",
  "failed",
  "cancelled",
]);

interface WorkflowTriggerSummary {
  workflowId: string;
  type: "manual" | "schedule" | "event";
  nextFireAt?: string;
}

interface WorkflowTopologySummary {
  employeeNodeCount: number;
  parallelGroupCount: number;
  hasApproval: boolean;
}

export function getWorkflowCenterPageData(workspaceId: string): WorkflowCenterPageData {
  const definitions = listWorkflowDefinitionsSync(workspaceId);
  const definitionIds = new Set(definitions.map((definition) => definition.id));
  const ownerLabels = new Map(
    listWorkspaceMemberUsersSync(workspaceId).map((member) => [member.userId, member.displayName]),
  );
  const latestRuns = new Map<string, { id: string; status: WorkflowRunStatus; finishedAt?: string }>();
  for (const run of listWorkflowRunsSync(workspaceId, 500)) {
    if (!definitionIds.has(run.workflowId) || latestRuns.has(run.workflowId) || !isWorkflowRunStatus(run.status)) {
      continue;
    }
    latestRuns.set(run.workflowId, {
      id: run.id,
      status: run.status,
      ...(run.finishedAt ? { finishedAt: run.finishedAt } : {}),
    });
  }

  const triggersByWorkflowId = new Map<string, WorkflowTriggerSummary>();
  for (const trigger of listWorkflowTriggerSummaries(workspaceId)) {
    if (definitionIds.has(trigger.workflowId) && !triggersByWorkflowId.has(trigger.workflowId)) {
      triggersByWorkflowId.set(trigger.workflowId, trigger);
    }
  }

  const workflows = definitions.map((definition): WorkflowListItem => {
    const trigger = triggersByWorkflowId.get(definition.id);
    return {
      id: definition.id,
      name: definition.name,
      status: definition.status,
      ownerLabel: ownerLabels.get(definition.ownerUserId) ?? definition.ownerUserId,
      triggerLabelCode: trigger?.type ?? "manual",
      ...(trigger?.nextFireAt ? { nextFireAt: trigger.nextFireAt } : {}),
      ...(latestRuns.has(definition.id) ? { latestRun: latestRuns.get(definition.id)! } : {}),
      topology: summarizeWorkflowTopology(definition.draftGraphJson),
    };
  });

  return {
    workflows,
    totals: {
      all: workflows.length,
      published: workflows.filter((workflow) => workflow.status === "published").length,
      paused: workflows.filter((workflow) => workflow.status === "paused").length,
      blocked: workflows.filter((workflow) => workflow.latestRun?.status === "waiting_approval").length,
    },
  };
}

export function getWorkflowBuilderPageData(
  workspaceId: string,
  workflowId?: string,
): WorkflowBuilderPageData | null {
  const bindings = new Map(
    listEmployeeRuntimeBindingsSync(workspaceId).map((binding) => [binding.employeeId, binding.status]),
  );
  const employees = listStoredEmployeesSync(workspaceId).map((employee) => ({
    id: employee.id,
    name: employee.remarkName?.trim() || employee.name,
    status: bindings.get(employee.id) ?? "unbound",
  }));
  if (!workflowId) return { employees };

  const workflow = readWorkflowDefinitionSync(workflowId, workspaceId);
  if (!workflow) return null;
  const trigger = readWorkflowTriggerForWorkflowSync(workflow.id, workspaceId);
  const activeVersion = workflow.activeVersionId
    ? readWorkflowVersionSync(workflow.activeVersionId, workspaceId)
    : null;
  const triggerConfig = parseRecord(trigger?.configJson);
  const governance = parseRecord(activeVersion?.governanceJson);
  return {
    employees,
    workflow: {
      id: workflow.id,
      name: workflow.name,
      description: workflow.description ?? "",
      status: workflow.status,
      graph: parseWorkflowGraph(workflow.draftGraphJson),
      draftVersion: workflow.draftVersion,
      trigger: {
        type: trigger?.type ?? "manual",
        config: triggerConfig,
        ...(trigger?.timezone ? { timezone: trigger.timezone } : {}),
      },
      governance: {
        maxConcurrency: numberInRange(governance.maxConcurrency, 1, 20, 4),
        failurePolicy: governance.failurePolicy === "continue" ? "continue" : "stop",
      },
    },
  };
}

function listWorkflowTriggerSummaries(workspaceId: string): WorkflowTriggerSummary[] {
  const rows = getDatabase().prepare(
    `SELECT workflow_id AS "workflowId", type, next_fire_at AS "nextFireAt"
     FROM workflow_trigger
     WHERE workspace_id = ? AND status = 'active'
     ORDER BY CASE WHEN next_fire_at IS NULL THEN 1 ELSE 0 END, next_fire_at ASC, id ASC`,
  ).all(workspaceId) as Array<Record<string, unknown>>;

  return rows.flatMap((row) => {
    if (typeof row.workflowId !== "string" || !isWorkflowTriggerType(row.type)) {
      return [];
    }
    return [{
      workflowId: row.workflowId,
      type: row.type,
      ...(typeof row.nextFireAt === "string" ? { nextFireAt: row.nextFireAt } : {}),
    }];
  });
}

function summarizeWorkflowTopology(graphJson: string): WorkflowTopologySummary {
  try {
    const graph = JSON.parse(graphJson) as { nodes?: unknown };
    if (!Array.isArray(graph.nodes)) {
      return { employeeNodeCount: 0, parallelGroupCount: 0, hasApproval: false };
    }
    const nodeTypes = graph.nodes.flatMap((node) => {
      if (!node || typeof node !== "object" || !("type" in node) || typeof node.type !== "string") {
        return [];
      }
      return [node.type];
    });
    return {
      employeeNodeCount: nodeTypes.filter((type) => type === "employee_task").length,
      parallelGroupCount: nodeTypes.filter((type) => type === "join").length,
      hasApproval: nodeTypes.includes("approval"),
    };
  } catch {
    return { employeeNodeCount: 0, parallelGroupCount: 0, hasApproval: false };
  }
}

function isWorkflowRunStatus(value: string): value is WorkflowRunStatus {
  return WORKFLOW_RUN_STATUSES.has(value as WorkflowRunStatus);
}

function isWorkflowTriggerType(value: unknown): value is WorkflowTriggerSummary["type"] {
  return value === "manual" || value === "schedule" || value === "event";
}

function parseWorkflowGraph(value: string): WorkflowGraphDefinition {
  try {
    const graph = JSON.parse(value) as WorkflowGraphDefinition;
    if (graph?.schemaVersion === 1 && Array.isArray(graph.nodes) && Array.isArray(graph.edges)) return graph;
  } catch {
    // Corrupt drafts remain editable as an empty graph; publish preflight is authoritative.
  }
  return { schemaVersion: 1, nodes: [], edges: [] };
}

function parseRecord(value: string | undefined): Record<string, unknown> {
  if (!value) return {};
  try {
    const parsed = JSON.parse(value) as unknown;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : {};
  } catch {
    return {};
  }
}

function numberInRange(value: unknown, min: number, max: number, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value)
    ? Math.max(min, Math.min(max, value))
    : fallback;
}

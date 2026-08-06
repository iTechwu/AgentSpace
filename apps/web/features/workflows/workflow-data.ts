import {
  getDatabase,
  listEmployeeRuntimeBindingsSync,
  listStoredEmployeesSync,
  listWorkflowDefinitionsSync,
  listWorkflowNodeRunsSync,
  listWorkflowRunEventsSync,
  listWorkflowRunsSync,
  listWorkspaceMemberUsersSync,
  readWorkflowDefinitionSync,
  readWorkflowRunSync,
  readWorkflowTriggerForWorkflowSync,
  readWorkflowVersionSync,
} from "@dofe-agent/db";
import {
  readWorkflowCutoverModeSync,
  readWorkspaceStateSnapshotSync,
  shouldReadLegacyWorkflowSources,
} from "@dofe-agent/services";
import type { WorkflowGraphDefinition, WorkflowRunStatus } from "@dofe-agent/domain";
import type {
  WorkflowBuilderPageData,
  WorkflowCenterPageData,
  WorkflowListItem,
  WorkflowRunEventItem,
  WorkflowRunPageData,
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
      sourceKind: "workflow",
      ...(definition.legacySourceId ? { legacySourceId: definition.legacySourceId, migrationStatus: "migrated" as const } : {}),
    };
  });
  const mode = readWorkflowCutoverModeSync(workspaceId);
  if (shouldReadLegacyWorkflowSources(mode)) {
    const migratedLegacyIds = new Set(
      definitions
        .filter((definition) => definition.legacySourceType === "automation_rule")
        .flatMap((definition) => definition.legacySourceId ? [definition.legacySourceId] : []),
    );
    for (const rule of readWorkspaceStateSnapshotSync(workspaceId).automationRules ?? []) {
      if (migratedLegacyIds.has(rule.id)) continue;
      workflows.push({
        id: `legacy-automation-${rule.id}`,
        name: rule.name,
        status: rule.enabled ? "published" : "paused",
        ownerLabel: rule.createdBy || "legacy",
        triggerLabelCode: rule.trigger.type === "schedule" ? "schedule" : "event",
        topology: {
          employeeNodeCount: rule.actions.filter((action) => action.type === "mention_agent").length,
          parallelGroupCount: 0,
          hasApproval: false,
        },
        sourceKind: "legacy",
        migrationStatus: "needs_migration",
        legacySourceId: rule.id,
      });
    }
  }

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
        ...(positiveNumber(governance.budgetUsd) ? { budgetUsd: positiveNumber(governance.budgetUsd) } : {}),
      },
    },
  };
}

export function getWorkflowRunPageData(
  workspaceId: string,
  runId: string,
): WorkflowRunPageData | null {
  const run = readWorkflowRunSync(runId, workspaceId);
  if (!run) return null;
  const definition = readWorkflowDefinitionSync(run.workflowId, workspaceId);
  const eventRecords = listWorkflowRunEventsSync(workspaceId, runId, { limit: 200 });
  const costByNodeRunId = new Map<string, number>();
  for (const event of eventRecords) {
    const data = parseRecord(event.dataJson);
    if (event.nodeRunId && typeof data.costUsd === "number" && Number.isFinite(data.costUsd)) {
      costByNodeRunId.set(event.nodeRunId, (costByNodeRunId.get(event.nodeRunId) ?? 0) + data.costUsd);
    }
  }
  return {
    id: run.id,
    workflowId: run.workflowId,
    workflowName: definition?.name ?? run.workflowId,
    status: run.status,
    triggerType: run.triggerType,
    currentSequence: run.currentSequence,
    ...(run.startedAt ? { startedAt: run.startedAt } : {}),
    ...(run.finishedAt ? { finishedAt: run.finishedAt } : {}),
    createdAt: run.createdAt,
    nodes: listWorkflowNodeRunsSync(workspaceId, runId).map((node) => ({
      id: node.id,
      nodeId: node.nodeId,
      nodeType: node.nodeType,
      employeeName: node.employeeNameSnapshot ?? node.employeeId ?? node.nodeId,
      status: node.status,
      attemptCount: node.attemptCount,
      maxAttempts: node.maxAttempts,
      artifactCount: artifactCount(node.artifactManifestJson),
      ...(costByNodeRunId.has(node.id) ? { costUsd: costByNodeRunId.get(node.id)! } : {}),
      ...(node.errorCode ? { errorCode: node.errorCode } : {}),
      ...(node.startedAt ? { startedAt: node.startedAt } : {}),
      ...(node.finishedAt ? { finishedAt: node.finishedAt } : {}),
    })),
    events: eventRecords.map(toWorkflowRunEventItem),
  };
}

export function getWorkflowRunEventsPage(
  workspaceId: string,
  runId: string,
  after: number,
): { events: WorkflowRunEventItem[]; hasMore: boolean } | null {
  if (!readWorkflowRunSync(runId, workspaceId)) return null;
  const rows = listWorkflowRunEventsSync(workspaceId, runId, { after, limit: 201 });
  return {
    events: rows.slice(0, 200).map(toWorkflowRunEventItem),
    hasMore: rows.length > 200,
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

function positiveNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : undefined;
}

function artifactCount(value: string | undefined): number {
  if (!value) return 0;
  try {
    const parsed = JSON.parse(value) as unknown;
    return Array.isArray(parsed) ? parsed.length : 0;
  } catch {
    return 0;
  }
}

function toWorkflowRunEventItem(event: {
  id: string;
  sequence: number;
  type: string;
  nodeRunId?: string;
  severity: string;
  createdAt: string;
}): WorkflowRunEventItem {
  return {
    id: event.id,
    sequence: event.sequence,
    type: event.type,
    ...(event.nodeRunId ? { nodeRunId: event.nodeRunId } : {}),
    severity: event.severity,
    createdAt: event.createdAt,
  };
}

import {
  countWorkflowRunsSync,
  getDatabase,
  listEmployeeRuntimeBindingsSync,
  listStoredChannelsSync,
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
import type { WorkflowRunRecord } from "@dofe-agent/db";
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
  WorkflowRunSummary,
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

const TERMINAL_RUN_STATUSES = new Set<string>([
  "succeeded",
  "partially_succeeded",
  "failed",
  "cancelled",
]);

export interface RunnableWorkflowSummary {
  id: string;
  name: string;
}

/**
 * 已发布且具备激活 manual 触发器的工作流——可在「立即运行」入口直接触发
 * （与 materializeManualWorkflowRunSync 的 assertManualWorkflowTriggerAvailable 约束一致）。
 *
 * 以一条 join 查询批量取出，避免对每个工作流单独读取触发器造成的 N+1。
 */
export function listRunnableWorkflowsSync(workspaceId: string): RunnableWorkflowSummary[] {
  const rows = getDatabase().prepare(
    `SELECT d.id AS id, d.name AS name
       FROM workflow_definition d
       INNER JOIN workflow_trigger t
         ON t.workflow_id = d.id
        AND t.workspace_id = d.workspace_id
        AND t.type = 'manual'
        AND t.status = 'active'
      WHERE d.workspace_id = ? AND d.status = 'published'
      ORDER BY d.name ASC`,
  ).all(workspaceId) as Array<{ id: string; name: string }>;
  return rows.map((row) => ({ id: row.id, name: row.name }));
}

interface WorkflowTriggerSummary {
  workflowId: string;
  type: "manual" | "schedule" | "event";
  nextFireAt?: string;
  updatedAt: string;
}

interface WorkflowTopologySummary {
  employeeNodeCount: number;
  parallelGroupCount: number;
  hasApproval: boolean;
}

type WorkflowTriggerOutcome = NonNullable<WorkflowListItem["lastTriggerOutcome"]> & { workflowId: string };

export function getWorkflowCenterPageData(workspaceId: string): WorkflowCenterPageData {
  const definitions = listWorkflowDefinitionsSync(workspaceId);
  const definitionIds = new Set(definitions.map((definition) => definition.id));
  const ownerLabels = new Map(
    listWorkspaceMemberUsersSync(workspaceId).map((member) => [member.userId, member.displayName]),
  );
  const latestRuns = new Map<string, { id: string; status: WorkflowRunStatus; finishedAt?: string }>();
  const recentRuns: WorkflowRunSummary[] = [];
  const workflowNamesById = new Map(definitions.map((definition) => [definition.id, definition.name]));
  for (const run of listWorkflowRunsSync(workspaceId, 500)) {
    if (!isStatusfulWorkflowRun(run)) continue;
    // 运行历史（UIUX:140）：收集最近运行用于中心「运行」标签，名称以当前定义为准、
    // 缺失（已归档/删除）时回退 workflowId，避免历史记录随定义消失。
    recentRuns.push(toWorkflowRunSummary(run, workflowNamesById));
    if (!definitionIds.has(run.workflowId) || latestRuns.has(run.workflowId)) {
      continue;
    }
    latestRuns.set(run.workflowId, {
      id: run.id,
      status: run.status,
      ...(run.finishedAt ? { finishedAt: run.finishedAt } : {}),
    });
  }
  recentRuns.sort((left, right) => right.createdAt.localeCompare(left.createdAt));
  // 运行历史总数（UIUX:运行历史分页）：中心页 SSR 只下发首页（RECENT_RUNS_PAGE_SIZE），
  // 其余通过 GET /api/workspaces/:id/workflow-runs 分页加载。total 让前端判断是否展示「加载更多」。
  const recentRunsTotal = countWorkflowRunsSync(workspaceId);

  const triggersByWorkflowId = new Map<string, WorkflowTriggerSummary>();
  for (const trigger of listWorkflowTriggerSummaries(workspaceId)) {
    if (definitionIds.has(trigger.workflowId) && !triggersByWorkflowId.has(trigger.workflowId)) {
      triggersByWorkflowId.set(trigger.workflowId, trigger);
    }
  }
  const outcomesByWorkflowId = new Map<string, WorkflowTriggerOutcome>();
  for (const outcome of listLatestWorkflowTriggerOutcomes(workspaceId)) {
    if (definitionIds.has(outcome.workflowId) && !outcomesByWorkflowId.has(outcome.workflowId)) {
      outcomesByWorkflowId.set(outcome.workflowId, outcome);
    }
  }

  const workflows = definitions.map((definition): WorkflowListItem => {
    const trigger = triggersByWorkflowId.get(definition.id);
    const triggerOutcome = outcomesByWorkflowId.get(definition.id);
    const currentTriggerOutcome = trigger && triggerOutcome && triggerOutcome.createdAt >= trigger.updatedAt
      ? triggerOutcome
      : undefined;
    return {
      id: definition.id,
      name: definition.name,
      status: definition.status,
      ownerLabel: ownerLabels.get(definition.ownerUserId) ?? definition.ownerUserId,
      triggerLabelCode: trigger?.type ?? "none",
      ...(trigger?.nextFireAt ? { nextFireAt: trigger.nextFireAt } : {}),
      ...(currentTriggerOutcome ? {
        lastTriggerOutcome: {
          code: currentTriggerOutcome.code,
          createdAt: currentTriggerOutcome.createdAt,
        },
      } : {}),
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
    recentRuns: recentRuns.slice(0, RECENT_RUNS_PAGE_SIZE),
    recentRunsTotal,
  };
}

/**
 * 运行历史分页（UIUX:运行历史分页）：中心页 SSR 只下发首页，前端通过此分页函数
 * （经 GET /api/workspaces/:id/workflow-runs）按 limit/offset 加载更多。
 *
 * 排序与 listWorkflowRunsSync 一致（created_at DESC, id DESC），offset 以同一口径推进，
 * 保证分页连续无重叠无遗漏。total 为工作区运行总数，hasMore = 当前页累计未覆盖 total。
 */
export function getWorkflowRunsPageSync(
  workspaceId: string,
  input: { limit: number; offset: number },
): { runs: WorkflowRunSummary[]; total: number; hasMore: boolean } {
  const limit = Math.max(1, Math.min(Math.trunc(input.limit), 200));
  const offset = Math.max(0, Math.trunc(input.offset));
  const workflowNamesById = new Map(
    listWorkflowDefinitionsSync(workspaceId).map((definition) => [definition.id, definition.name]),
  );
  const runs = listWorkflowRunsSync(workspaceId, limit, offset)
    .filter(isStatusfulWorkflowRun)
    .map((run) => toWorkflowRunSummary(run, workflowNamesById));
  const total = countWorkflowRunsSync(workspaceId);
  return { runs, total, hasMore: offset + runs.length < total };
}

const RECENT_RUNS_PAGE_SIZE = 50;

/** 把运行记录映射为运行历史摘要，名称以当前定义为准、缺失时回退 workflowId。 */
function toWorkflowRunSummary(
  run: { id: string; workflowId: string; status: WorkflowRunStatus; triggerType: string; createdAt: string; startedAt?: string; finishedAt?: string },
  workflowNamesById: Map<string, string>,
): WorkflowRunSummary {
  return {
    id: run.id,
    workflowId: run.workflowId,
    workflowName: workflowNamesById.get(run.workflowId) ?? run.workflowId,
    status: run.status,
    triggerType: run.triggerType,
    createdAt: run.createdAt,
    ...(run.startedAt ? { startedAt: run.startedAt } : {}),
    ...(run.finishedAt ? { finishedAt: run.finishedAt } : {}),
  };
}

export function getWorkflowBuilderPageData(
  workspaceId: string,
  workflowId?: string,
  actor?: { userId: string; displayName: string },
): WorkflowBuilderPageData | null {
  const bindings = new Map(
    listEmployeeRuntimeBindingsSync(workspaceId).map((binding) => [binding.employeeId, binding.status]),
  );
  const employees = listStoredEmployeesSync(workspaceId).map((employee) => ({
    id: employee.id,
    name: employee.remarkName?.trim() || employee.name,
    status: bindings.get(employee.id) ?? "unbound",
  }));
  const channels = listStoredChannelsSync(workspaceId).map((channel) => channel.name);
  const members = listWorkspaceMemberUsersSync(workspaceId).map((member) => ({
    userId: member.userId,
    displayName: member.displayName,
  }));
  const ownerLabels = new Map(members.map((member) => [member.userId, member.displayName]));
  if (!workflowId) return { employees, channels, members, ownerLabel: actor?.displayName ?? "当前用户" };

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
    channels,
    members,
    ownerLabel: ownerLabels.get(workflow.ownerUserId)
      ?? (workflow.ownerUserId === actor?.userId ? actor.displayName : workflow.ownerUserId),
    workflow: {
      id: workflow.id,
      name: workflow.name,
      description: workflow.description ?? "",
      status: workflow.status,
      graph: parseWorkflowGraph(workflow.draftGraphJson),
      draftVersion: workflow.draftVersion,
      ...(activeVersion ? { publishedVersionNumber: activeVersion.versionNumber } : {}),
      trigger: {
        type: trigger?.type ?? "none",
        config: triggerConfig,
        ...(trigger?.timezone ? { timezone: trigger.timezone } : {}),
        misfirePolicy: trigger?.misfirePolicy ?? "skip",
      },
      governance: {
        maxConcurrency: numberInRange(governance.maxConcurrency, 1, 20, 4),
        ...(positiveNumber(governance.budgetUsd) ? { budgetUsd: positiveNumber(governance.budgetUsd) } : {}),
      },
      ...(workflow.channelName ? { channelName: workflow.channelName } : {}),
    },
  };
}

export function getWorkflowRunPageData(
  workspaceId: string,
  runId: string,
  actor?: { userId: string; role: string },
): WorkflowRunPageData | null {
  const run = readWorkflowRunSync(runId, workspaceId);
  if (!run) return null;
  const definition = readWorkflowDefinitionSync(run.workflowId, workspaceId);
  // 重跑放宽入口：不再要求 manual 触发器，只要原运行已终结、且其落库版本仍存在即可
  // 重跑（定时/事件触发的运行也可由用户手动重跑）。重跑固定复用原版本与输入快照，
  // 见 rerunWorkflowRunSync。
  const version = readWorkflowVersionSync(run.versionId, workspaceId);
  const canRerun = TERMINAL_RUN_STATUSES.has(run.status)
    && Boolean(version);
  const eventRecords = listWorkflowRunEventsSync(workspaceId, runId, { limit: 200 });
  const memberLabels = new Map(
    listWorkspaceMemberUsersSync(workspaceId).map((member) => [member.userId, member.displayName]),
  );
  const costByNodeRunId = new Map<string, number>();
  for (const event of eventRecords) {
    const data = parseRecord(event.dataJson);
    if (event.nodeRunId && typeof data.costUsd === "number" && Number.isFinite(data.costUsd)) {
      costByNodeRunId.set(event.nodeRunId, (costByNodeRunId.get(event.nodeRunId) ?? 0) + data.costUsd);
    }
  }
  const nodeRuns = listWorkflowNodeRunsSync(workspaceId, runId);
  const runNodeIds = new Set(nodeRuns.map((node) => node.nodeId));
  // 流程图视图需要图的拓扑（边）：从运行绑定的版本 graphJson 解析，并过滤掉两端
  // 不在本次运行节点集合中的边（版本可能含本次未实例化的节点，作防御性收敛）。
  const edges = extractRunEdges(version?.graphJson, runNodeIds);
  return {
    id: run.id,
    workflowId: run.workflowId,
    workflowName: definition?.name ?? run.workflowId,
    status: run.status,
    triggerType: run.triggerType,
    currentSequence: run.currentSequence,
    canControl: actor?.role === "owner" || actor?.role === "admin" || definition?.ownerUserId === actor?.userId,
    canRerun,
    ...(run.startedAt ? { startedAt: run.startedAt } : {}),
    ...(run.finishedAt ? { finishedAt: run.finishedAt } : {}),
    createdAt: run.createdAt,
    nodes: nodeRuns.map((node) => {
      // 审批节点的等待详情：approvalId 来自 node_run 列；风险/审批人来自建 Run 时
      // 快照进 input_json 的节点 config；来源固定为「工作流审批」。
      const approvalFields = node.nodeType === "approval" ? buildApprovalNodeFields(node, memberLabels) : {};
      return {
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
        ...approvalFields,
      };
    }),
    edges,
    events: eventRecords.map(toWorkflowRunEventItem),
  };
}

/** 从版本 graphJson 解析运行流程图所需的边，仅保留两端均在运行节点集合中的边。 */
function extractRunEdges(
  graphJson: string | undefined,
  runNodeIds: Set<string>,
): Array<{ source: string; target: string }> {
  if (!graphJson) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(graphJson);
  } catch {
    return [];
  }
  const edges = (parsed as { edges?: unknown })?.edges;
  if (!Array.isArray(edges)) return [];
  const result: Array<{ source: string; target: string }> = [];
  for (const edge of edges) {
    if (!edge || typeof edge !== "object") continue;
    const source = (edge as { source?: unknown }).source;
    const target = (edge as { target?: unknown }).target;
    if (typeof source !== "string" || typeof target !== "string") continue;
    if (!runNodeIds.has(source) || !runNodeIds.has(target)) continue;
    result.push({ source, target });
  }
  return result;
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
    `SELECT workflow_id AS "workflowId", type, next_fire_at AS "nextFireAt", updated_at AS "updatedAt"
     FROM workflow_trigger
     WHERE workspace_id = ? AND status IN ('active', 'suspended', 'paused')
     ORDER BY workflow_id ASC,
       CASE
         WHEN type <> 'manual' AND status = 'active' THEN 0
         WHEN type <> 'manual' AND status = 'suspended' THEN 1
         WHEN type <> 'manual' THEN 2
         WHEN status = 'active' THEN 3
         WHEN status = 'suspended' THEN 4
         ELSE 5
       END,
       updated_at DESC, id ASC`,
  ).all(workspaceId) as Array<Record<string, unknown>>;

  return rows.flatMap((row) => {
    if (typeof row.workflowId !== "string" || !isWorkflowTriggerType(row.type) || typeof row.updatedAt !== "string") {
      return [];
    }
    return [{
      workflowId: row.workflowId,
      type: row.type,
      updatedAt: row.updatedAt,
      ...(typeof row.nextFireAt === "string" ? { nextFireAt: row.nextFireAt } : {}),
    }];
  });
}

function listLatestWorkflowTriggerOutcomes(workspaceId: string): WorkflowTriggerOutcome[] {
  const rows = getDatabase().prepare(
    `SELECT "workflowId", code, "createdAt"
       FROM (
         SELECT data_json ->> 'workflowId' AS "workflowId",
                code,
                created_at AS "createdAt",
                ROW_NUMBER() OVER (
                  PARTITION BY data_json ->> 'workflowId'
                  ORDER BY created_at DESC, source_index DESC
                ) AS outcome_rank
           FROM audit_log
          WHERE workspace_id = ?
            AND code IN (
              'workflow.trigger.misfire_skipped',
              'workflow.trigger.misfire_fire_once',
              'workflow.trigger.invalid',
              'workflow.trigger.materialization_failed'
            )
       ) AS latest_workflow_outcomes
      WHERE outcome_rank = 1
      ORDER BY "createdAt" DESC
      LIMIT 1000`,
  ).all(workspaceId) as Array<Record<string, unknown>>;
  return rows.flatMap((row) => (
    typeof row.workflowId === "string"
    && typeof row.createdAt === "string"
    && isWorkflowTriggerOutcomeCode(row.code)
      ? [{ workflowId: row.workflowId, code: row.code, createdAt: row.createdAt }]
      : []
  ));
}

function isWorkflowTriggerOutcomeCode(value: unknown): value is WorkflowTriggerOutcome["code"] {
  return value === "workflow.trigger.misfire_skipped"
    || value === "workflow.trigger.misfire_fire_once"
    || value === "workflow.trigger.invalid"
    || value === "workflow.trigger.materialization_failed";
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

// 对象级收窄：isWorkflowRunStatus 只收窄 status 属性，无法让 `run` 本身满足
// toWorkflowRunSummary 形参（status: WorkflowRunStatus）。此守卫把整条运行收窄为
// 带 WorkflowRunStatus 的记录，供循环 continue 与 .filter 复用。
function isStatusfulWorkflowRun(run: WorkflowRunRecord): run is WorkflowRunRecord & { status: WorkflowRunStatus } {
  return isWorkflowRunStatus(run.status);
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

/**
 * 审批节点运行详情：从 node_run.approval_id 取审批 id，从建 Run 时快照进
 * input_json 的节点 config 取风险等级与指定审批人（解析为展示名），来源固定
 * 为「工作流审批」。审批中心的详细卡片由 /approvals 自身渲染，此处只提供跳转。
 */
function buildApprovalNodeFields(
  node: { approvalId?: string; inputJson: string },
  memberLabels: Map<string, string>,
): {
  approvalId?: string;
  approvalRisk?: "low" | "medium" | "high";
  approvalReviewerLabel?: string;
  approvalSource?: string;
  approvalDeadlineLabel?: string;
} {
  const config = parseRecord(node.inputJson);
  const fields: {
    approvalId?: string;
    approvalRisk?: "low" | "medium" | "high";
    approvalReviewerLabel?: string;
    approvalSource?: string;
    approvalDeadlineLabel?: string;
  } = { approvalSource: "工作流审批" };
  if (node.approvalId) fields.approvalId = node.approvalId;
  const risk = config.risk;
  if (risk === "low" || risk === "medium" || risk === "high") fields.approvalRisk = risk;
  const reviewerUserId = typeof config.reviewerUserId === "string" ? config.reviewerUserId.trim() : "";
  if (reviewerUserId) {
    fields.approvalReviewerLabel = memberLabels.get(reviewerUserId) ?? reviewerUserId;
  }
  const deadlineLabel = formatApprovalDeadlineLabel(config.deadlineSeconds);
  if (deadlineLabel) fields.approvalDeadlineLabel = deadlineLabel;
  return fields;
}

/**
 * 将审批限时（秒）格式化为易读的中文标签，如「限时：1 小时」「限时：2 天 3 小时」。
 * 仅接受 1..2592000（最长 30 天）的正数，与发布侧 parseApprovalDeadlineSeconds 对齐。
 */
function formatApprovalDeadlineLabel(value: unknown): string | undefined {
  const seconds = typeof value === "number" ? value : typeof value === "string" ? Number(value) : NaN;
  if (!Number.isFinite(seconds) || seconds < 1 || seconds > 30 * 24 * 60 * 60) return undefined;
  const whole = Math.floor(seconds);
  const days = Math.floor(whole / 86_400);
  const hours = Math.floor((whole % 86_400) / 3_600);
  const minutes = Math.floor((whole % 3_600) / 60);
  if (days > 0) return `限时：${days} 天${hours > 0 ? ` ${hours} 小时` : ""}`;
  if (hours > 0) return `限时：${hours} 小时${minutes > 0 ? ` ${minutes} 分钟` : ""}`;
  if (minutes > 0) return `限时：${minutes} 分钟`;
  return `限时：${whole} 秒`;
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

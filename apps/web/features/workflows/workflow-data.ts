import { createHmac, timingSafeEqual } from "node:crypto";
import {
  getDatabase,
  listEmployeeRuntimeBindingsSync,
  listStoredChannelsSync,
  listStoredEmployeesSync,
  listWorkflowDefinitionsSync,
  listWorkflowNodeRunsSync,
  listWorkflowRunEventsSync,
  listWorkflowRunsSync,
  listWorkflowRunsPageSnapshotSync,
  listWorkflowRunsAfterCursorSync,
  listWorkspaceMemberUsersSync,
  readWorkflowDefinitionSync,
  readWorkflowRunSync,
  readWorkflowTriggerForWorkflowSync,
  readWorkflowVersionSync,
} from "@dofe-agent/db";
import type { WorkflowRunRecord, WorkflowRunListCursor } from "@dofe-agent/db";
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

// 运行历史分页首页大小（UIUX:运行历史分页）：SSR 中心页与 GET /api/workspaces/:id/workflow-runs 共用。
const RECENT_RUNS_PAGE_SIZE = 50;
const MAX_POSTGRES_BIGINT = 9_223_372_036_854_775_807n;
const WORKFLOW_RUN_CURSOR_VERSION = 3;
const PREVIOUS_WORKFLOW_RUN_CURSOR_VERSION = 2;

interface SignedWorkflowRunCursorWire {
  version: typeof WORKFLOW_RUN_CURSOR_VERSION | typeof PREVIOUS_WORKFLOW_RUN_CURSOR_VERSION;
  workspaceId: string;
  createdAt: string;
  id: string;
  snapshotSequence?: string;
  snapshotTotal?: number;
  snapshotCount?: number;
  keyId?: string;
  signature: string;
}

interface DecodedWorkflowRunCursor {
  cursor: WorkflowRunListCursor;
  kind: "signed" | "legacy";
}

type SignedWorkflowRunCursorInput = WorkflowRunListCursor & {
  snapshotTotal: number;
  snapshotSequence: string;
};

interface WorkflowRunCursorSigningKey {
  id: string;
  secret: string;
}

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
  // 每个工作流最近一次运行（计划列表 latestRun 列）：扫描最近 500 条运行，按 (created_at
  // DESC, id DESC) 取每个 workflowId 的首条。与运行历史分页独立——recentRuns 首页由下方
  // getWorkflowRunsPageSync 与 API 共用同一 keyset 游标实现产出，保证 SSR 首页与懒加载页
  // 的排序、过滤、游标口径完全一致。
  for (const run of listWorkflowRunsSync(workspaceId, 500)) {
    if (!isStatusfulWorkflowRun(run)) continue;
    if (!definitionIds.has(run.workflowId) || latestRuns.has(run.workflowId)) continue;
    latestRuns.set(run.workflowId, {
      id: run.id,
      status: run.status,
      ...(run.finishedAt ? { finishedAt: run.finishedAt } : {}),
    });
  }
  // 运行历史首页（UIUX:运行历史分页）：与 GET /api/workspaces/:id/workflow-runs 共用同一
  // keyset 游标实现。SSR 下发首页 + nextCursor/hasMore，前端据此续拉，避免 offset 分页在
  // 并发新增运行时漏记录或「加载更多」永不结束。
  const recentRunsPage = getWorkflowRunsPageSync(workspaceId, { limit: RECENT_RUNS_PAGE_SIZE });

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
    recentRuns: recentRunsPage.runs,
    recentRunsTotal: recentRunsPage.total,
    recentRunsHasMore: recentRunsPage.hasMore,
    recentRunsNextCursor: recentRunsPage.nextCursor,
  };
}

/** 游标分页结果：runs 为本页，nextCursor 供前端续拉下一页（无更多时为 null），total 仅用于「共 N 条」展示。 */
export interface WorkflowRunsPage {
  runs: WorkflowRunSummary[];
  total: number;
  hasMore: boolean;
  nextCursor: string | null;
  /** 请求携带旧协议（114/115 无签名）游标时为 true：结果已是重置后的首页，前端应替换列表而非追加。 */
  cursorReset?: boolean;
}

/**
 * 运行历史游标分页（UIUX:运行历史分页）：中心页 SSR 与 GET /api/workspaces/:id/workflow-runs
 * 共用此实现，按 (created_at DESC, id DESC) keyset 推进。
 *
 * 取代 offset 分页以消除「分页期间新增运行导致 offset 整体后移、去重后漏记录或『加载更多』
 * 永不结束」的缺陷：新插入的运行 createdAt 晚于游标，不会被后续页误纳入，分页始终连续、
 * 确定且可终止。首页用单条 SQL 同时读取列表、总数和不可变写入序号上界；后续页只读取
 * 上界内的记录，并沿用服务端签名保护的快照总数。这样同时间戳、回填时间或更小 ID 的后插运行
 * 也不会穿透当前分页会话。取 limit+1 条以判定 hasMore（多取的一条仅用于边界判定，不下发）。
 */
export function getWorkflowRunsPageSync(
  workspaceId: string,
  input: { limit: number; cursor?: string | null },
): WorkflowRunsPage {
  const limit = Math.max(1, Math.min(Math.trunc(input.limit), 200));
  const decodedCursor = decodeWorkflowRunCursorEnvelope(input.cursor ?? null, workspaceId);
  // 114/115 旧游标（无签名）只用于识别过期协议，绝不把其中的 total/sequence 用作查询边界。
  // 滚动升级中旧页面带着旧游标请求新 API：回退为首页并标记 cursorReset，前端据此替换列表而非追加，
  // 使已打开的旧页面无需强制刷新即可恢复（旧前端无 409 处理，会显示"加载更多失败"）。
  const cursorReset = decodedCursor?.kind === "legacy";
  const cursor = cursorReset ? null : (decodedCursor?.cursor ?? null);
  const workflowNamesById = new Map(
    listWorkflowDefinitionsSync(workspaceId).map((definition) => [definition.id, definition.name]),
  );
  const firstPageSnapshot = !cursor
    ? listWorkflowRunsPageSnapshotSync(workspaceId, limit + 1)
    : null;
  const snapshotSequence = cursor?.snapshotSequence
    ?? firstPageSnapshot!.snapshotSequence;
  const pageCursor = cursor ? { ...cursor, snapshotSequence } : null;
  const fetched = (cursor
    ? listWorkflowRunsAfterCursorSync(workspaceId, pageCursor, limit + 1)
    : firstPageSnapshot!.runs).filter(isStatusfulWorkflowRun);
  const total = cursor?.snapshotTotal ?? firstPageSnapshot?.total;
  if (total === undefined) throw new Error("workflow_run_cursor_snapshot_incomplete");
  const hasMore = fetched.length > limit;
  const pageRecords = hasMore ? fetched.slice(0, limit) : fetched;
  const runs = pageRecords.map((run) => toWorkflowRunSummary(run, workflowNamesById));
  const lastRecord = pageRecords[pageRecords.length - 1];
  const nextCursor = hasMore && lastRecord
    ? encodeWorkflowRunCursor({
        createdAt: lastRecord.createdAt,
        id: lastRecord.id,
        snapshotSequence,
        snapshotTotal: total,
      }, workspaceId)
    : null;
  return { runs, total, hasMore, nextCursor, cursorReset };
}

/** 编码为旧实例仍可读取、当前实例可验签并校验 workspace 的 base64url JSON。 */
export function encodeWorkflowRunCursor(cursor: SignedWorkflowRunCursorInput, workspaceId: string): string {
  const validated = validateWorkflowRunCursor(cursor);
  if (!validated || validated.snapshotTotal === undefined || validated.snapshotSequence === undefined) {
    throw new Error("workflow_run_cursor_snapshot_required");
  }
  const unsigned = workflowRunCursorSigningPayload(validated as SignedWorkflowRunCursorInput, workspaceId);
  const signingKey = readWorkflowRunCursorSigningKeys()[0]!;
  return Buffer.from(JSON.stringify({
    ...unsigned,
    keyId: signingKey.id,
    signature: signWorkflowRunCursor(JSON.stringify(unsigned), signingKey.secret),
  } satisfies SignedWorkflowRunCursorWire), "utf8").toString("base64url");
}

/** 解码游标；输入为空或格式非法时返回 null（由调用方决定空 vs 非法的语义）。 */
export function decodeWorkflowRunCursor(raw: string | null, workspaceId?: string): WorkflowRunListCursor | null {
  return decodeWorkflowRunCursorEnvelope(raw, workspaceId)?.cursor ?? null;
}

function decodeWorkflowRunCursorEnvelope(
  raw: string | null,
  workspaceId?: string,
): DecodedWorkflowRunCursor | null {
  if (typeof raw !== "string" || raw.length === 0) return null;
  try {
    const parsed = JSON.parse(Buffer.from(raw, "base64url").toString("utf8")) as Partial<SignedWorkflowRunCursorWire>;
    if (parsed.version !== undefined) {
      if ((parsed.version !== WORKFLOW_RUN_CURSOR_VERSION
          && parsed.version !== PREVIOUS_WORKFLOW_RUN_CURSOR_VERSION)
        || typeof parsed.workspaceId !== "string"
        || typeof parsed.signature !== "string"
        || (workspaceId !== undefined && parsed.workspaceId !== workspaceId)) {
        return null;
      }
      const cursor = validateWorkflowRunCursor({
        createdAt: parsed.createdAt,
        id: parsed.id,
        snapshotSequence: parsed.snapshotSequence,
        snapshotTotal: parsed.version === WORKFLOW_RUN_CURSOR_VERSION
          ? parsed.snapshotCount
          : parsed.snapshotTotal,
      });
      if (!cursor
        || cursor.snapshotSequence === undefined
        || cursor.snapshotTotal === undefined
        || !verifyWorkflowRunCursorSignature(
          JSON.stringify(workflowRunCursorSigningPayload(
            cursor as SignedWorkflowRunCursorInput,
            parsed.workspaceId,
            parsed.version,
          )),
          parsed.signature,
          parsed.keyId,
        )) {
        return null;
      }
      return cursor ? { cursor, kind: "signed" } : null;
    }
    // 114/115 生成的无签名游标只用于识别过期协议；绝不把其中的 total/sequence 用作查询边界。
    const cursor = validateWorkflowRunCursor(parsed);
    return cursor ? { cursor, kind: "legacy" } : null;
  } catch {
    return null;
  }
}

function validateWorkflowRunCursor(parsed: Partial<WorkflowRunListCursor> | undefined): WorkflowRunListCursor | null {
  if (!parsed) return null;
  try {
    const hasValidSnapshotTotal = parsed.snapshotTotal === undefined
      || (typeof parsed.snapshotTotal === "number"
        && Number.isSafeInteger(parsed.snapshotTotal)
        && parsed.snapshotTotal >= 0);
    const hasValidSnapshotSequence = parsed.snapshotSequence === undefined
      || (typeof parsed.snapshotSequence === "string"
        && /^\d+$/.test(parsed.snapshotSequence)
        && BigInt(parsed.snapshotSequence) <= MAX_POSTGRES_BIGINT);
    if (typeof parsed.createdAt === "string"
      && Number.isFinite(Date.parse(parsed.createdAt))
      && typeof parsed.id === "string"
      && parsed.id.length > 0
      && hasValidSnapshotTotal
      && hasValidSnapshotSequence) {
      return {
        createdAt: parsed.createdAt,
        id: parsed.id,
        ...(parsed.snapshotTotal !== undefined ? { snapshotTotal: parsed.snapshotTotal } : {}),
        ...(parsed.snapshotSequence !== undefined ? { snapshotSequence: parsed.snapshotSequence } : {}),
      };
    }
    return null;
  } catch {
    return null;
  }
}

function signWorkflowRunCursor(content: string, secret: string): string {
  return createHmac("sha256", secret).update(content, "utf8").digest("base64url");
}

function workflowRunCursorSigningPayload(
  cursor: SignedWorkflowRunCursorInput,
  workspaceId: string,
  version: SignedWorkflowRunCursorWire["version"] = WORKFLOW_RUN_CURSOR_VERSION,
): Omit<SignedWorkflowRunCursorWire, "signature" | "keyId"> {
  const base = {
    version,
    workspaceId,
    createdAt: cursor.createdAt,
    id: cursor.id,
  };
  return version === WORKFLOW_RUN_CURSOR_VERSION
    ? { ...base, snapshotCount: cursor.snapshotTotal, snapshotSequence: cursor.snapshotSequence }
    : { ...base, snapshotTotal: cursor.snapshotTotal, snapshotSequence: cursor.snapshotSequence };
}

function verifyWorkflowRunCursorSignature(content: string, signature: string, keyId?: string): boolean {
  const actual = Buffer.from(signature, "base64url");
  const keys = readWorkflowRunCursorSigningKeys();
  const orderedKeys = keyId
    ? [...keys.filter((key) => key.id === keyId), ...keys.filter((key) => key.id !== keyId)]
    : keys;
  return orderedKeys.some((key) => {
    const expected = Buffer.from(signWorkflowRunCursor(content, key.secret), "base64url");
    return expected.length === actual.length && timingSafeEqual(expected, actual);
  });
}

function readWorkflowRunCursorSigningKeys(): WorkflowRunCursorSigningKey[] {
  const currentSecret = (
    process.env.WORKFLOW_RUN_CURSOR_SECRET
    ?? process.env.INTERNAL_API_SECRET
    ?? ""
  ).trim();
  if (!currentSecret) {
    throw new Error("WORKFLOW_RUN_CURSOR_SECRET or INTERNAL_API_SECRET is required to sign workflow run cursors.");
  }
  const keys: WorkflowRunCursorSigningKey[] = [{
    id: process.env.WORKFLOW_RUN_CURSOR_KEY_ID?.trim() || "current",
    secret: currentSecret,
  }];
  const previousSecret = process.env.WORKFLOW_RUN_CURSOR_PREVIOUS_SECRET?.trim();
  if (previousSecret && previousSecret !== currentSecret) {
    keys.push({
      id: process.env.WORKFLOW_RUN_CURSOR_PREVIOUS_KEY_ID?.trim() || "previous",
      secret: previousSecret,
    });
  }
  return keys;
}

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

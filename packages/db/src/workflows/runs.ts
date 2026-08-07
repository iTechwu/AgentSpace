import { getDatabase, randomLikeId, withTransaction, type PostgresSyncDatabase } from "../database.ts";
import { isWorkflowNodeType } from "@dofe-agent/domain";
import type { WorkflowNodeRunRecord, WorkflowRunRecord } from "../types.ts";

export interface CreateWorkflowRunInput {
  id?: string;
  workspaceId: string;
  workflowId: string;
  versionId: string;
  rootTaskId?: string;
  triggerId?: string;
  triggerType: string;
  triggerKey: string;
  inputJson: string;
  createdBy?: string;
  budgetJson?: string;
  now?: string;
}

export interface WorkflowNodeSeed {
  nodeId: string;
  nodeType: string;
  employeeId?: string;
  employeeNameSnapshot?: string;
  maxAttempts?: number;
  inputJson?: string;
}

export interface MaterializeNodeRunsInput {
  workspaceId: string;
  runId: string;
  nodes: WorkflowNodeSeed[];
  now?: string;
}

export interface TransitionWorkflowRunInput {
  workspaceId: string;
  runId: string;
  from: string[];
  to: string;
  now?: string;
  startedAt?: string;
  finishedAt?: string;
  allowTerminalRetry?: boolean;
  clearFinishedAt?: boolean;
}

export interface TransitionWorkflowNodeRunInput {
  workspaceId: string;
  nodeRunId: string;
  from: string[];
  to: string;
  now?: string;
  taskQueueId?: string | null;
  clearTaskQueueId?: boolean;
  approvalId?: string;
  availableAt?: string | null;
  attemptCount?: number;
  startedAt?: string;
  finishedAt?: string;
  outputJson?: string;
  inputJson?: string;
  artifactManifestJson?: string;
  errorCode?: string;
  errorMessage?: string;
  clearError?: boolean;
  allowTerminalRetry?: boolean;
  clearFinishedAt?: boolean;
  maxAttempts?: number;
}

export interface ClaimWorkflowNodeForDispatchInput {
  workspaceId: string;
  nodeRunId: string;
  maxConcurrency: number;
  now: string;
  retryDelaySeconds?: number;
}

export interface ClaimWorkflowNodeForDispatchResult {
  nodeRun: WorkflowNodeRunRecord | null;
  reason: "claimed" | "concurrency_limited" | "not_ready";
}

const TERMINAL_RUN_STATUSES = new Set(["succeeded", "partially_succeeded", "failed", "cancelled"]);
const TERMINAL_NODE_RUN_STATUSES = new Set(["succeeded", "failed", "skipped", "cancelled"]);

export function createWorkflowRunSync(input: CreateWorkflowRunInput): WorkflowRunRecord {
  const db = getDatabase();
  const id = input.id ?? `workflow-run-${randomLikeId()}`;
  const now = input.now ?? new Date().toISOString();
  const references = db.prepare(
    `SELECT wd.workspace_id AS definition_workspace_id,
            wv.workspace_id AS version_workspace_id,
            wv.workflow_id AS version_workflow_id,
            wt.workspace_id AS trigger_workspace_id,
            wt.workflow_id AS trigger_workflow_id,
            wt.type AS trigger_type
       FROM workflow_definition wd
       LEFT JOIN workflow_version wv ON wv.id = ?
       LEFT JOIN workflow_trigger wt ON wt.id = ?
      WHERE wd.id = ?`,
  ).get(input.versionId, input.triggerId ?? null, input.workflowId) as Record<string, unknown> | undefined;
  if (!references
    || references.definition_workspace_id !== input.workspaceId
    || references.version_workspace_id !== input.workspaceId
    || references.version_workflow_id !== input.workflowId
    || (input.triggerId && (
      references.trigger_workspace_id !== input.workspaceId
      || references.trigger_workflow_id !== input.workflowId
      || references.trigger_type !== input.triggerType
    ))) {
    throw new Error("workflow_workspace_mismatch");
  }
  if (input.rootTaskId) {
    const task = db.prepare("SELECT workspace_id FROM agent_task_queue WHERE id = ?").get(input.rootTaskId) as { workspace_id?: unknown } | undefined;
    if (task?.workspace_id !== input.workspaceId) throw new Error("workflow_workspace_mismatch");
  }
  db.prepare(
    `INSERT INTO workflow_run (
       id, workspace_id, workflow_id, version_id, root_task_id, trigger_id, trigger_type,
       trigger_key, input_json, status, current_sequence, budget_json, created_by, created_at, updated_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'created', 0, ?, ?, ?, ?)
     ON CONFLICT (workspace_id, trigger_key) DO NOTHING`,
  ).run(
    id,
    input.workspaceId,
    input.workflowId,
    input.versionId,
    input.rootTaskId ?? null,
    input.triggerId ?? null,
    input.triggerType,
    input.triggerKey,
    input.inputJson,
    input.budgetJson ?? "{}",
    input.createdBy ?? "system",
    now,
    now,
  );
  const run = readWorkflowRunSyncByTriggerKey(input.workspaceId, input.triggerKey);
  if (!run) throw new Error("workflow_run_create_failed");
  return run;
}

export function readWorkflowRunSync(id: string, workspaceId: string): WorkflowRunRecord | null {
  const row = getDatabase().prepare(`${RUN_SELECT} WHERE id = ? AND workspace_id = ?`)
    .get(id, workspaceId) as Record<string, unknown> | undefined;
  return row ? mapRun(row) : null;
}

export function lockWorkflowRunForUpdateSync(id: string, workspaceId: string): WorkflowRunRecord | null {
  const row = getDatabase().prepare(`${RUN_SELECT} WHERE id = ? AND workspace_id = ? FOR UPDATE`)
    .get(id, workspaceId) as Record<string, unknown> | undefined;
  return row ? mapRun(row) : null;
}

export function readWorkflowRunSyncByTriggerKey(workspaceId: string, triggerKey: string): WorkflowRunRecord | null {
  const row = getDatabase().prepare(`${RUN_SELECT} WHERE workspace_id = ? AND trigger_key = ?`)
    .get(workspaceId, triggerKey) as Record<string, unknown> | undefined;
  return row ? mapRun(row) : null;
}

export function listWorkflowRunsSync(workspaceId: string, limit = 100): WorkflowRunRecord[] {
  const safeLimit = Math.max(1, Math.min(limit, 500));
  return (getDatabase().prepare(
    `${RUN_SELECT} WHERE workspace_id = ? ORDER BY created_at DESC, id DESC LIMIT ${safeLimit}`,
  ).all(workspaceId) as Array<Record<string, unknown>>).map(mapRun);
}

export function materializeWorkflowNodeRunsSync(input: MaterializeNodeRunsInput): WorkflowNodeRunRecord[] {
  const db = getDatabase();
  const now = input.now ?? new Date().toISOString();
  withTransaction(db, () => {
    if (!readWorkflowRunSync(input.runId, input.workspaceId)) throw new Error("workflow_workspace_mismatch");
    for (const node of input.nodes) {
      if (!isWorkflowNodeType(node.nodeType)) {
        throw new Error("workflow_node_type_unsupported");
      }
      db.prepare(
        `INSERT INTO workflow_node_run (
           id, workspace_id, run_id, node_id, node_type, employee_id, employee_name_snapshot,
           status, attempt_count, max_attempts, input_json, created_at, updated_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, 'pending', 0, ?, ?, ?, ?)
         ON CONFLICT (run_id, node_id) DO NOTHING`,
      ).run(
        `workflow-node-run-${randomLikeId()}`,
        input.workspaceId,
        input.runId,
        node.nodeId,
        node.nodeType,
        node.employeeId ?? null,
        node.employeeNameSnapshot ?? null,
        node.maxAttempts ?? 1,
        node.inputJson ?? "{}",
        now,
        now,
      );
    }
  });
  return listWorkflowNodeRunsSync(input.workspaceId, input.runId);
}

export function readWorkflowNodeRunSync(id: string, workspaceId: string): WorkflowNodeRunRecord | null {
  const row = getDatabase().prepare(`${NODE_RUN_SELECT} WHERE id = ? AND workspace_id = ?`)
    .get(id, workspaceId) as Record<string, unknown> | undefined;
  return row ? mapNodeRun(row) : null;
}

export function readWorkflowNodeRunByTaskQueueIdSync(taskQueueId: string, workspaceId: string): WorkflowNodeRunRecord | null {
  const row = getDatabase().prepare(`${NODE_RUN_SELECT} WHERE task_queue_id = ? AND workspace_id = ?`)
    .get(taskQueueId, workspaceId) as Record<string, unknown> | undefined;
  return row ? mapNodeRun(row) : null;
}

export function readWorkflowNodeRunByApprovalIdSync(approvalId: string, workspaceId: string): WorkflowNodeRunRecord | null {
  const row = getDatabase().prepare(`${NODE_RUN_SELECT} WHERE approval_id = ? AND workspace_id = ?`)
    .get(approvalId, workspaceId) as Record<string, unknown> | undefined;
  return row ? mapNodeRun(row) : null;
}

export function listWorkflowNodeRunsSync(workspaceId: string, runId: string): WorkflowNodeRunRecord[] {
  return (getDatabase().prepare(
    `${NODE_RUN_SELECT} WHERE workspace_id = ? AND run_id = ? ORDER BY created_at ASC, id ASC`,
  ).all(workspaceId, runId) as Array<Record<string, unknown>>).map(mapNodeRun);
}

export function claimWorkflowNodeForDispatchSync(
  input: ClaimWorkflowNodeForDispatchInput,
): ClaimWorkflowNodeForDispatchResult {
  const db = getDatabase();
  return withTransaction(db, () => {
    const candidate = readWorkflowNodeRunSync(input.nodeRunId, input.workspaceId);
    if (!candidate || candidate.status !== "ready") return { nodeRun: candidate, reason: "not_ready" };
    const run = lockWorkflowRunForUpdateSync(candidate.runId, input.workspaceId);
    if (!run) return { nodeRun: null, reason: "not_ready" };
    const row = db.prepare(`${NODE_RUN_SELECT} WHERE id = ? AND workspace_id = ? FOR UPDATE`)
      .get(input.nodeRunId, input.workspaceId) as Record<string, unknown> | undefined;
    const nodeRun = row ? mapNodeRun(row) : null;
    if (!nodeRun || nodeRun.status !== "ready") return { nodeRun, reason: "not_ready" };
    const active = db.prepare(
      `SELECT COUNT(*)::integer AS count
         FROM workflow_node_run
        WHERE workspace_id = ? AND run_id = ? AND status IN ('queued', 'running')`,
    ).get(input.workspaceId, nodeRun.runId) as { count: number };
    if (active.count >= Math.max(1, input.maxConcurrency)) {
      const availableAt = new Date(Date.parse(input.now) + (input.retryDelaySeconds ?? 5) * 1_000).toISOString();
      return {
        nodeRun: transitionWorkflowNodeRunSync({
          workspaceId: input.workspaceId,
          nodeRunId: nodeRun.id,
          from: ["ready"],
          to: "retry_wait",
          availableAt,
          errorCode: "workflow_concurrency_limited",
          errorMessage: `max_concurrency_${input.maxConcurrency}`,
          now: input.now,
        }),
        reason: "concurrency_limited",
      };
    }
    return {
      nodeRun: transitionWorkflowNodeRunSync({
        workspaceId: input.workspaceId,
        nodeRunId: nodeRun.id,
        from: ["ready"],
        to: "queued",
        clearError: true,
        now: input.now,
      }),
      reason: "claimed",
    };
  });
}

export function transitionWorkflowRunSync(input: TransitionWorkflowRunInput): WorkflowRunRecord | null {
  const now = input.now ?? new Date().toISOString();
  const from = input.from.filter((status) => (
    !TERMINAL_RUN_STATUSES.has(status)
    || (input.allowTerminalRetry === true
      && (status === "failed" || status === "partially_succeeded")
      && input.to === "running")
  ));
  if (from.length === 0) return null;
  const placeholders = from.map(() => "?").join(", ");
  const row = getDatabase().prepare(
    `UPDATE workflow_run
        SET status = ?, started_at = COALESCE(?, started_at),
            finished_at = CASE WHEN ? THEN NULL ELSE COALESCE(?, finished_at) END, updated_at = ?
      WHERE id = ? AND workspace_id = ? AND status IN (${placeholders})
      RETURNING ${RUN_COLUMNS}`,
  ).get(input.to, input.startedAt ?? null, input.clearFinishedAt === true, input.finishedAt ?? null, now, input.runId, input.workspaceId, ...from) as Record<string, unknown> | undefined;
  return row ? mapRun(row) : null;
}

export function transitionWorkflowNodeRunSync(input: TransitionWorkflowNodeRunInput): WorkflowNodeRunRecord | null {
  const now = input.now ?? new Date().toISOString();
  const from = input.from.filter((status) => (
    !TERMINAL_NODE_RUN_STATUSES.has(status)
    || (input.allowTerminalRetry === true && status === "failed" && input.to === "retry_wait")
  ));
  if (from.length === 0) return null;
  const placeholders = from.map(() => "?").join(", ");
  const row = getDatabase().prepare(
    `UPDATE workflow_node_run
        SET status = ?, task_queue_id = CASE WHEN ? THEN NULL ELSE COALESCE(?, task_queue_id) END,
            approval_id = COALESCE(?, approval_id), available_at = COALESCE(?, available_at),
            attempt_count = COALESCE(?, attempt_count), max_attempts = COALESCE(?, max_attempts),
            started_at = COALESCE(?, started_at),
            finished_at = CASE WHEN ? THEN NULL ELSE COALESCE(?, finished_at) END,
            input_json = COALESCE(?, input_json), output_json = COALESCE(?, output_json),
            artifact_manifest_json = COALESCE(?, artifact_manifest_json),
            error_code = CASE WHEN ? THEN NULL ELSE COALESCE(?, error_code) END,
            error_message = CASE WHEN ? THEN NULL ELSE COALESCE(?, error_message) END, updated_at = ?
      WHERE id = ? AND workspace_id = ? AND status IN (${placeholders})
      RETURNING ${NODE_RUN_COLUMNS}`,
  ).get(
    input.to,
    input.clearTaskQueueId === true,
    input.taskQueueId ?? null,
    input.approvalId ?? null,
    input.availableAt ?? null,
    input.attemptCount ?? null,
    input.maxAttempts ?? null,
    input.startedAt ?? null,
    input.clearFinishedAt === true,
    input.finishedAt ?? null,
    input.inputJson ?? null,
    input.outputJson ?? null,
    input.artifactManifestJson ?? null,
    input.clearError === true,
    input.errorCode ?? null,
    input.clearError === true,
    input.errorMessage ?? null,
    now,
    input.nodeRunId,
    input.workspaceId,
    ...from,
  ) as Record<string, unknown> | undefined;
  return row ? mapNodeRun(row) : null;
}

export function resetWorkflowDescendantNodeRunsForRetrySync(input: {
  workspaceId: string;
  runId: string;
  nodeIds: string[];
  now?: string;
}): WorkflowNodeRunRecord[] {
  if (input.nodeIds.length === 0) return [];
  const placeholders = input.nodeIds.map(() => "?").join(", ");
  const rows = getDatabase().prepare(
    `UPDATE workflow_node_run
        SET status = 'pending', task_queue_id = NULL, approval_id = NULL, available_at = NULL,
            started_at = NULL, finished_at = NULL, output_json = NULL, artifact_manifest_json = NULL,
            attempt_count = CASE
              WHEN node_type = 'employee_task' AND status = 'succeeded' THEN attempt_count + 1
              ELSE attempt_count
            END,
            max_attempts = CASE
              WHEN node_type = 'employee_task' AND status = 'succeeded' THEN GREATEST(max_attempts, attempt_count + 1)
              ELSE max_attempts
            END,
            error_code = NULL, error_message = NULL, updated_at = ?
      WHERE workspace_id = ? AND run_id = ? AND id IN (${placeholders})
        AND (node_type = 'join' OR status = 'succeeded'
          OR (status = 'skipped' AND error_code = 'workflow_upstream_failed'))
      RETURNING ${NODE_RUN_COLUMNS}`,
  ).all(input.now ?? new Date().toISOString(), input.workspaceId, input.runId, ...input.nodeIds) as Array<Record<string, unknown>>;
  return rows.map(mapNodeRun);
}

const RUN_COLUMNS = `id, workspace_id AS "workspaceId", workflow_id AS "workflowId", version_id AS "versionId",
  root_task_id AS "rootTaskId", trigger_id AS "triggerId", trigger_type AS "triggerType", trigger_key AS "triggerKey",
  input_json AS "inputJson", status, current_sequence AS "currentSequence", budget_json AS "budgetJson",
  started_at AS "startedAt", finished_at AS "finishedAt", created_by AS "createdBy", created_at AS "createdAt", updated_at AS "updatedAt"`;
const RUN_SELECT = `SELECT ${RUN_COLUMNS} FROM workflow_run`;
const NODE_RUN_COLUMNS = `id, workspace_id AS "workspaceId", run_id AS "runId", node_id AS "nodeId", node_type AS "nodeType",
  employee_id AS "employeeId", employee_name_snapshot AS "employeeNameSnapshot", status, attempt_count AS "attemptCount",
  max_attempts AS "maxAttempts", available_at AS "availableAt", task_queue_id AS "taskQueueId", approval_id AS "approvalId",
  input_json AS "inputJson", output_json AS "outputJson", artifact_manifest_json AS "artifactManifestJson",
  error_code AS "errorCode", error_message AS "errorMessage", started_at AS "startedAt", finished_at AS "finishedAt",
  created_at AS "createdAt", updated_at AS "updatedAt"`;
const NODE_RUN_SELECT = `SELECT ${NODE_RUN_COLUMNS} FROM workflow_node_run`;

function mapRun(row: Record<string, unknown>): WorkflowRunRecord {
  return compactOptional(row) as unknown as WorkflowRunRecord;
}

function mapNodeRun(row: Record<string, unknown>): WorkflowNodeRunRecord {
  return compactOptional(row) as unknown as WorkflowNodeRunRecord;
}

function compactOptional(row: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(row).filter(([, value]) => value !== null));
}

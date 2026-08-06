import { getDatabase, randomLikeId, withTransaction, type PostgresSyncDatabase } from "../database.ts";
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
}

export interface TransitionWorkflowNodeRunInput {
  workspaceId: string;
  nodeRunId: string;
  from: string[];
  to: string;
  now?: string;
  taskQueueId?: string | null;
  availableAt?: string | null;
  attemptCount?: number;
  startedAt?: string;
  finishedAt?: string;
  outputJson?: string;
  errorCode?: string;
  errorMessage?: string;
}

export function createWorkflowRunSync(input: CreateWorkflowRunInput): WorkflowRunRecord {
  const db = getDatabase();
  const id = input.id ?? `workflow-run-${randomLikeId()}`;
  const now = input.now ?? new Date().toISOString();
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
    for (const node of input.nodes) {
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

export function listWorkflowNodeRunsSync(workspaceId: string, runId: string): WorkflowNodeRunRecord[] {
  return (getDatabase().prepare(
    `${NODE_RUN_SELECT} WHERE workspace_id = ? AND run_id = ? ORDER BY created_at ASC, id ASC`,
  ).all(workspaceId, runId) as Array<Record<string, unknown>>).map(mapNodeRun);
}

export function transitionWorkflowRunSync(input: TransitionWorkflowRunInput): WorkflowRunRecord | null {
  const now = input.now ?? new Date().toISOString();
  const from = input.from.length > 0 ? input.from : ["__never__"];
  const placeholders = from.map(() => "?").join(", ");
  const row = getDatabase().prepare(
    `UPDATE workflow_run
        SET status = ?, started_at = COALESCE(?, started_at), finished_at = COALESCE(?, finished_at), updated_at = ?
      WHERE id = ? AND workspace_id = ? AND status IN (${placeholders})
      RETURNING ${RUN_COLUMNS}`,
  ).get(input.to, input.startedAt ?? null, input.finishedAt ?? null, now, input.runId, input.workspaceId, ...from) as Record<string, unknown> | undefined;
  return row ? mapRun(row) : null;
}

export function transitionWorkflowNodeRunSync(input: TransitionWorkflowNodeRunInput): WorkflowNodeRunRecord | null {
  const now = input.now ?? new Date().toISOString();
  const from = input.from.length > 0 ? input.from : ["__never__"];
  const placeholders = from.map(() => "?").join(", ");
  const row = getDatabase().prepare(
    `UPDATE workflow_node_run
        SET status = ?, task_queue_id = COALESCE(?, task_queue_id), available_at = COALESCE(?, available_at),
            attempt_count = COALESCE(?, attempt_count), started_at = COALESCE(?, started_at),
            finished_at = COALESCE(?, finished_at), output_json = COALESCE(?, output_json),
            error_code = COALESCE(?, error_code), error_message = COALESCE(?, error_message), updated_at = ?
      WHERE id = ? AND workspace_id = ? AND status IN (${placeholders})
      RETURNING ${NODE_RUN_COLUMNS}`,
  ).get(
    input.to,
    input.taskQueueId ?? null,
    input.availableAt ?? null,
    input.attemptCount ?? null,
    input.startedAt ?? null,
    input.finishedAt ?? null,
    input.outputJson ?? null,
    input.errorCode ?? null,
    input.errorMessage ?? null,
    now,
    input.nodeRunId,
    input.workspaceId,
    ...from,
  ) as Record<string, unknown> | undefined;
  return row ? mapNodeRun(row) : null;
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

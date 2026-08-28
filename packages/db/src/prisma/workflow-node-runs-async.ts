// @deprecated — Phase 2 pg 直连原型，保留作 Prisma 接入迁移期 fallback。
// 生产路径走 workflow-node-runs-prisma.ts（同等接口）。

import { Client } from "pg";
import { resolvePostgresDatabaseUrl } from "../postgres-config.ts";
import type { WorkflowNodeRunRecord } from "../types.ts";

export async function listWorkflowNodeRunsAsync(
  workspaceId: string,
  runId: string,
): Promise<WorkflowNodeRunRecord[]> {
  const sql = `SELECT id, workspace_id, run_id, node_id, node_type,
                     employee_id, employee_name_snapshot, status, attempt_count,
                     max_attempts, available_at, task_queue_id, approval_id,
                     approval_deadline, approval_scan_after, input_json,
                     output_json, artifact_manifest_json, error_code,
                     error_message, started_at, finished_at,
                     created_at, updated_at
              FROM workflow_node_run
              WHERE workspace_id = $1 AND run_id = $2
              ORDER BY created_at ASC, id ASC`;

  const client = new Client({ connectionString: resolvePostgresDatabaseUrl() });
  try {
    await client.connect();
    const result = await client.query<RawRow>(sql, [workspaceId, runId]);
    return result.rows.map(mapRow);
  } finally {
    await client.end().catch(() => undefined);
  }
}

export function isWorkflowNodeRunsAsyncReadEnabled(): boolean {
  return process.env.WORKFLOW_NODE_RUNS_ASYNC_READ_ENABLED === "1";
}

export function isWorkflowNodeRunsShadowReadEnabled(): boolean {
  return process.env.WORKFLOW_NODE_RUNS_SHADOW_READ_ENABLED === "1";
}

interface RawRow {
  id: string;
  workspace_id: string;
  run_id: string;
  node_id: string;
  node_type: string;
  employee_id: string | null;
  employee_name_snapshot: string | null;
  status: string;
  attempt_count: number;
  max_attempts: number;
  available_at: Date | string | null;
  task_queue_id: string | null;
  approval_id: string | null;
  approval_deadline: Date | string | null;
  approval_scan_after: Date | string | null;
  input_json: string;
  output_json: string | null;
  artifact_manifest_json: string | null;
  error_code: string | null;
  error_message: string | null;
  started_at: Date | string | null;
  finished_at: Date | string | null;
  created_at: Date | string;
  updated_at: Date | string;
}

function mapRow(row: RawRow): WorkflowNodeRunRecord {
  const record: WorkflowNodeRunRecord = {
    id: row.id,
    workspaceId: row.workspace_id,
    runId: row.run_id,
    nodeId: row.node_id,
    nodeType: row.node_type,
    status: row.status,
    attemptCount: Number(row.attempt_count),
    maxAttempts: Number(row.max_attempts),
    inputJson: row.input_json,
    createdAt: toIsoString(row.created_at),
    updatedAt: toIsoString(row.updated_at),
  };
  if (row.employee_id !== null) record.employeeId = row.employee_id;
  if (row.employee_name_snapshot !== null) {
    record.employeeNameSnapshot = row.employee_name_snapshot;
  }
  if (row.available_at !== null) record.availableAt = toIsoString(row.available_at);
  if (row.task_queue_id !== null) record.taskQueueId = row.task_queue_id;
  if (row.approval_id !== null) record.approvalId = row.approval_id;
  if (row.approval_deadline !== null) {
    record.approvalDeadline = toIsoString(row.approval_deadline);
  }
  if (row.approval_scan_after !== null) {
    record.approvalScanAfter = toIsoString(row.approval_scan_after);
  }
  if (row.output_json !== null) record.outputJson = row.output_json;
  if (row.artifact_manifest_json !== null) {
    record.artifactManifestJson = row.artifact_manifest_json;
  }
  if (row.error_code !== null) record.errorCode = row.error_code;
  if (row.error_message !== null) record.errorMessage = row.error_message;
  if (row.started_at !== null) record.startedAt = toIsoString(row.started_at);
  if (row.finished_at !== null) record.finishedAt = toIsoString(row.finished_at);
  return record;
}

function toIsoString(value: Date | string): string {
  return value instanceof Date ? value.toISOString() : value;
}

// @deprecated — Phase 2 pg 直连原型，保留作 Prisma 接入迁移期 fallback。
// 生产路径走 workflow-runs-prisma.ts（同等接口）。

import { Client } from "pg";
import { resolvePostgresDatabaseUrl } from "../postgres-config.ts";
import type { WorkflowRunRecord } from "../types.ts";

export async function listWorkflowRunsAsync(
  workspaceId: string,
  limit: number = 100,
  offset: number = 0,
): Promise<WorkflowRunRecord[]> {
  const safeLimit = Math.max(1, Math.min(limit, 500));
  const safeOffset = Math.max(0, Math.trunc(offset));
  const sql = `SELECT id, workspace_id, workflow_id, version_id,
                     root_task_id, trigger_id, trigger_type, trigger_key,
                     input_json, status, current_sequence, budget_json,
                     started_at, finished_at, created_by, created_at, updated_at
              FROM workflow_run
              WHERE workspace_id = $1
              ORDER BY created_at DESC, id DESC
              LIMIT ${safeLimit} OFFSET ${safeOffset}`;

  const client = new Client({ connectionString: resolvePostgresDatabaseUrl() });
  try {
    await client.connect();
    const result = await client.query<RawRow>(sql, [workspaceId]);
    return result.rows.map(mapRow);
  } finally {
    await client.end().catch(() => undefined);
  }
}

export function isWorkflowRunsAsyncReadEnabled(): boolean {
  return process.env.WORKFLOW_RUNS_ASYNC_READ_ENABLED === "1";
}

export function isWorkflowRunsShadowReadEnabled(): boolean {
  return process.env.WORKFLOW_RUNS_SHADOW_READ_ENABLED === "1";
}

interface RawRow {
  id: string;
  workspace_id: string;
  workflow_id: string;
  version_id: string;
  root_task_id: string | null;
  trigger_id: string | null;
  trigger_type: string;
  trigger_key: string;
  input_json: string;
  status: string;
  current_sequence: string | number;
  budget_json: string;
  started_at: Date | string | null;
  finished_at: Date | string | null;
  created_by: string;
  created_at: Date | string;
  updated_at: Date | string;
}

function mapRow(row: RawRow): WorkflowRunRecord {
  const record: WorkflowRunRecord = {
    id: row.id,
    workspaceId: row.workspace_id,
    workflowId: row.workflow_id,
    versionId: row.version_id,
    triggerType: row.trigger_type,
    triggerKey: row.trigger_key,
    inputJson: row.input_json,
    status: row.status,
    currentSequence: Number(row.current_sequence),
    budgetJson: row.budget_json,
    createdBy: row.created_by,
    createdAt: toIsoString(row.created_at),
    updatedAt: toIsoString(row.updated_at),
  };
  if (row.root_task_id !== null) record.rootTaskId = row.root_task_id;
  if (row.trigger_id !== null) record.triggerId = row.trigger_id;
  if (row.started_at !== null) record.startedAt = toIsoString(row.started_at);
  if (row.finished_at !== null) record.finishedAt = toIsoString(row.finished_at);
  return record;
}

function toIsoString(value: Date | string): string {
  return value instanceof Date ? value.toISOString() : value;
}
// @deprecated — Phase 2 pg 直连原型，保留作 Prisma 接入迁移期 fallback。
// 生产路径走 task-queue-prisma.ts（同等接口，@prisma/client 真接入）。
//
// task-queue Phase 2 异步 primary（pg.Client 直连原型）：listQueuedTasksAsync
// 通过 pg.Client 直连 PG 拉 agent_task_queue 行；切流 flag 由 env var 控制。

import { Client } from "pg";
import { resolvePostgresDatabaseUrl } from "../postgres-config.ts";
import type { QueuedTaskRecord } from "../types.ts";

const VALID_STATUSES = new Set([
  "queued",
  "claimed",
  "running",
  "preparing_commit",
  "committed",
  "completed",
  "failed",
  "cancelled",
]);

export async function listQueuedTasksAsync(options?: {
  workspaceId?: string;
  runtimeId?: string;
}): Promise<QueuedTaskRecord[]> {
  const conditions: string[] = [];
  const params: unknown[] = [];
  if (typeof options?.workspaceId === "string") {
    conditions.push(`workspace_id = $${params.length + 1}`);
    params.push(options.workspaceId);
  }
  if (typeof options?.runtimeId === "string") {
    conditions.push(`runtime_id = $${params.length + 1}`);
    params.push(options.runtimeId);
  }
  const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";
  const sql = `SELECT id, workspace_id, employee_id, employee_name, agent_id,
                     runtime_id, runtime_credential_id, router_session_id,
                     issue_id, trigger_type, priority, status, input_json,
                     requested_by_user_id, requested_by_display_name,
                     result_json, error_text, session_id, work_dir,
                     binding_generation, queued_at, claimed_at, started_at,
                     finished_at, mcp_session_claimed_at, created_at, updated_at
              FROM agent_task_queue
              ${whereClause}
              ORDER BY queued_at ASC, id ASC`;

  const client = new Client({ connectionString: resolvePostgresDatabaseUrl() });
  try {
    await client.connect();
    const result = await client.query<RawRow>(sql, params);
    return result.rows.map(mapRow).filter((r): r is QueuedTaskRecord => r !== null);
  } finally {
    await client.end().catch(() => undefined);
  }
}

export function isTaskQueueAsyncReadEnabled(): boolean {
  return process.env.TASK_QUEUE_ASYNC_READ_ENABLED === "1";
}

export function isTaskQueueShadowReadEnabled(): boolean {
  return process.env.TASK_QUEUE_SHADOW_READ_ENABLED === "1";
}

interface RawRow {
  id: string;
  workspace_id: string;
  employee_id: string;
  employee_name: string;
  agent_id: string | null;
  runtime_id: string | null;
  runtime_credential_id: string | null;
  router_session_id: string | null;
  issue_id: string | null;
  trigger_type: string;
  priority: number;
  status: string;
  input_json: string;
  requested_by_user_id: string | null;
  requested_by_display_name: string | null;
  result_json: string | null;
  error_text: string | null;
  session_id: string | null;
  work_dir: string | null;
  binding_generation: number | null;
  queued_at: Date | string;
  claimed_at: Date | string | null;
  started_at: Date | string | null;
  finished_at: Date | string | null;
  mcp_session_claimed_at: Date | string | null;
  created_at: Date | string;
  updated_at: Date | string;
}

function mapRow(row: RawRow): QueuedTaskRecord | null {
  if (!VALID_STATUSES.has(row.status)) return null;
  const record: QueuedTaskRecord = {
    id: row.id,
    workspaceId: row.workspace_id,
    employeeId: row.employee_id,
    employeeName: row.employee_name,
    agentId: row.agent_id ?? row.employee_id,
    runtimeId: row.runtime_id ?? "",
    triggerType: row.trigger_type,
    priority: row.priority,
    status: row.status as QueuedTaskRecord["status"],
    inputJson: row.input_json,
    queuedAt: toIsoString(row.queued_at),
    createdAt: toIsoString(row.created_at),
    updatedAt: toIsoString(row.updated_at),
  };
  if (row.runtime_credential_id !== null) record.runtimeCredentialId = row.runtime_credential_id;
  if (row.router_session_id !== null) record.routerSessionId = row.router_session_id;
  if (row.issue_id !== null) record.issueId = row.issue_id;
  if (row.requested_by_user_id !== null) record.requestedByUserId = row.requested_by_user_id;
  if (row.requested_by_display_name !== null) record.requestedByDisplayName = row.requested_by_display_name;
  if (row.result_json !== null) record.resultJson = row.result_json;
  if (row.error_text !== null) record.errorText = row.error_text;
  if (row.session_id !== null) record.sessionId = row.session_id;
  if (row.work_dir !== null) record.workDir = row.work_dir;
  if (row.binding_generation !== null) record.bindingGeneration = row.binding_generation;
  if (row.claimed_at !== null) record.claimedAt = toIsoString(row.claimed_at);
  if (row.started_at !== null) record.startedAt = toIsoString(row.started_at);
  if (row.finished_at !== null) record.finishedAt = toIsoString(row.finished_at);
  if (row.mcp_session_claimed_at !== null) record.mcpSessionClaimedAt = toIsoString(row.mcp_session_claimed_at);
  return record;
}

function toIsoString(value: Date | string): string {
  return value instanceof Date ? value.toISOString() : value;
}
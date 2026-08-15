// @deprecated — Phase 2 pg 直连原型，保留作 Prisma 接入迁移期 fallback。
// 生产路径走 workflow-triggers-prisma.ts（同等接口）。

import { Client } from "pg";
import { resolvePostgresDatabaseUrl } from "../postgres-config.ts";
import type { WorkflowTriggerRecord } from "../types.ts";

export async function listWorkflowTriggersForWorkflowAsync(
  workflowId: string,
  workspaceId: string,
): Promise<WorkflowTriggerRecord[]> {
  const sql = `SELECT id, workspace_id, workflow_id, type, config_json,
                     timezone, status, next_fire_at, last_fire_at,
                     misfire_policy, dedupe_window_seconds, lease_owner,
                     lease_expires_at, created_at, updated_at
              FROM workflow_trigger
              WHERE workflow_id = $1 AND workspace_id = $2
              ORDER BY created_at ASC, id ASC`;

  const client = new Client({ connectionString: resolvePostgresDatabaseUrl() });
  try {
    await client.connect();
    const result = await client.query<RawRow>(sql, [workflowId, workspaceId]);
    return result.rows.map(mapRow);
  } finally {
    await client.end().catch(() => undefined);
  }
}

export function isWorkflowTriggersAsyncReadEnabled(): boolean {
  return process.env.WORKFLOW_TRIGGERS_ASYNC_READ_ENABLED === "1";
}

export function isWorkflowTriggersShadowReadEnabled(): boolean {
  return process.env.WORKFLOW_TRIGGERS_SHADOW_READ_ENABLED === "1";
}

interface RawRow {
  id: string;
  workspace_id: string;
  workflow_id: string;
  type: string;
  config_json: string;
  timezone: string | null;
  status: string;
  next_fire_at: Date | string | null;
  last_fire_at: Date | string | null;
  misfire_policy: string;
  dedupe_window_seconds: number;
  lease_owner: string | null;
  lease_expires_at: Date | string | null;
  created_at: Date | string;
  updated_at: Date | string;
}

function mapRow(row: RawRow): WorkflowTriggerRecord {
  const record: WorkflowTriggerRecord = {
    id: row.id,
    workspaceId: row.workspace_id,
    workflowId: row.workflow_id,
    type: row.type as WorkflowTriggerRecord["type"],
    configJson: row.config_json,
    status: row.status,
    misfirePolicy: row.misfire_policy as WorkflowTriggerRecord["misfirePolicy"],
    dedupeWindowSeconds: Number(row.dedupe_window_seconds),
    createdAt: toIsoString(row.created_at),
    updatedAt: toIsoString(row.updated_at),
  };
  if (row.timezone !== null) record.timezone = row.timezone;
  if (row.next_fire_at !== null) record.nextFireAt = toIsoString(row.next_fire_at);
  if (row.last_fire_at !== null) record.lastFireAt = toIsoString(row.last_fire_at);
  if (row.lease_owner !== null) record.leaseOwner = row.lease_owner;
  if (row.lease_expires_at !== null) record.leaseExpiresAt = toIsoString(row.lease_expires_at);
  return record;
}

function toIsoString(value: Date | string): string {
  return value instanceof Date ? value.toISOString() : value;
}

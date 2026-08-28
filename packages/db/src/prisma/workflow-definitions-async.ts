// @deprecated — Phase 2 pg 直连原型，保留作 Prisma 接入迁移期 fallback。
// 生产路径走 workflow-definitions-prisma.ts（同等接口）。

import { Client } from "pg";
import { resolvePostgresDatabaseUrl } from "../postgres-config.ts";
import type { WorkflowDefinitionRecord } from "../types.ts";

const VALID_STATUSES = new Set(["draft", "published", "paused", "archived"]);

export async function listWorkflowDefinitionsAsync(
  workspaceId: string,
): Promise<WorkflowDefinitionRecord[]> {
  const sql = `SELECT id, workspace_id, name, description, owner_user_id,
                     channel_name, status, draft_graph_json, draft_version,
                     active_version_id, legacy_source_type, legacy_source_id,
                     created_by, created_at, updated_at, archived_at
              FROM workflow_definition
              WHERE workspace_id = $1
              ORDER BY updated_at DESC, id ASC`;

  const client = new Client({ connectionString: resolvePostgresDatabaseUrl() });
  try {
    await client.connect();
    const result = await client.query<RawRow>(sql, [workspaceId]);
    return result.rows.map(mapRow);
  } finally {
    await client.end().catch(() => undefined);
  }
}

export function isWorkflowDefinitionsAsyncReadEnabled(): boolean {
  return process.env.WORKFLOW_DEFINITIONS_ASYNC_READ_ENABLED === "1";
}

export function isWorkflowDefinitionsShadowReadEnabled(): boolean {
  return process.env.WORKFLOW_DEFINITIONS_SHADOW_READ_ENABLED === "1";
}

interface RawRow {
  id: string;
  workspace_id: string;
  name: string;
  description: string | null;
  owner_user_id: string;
  channel_name: string | null;
  status: string;
  draft_graph_json: string;
  draft_version: number;
  active_version_id: string | null;
  legacy_source_type: string | null;
  legacy_source_id: string | null;
  created_by: string;
  created_at: Date | string;
  updated_at: Date | string;
  archived_at: Date | string | null;
}

function mapRow(row: RawRow): WorkflowDefinitionRecord {
  if (!VALID_STATUSES.has(row.status)) {
    return {
      id: row.id,
      workspaceId: row.workspace_id,
      name: row.name,
      ownerUserId: row.owner_user_id,
      status: "draft",
      draftGraphJson: row.draft_graph_json,
      draftVersion: row.draft_version,
      createdBy: row.created_by,
      createdAt: toIsoString(row.created_at),
      updatedAt: toIsoString(row.updated_at),
    };
  }
  const record: WorkflowDefinitionRecord = {
    id: row.id,
    workspaceId: row.workspace_id,
    name: row.name,
    ownerUserId: row.owner_user_id,
    status: row.status as WorkflowDefinitionRecord["status"],
    draftGraphJson: row.draft_graph_json,
    draftVersion: row.draft_version,
    createdBy: row.created_by,
    createdAt: toIsoString(row.created_at),
    updatedAt: toIsoString(row.updated_at),
  };
  if (row.description !== null) record.description = row.description;
  if (row.channel_name !== null) record.channelName = row.channel_name;
  if (row.active_version_id !== null) record.activeVersionId = row.active_version_id;
  if (row.legacy_source_type !== null) record.legacySourceType = row.legacy_source_type;
  if (row.legacy_source_id !== null) record.legacySourceId = row.legacy_source_id;
  if (row.archived_at !== null) record.archivedAt = toIsoString(row.archived_at);
  return record;
}

function toIsoString(value: Date | string): string {
  return value instanceof Date ? value.toISOString() : value;
}
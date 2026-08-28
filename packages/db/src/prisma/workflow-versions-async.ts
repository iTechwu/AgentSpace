// @deprecated — Phase 2 pg 直连原型，保留作 Prisma 接入迁移期 fallback。
// 生产路径走 workflow-versions-prisma.ts（同等接口）。

import { Client } from "pg";
import { resolvePostgresDatabaseUrl } from "../postgres-config.ts";
import type { WorkflowVersionRecord } from "../types.ts";

export async function listWorkflowVersionsAsync(
  workflowId: string,
  workspaceId: string,
): Promise<WorkflowVersionRecord[]> {
  const sql = `SELECT id, workspace_id, workflow_id, version_number,
                     schema_version, graph_json, input_schema_json,
                     output_schema_json, governance_json, content_hash,
                     published_by, published_at, created_at
              FROM workflow_version
              WHERE workflow_id = $1 AND workspace_id = $2
              ORDER BY version_number DESC`;

  const client = new Client({ connectionString: resolvePostgresDatabaseUrl() });
  try {
    await client.connect();
    const result = await client.query<RawRow>(sql, [workflowId, workspaceId]);
    return result.rows.map(mapRow);
  } finally {
    await client.end().catch(() => undefined);
  }
}

export function isWorkflowVersionsAsyncReadEnabled(): boolean {
  return process.env.WORKFLOW_VERSIONS_ASYNC_READ_ENABLED === "1";
}

export function isWorkflowVersionsShadowReadEnabled(): boolean {
  return process.env.WORKFLOW_VERSIONS_SHADOW_READ_ENABLED === "1";
}

interface RawRow {
  id: string;
  workspace_id: string;
  workflow_id: string;
  version_number: number;
  schema_version: number;
  graph_json: string;
  input_schema_json: string;
  output_schema_json: string;
  governance_json: string;
  content_hash: string;
  published_by: string;
  published_at: Date | string;
  created_at: Date | string;
}

function mapRow(row: RawRow): WorkflowVersionRecord {
  return {
    id: row.id,
    workspaceId: row.workspace_id,
    workflowId: row.workflow_id,
    versionNumber: Number(row.version_number),
    schemaVersion: Number(row.schema_version),
    graphJson: row.graph_json,
    inputSchemaJson: row.input_schema_json,
    outputSchemaJson: row.output_schema_json,
    governanceJson: row.governance_json,
    contentHash: row.content_hash,
    publishedBy: row.published_by,
    publishedAt: toIsoString(row.published_at),
    createdAt: toIsoString(row.created_at),
  };
}

function toIsoString(value: Date | string): string {
  return value instanceof Date ? value.toISOString() : value;
}

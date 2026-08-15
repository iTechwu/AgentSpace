// @deprecated — Phase 2 pg 直连原型，保留作 Prisma 接入迁移期 fallback。
// 生产路径走 document-agent-access-prisma.ts（同等接口，@prisma/client 真接入）。
//
// document-agent-access Phase 2 异步 primary（pg.Client 直连原型）：
// listDocumentAgentAccessAsync 通过 pg.Client 直连 PG 拉 document_agent_access
// 行；切流 flag 由 env var 控制。

import { Client } from "pg";
import { resolvePostgresDatabaseUrl } from "../postgres-config.ts";
import type { DocumentAgentAccessRecord } from "../types.ts";

const VALID_SUBJECT_TYPES = new Set(["agent", "human", "system"]);
const VALID_ROLES = new Set(["viewer", "commenter", "editor", "owner"]);

export async function listDocumentAgentAccessAsync(input: {
  workspaceId?: string;
  documentId?: string;
  subjectId?: string;
  includeRevoked?: boolean;
} = {}): Promise<DocumentAgentAccessRecord[]> {
  const workspaceId = input.workspaceId ?? "default";
  const conditions: string[] = ["workspace_id = $1"];
  const params: unknown[] = [workspaceId];
  if (input.documentId?.trim()) {
    conditions.push(`document_id = $${params.length + 1}`);
    params.push(input.documentId.trim());
  }
  if (input.subjectId?.trim()) {
    conditions.push(`subject_type = 'agent'`);
    conditions.push(`subject_id = $${params.length + 1}`);
    params.push(input.subjectId.trim());
  }
  if (!input.includeRevoked) {
    conditions.push("revoked_at IS NULL");
  }
  const sql = `SELECT id, workspace_id, document_id, subject_type, subject_id,
                     role, scope, granted_by_user_id, created_at, updated_at, revoked_at
              FROM document_agent_access
              WHERE ${conditions.join(" AND ")}
              ORDER BY updated_at DESC, created_at DESC, id ASC`;

  const client = new Client({ connectionString: resolvePostgresDatabaseUrl() });
  try {
    await client.connect();
    const result = await client.query<RawRow>(sql, params);
    return result.rows.map(mapRow).filter((r): r is DocumentAgentAccessRecord => r !== null);
  } finally {
    await client.end().catch(() => undefined);
  }
}

export function isDocumentAgentAccessAsyncReadEnabled(): boolean {
  return process.env.DOCUMENT_AGENT_ACCESS_ASYNC_READ_ENABLED === "1";
}

export function isDocumentAgentAccessShadowReadEnabled(): boolean {
  return process.env.DOCUMENT_AGENT_ACCESS_SHADOW_READ_ENABLED === "1";
}

interface RawRow {
  id: string;
  workspace_id: string;
  document_id: string;
  subject_type: string;
  subject_id: string;
  role: string;
  scope: string;
  granted_by_user_id: string;
  created_at: Date | string;
  updated_at: Date | string;
  revoked_at: Date | string | null;
}

function mapRow(row: RawRow): DocumentAgentAccessRecord | null {
  if (!VALID_SUBJECT_TYPES.has(row.subject_type)) return null;
  if (!VALID_ROLES.has(row.role)) return null;
  const record: DocumentAgentAccessRecord = {
    id: row.id,
    workspaceId: row.workspace_id,
    documentId: row.document_id,
    subjectType: row.subject_type as DocumentAgentAccessRecord["subjectType"],
    subjectId: row.subject_id,
    role: row.role as DocumentAgentAccessRecord["role"],
    scope: "document",
    grantedByUserId: row.granted_by_user_id,
    createdAt: toIsoString(row.created_at),
    updatedAt: toIsoString(row.updated_at),
  };
  if (row.revoked_at !== null) record.revokedAt = toIsoString(row.revoked_at);
  return record;
}

function toIsoString(value: Date | string): string {
  return value instanceof Date ? value.toISOString() : value;
}
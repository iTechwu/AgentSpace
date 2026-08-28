// @deprecated — Phase 2 pg 直连原型，保留作 Prisma 接入迁移期 fallback。
// 生产路径走 document-permission-requests-prisma.ts（同等接口）。
//
// document-permission-request Phase 2 异步 primary（pg.Client 直连原型）：
// listDocumentPermissionRequestsAsync 通过 pg.Client 直连 PG 拉行。

import { Client } from "pg";
import { resolvePostgresDatabaseUrl } from "../postgres-config.ts";
import type {
  DocumentPermissionRequestExternalProvider,
  DocumentPermissionRequestRecord,
  DocumentPermissionRequestStatus,
} from "../types.ts";

const VALID_PROVIDERS = new Set(["notion", "microsoft_365"]);
const VALID_STATUSES = new Set(["pending", "approved", "rejected", "cancelled"]);

export async function listDocumentPermissionRequestsAsync(input: {
  workspaceId?: string;
  status?: DocumentPermissionRequestStatus;
  requestedByAgentName?: string;
  documentId?: string;
} = {}): Promise<DocumentPermissionRequestRecord[]> {
  const workspaceId = input.workspaceId ?? "default";
  const conditions: string[] = ["workspace_id = $1"];
  const params: unknown[] = [workspaceId];
  if (input.status) {
    conditions.push(`status = $${params.length + 1}`);
    params.push(input.status);
  }
  if (input.requestedByAgentName?.trim()) {
    conditions.push(`requested_by_agent_name = $${params.length + 1}`);
    params.push(input.requestedByAgentName.trim());
  }
  if (input.documentId?.trim()) {
    conditions.push(`document_id = $${params.length + 1}`);
    params.push(input.documentId.trim());
  }
  const sql = `SELECT id, workspace_id, document_id, external_provider,
                     external_file_id, external_url, requested_role,
                     requested_by_agent_name, requested_for_channel_name,
                     triggered_by_user_id, reason, status, decided_by_user_id,
                     decision_note, source_task_id, created_at, decided_at
              FROM document_permission_request
              WHERE ${conditions.join(" AND ")}
              ORDER BY created_at DESC, id ASC`;

  const client = new Client({ connectionString: resolvePostgresDatabaseUrl() });
  try {
    await client.connect();
    const result = await client.query<RawRow>(sql, params);
    return result.rows.map(mapRow).filter((r): r is DocumentPermissionRequestRecord => r !== null);
  } finally {
    await client.end().catch(() => undefined);
  }
}

export function isDocumentPermissionRequestsAsyncReadEnabled(): boolean {
  return process.env.DOCUMENT_PERMISSION_REQUESTS_ASYNC_READ_ENABLED === "1";
}

export function isDocumentPermissionRequestsShadowReadEnabled(): boolean {
  return process.env.DOCUMENT_PERMISSION_REQUESTS_SHADOW_READ_ENABLED === "1";
}

interface RawRow {
  id: string;
  workspace_id: string;
  document_id: string | null;
  external_provider: string | null;
  external_file_id: string | null;
  external_url: string | null;
  requested_role: string;
  requested_by_agent_name: string;
  requested_for_channel_name: string | null;
  triggered_by_user_id: string | null;
  reason: string;
  status: string;
  decided_by_user_id: string | null;
  decision_note: string | null;
  source_task_id: string | null;
  created_at: Date | string;
  decided_at: Date | string | null;
}

function mapRow(row: RawRow): DocumentPermissionRequestRecord | null {
  if (row.external_provider !== null && !VALID_PROVIDERS.has(row.external_provider)) return null;
  if (!VALID_STATUSES.has(row.status)) return null;
  const record: DocumentPermissionRequestRecord = {
    id: row.id,
    workspaceId: row.workspace_id,
    requestedRole: row.requested_role as DocumentPermissionRequestRecord["requestedRole"],
    requestedByAgentName: row.requested_by_agent_name,
    reason: row.reason,
    status: row.status as DocumentPermissionRequestStatus,
    createdAt: toIsoString(row.created_at),
  };
  if (row.document_id !== null) record.documentId = row.document_id;
  if (row.external_provider !== null) {
    record.externalProvider = row.external_provider as DocumentPermissionRequestExternalProvider;
  }
  if (row.external_file_id !== null) record.externalFileId = row.external_file_id;
  if (row.external_url !== null) record.externalUrl = row.external_url;
  if (row.requested_for_channel_name !== null) record.requestedForChannelName = row.requested_for_channel_name;
  if (row.triggered_by_user_id !== null) record.triggeredByUserId = row.triggered_by_user_id;
  if (row.decided_by_user_id !== null) record.decidedByUserId = row.decided_by_user_id;
  if (row.decision_note !== null) record.decisionNote = row.decision_note;
  if (row.source_task_id !== null) record.sourceTaskId = row.source_task_id;
  if (row.decided_at !== null) record.decidedAt = toIsoString(row.decided_at);
  return record;
}

function toIsoString(value: Date | string): string {
  return value instanceof Date ? value.toISOString() : value;
}
// @deprecated — Phase 2 pg 直连原型，保留作 Prisma 接入迁移期 fallback。
// 生产路径走 agent-access-requests-prisma.ts（同等接口）。

import { Client } from "pg";
import { resolvePostgresDatabaseUrl } from "../postgres-config.ts";
import type {
  AgentAccessRequestRecord,
  AgentAccessRequestStatus,
  AgentAccessRequestType,
} from "../types.ts";

const VALID_TYPES = new Set(["fork_copy", "channel_use"]);
const VALID_STATUSES = new Set(["pending", "approved", "rejected", "cancelled"]);

export async function listAgentAccessRequestsAsync(
  workspaceId: string,
  options: {
    sourceAgentName?: string;
    requesterUserId?: string;
    requestType?: AgentAccessRequestType;
    statuses?: AgentAccessRequestStatus[];
  } = {},
): Promise<AgentAccessRequestRecord[]> {
  const conditions: string[] = ["workspace_id = $1"];
  const params: unknown[] = [workspaceId];
  if (options.sourceAgentName?.trim()) {
    conditions.push(`source_agent_name = $${params.length + 1}`);
    params.push(options.sourceAgentName.trim());
  }
  if (options.requesterUserId?.trim()) {
    conditions.push(`requester_user_id = $${params.length + 1}`);
    params.push(options.requesterUserId.trim());
  }
  if (options.requestType) {
    conditions.push(`request_type = $${params.length + 1}`);
    params.push(options.requestType);
  }
  if (options.statuses?.length) {
    const placeholders = options.statuses.map((_, i) => `$${params.length + 1 + i}`).join(", ");
    conditions.push(`status IN (${placeholders})`);
    params.push(...options.statuses);
  }
  const sql = `SELECT id, workspace_id, source_agent_name, requester_user_id,
                     request_type, target_channel_name, status, reason,
                     resolver_user_id, resolved_at, created_at, updated_at,
                     fork_invitation_id, audit_data_json
              FROM agent_access_request
              WHERE ${conditions.join(" AND ")}
              ORDER BY created_at DESC, id DESC`;

  const client = new Client({ connectionString: resolvePostgresDatabaseUrl() });
  try {
    await client.connect();
    const result = await client.query<RawRow>(sql, params);
    return result.rows.map(mapRow).filter((r): r is AgentAccessRequestRecord => r !== null);
  } finally {
    await client.end().catch(() => undefined);
  }
}

export function isAgentAccessRequestsAsyncReadEnabled(): boolean {
  return process.env.AGENT_ACCESS_REQUESTS_ASYNC_READ_ENABLED === "1";
}

export function isAgentAccessRequestsShadowReadEnabled(): boolean {
  return process.env.AGENT_ACCESS_REQUESTS_SHADOW_READ_ENABLED === "1";
}

interface RawRow {
  id: string;
  workspace_id: string;
  source_agent_name: string;
  requester_user_id: string;
  request_type: string;
  target_channel_name: string | null;
  status: string;
  reason: string;
  resolver_user_id: string | null;
  resolved_at: Date | string | null;
  created_at: Date | string;
  updated_at: Date | string;
  fork_invitation_id: string | null;
  audit_data_json: unknown;
}

function mapRow(row: RawRow): AgentAccessRequestRecord | null {
  if (!VALID_TYPES.has(row.request_type)) return null;
  if (!VALID_STATUSES.has(row.status)) return null;
  const record: AgentAccessRequestRecord = {
    id: row.id,
    workspaceId: row.workspace_id,
    sourceAgentName: row.source_agent_name,
    requesterUserId: row.requester_user_id,
    requestType: row.request_type as AgentAccessRequestType,
    status: row.status as AgentAccessRequestStatus,
    reason: row.reason,
    auditDataJson: serializeJson(row.audit_data_json),
    createdAt: toIsoString(row.created_at),
    updatedAt: toIsoString(row.updated_at),
  };
  if (row.target_channel_name !== null) record.targetChannelName = row.target_channel_name;
  if (row.resolver_user_id !== null) record.resolverUserId = row.resolver_user_id;
  if (row.resolved_at !== null) record.resolvedAt = toIsoString(row.resolved_at);
  if (row.fork_invitation_id !== null) record.forkInvitationId = row.fork_invitation_id;
  return record;
}

function toIsoString(value: Date | string): string {
  return value instanceof Date ? value.toISOString() : value;
}

function serializeJson(value: unknown): string {
  if (value === null || value === undefined) return "{}";
  if (typeof value === "string") {
    try {
      return JSON.stringify(JSON.parse(value));
    } catch {
      return value;
    }
  }
  try {
    return JSON.stringify(value);
  } catch {
    return "{}";
  }
}
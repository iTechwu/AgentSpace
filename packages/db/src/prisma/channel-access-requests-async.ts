// @deprecated — Phase 2 pg 直连原型，保留作 Prisma 接入迁移期 fallback。
// 生产路径走 channel-access-requests-prisma.ts（同等接口）。

import { Client } from "pg";
import { resolvePostgresDatabaseUrl } from "../postgres-config.ts";
import type {
  ChannelAccessRequestStatus,
  StoredChannelAccessRequestRecord,
} from "../types.ts";

const VALID_STATUSES = new Set(["pending", "approved", "rejected", "cancelled"]);

export async function listChannelAccessRequestsAsync(
  workspaceId: string,
  options?: { channelName?: string; userId?: string; statuses?: ChannelAccessRequestStatus[] },
): Promise<StoredChannelAccessRequestRecord[]> {
  const conditions: string[] = ["workspace_id = $1"];
  const params: unknown[] = [workspaceId];
  if (options?.channelName) {
    conditions.push(`channel_name = $${params.length + 1}`);
    params.push(options.channelName);
  }
  if (options?.userId) {
    conditions.push(`user_id = $${params.length + 1}`);
    params.push(options.userId);
  }
  const statuses = options?.statuses?.length ? options.statuses : ["pending" as ChannelAccessRequestStatus];
  const placeholders = statuses.map((_, i) => `$${params.length + 1 + i}`).join(", ");
  conditions.push(`status IN (${placeholders})`);
  params.push(...statuses);
  const sql = `SELECT id, workspace_id, channel_name, user_id, status,
                     requested_at, resolved_at, resolved_by, note
              FROM channel_access_request
              WHERE ${conditions.join(" AND ")}
              ORDER BY requested_at DESC, id DESC`;

  const client = new Client({ connectionString: resolvePostgresDatabaseUrl() });
  try {
    await client.connect();
    const result = await client.query<RawRow>(sql, params);
    return result.rows.map(mapRow);
  } finally {
    await client.end().catch(() => undefined);
  }
}

export function isChannelAccessRequestsAsyncReadEnabled(): boolean {
  return process.env.CHANNEL_ACCESS_REQUESTS_ASYNC_READ_ENABLED === "1";
}

export function isChannelAccessRequestsShadowReadEnabled(): boolean {
  return process.env.CHANNEL_ACCESS_REQUESTS_SHADOW_READ_ENABLED === "1";
}

interface RawRow {
  id: string;
  workspace_id: string;
  channel_name: string;
  user_id: string;
  status: string;
  requested_at: Date | string;
  resolved_at: Date | string | null;
  resolved_by: string | null;
  note: string | null;
}

function mapRow(row: RawRow): StoredChannelAccessRequestRecord {
  const record: StoredChannelAccessRequestRecord = {
    id: row.id,
    workspaceId: row.workspace_id,
    channelName: row.channel_name,
    userId: row.user_id,
    status: VALID_STATUSES.has(row.status)
      ? (row.status as ChannelAccessRequestStatus)
      : "pending",
    requestedAt: toIsoString(row.requested_at),
  };
  if (row.resolved_at !== null) record.resolvedAt = toIsoString(row.resolved_at);
  if (row.resolved_by !== null) record.resolvedBy = row.resolved_by;
  if (row.note !== null) record.note = row.note;
  return record;
}

function toIsoString(value: Date | string): string {
  return value instanceof Date ? value.toISOString() : value;
}
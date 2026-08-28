// @deprecated — Phase 2 pg 直连原型，保留作 Prisma 接入迁移期 fallback。
// 生产路径走 channel-participants-prisma.ts（同等接口）。

import { Client } from "pg";
import { resolvePostgresDatabaseUrl } from "../postgres-config.ts";
import type { ChannelParticipantStatus, StoredChannelParticipantRecord } from "../types.ts";

const VALID_STATUSES = new Set(["active", "invited", "removed"]);

export async function listChannelParticipantsAsync(
  workspaceId: string,
  channelName: string,
  options?: { userId?: string; statuses?: ChannelParticipantStatus[] },
): Promise<StoredChannelParticipantRecord[]> {
  const conditions: string[] = ["workspace_id = $1", "channel_name = $2"];
  const params: unknown[] = [workspaceId, channelName];
  const statuses = options?.statuses?.length ? options.statuses : ["active" as ChannelParticipantStatus];
  const placeholders = statuses.map((_, i) => `$${params.length + 1 + i}`).join(", ");
  conditions.push(`status IN (${placeholders})`);
  params.push(...statuses);
  if (options?.userId) {
    conditions.push(`user_id = $${params.length + 1}`);
    params.push(options.userId);
  }
  const sql = `SELECT id, workspace_id, channel_name, user_id, status,
                     added_by, joined_at, removed_at, updated_at
              FROM channel_participant
              WHERE ${conditions.join(" AND ")}
              ORDER BY joined_at ASC, user_id ASC`;

  const client = new Client({ connectionString: resolvePostgresDatabaseUrl() });
  try {
    await client.connect();
    const result = await client.query<RawRow>(sql, params);
    return result.rows.map(mapRow);
  } finally {
    await client.end().catch(() => undefined);
  }
}

export function isChannelParticipantsAsyncReadEnabled(): boolean {
  return process.env.CHANNEL_PARTICIPANTS_ASYNC_READ_ENABLED === "1";
}

export function isChannelParticipantsShadowReadEnabled(): boolean {
  return process.env.CHANNEL_PARTICIPANTS_SHADOW_READ_ENABLED === "1";
}

interface RawRow {
  id: string;
  workspace_id: string;
  channel_name: string;
  user_id: string;
  status: string;
  added_by: string | null;
  joined_at: Date | string;
  removed_at: Date | string | null;
  updated_at: Date | string;
}

function mapRow(row: RawRow): StoredChannelParticipantRecord {
  const record: StoredChannelParticipantRecord = {
    id: row.id,
    workspaceId: row.workspace_id,
    channelName: row.channel_name,
    userId: row.user_id,
    status: VALID_STATUSES.has(row.status)
      ? (row.status as StoredChannelParticipantRecord["status"])
      : "active",
    joinedAt: toIsoString(row.joined_at),
    updatedAt: toIsoString(row.updated_at),
  };
  if (row.added_by !== null) record.addedBy = row.added_by;
  if (row.removed_at !== null) record.removedAt = toIsoString(row.removed_at);
  return record;
}

function toIsoString(value: Date | string): string {
  return value instanceof Date ? value.toISOString() : value;
}
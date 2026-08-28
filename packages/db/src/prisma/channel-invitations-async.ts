// @deprecated — Phase 2 pg 直连原型，保留作 Prisma 接入迁移期 fallback。
// 生产路径走 channel-invitations-prisma.ts（同等接口）。

import { Client } from "pg";
import { resolvePostgresDatabaseUrl } from "../postgres-config.ts";
import type {
  ChannelInvitationStatus,
  StoredChannelInvitationRecord,
} from "../types.ts";

const VALID_STATUSES = new Set(["pending", "accepted", "rejected", "revoked", "expired"]);

export async function listChannelInvitationsAsync(
  workspaceId: string,
  options?: {
    channelName?: string;
    inviteeUserId?: string;
    inviteeEmail?: string;
    statuses?: ChannelInvitationStatus[];
  },
): Promise<StoredChannelInvitationRecord[]> {
  const conditions: string[] = ["workspace_id = $1"];
  const params: unknown[] = [workspaceId];
  if (options?.channelName) {
    conditions.push(`channel_name = $${params.length + 1}`);
    params.push(options.channelName);
  }
  if (options?.inviteeUserId) {
    conditions.push(`invitee_user_id = $${params.length + 1}`);
    params.push(options.inviteeUserId);
  }
  if (options?.inviteeEmail) {
    conditions.push(`invitee_email = $${params.length + 1}`);
    params.push(options.inviteeEmail);
  }
  const statuses = options?.statuses?.length
    ? options.statuses
    : ["pending" as ChannelInvitationStatus];
  const placeholders = statuses.map((_, i) => `$${params.length + 1 + i}`).join(", ");
  conditions.push(`status IN (${placeholders})`);
  params.push(...statuses);
  const sql = `SELECT id, workspace_id, channel_name, invitee_user_id,
                     invitee_email, invited_by, status, created_at,
                     expires_at, responded_at, responded_by
              FROM channel_invitation
              WHERE ${conditions.join(" AND ")}
              ORDER BY created_at DESC, id DESC`;

  const client = new Client({ connectionString: resolvePostgresDatabaseUrl() });
  try {
    await client.connect();
    const result = await client.query<RawRow>(sql, params);
    return result.rows.map(mapRow);
  } finally {
    await client.end().catch(() => undefined);
  }
}

export function isChannelInvitationsAsyncReadEnabled(): boolean {
  return process.env.CHANNEL_INVITATIONS_ASYNC_READ_ENABLED === "1";
}

export function isChannelInvitationsShadowReadEnabled(): boolean {
  return process.env.CHANNEL_INVITATIONS_SHADOW_READ_ENABLED === "1";
}

interface RawRow {
  id: string;
  workspace_id: string;
  channel_name: string;
  invitee_user_id: string | null;
  invitee_email: string | null;
  invited_by: string;
  status: string;
  created_at: Date | string;
  expires_at: Date | string | null;
  responded_at: Date | string | null;
  responded_by: string | null;
}

function mapRow(row: RawRow): StoredChannelInvitationRecord {
  const record: StoredChannelInvitationRecord = {
    id: row.id,
    workspaceId: row.workspace_id,
    channelName: row.channel_name,
    invitedBy: row.invited_by,
    status: VALID_STATUSES.has(row.status)
      ? (row.status as ChannelInvitationStatus)
      : "pending",
    createdAt: toIsoString(row.created_at),
  };
  if (row.invitee_user_id !== null) record.inviteeUserId = row.invitee_user_id;
  if (row.invitee_email !== null) record.inviteeEmail = row.invitee_email;
  if (row.expires_at !== null) record.expiresAt = toIsoString(row.expires_at);
  if (row.responded_at !== null) record.respondedAt = toIsoString(row.responded_at);
  if (row.responded_by !== null) record.respondedBy = row.responded_by;
  return record;
}

function toIsoString(value: Date | string): string {
  return value instanceof Date ? value.toISOString() : value;
}
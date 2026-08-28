// @deprecated — Phase 2 pg 直连原型，保留作 Prisma 接入迁移期 fallback。
// 生产路径走 workspace-memberships-prisma.ts（同等接口，@prisma/client 真接入）。
//
// workspace-memberships Phase 2 异步 primary（pg.Client 直连原型）：
// - listWorkspaceMembershipsAsync 通过 pg.Client 直连 PG 拉
//   workspace_membership 行，作为 cutover runner 的 async primary。
// - 与 sync listWorkspaceMembershipsSync 等价：filter by workspace_id +
//   status='active'、按 joined_at ASC 排序。
// - 切流 flag 由 env var 控制：WORKSPACE_MEMBERSHIPS_ASYNC_READ_ENABLED=1 /
//   WORKSPACE_MEMBERSHIPS_SHADOW_READ_ENABLED=1。

import { Client } from "pg";
import { resolvePostgresDatabaseUrl } from "../postgres-config.ts";
import type { StoredWorkspaceMembershipRecord } from "../types.ts";

const VALID_ROLES = new Set(["owner", "admin", "member", "guest"]);
const VALID_STATUSES = new Set(["active", "invited", "removed"]);

export async function listWorkspaceMembershipsAsync(
  workspaceId: string,
): Promise<StoredWorkspaceMembershipRecord[]> {
  const sql = `SELECT id, workspace_id, user_id, role, status, joined_at, invited_by
               FROM workspace_membership
               WHERE workspace_id = $1 AND status = 'active'
               ORDER BY joined_at ASC`;

  const client = new Client({ connectionString: resolvePostgresDatabaseUrl() });
  try {
    await client.connect();
    const result = await client.query<RawRow>(sql, [workspaceId]);
    return result.rows.map(mapRow).filter((record): record is StoredWorkspaceMembershipRecord => record !== null);
  } finally {
    await client.end().catch(() => undefined);
  }
}

export function isWorkspaceMembershipsAsyncReadEnabled(): boolean {
  return process.env.WORKSPACE_MEMBERSHIPS_ASYNC_READ_ENABLED === "1";
}

export function isWorkspaceMembershipsShadowReadEnabled(): boolean {
  return process.env.WORKSPACE_MEMBERSHIPS_SHADOW_READ_ENABLED === "1";
}

interface RawRow {
  id: string;
  workspace_id: string;
  user_id: string;
  role: string;
  status: string;
  joined_at: Date | string;
  invited_by: string | null;
}

function mapRow(row: RawRow): StoredWorkspaceMembershipRecord | null {
  if (!VALID_ROLES.has(row.role)) return null;
  if (!VALID_STATUSES.has(row.status)) return null;
  const record: StoredWorkspaceMembershipRecord = {
    id: row.id,
    workspaceId: row.workspace_id,
    userId: row.user_id,
    role: row.role as StoredWorkspaceMembershipRecord["role"],
    status: row.status as StoredWorkspaceMembershipRecord["status"],
    joinedAt: row.joined_at instanceof Date ? row.joined_at.toISOString() : row.joined_at,
  };
  if (row.invited_by !== null) record.invitedBy = row.invited_by;
  return record;
}
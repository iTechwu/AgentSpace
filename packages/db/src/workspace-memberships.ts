import { getDatabase, withTransaction } from "./database.ts";
import { randomLikeId } from "./database.ts";
import { getPrismaClient } from "./prisma/client.ts";
import { toIsoString, toOptionalString } from "./prisma/runtime-mappers.ts";
import { isPlatformAdminUserSync } from "./user-auth.ts";
import type { StoredWorkspaceMembershipRecord, WorkspaceRole } from "./types.ts";

export function createWorkspaceMembershipSync(params: {
  workspaceId: string;
  userId: string;
  role?: WorkspaceRole;
  invitedBy?: string;
}): StoredWorkspaceMembershipRecord {
  const db = getDatabase();
  const now = new Date().toISOString();
  const id = randomLikeId();
  const role = params.role ?? "member";

  db.prepare(
    `INSERT INTO workspace_membership (id, workspace_id, user_id, role, status, joined_at, invited_by)
     VALUES (?, ?, ?, ?, 'active', ?, ?)`,
  ).run(id, params.workspaceId, params.userId, role, now, params.invitedBy ?? null);

  return { id, workspaceId: params.workspaceId, userId: params.userId, role, status: "active", joinedAt: now, invitedBy: params.invitedBy };
}

export function upsertWorkspaceMembershipSync(params: {
  workspaceId: string;
  userId: string;
  role?: WorkspaceRole;
  invitedBy?: string;
}): StoredWorkspaceMembershipRecord {
  const db = getDatabase();
  const now = new Date().toISOString();
  const id = randomLikeId();
  const role = params.role ?? "member";

  db.prepare(
    `INSERT INTO workspace_membership (id, workspace_id, user_id, role, status, joined_at, invited_by)
     VALUES (?, ?, ?, ?, 'active', ?, ?)
     ON CONFLICT(workspace_id, user_id) DO UPDATE SET
       role = excluded.role,
       status = 'active',
       joined_at = excluded.joined_at,
       invited_by = excluded.invited_by`,
  ).run(id, params.workspaceId, params.userId, role, now, params.invitedBy ?? null);

  return readWorkspaceMembershipSync(params.workspaceId, params.userId)!;
}

export function readWorkspaceMembershipSync(
  workspaceId: string,
  userId: string,
): StoredWorkspaceMembershipRecord | null {
  const db = getDatabase();
  const row = (db.prepare(
    `SELECT id, workspace_id, user_id, role, status, joined_at, invited_by
     FROM workspace_membership
     WHERE workspace_id = ? AND user_id = ? AND status = 'active'`,
  ).get(workspaceId, userId) as {
    id: string; workspace_id: string; user_id: string;
    role: string; status: string; joined_at: string; invited_by: string | null;
  } | undefined) ?? null;

  if (!row) return null;
  return {
    id: row.id,
    workspaceId: row.workspace_id,
    userId: row.user_id,
    role: row.role as WorkspaceRole,
    status: row.status as "active" | "invited" | "removed",
    joinedAt: row.joined_at,
    invitedBy: row.invited_by ?? undefined,
  };
}

export function listWorkspaceMembershipsSync(workspaceId: string): StoredWorkspaceMembershipRecord[] {
  const db = getDatabase();
  const rows = db.prepare(
    `SELECT id, workspace_id, user_id, role, status, joined_at, invited_by
     FROM workspace_membership
     WHERE workspace_id = ? AND status = 'active'
     ORDER BY joined_at ASC`,
  ).all(workspaceId) as Array<{
    id: string; workspace_id: string; user_id: string;
    role: string; status: string; joined_at: string; invited_by: string | null;
  }>;

  return rows.map((row) => ({
    id: row.id,
    workspaceId: row.workspace_id,
    userId: row.user_id,
    role: row.role as WorkspaceRole,
    status: row.status as "active" | "invited" | "removed",
    joinedAt: row.joined_at,
    invitedBy: row.invited_by ?? undefined,
  }));
}

export function listUserWorkspacesSync(userId: string): StoredWorkspaceMembershipRecord[] {
  const db = getDatabase();
  const rows = db.prepare(
    `SELECT id, workspace_id, user_id, role, status, joined_at, invited_by
     FROM workspace_membership
     WHERE user_id = ? AND status = 'active'
     ORDER BY joined_at ASC`,
  ).all(userId) as Array<{
    id: string; workspace_id: string; user_id: string;
    role: string; status: string; joined_at: string; invited_by: string | null;
  }>;

  return rows.map((row) => ({
    id: row.id,
    workspaceId: row.workspace_id,
    userId: row.user_id,
    role: row.role as WorkspaceRole,
    status: row.status as "active" | "invited" | "removed",
    joinedAt: row.joined_at,
    invitedBy: row.invited_by ?? undefined,
  }));
}

export function updateWorkspaceMembershipRoleSync(
  workspaceId: string,
  userId: string,
  role: WorkspaceRole,
): void {
  const db = getDatabase();
  db.prepare(
    `UPDATE workspace_membership SET role = ? WHERE workspace_id = ? AND user_id = ? AND status = 'active'`,
  ).run(role, workspaceId, userId);
}

export function removeWorkspaceMembershipSync(workspaceId: string, userId: string): void {
  const db = getDatabase();
  db.prepare(
    `UPDATE workspace_membership SET status = 'removed' WHERE workspace_id = ? AND user_id = ?`,
  ).run(workspaceId, userId);
}

export function transferWorkspaceOwnershipSync(
  workspaceId: string,
  currentOwnerUserId: string,
  nextOwnerUserId: string,
): void {
  if (isPlatformAdminUserSync(nextOwnerUserId)) {
    throw new Error("workspace.members.transfer_target_is_platform_admin");
  }
  const db = getDatabase();
  withTransaction(db, () => {
    const demote = db.prepare(
      `UPDATE workspace_membership
       SET role = 'admin'
       WHERE workspace_id = ? AND user_id = ? AND status = 'active' AND role = 'owner'`,
    ).run(workspaceId, currentOwnerUserId);
    if (demote.changes === 0) {
      throw new Error("workspace.members.transfer_source_missing");
    }

    const promote = db.prepare(
      `UPDATE workspace_membership
       SET role = 'owner'
       WHERE workspace_id = ? AND user_id = ? AND status = 'active'`,
    ).run(workspaceId, nextOwnerUserId);
    if (promote.changes === 0) {
      throw new Error("workspace.members.transfer_target_missing");
    }
  });
}

// ---------------------------------------------------------------------------
// Phase 2 async Prisma repository (Route B).
//
// Coexists with the *Sync functions above and returns the SAME
// `StoredWorkspaceMembershipRecord` DTO. FIDELITY READS use `$queryRawUnsafe`
// with a `joined_at::text` cast — @prisma/adapter-pg relabels timestamptz
// offsets without shifting wall-clock digits (wrong under a non-UTC PG session),
// so `joined_at` is selected as text and fed through `toIsoString`, which
// mirrors the legacy sync worker's `new Date(rawText).toISOString()`. Void
// writes (updateRole / remove / transferOwnership) use typed Prisma
// `updateMany` (and `$transaction` for ownership transfer) since they carry no
// fidelity columns. See prisma/runtime-mappers.ts for the full rationale.
// ---------------------------------------------------------------------------

type PrismaWorkspaceMembershipRow = {
  id: string;
  workspace_id: string;
  user_id: string;
  role: string;
  status: string;
  joined_at: string;
  invited_by: string | null;
};

/** Shared column list with the fidelity cast on the timestamp column. */
const WORKSPACE_MEMBERSHIP_SELECT_COLUMNS =
  "id, workspace_id, user_id, role, status, joined_at::text AS joined_at, invited_by";

function mapWorkspaceMembershipFromPrisma(
  row: PrismaWorkspaceMembershipRow,
): StoredWorkspaceMembershipRecord {
  return {
    id: row.id,
    workspaceId: row.workspace_id,
    userId: row.user_id,
    role: row.role as WorkspaceRole,
    status: row.status as "active" | "invited" | "removed",
    joinedAt: toIsoString(row.joined_at) ?? "",
    invitedBy: toOptionalString(row.invited_by),
  };
}

export async function readWorkspaceMembershipAsync(
  workspaceId: string,
  userId: string,
): Promise<StoredWorkspaceMembershipRecord | null> {
  const sql =
    `SELECT ${WORKSPACE_MEMBERSHIP_SELECT_COLUMNS} FROM workspace_membership ` +
    `WHERE workspace_id = $1 AND user_id = $2 AND status = 'active'`;
  const rows =
    await getPrismaClient().$queryRawUnsafe<PrismaWorkspaceMembershipRow[]>(sql, workspaceId, userId);
  return rows.length > 0 ? mapWorkspaceMembershipFromPrisma(rows[0]!) : null;
}

export async function listWorkspaceMembershipsAsync(
  workspaceId: string,
): Promise<StoredWorkspaceMembershipRecord[]> {
  const sql =
    `SELECT ${WORKSPACE_MEMBERSHIP_SELECT_COLUMNS} FROM workspace_membership ` +
    `WHERE workspace_id = $1 AND status = 'active' ORDER BY joined_at ASC`;
  const rows =
    await getPrismaClient().$queryRawUnsafe<PrismaWorkspaceMembershipRow[]>(sql, workspaceId);
  return rows.map(mapWorkspaceMembershipFromPrisma);
}

export async function listUserWorkspacesAsync(
  userId: string,
): Promise<StoredWorkspaceMembershipRecord[]> {
  const sql =
    `SELECT ${WORKSPACE_MEMBERSHIP_SELECT_COLUMNS} FROM workspace_membership ` +
    `WHERE user_id = $1 AND status = 'active' ORDER BY joined_at ASC`;
  const rows =
    await getPrismaClient().$queryRawUnsafe<PrismaWorkspaceMembershipRow[]>(sql, userId);
  return rows.map(mapWorkspaceMembershipFromPrisma);
}

export async function createWorkspaceMembershipAsync(params: {
  workspaceId: string;
  userId: string;
  role?: WorkspaceRole;
  invitedBy?: string;
}): Promise<StoredWorkspaceMembershipRecord> {
  const now = new Date().toISOString();
  const id = randomLikeId();
  const role = params.role ?? "member";
  // Raw INSERT: joined_at is timestamptz. Typed Prisma `new Date()` shifts under a
  // non-UTC session (see user-auth fix); ISO string mirrors the sync INSERT.
  await getPrismaClient().$executeRawUnsafe(
    `INSERT INTO workspace_membership (id, workspace_id, user_id, role, status, joined_at, invited_by)
     VALUES ($1, $2, $3, $4, 'active', $5, $6)`,
    id,
    params.workspaceId,
    params.userId,
    role,
    now,
    params.invitedBy ?? null,
  );
  const record = await readWorkspaceMembershipAsync(params.workspaceId, params.userId);
  if (!record) {
    throw new Error(
      `createWorkspaceMembershipAsync: row ${params.workspaceId}/${params.userId} missing immediately after create`,
    );
  }
  return record;
}

export async function upsertWorkspaceMembershipAsync(params: {
  workspaceId: string;
  userId: string;
  role?: WorkspaceRole;
  invitedBy?: string;
}): Promise<StoredWorkspaceMembershipRecord> {
  const now = new Date().toISOString();
  const id = randomLikeId();
  const role = params.role ?? "member";
  // Raw INSERT ... ON CONFLICT: joined_at is timestamptz — write ISO string.
  await getPrismaClient().$executeRawUnsafe(
    `INSERT INTO workspace_membership (id, workspace_id, user_id, role, status, joined_at, invited_by)
     VALUES ($1, $2, $3, $4, 'active', $5, $6)
     ON CONFLICT(workspace_id, user_id) DO UPDATE SET
       role = excluded.role,
       status = 'active',
       joined_at = excluded.joined_at,
       invited_by = excluded.invited_by`,
    id,
    params.workspaceId,
    params.userId,
    role,
    now,
    params.invitedBy ?? null,
  );
  const record = await readWorkspaceMembershipAsync(params.workspaceId, params.userId);
  if (!record) {
    throw new Error(
      `upsertWorkspaceMembershipAsync: row ${params.workspaceId}/${params.userId} missing immediately after upsert`,
    );
  }
  return record;
}

export async function updateWorkspaceMembershipRoleAsync(
  workspaceId: string,
  userId: string,
  role: WorkspaceRole,
): Promise<void> {
  await getPrismaClient().workspaceMembership.updateMany({
    where: { workspaceId, userId, status: "active" },
    data: { role },
  });
}

export async function removeWorkspaceMembershipAsync(
  workspaceId: string,
  userId: string,
): Promise<void> {
  await getPrismaClient().workspaceMembership.updateMany({
    where: { workspaceId, userId },
    data: { status: "removed" },
  });
}

export async function transferWorkspaceOwnershipAsync(
  workspaceId: string,
  currentOwnerUserId: string,
  nextOwnerUserId: string,
): Promise<void> {
  if (isPlatformAdminUserSync(nextOwnerUserId)) {
    throw new Error("workspace.members.transfer_target_is_platform_admin");
  }
  await getPrismaClient().$transaction(async (tx) => {
    const demote = await tx.workspaceMembership.updateMany({
      where: { workspaceId, userId: currentOwnerUserId, status: "active", role: "owner" },
      data: { role: "admin" },
    });
    if (demote.count === 0) {
      throw new Error("workspace.members.transfer_source_missing");
    }
    const promote = await tx.workspaceMembership.updateMany({
      where: { workspaceId, userId: nextOwnerUserId, status: "active" },
      data: { role: "owner" },
    });
    if (promote.count === 0) {
      throw new Error("workspace.members.transfer_target_missing");
    }
  });
}

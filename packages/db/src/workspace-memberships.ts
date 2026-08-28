import { getDatabase, withTransaction } from "./database.ts";
import { randomLikeId } from "./database.ts";
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

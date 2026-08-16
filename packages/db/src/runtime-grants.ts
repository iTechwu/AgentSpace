import { DEFAULT_WORKSPACE_ID, getDatabase, randomLikeId } from "./database.ts";
import type { WorkspaceRuntimeGrantRecord } from "./types.ts";

export function grantRuntimeUseToUserSync(input: {
  workspaceId?: string;
  runtimeId: string;
  userId: string;
  grantedByUserId: string;
}): WorkspaceRuntimeGrantRecord {
  const db = getDatabase();
  const workspaceId = input.workspaceId ?? DEFAULT_WORKSPACE_ID;
  const runtimeId = input.runtimeId.trim();
  const userId = input.userId.trim();
  const grantedByUserId = input.grantedByUserId.trim();
  const now = new Date().toISOString();

  if (!runtimeId) {
    throw new Error("runtimeId is required.");
  }
  if (!userId) {
    throw new Error("userId is required.");
  }
  if (!grantedByUserId) {
    throw new Error("grantedByUserId is required.");
  }
  ensureRuntimeExists(workspaceId, runtimeId);
  ensureUserExists(userId);
  ensureUserExists(grantedByUserId);

  db.prepare(
    `INSERT INTO workspace_runtime_grant (
      id,
      workspace_id,
      runtime_id,
      user_id,
      permission,
      status,
      granted_by_user_id,
      created_at,
      updated_at,
      revoked_at
    ) VALUES (?, ?, ?, ?, 'use', 'active', ?, ?, ?, NULL)
    ON CONFLICT(workspace_id, runtime_id, user_id, permission) DO UPDATE SET
      status = 'active',
      granted_by_user_id = excluded.granted_by_user_id,
      updated_at = excluded.updated_at,
      revoked_at = NULL`,
  ).run(`runtime-grant-${randomLikeId()}`, workspaceId, runtimeId, userId, grantedByUserId, now, now);

  const grant = readRuntimeGrantSync(workspaceId, runtimeId, userId);
  if (!grant) {
    throw new Error("Runtime grant could not be read after write.");
  }
  return grant;
}

export function revokeRuntimeUseFromUserSync(input: {
  workspaceId?: string;
  runtimeId: string;
  userId: string;
}): WorkspaceRuntimeGrantRecord | null {
  const db = getDatabase();
  const workspaceId = input.workspaceId ?? DEFAULT_WORKSPACE_ID;
  const runtimeId = input.runtimeId.trim();
  const userId = input.userId.trim();
  const now = new Date().toISOString();

  db.prepare(
    `UPDATE workspace_runtime_grant
     SET status = 'revoked',
         revoked_at = COALESCE(revoked_at, ?),
         updated_at = ?
     WHERE workspace_id = ? AND runtime_id = ? AND user_id = ? AND permission = 'use'`,
  ).run(now, now, workspaceId, runtimeId, userId);

  return readRuntimeGrantSync(workspaceId, runtimeId, userId);
}

export function listRuntimeGrantsSync(workspaceId = DEFAULT_WORKSPACE_ID): WorkspaceRuntimeGrantRecord[] {
  const db = getDatabase();
  const rows = db.prepare(
    `SELECT
      id,
      workspace_id AS "workspaceId",
      runtime_id AS "runtimeId",
      user_id AS "userId",
      permission,
      status,
      granted_by_user_id AS "grantedByUserId",
      created_at AS "createdAt",
      updated_at AS "updatedAt",
      revoked_at AS "revokedAt"
     FROM workspace_runtime_grant
     WHERE workspace_id = ?
     ORDER BY created_at ASC, id ASC`,
  ).all(workspaceId) as Array<Record<string, unknown>>;

  return rows
    .map(mapRuntimeGrantRecord)
    .filter((grant): grant is WorkspaceRuntimeGrantRecord => grant !== null);
}

export function listRuntimeGrantsForUserSync(
  workspaceId: string,
  userId: string,
): WorkspaceRuntimeGrantRecord[] {
  return listRuntimeGrantsSync(workspaceId).filter((grant) => grant.userId === userId.trim());
}

export function canUserUseRuntimeSync(
  workspaceId: string,
  runtimeId: string,
  userId: string,
): boolean {
  const db = getDatabase();
  const row = db.prepare(
    `SELECT 1
     FROM workspace_runtime_grant
     WHERE workspace_id = ?
       AND runtime_id = ?
       AND user_id = ?
       AND permission = 'use'
       AND status = 'active'
     LIMIT 1`,
  ).get(workspaceId, runtimeId.trim(), userId.trim()) as Record<string, unknown> | undefined;

  return Boolean(row);
}

function readRuntimeGrantSync(
  workspaceId: string,
  runtimeId: string,
  userId: string,
): WorkspaceRuntimeGrantRecord | null {
  const db = getDatabase();
  const row = db.prepare(
    `SELECT
      id,
      workspace_id AS "workspaceId",
      runtime_id AS "runtimeId",
      user_id AS "userId",
      permission,
      status,
      granted_by_user_id AS "grantedByUserId",
      created_at AS "createdAt",
      updated_at AS "updatedAt",
      revoked_at AS "revokedAt"
     FROM workspace_runtime_grant
     WHERE workspace_id = ? AND runtime_id = ? AND user_id = ? AND permission = 'use'`,
  ).get(workspaceId, runtimeId, userId) as Record<string, unknown> | undefined;

  return row ? mapRuntimeGrantRecord(row) : null;
}

function ensureRuntimeExists(workspaceId: string, runtimeId: string): void {
  const db = getDatabase();
  const row = db.prepare(
    `SELECT 1
     FROM agent_runtime
     WHERE workspace_id = ? AND id = ?
     LIMIT 1`,
  ).get(workspaceId, runtimeId) as Record<string, unknown> | undefined;
  if (!row) {
    throw new Error(`Runtime "${runtimeId}" does not exist.`);
  }
}

function ensureUserExists(userId: string): void {
  const db = getDatabase();
  const row = db.prepare("SELECT 1 FROM users WHERE id = ? LIMIT 1").get(userId) as Record<string, unknown> | undefined;
  if (!row) {
    throw new Error(`User "${userId}" does not exist.`);
  }
}

function mapRuntimeGrantRecord(value: Record<string, unknown>): WorkspaceRuntimeGrantRecord | null {
  if (
    typeof value.id !== "string" ||
    typeof value.workspaceId !== "string" ||
    typeof value.runtimeId !== "string" ||
    typeof value.userId !== "string" ||
    value.permission !== "use" ||
    (value.status !== "active" && value.status !== "revoked") ||
    typeof value.grantedByUserId !== "string" ||
    typeof value.createdAt !== "string" ||
    typeof value.updatedAt !== "string"
  ) {
    return null;
  }

  return {
    id: value.id,
    workspaceId: value.workspaceId,
    runtimeId: value.runtimeId,
    userId: value.userId,
    permission: value.permission,
    status: value.status,
    grantedByUserId: value.grantedByUserId,
    createdAt: value.createdAt,
    updatedAt: value.updatedAt,
    revokedAt: typeof value.revokedAt === "string" ? value.revokedAt : undefined,
  };
}

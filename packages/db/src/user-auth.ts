import { getDatabase, randomLikeId } from "./database.ts";
import type { AuthProvider, StoredAuthIdentityRecord, StoredSessionRecord, StoredUserRecord, WorkspaceRole } from "./types.ts";

export interface WorkspaceMemberUserRecord {
  userId: string;
  displayName: string;
  primaryEmail?: string;
  role: WorkspaceRole;
}

export function countUsersSync(): number {
  const db = getDatabase();
  const row = db.prepare("SELECT COUNT(*) AS count FROM users").get() as { count: number };
  return row.count;
}

export function createUserSync(input: {
  displayName: string;
  primaryEmail?: string;
  avatarUrl?: string;
  isAdmin?: boolean;
}): StoredUserRecord {
  const db = getDatabase();
  const now = new Date().toISOString();
  const id = `user-${randomLikeId()}`;
  db.prepare(
    `INSERT INTO users (id, display_name, avatar_url, primary_email, is_admin, created_at, updated_at, last_login_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, NULL)`,
  ).run(
    id,
    input.displayName.trim(),
    input.avatarUrl ?? null,
    normalizeEmail(input.primaryEmail) ?? null,
    input.isAdmin === true ? 1 : 0,
    now,
    now,
  );

  return readUserSync(id)!;
}

export function readUserSync(userId: string): StoredUserRecord | null {
  const db = getDatabase();
  const row = db.prepare(
    `SELECT
      id,
      display_name AS displayName,
      avatar_url AS avatarUrl,
      primary_email AS primaryEmail,
      is_admin AS "isAdmin",
      created_at AS createdAt,
      updated_at AS updatedAt,
      last_login_at AS lastLoginAt
     FROM users
     WHERE id = ?`,
  ).get(userId) as Record<string, unknown> | undefined;

  return row ? mapStoredUserRecord(row) : null;
}

export function readUserByEmailSync(email: string): StoredUserRecord | null {
  const db = getDatabase();
  const normalizedEmail = normalizeEmail(email);
  if (!normalizedEmail) {
    return null;
  }

  const row = db.prepare(
    `SELECT
      id,
      display_name AS displayName,
      avatar_url AS avatarUrl,
      primary_email AS primaryEmail,
      is_admin AS "isAdmin",
      created_at AS createdAt,
      updated_at AS updatedAt,
      last_login_at AS lastLoginAt
     FROM users
     WHERE primary_email = ?`,
  ).get(normalizedEmail) as Record<string, unknown> | undefined;

  return row ? mapStoredUserRecord(row) : null;
}

export function createAuthIdentitySync(input: {
  userId: string;
  provider: AuthProvider;
  providerSubject: string;
  email?: string;
  emailVerified?: boolean;
  profileJson?: string;
}): StoredAuthIdentityRecord {
  const db = getDatabase();
  const now = new Date().toISOString();
  const id = `identity-${randomLikeId()}`;
  const normalizedProviderSubject = input.providerSubject.trim();
  if (!normalizedProviderSubject) {
    throw new Error("Provider subject is required.");
  }
  const normalizedEmail = normalizeEmail(input.email);

  db.prepare(
    `INSERT INTO auth_identity (
      id,
      user_id,
      provider,
      provider_subject,
      email,
      email_verified,
      profile_json,
      created_at,
      updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    id,
    input.userId,
    input.provider,
    normalizedProviderSubject,
    normalizedEmail ?? null,
    input.emailVerified === true ? 1 : 0,
    input.profileJson ?? "{}",
    now,
    now,
  );

  return readAuthIdentitySync(id)!;
}

export function readAuthIdentityByProviderSubjectSync(
  provider: AuthProvider,
  providerSubject: string,
): StoredAuthIdentityRecord | null {
  const db = getDatabase();
  const normalizedProviderSubject = providerSubject.trim();
  if (!normalizedProviderSubject) {
    return null;
  }

  const row = db.prepare(
    `SELECT
      id,
      user_id AS userId,
      provider,
      provider_subject AS providerSubject,
      email,
      email_verified AS emailVerified,
      profile_json AS profileJson,
      created_at AS createdAt,
      updated_at AS updatedAt
     FROM auth_identity
     WHERE provider = ? AND provider_subject = ?`,
  ).get(provider, normalizedProviderSubject) as Record<string, unknown> | undefined;

  return row ? mapStoredAuthIdentityRecord(row) : null;
}

export function readAuthIdentityForUserSync(
  userId: string,
  provider: AuthProvider,
): StoredAuthIdentityRecord | null {
  const normalizedUserId = userId.trim();
  if (!normalizedUserId) {
    return null;
  }

  const db = getDatabase();
  const row = db.prepare(
    `SELECT
      id,
      user_id AS userId,
      provider,
      provider_subject AS providerSubject,
      email,
      email_verified AS emailVerified,
      profile_json AS profileJson,
      created_at AS createdAt,
      updated_at AS updatedAt
     FROM auth_identity
     WHERE user_id = ? AND provider = ?
     ORDER BY created_at ASC
     LIMIT 1`,
  ).get(normalizedUserId, provider) as Record<string, unknown> | undefined;

  return row ? mapStoredAuthIdentityRecord(row) : null;
}

export function updateUserSync(input: {
  userId: string;
  displayName?: string;
  primaryEmail?: string;
  avatarUrl?: string;
  isAdmin?: boolean;
}): StoredUserRecord | null {
  const db = getDatabase();
  const now = new Date().toISOString();
  const sets: string[] = ["updated_at = ?"];
  const values: Array<string | number | null> = [now];

  if (input.displayName !== undefined) {
    sets.push("display_name = ?");
    values.push(input.displayName.trim());
  }
  if (input.primaryEmail !== undefined) {
    sets.push("primary_email = ?");
    values.push(normalizeEmail(input.primaryEmail) ?? null);
  }
  if (input.avatarUrl !== undefined) {
    sets.push("avatar_url = ?");
    values.push(input.avatarUrl.trim() || null);
  }
  if (input.isAdmin !== undefined) {
    sets.push("is_admin = ?");
    values.push(input.isAdmin === true ? 1 : 0);
  }

  values.push(input.userId);
  db.prepare(
    `UPDATE users
     SET ${sets.join(", ")}
     WHERE id = ?`,
  ).run(...values);

  return readUserSync(input.userId);
}

export function createSessionSync(input: {
  userId: string;
  tokenHash: string;
  expiresAt: string;
  ipAddress?: string;
  userAgent?: string;
}): StoredSessionRecord {
  const db = getDatabase();
  const now = new Date().toISOString();
  const id = `session-${randomLikeId()}`;
  db.prepare(
    `INSERT INTO session (
      id,
      user_id,
      token_hash,
      expires_at,
      last_seen_at,
      created_at,
      ip_address,
      user_agent,
      revoked_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL)`,
  ).run(id, input.userId, input.tokenHash, input.expiresAt, now, now, input.ipAddress ?? null, input.userAgent ?? null);
  db.prepare(
    `UPDATE users
     SET last_login_at = ?, updated_at = ?
     WHERE id = ?`,
  ).run(now, now, input.userId);

  return readSessionByTokenHashSync(input.tokenHash)!;
}

export function readSessionByTokenHashSync(tokenHash: string): StoredSessionRecord | null {
  const db = getDatabase();
  const row = db.prepare(
    `SELECT
      id,
      user_id AS userId,
      token_hash AS tokenHash,
      expires_at AS expiresAt,
      last_seen_at AS lastSeenAt,
      created_at AS createdAt,
      ip_address AS ipAddress,
      user_agent AS userAgent,
      revoked_at AS revokedAt
     FROM session
     WHERE token_hash = ?`,
  ).get(tokenHash) as Record<string, unknown> | undefined;

  return row ? mapStoredSessionRecord(row) : null;
}

export function touchSessionLastSeenSync(tokenHash: string): void {
  const db = getDatabase();
  db.prepare(
    `UPDATE session
     SET last_seen_at = ?
     WHERE token_hash = ?`,
  ).run(new Date().toISOString(), tokenHash);
}

export function deleteSessionByTokenHashSync(tokenHash: string): boolean {
  const db = getDatabase();
  const result = db.prepare("DELETE FROM session WHERE token_hash = ?").run(tokenHash);
  return result.changes > 0;
}

export function listSessionsForUserSync(userId: string): StoredSessionRecord[] {
  const db = getDatabase();
  const rows = db.prepare(
    `SELECT
      id,
      user_id AS userId,
      token_hash AS tokenHash,
      expires_at AS expiresAt,
      last_seen_at AS lastSeenAt,
      created_at AS createdAt,
      ip_address AS ipAddress,
      user_agent AS userAgent,
      revoked_at AS revokedAt
     FROM session
     WHERE user_id = ?
     ORDER BY created_at DESC, id DESC`,
  ).all(userId) as Array<Record<string, unknown>>;

  return rows
    .map((row) => mapStoredSessionRecord(row))
    .filter((row): row is StoredSessionRecord => row !== null);
}

export function countActiveSessionsForUserSync(userId: string): number {
  const db = getDatabase();
  const row = db.prepare(
    `SELECT COUNT(*) AS count
     FROM session
     WHERE user_id = ? AND revoked_at IS NULL`,
  ).get(userId) as { count?: number } | undefined;

  return typeof row?.count === "number" ? row.count : 0;
}

export function revokeSessionByIdSync(sessionId: string, userId?: string): boolean {
  const db = getDatabase();
  const now = new Date().toISOString();
  const result = userId
    ? db.prepare(
      `UPDATE session
       SET revoked_at = COALESCE(revoked_at, ?)
       WHERE id = ? AND user_id = ?`,
    ).run(now, sessionId, userId)
    : db.prepare(
      `UPDATE session
       SET revoked_at = COALESCE(revoked_at, ?)
       WHERE id = ?`,
    ).run(now, sessionId);

  return result.changes > 0;
}

export function revokeOtherSessionsForUserSync(userId: string, currentSessionId: string): number {
  const db = getDatabase();
  const now = new Date().toISOString();
  const result = db.prepare(
    `UPDATE session
     SET revoked_at = COALESCE(revoked_at, ?)
     WHERE user_id = ? AND id <> ?`,
  ).run(now, userId, currentSessionId);

  return Number(result.changes);
}

export function listWorkspaceMemberUsersSync(workspaceId: string): WorkspaceMemberUserRecord[] {
  const db = getDatabase();
  const rows = db.prepare(
    `SELECT
      u.id AS userId,
      u.display_name AS displayName,
      u.primary_email AS primaryEmail,
      wm.role
     FROM workspace_membership wm
     JOIN users u ON u.id = wm.user_id
     WHERE wm.workspace_id = ? AND wm.status = 'active' AND u.is_admin = 0
     ORDER BY wm.joined_at ASC`,
  ).all(workspaceId) as Array<Record<string, unknown>>;

  return rows
    .map((row) => mapWorkspaceMemberUserRecord(row))
    .filter((row): row is WorkspaceMemberUserRecord => row !== null);
}

export function countWorkspaceMembersSync(workspaceId: string): number {
  const db = getDatabase();
  const row = db.prepare(
    `SELECT COUNT(*) AS count
     FROM workspace_membership wm
     JOIN users u ON u.id = wm.user_id
     WHERE wm.workspace_id = ? AND wm.status = 'active' AND u.is_admin = 0`,
  ).get(workspaceId) as { count?: number } | undefined;

  return typeof row?.count === "number" ? row.count : 0;
}

export function isPlatformAdminUserSync(userId: string): boolean {
  const user = readUserSync(userId);
  return user?.isAdmin === true;
}

function readAuthIdentitySync(identityId: string): StoredAuthIdentityRecord | null {
  const db = getDatabase();
  const row = db.prepare(
    `SELECT
      id,
      user_id AS userId,
      provider,
      provider_subject AS providerSubject,
      email,
      email_verified AS emailVerified,
      profile_json AS profileJson,
      created_at AS createdAt,
      updated_at AS updatedAt
     FROM auth_identity
     WHERE id = ?`,
  ).get(identityId) as Record<string, unknown> | undefined;

  return row ? mapStoredAuthIdentityRecord(row) : null;
}

function mapStoredUserRecord(value: Record<string, unknown>): StoredUserRecord | null {
  if (
    typeof value.id !== "string" ||
    typeof value.displayName !== "string" ||
    typeof value.createdAt !== "string" ||
    typeof value.updatedAt !== "string"
  ) {
    return null;
  }

  return {
    id: value.id,
    displayName: value.displayName,
    avatarUrl: typeof value.avatarUrl === "string" ? value.avatarUrl : undefined,
    primaryEmail: typeof value.primaryEmail === "string" ? value.primaryEmail : undefined,
    isAdmin:
      value.isAdmin === true ||
      value.isAdmin === 1 ||
      value.isadmin === true ||
      value.isadmin === 1 ||
      value.is_admin === true ||
      value.is_admin === 1,
    createdAt: value.createdAt,
    updatedAt: value.updatedAt,
    lastLoginAt: typeof value.lastLoginAt === "string" ? value.lastLoginAt : undefined,
  };
}

function mapStoredAuthIdentityRecord(value: Record<string, unknown>): StoredAuthIdentityRecord | null {
  if (
    typeof value.id !== "string" ||
    typeof value.userId !== "string" ||
    value.provider !== "sso" ||
    typeof value.providerSubject !== "string" ||
    typeof value.emailVerified !== "number" ||
    typeof value.profileJson !== "string" ||
    typeof value.createdAt !== "string" ||
    typeof value.updatedAt !== "string"
  ) {
    return null;
  }

  return {
    id: value.id,
    userId: value.userId,
    provider: value.provider,
    providerSubject: value.providerSubject,
    email: typeof value.email === "string" ? value.email : undefined,
    emailVerified: value.emailVerified === 1,
    profileJson: value.profileJson,
    createdAt: value.createdAt,
    updatedAt: value.updatedAt,
  };
}

function mapStoredSessionRecord(value: Record<string, unknown>): StoredSessionRecord | null {
  if (
    typeof value.id !== "string" ||
    typeof value.userId !== "string" ||
    typeof value.tokenHash !== "string" ||
    typeof value.expiresAt !== "string" ||
    typeof value.lastSeenAt !== "string" ||
    typeof value.createdAt !== "string"
  ) {
    return null;
  }

  return {
    id: value.id,
    userId: value.userId,
    tokenHash: value.tokenHash,
    expiresAt: value.expiresAt,
    lastSeenAt: value.lastSeenAt,
    createdAt: value.createdAt,
    ipAddress: typeof value.ipAddress === "string" ? value.ipAddress : undefined,
    userAgent: typeof value.userAgent === "string" ? value.userAgent : undefined,
    revokedAt: typeof value.revokedAt === "string" ? value.revokedAt : undefined,
  };
}

function mapWorkspaceMemberUserRecord(value: Record<string, unknown>): WorkspaceMemberUserRecord | null {
  if (
    typeof value.userId !== "string" ||
    typeof value.displayName !== "string" ||
    (value.role !== "owner" && value.role !== "admin" && value.role !== "member")
  ) {
    return null;
  }

  return {
    userId: value.userId,
    displayName: value.displayName,
    primaryEmail: typeof value.primaryEmail === "string" ? value.primaryEmail : undefined,
    role: value.role,
  };
}

function normalizeEmail(email: string | undefined): string | undefined {
  const normalized = email?.trim().toLowerCase();
  return normalized ? normalized : undefined;
}

import { getDatabase, randomLikeId } from "./database.ts";
import { getPrismaClient } from "./prisma/client.ts";
import { toIsoString, toJsonString, toOptionalString } from "./prisma/runtime-mappers.ts";
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

// ---------------------------------------------------------------------------
// Phase 2 async Prisma repository (Route B).
//
// Coexists with the *Sync functions above and returns the SAME `*Record` DTOs
// (StoredUserRecord / StoredAuthIdentityRecord / StoredSessionRecord /
// WorkspaceMemberUserRecord). FIDELITY READS use `$queryRawUnsafe` with `::text`
// casts on every timestamptz and jsonb column — @prisma/adapter-pg relabels
// timestamptz offsets without shifting wall-clock digits (wrong under a non-UTC
// session) and parses jsonb into a compact object; selecting `::text` and routing
// through `toIsoString` / `toJsonString` reproduces the sync worker's output
// byte-for-byte. The auth_identity create uses raw SQL for the profile_json
// jsonb write (avoids Prisma InputJsonValue friction and guarantees fidelity);
// user/session creates/updates use typed Prisma (no jsonb columns). COALESCE
// revoke updates use raw SQL (non-destructive semantics). See
// prisma/runtime-mappers.ts for the full rationale. Identifiers are a hardcoded
// whitelist; only values are parameterized (`$1..$N`).
// ---------------------------------------------------------------------------

type PrismaUserRow = {
  id: string;
  display_name: string;
  avatar_url: string | null;
  primary_email: string | null;
  is_admin: number;
  created_at: string;
  updated_at: string;
  last_login_at: string | null;
};

type PrismaAuthIdentityRow = {
  id: string;
  user_id: string;
  provider: string;
  provider_subject: string;
  email: string | null;
  email_verified: number;
  profile_json: string;
  created_at: string;
  updated_at: string;
};

type PrismaSessionRow = {
  id: string;
  user_id: string;
  token_hash: string;
  expires_at: string;
  last_seen_at: string;
  created_at: string;
  ip_address: string | null;
  user_agent: string | null;
  revoked_at: string | null;
};

const USERS_SELECT_COLUMNS =
  "id, display_name, avatar_url, primary_email, is_admin, " +
  "created_at::text AS created_at, updated_at::text AS updated_at, last_login_at::text AS last_login_at";

const AUTH_IDENTITY_SELECT_COLUMNS =
  "id, user_id, provider, provider_subject, email, email_verified, " +
  "profile_json::text AS profile_json, created_at::text AS created_at, updated_at::text AS updated_at";

const SESSION_SELECT_COLUMNS =
  "id, user_id, token_hash, expires_at::text AS expires_at, last_seen_at::text AS last_seen_at, " +
  "created_at::text AS created_at, ip_address, user_agent, revoked_at::text AS revoked_at";

function mapUserFromPrisma(row: PrismaUserRow): StoredUserRecord {
  return {
    id: row.id,
    displayName: row.display_name,
    avatarUrl: toOptionalString(row.avatar_url),
    primaryEmail: toOptionalString(row.primary_email),
    isAdmin: row.is_admin === 1,
    createdAt: toIsoString(row.created_at) ?? "",
    updatedAt: toIsoString(row.updated_at) ?? "",
    lastLoginAt: toIsoString(row.last_login_at) ?? undefined,
  };
}

function mapAuthIdentityFromPrisma(row: PrismaAuthIdentityRow): StoredAuthIdentityRecord {
  return {
    id: row.id,
    userId: row.user_id,
    provider: row.provider as AuthProvider,
    providerSubject: row.provider_subject,
    email: toOptionalString(row.email),
    emailVerified: row.email_verified === 1,
    profileJson: toJsonString(row.profile_json),
    createdAt: toIsoString(row.created_at) ?? "",
    updatedAt: toIsoString(row.updated_at) ?? "",
  };
}

function mapSessionFromPrisma(row: PrismaSessionRow): StoredSessionRecord {
  return {
    id: row.id,
    userId: row.user_id,
    tokenHash: row.token_hash,
    expiresAt: toIsoString(row.expires_at) ?? "",
    lastSeenAt: toIsoString(row.last_seen_at) ?? "",
    createdAt: toIsoString(row.created_at) ?? "",
    ipAddress: toOptionalString(row.ip_address),
    userAgent: toOptionalString(row.user_agent),
    revokedAt: toIsoString(row.revoked_at) ?? undefined,
  };
}

// --- users -----------------------------------------------------------------

export async function countUsersAsync(): Promise<number> {
  const rows = await getPrismaClient().$queryRawUnsafe<Array<{ count: bigint }>>(
    "SELECT COUNT(*) AS count FROM users",
  );
  return Number(rows[0]?.count ?? 0);
}

export async function readUserAsync(userId: string): Promise<StoredUserRecord | null> {
  const rows = await getPrismaClient().$queryRawUnsafe<PrismaUserRow[]>(
    `SELECT ${USERS_SELECT_COLUMNS} FROM users WHERE id = $1`,
    userId,
  );
  return rows.length > 0 ? mapUserFromPrisma(rows[0]!) : null;
}

export async function readUserByEmailAsync(email: string): Promise<StoredUserRecord | null> {
  const normalizedEmail = normalizeEmail(email);
  if (!normalizedEmail) return null;
  const rows = await getPrismaClient().$queryRawUnsafe<PrismaUserRow[]>(
    `SELECT ${USERS_SELECT_COLUMNS} FROM users WHERE primary_email = $1`,
    normalizedEmail,
  );
  return rows.length > 0 ? mapUserFromPrisma(rows[0]!) : null;
}

export async function createUserAsync(input: {
  displayName: string;
  primaryEmail?: string;
  avatarUrl?: string;
  isAdmin?: boolean;
}): Promise<StoredUserRecord> {
  const id = `user-${randomLikeId()}`;
  const now = new Date().toISOString();
  // Raw INSERT: timestamptz columns (created_at/updated_at) must be written as
  // ISO strings, not typed Prisma Dates — @prisma/adapter-pg serializes a Date
  // to an offset-less ISO that PG parses in the session timezone (+08), shifting
  // the stored instant by the tz offset. Mirrors the sync INSERT exactly.
  await getPrismaClient().$executeRawUnsafe(
    `INSERT INTO users (id, display_name, avatar_url, primary_email, is_admin, created_at, updated_at, last_login_at)
     VALUES ($1, $2, $3, $4, $5, $6, $6, NULL)`,
    id,
    input.displayName.trim(),
    input.avatarUrl ?? null,
    normalizeEmail(input.primaryEmail) ?? null,
    input.isAdmin === true ? 1 : 0,
    now,
  );
  const record = await readUserAsync(id);
  if (!record) {
    throw new Error(`createUserAsync: user ${id} missing immediately after create`);
  }
  return record;
}

export async function updateUserAsync(input: {
  userId: string;
  displayName?: string;
  primaryEmail?: string;
  avatarUrl?: string;
  isAdmin?: boolean;
}): Promise<StoredUserRecord | null> {
  // Raw UPDATE: build the SET clause dynamically (like sync) and write timestamptz
  // updated_at as an ISO string — typed Prisma Dates shift under a non-UTC session
  // (see createUserAsync). A missing user affects 0 rows → readUserAsync returns
  // null, mirroring the sync UPDATE + readUserSync path.
  const now = new Date().toISOString();
  const sets: string[] = ["updated_at = $1"];
  const values: Array<string | number | null> = [now];
  let idx = 2;
  if (input.displayName !== undefined) {
    sets.push(`display_name = $${idx++}`);
    values.push(input.displayName.trim());
  }
  if (input.primaryEmail !== undefined) {
    sets.push(`primary_email = $${idx++}`);
    values.push(normalizeEmail(input.primaryEmail) ?? null);
  }
  if (input.avatarUrl !== undefined) {
    sets.push(`avatar_url = $${idx++}`);
    values.push(input.avatarUrl.trim() || null);
  }
  if (input.isAdmin !== undefined) {
    sets.push(`is_admin = $${idx++}`);
    values.push(input.isAdmin === true ? 1 : 0);
  }
  values.push(input.userId);
  await getPrismaClient().$executeRawUnsafe(
    `UPDATE users SET ${sets.join(", ")} WHERE id = $${idx}`,
    ...values,
  );
  return readUserAsync(input.userId);
}

export async function isPlatformAdminUserAsync(userId: string): Promise<boolean> {
  const user = await readUserAsync(userId);
  return user?.isAdmin === true;
}

// --- auth_identity ---------------------------------------------------------

async function readAuthIdentityAsync(identityId: string): Promise<StoredAuthIdentityRecord | null> {
  const rows = await getPrismaClient().$queryRawUnsafe<PrismaAuthIdentityRow[]>(
    `SELECT ${AUTH_IDENTITY_SELECT_COLUMNS} FROM auth_identity WHERE id = $1`,
    identityId,
  );
  return rows.length > 0 ? mapAuthIdentityFromPrisma(rows[0]!) : null;
}

export async function readAuthIdentityByProviderSubjectAsync(
  provider: AuthProvider,
  providerSubject: string,
): Promise<StoredAuthIdentityRecord | null> {
  const normalizedProviderSubject = providerSubject.trim();
  if (!normalizedProviderSubject) return null;
  const rows = await getPrismaClient().$queryRawUnsafe<PrismaAuthIdentityRow[]>(
    `SELECT ${AUTH_IDENTITY_SELECT_COLUMNS} FROM auth_identity WHERE provider = $1 AND provider_subject = $2`,
    provider,
    normalizedProviderSubject,
  );
  return rows.length > 0 ? mapAuthIdentityFromPrisma(rows[0]!) : null;
}

export async function readAuthIdentityForUserAsync(
  userId: string,
  provider: AuthProvider,
): Promise<StoredAuthIdentityRecord | null> {
  const normalizedUserId = userId.trim();
  if (!normalizedUserId) return null;
  const rows = await getPrismaClient().$queryRawUnsafe<PrismaAuthIdentityRow[]>(
    `SELECT ${AUTH_IDENTITY_SELECT_COLUMNS} FROM auth_identity WHERE user_id = $1 AND provider = $2 ORDER BY created_at ASC LIMIT 1`,
    normalizedUserId,
    provider,
  );
  return rows.length > 0 ? mapAuthIdentityFromPrisma(rows[0]!) : null;
}

export async function createAuthIdentityAsync(input: {
  userId: string;
  provider: AuthProvider;
  providerSubject: string;
  email?: string;
  emailVerified?: boolean;
  profileJson?: string;
}): Promise<StoredAuthIdentityRecord> {
  const normalizedProviderSubject = input.providerSubject.trim();
  if (!normalizedProviderSubject) {
    throw new Error("Provider subject is required.");
  }
  const id = `identity-${randomLikeId()}`;
  const now = new Date().toISOString();
  const normalizedEmail = normalizeEmail(input.email);
  const profileJson = input.profileJson ?? "{}";
  // Raw INSERT for the profile_json jsonb write (fidelity + avoids InputJsonValue).
  await getPrismaClient().$executeRawUnsafe(
    `INSERT INTO auth_identity (id, user_id, provider, provider_subject, email, email_verified, profile_json, created_at, updated_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
    id,
    input.userId,
    input.provider,
    normalizedProviderSubject,
    normalizedEmail ?? null,
    input.emailVerified === true ? 1 : 0,
    profileJson,
    now,
    now,
  );
  const record = await readAuthIdentityAsync(id);
  if (!record) {
    throw new Error(`createAuthIdentityAsync: identity ${id} missing immediately after create`);
  }
  return record;
}

// --- session ---------------------------------------------------------------

export async function readSessionByTokenHashAsync(tokenHash: string): Promise<StoredSessionRecord | null> {
  const rows = await getPrismaClient().$queryRawUnsafe<PrismaSessionRow[]>(
    `SELECT ${SESSION_SELECT_COLUMNS} FROM session WHERE token_hash = $1`,
    tokenHash,
  );
  return rows.length > 0 ? mapSessionFromPrisma(rows[0]!) : null;
}

export async function listSessionsForUserAsync(userId: string): Promise<StoredSessionRecord[]> {
  const rows = await getPrismaClient().$queryRawUnsafe<PrismaSessionRow[]>(
    `SELECT ${SESSION_SELECT_COLUMNS} FROM session WHERE user_id = $1 ORDER BY created_at DESC, id DESC`,
    userId,
  );
  return rows.map(mapSessionFromPrisma);
}

export async function countActiveSessionsForUserAsync(userId: string): Promise<number> {
  const rows = await getPrismaClient().$queryRawUnsafe<Array<{ count: bigint }>>(
    `SELECT COUNT(*) AS count FROM session WHERE user_id = $1 AND revoked_at IS NULL`,
    userId,
  );
  return Number(rows[0]?.count ?? 0);
}

export async function createSessionAsync(input: {
  userId: string;
  tokenHash: string;
  expiresAt: string;
  ipAddress?: string;
  userAgent?: string;
}): Promise<StoredSessionRecord> {
  const id = `session-${randomLikeId()}`;
  const now = new Date().toISOString();
  const prisma = getPrismaClient();
  // Raw INSERT: every timestamptz column (expires_at / last_seen_at / created_at)
  // is written as an ISO string — typed Prisma Dates shift the stored instant
  // under a non-UTC session (see createUserAsync). Mirrors the sync INSERT.
  await prisma.$executeRawUnsafe(
    `INSERT INTO session (id, user_id, token_hash, expires_at, last_seen_at, created_at, ip_address, user_agent, revoked_at)
     VALUES ($1, $2, $3, $4, $5, $5, $6, $7, NULL)`,
    id,
    input.userId,
    input.tokenHash,
    input.expiresAt,
    now,
    input.ipAddress ?? null,
    input.userAgent ?? null,
  );
  // Mirror the sync layer: stamp the user's last_login_at on session creation.
  await prisma.$executeRawUnsafe(
    `UPDATE users SET last_login_at = $1, updated_at = $1 WHERE id = $2`,
    now,
    input.userId,
  );
  const record = await readSessionByTokenHashAsync(input.tokenHash);
  if (!record) {
    throw new Error(`createSessionAsync: session ${id} missing immediately after create`);
  }
  return record;
}

export async function touchSessionLastSeenAsync(tokenHash: string): Promise<void> {
  // Raw UPDATE: last_seen_at is timestamptz — write ISO string, not typed Date.
  await getPrismaClient().$executeRawUnsafe(
    `UPDATE session SET last_seen_at = $1 WHERE token_hash = $2`,
    new Date().toISOString(),
    tokenHash,
  );
}

export async function deleteSessionByTokenHashAsync(tokenHash: string): Promise<boolean> {
  const result = await getPrismaClient().session.deleteMany({ where: { tokenHash } });
  return result.count > 0;
}

export async function revokeSessionByIdAsync(sessionId: string, userId?: string): Promise<boolean> {
  const now = new Date().toISOString();
  // COALESCE keeps the first revoke timestamp (idempotent), matching the sync layer.
  const sql = userId
    ? `UPDATE session SET revoked_at = COALESCE(revoked_at, $1) WHERE id = $2 AND user_id = $3`
    : `UPDATE session SET revoked_at = COALESCE(revoked_at, $1) WHERE id = $2`;
  const params = userId ? [now, sessionId, userId] : [now, sessionId];
  const affected = await getPrismaClient().$executeRawUnsafe(sql, ...params);
  return affected > 0;
}

export async function revokeOtherSessionsForUserAsync(userId: string, currentSessionId: string): Promise<number> {
  const now = new Date().toISOString();
  const affected = await getPrismaClient().$executeRawUnsafe(
    `UPDATE session SET revoked_at = COALESCE(revoked_at, $1) WHERE user_id = $2 AND id <> $3`,
    now,
    userId,
    currentSessionId,
  );
  return Number(affected);
}

// --- workspace_membership cross-reads (non-admin active members) -----------

export async function listWorkspaceMemberUsersAsync(workspaceId: string): Promise<WorkspaceMemberUserRecord[]> {
  const rows = await getPrismaClient().$queryRawUnsafe<Array<{ userId: string; displayName: string; primaryEmail: string | null; role: string }>>(
    `SELECT u.id AS "userId", u.display_name AS "displayName", u.primary_email AS "primaryEmail", wm.role AS "role"
     FROM workspace_membership wm
     JOIN users u ON u.id = wm.user_id
     WHERE wm.workspace_id = $1 AND wm.status = 'active' AND u.is_admin = 0
     ORDER BY wm.joined_at ASC`,
    workspaceId,
  );
  return rows
    .filter((row): row is { userId: string; displayName: string; primaryEmail: string | null; role: "owner" | "admin" | "member" } =>
      row.role === "owner" || row.role === "admin" || row.role === "member")
    .map((row) => ({
      userId: row.userId,
      displayName: row.displayName,
      primaryEmail: toOptionalString(row.primaryEmail),
      role: row.role,
    }));
}

export async function countWorkspaceMembersAsync(workspaceId: string): Promise<number> {
  const rows = await getPrismaClient().$queryRawUnsafe<Array<{ count: bigint }>>(
    `SELECT COUNT(*) AS count
     FROM workspace_membership wm
     JOIN users u ON u.id = wm.user_id
     WHERE wm.workspace_id = $1 AND wm.status = 'active' AND u.is_admin = 0`,
    workspaceId,
  );
  return Number(rows[0]?.count ?? 0);
}

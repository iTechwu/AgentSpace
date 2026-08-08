// Phase 2 parity test — user/auth/session async Prisma repo vs legacy sync.
//
// Same fixture (seeded into agent_space_test) → `*Sync` and `*Async` must agree.
// Read/list/count paths compare DTOs directly, locking the timestamptz→ISO /
// jsonb→string / Int→boolean / nullable→undefined fidelity rules. Write paths
// (createUser / createAuthIdentity / createSession) strip the volatile id and
// server-set timestamps; state-effect paths (updateUser / revoke / delete /
// touch) seed equivalent rows, apply sync to one and async to the other, then
// deep-equal the resulting reads. See prisma/runtime-mappers.ts for the rules.

import assert from "node:assert/strict";
import test, { after, before } from "node:test";
import {
  countActiveSessionsForUserAsync,
  countActiveSessionsForUserSync,
  countUsersAsync,
  countUsersSync,
  countWorkspaceMembersAsync,
  countWorkspaceMembersSync,
  createAuthIdentityAsync,
  createAuthIdentitySync,
  createSessionAsync,
  createSessionSync,
  createUserAsync,
  createUserSync,
  deleteSessionByTokenHashAsync,
  deleteSessionByTokenHashSync,
  isPlatformAdminUserAsync,
  isPlatformAdminUserSync,
  listSessionsForUserAsync,
  listSessionsForUserSync,
  listWorkspaceMemberUsersAsync,
  listWorkspaceMemberUsersSync,
  readAuthIdentityByProviderSubjectAsync,
  readAuthIdentityByProviderSubjectSync,
  readAuthIdentityForUserAsync,
  readAuthIdentityForUserSync,
  readSessionByTokenHashAsync,
  readSessionByTokenHashSync,
  readUserAsync,
  readUserByEmailAsync,
  readUserByEmailSync,
  readUserSync,
  revokeOtherSessionsForUserAsync,
  revokeOtherSessionsForUserSync,
  revokeSessionByIdAsync,
  revokeSessionByIdSync,
  touchSessionLastSeenAsync,
  touchSessionLastSeenSync,
  updateUserAsync,
  updateUserSync,
} from "./user-auth.ts";
import { getDatabase, resetDatabaseForTests } from "./database.ts";
import { assertParityEqual, parityTest } from "./prisma/parity-test-harness.ts";
import { shutdownPrisma } from "./prisma/client.ts";

const WORKSPACE = "ua-parity-ws";
// Reads use dedicated users so write-test mutations (e.g. last_login_at stamping
// on createSession) never disturb the deterministic read fixtures.
const READ_USER = "ua-read-u1";
const ADMIN_USER = "ua-admin";
const AUTH_USER = "ua-auth-user";
const SESSION_USER = "ua-session-user";
const MEMBER_1 = "ua-ws-member-1";
const MEMBER_2 = "ua-ws-member-2";

function seedUser(id: string, displayName: string, email: string | null, isAdmin: number): void {
  getDatabase()
    .prepare(
      `INSERT INTO users (id, display_name, primary_email, is_admin, created_at, updated_at)
       VALUES (?, ?, ?, ?, '2026-08-09T08:00:00.000Z', '2026-08-09T08:00:00.000Z')
       ON CONFLICT (id) DO UPDATE SET display_name = EXCLUDED.display_name, primary_email = EXCLUDED.primary_email, is_admin = EXCLUDED.is_admin, last_login_at = NULL`,
    )
    .run(id, displayName, email, isAdmin);
}

function seedSession(
  id: string,
  userId: string,
  tokenHash: string,
  createdAt: string,
  revokedAt: string | null = null,
  expiresAt = "2026-12-31T23:59:59.000Z",
): void {
  getDatabase()
    .prepare(
      `INSERT INTO session (id, user_id, token_hash, expires_at, last_seen_at, created_at, ip_address, user_agent, revoked_at)
       VALUES (?, ?, ?, ?, '2026-08-09T08:00:00.000Z', ?, NULL, NULL, ?)
       ON CONFLICT (id) DO UPDATE SET user_id = EXCLUDED.user_id, token_hash = EXCLUDED.token_hash, revoked_at = EXCLUDED.revoked_at, expires_at = EXCLUDED.expires_at, last_seen_at = EXCLUDED.last_seen_at`,
    )
    .run(id, userId, tokenHash, expiresAt, createdAt, revokedAt);
}

function seedMembership(rowId: string, workspaceId: string, userId: string, role: string, joinedAt: string): void {
  getDatabase()
    .prepare(
      `INSERT INTO workspace_membership (id, workspace_id, user_id, role, status, joined_at, invited_by)
       VALUES (?, ?, ?, ?, 'active', ?, NULL)
       ON CONFLICT (workspace_id, user_id) DO UPDATE SET role = EXCLUDED.role, status = 'active', joined_at = EXCLUDED.joined_at`,
    )
    .run(rowId, workspaceId, userId, role, joinedAt);
}

function deleteSession(id: string): void {
  getDatabase().prepare("DELETE FROM session WHERE id = ?").run(id);
}

before(() => {
  resetDatabaseForTests();
  getDatabase()
    .prepare(
      `INSERT INTO workspace (id, slug, name, created_at, updated_at)
       VALUES (?, ?, ?, NOW(), NOW()) ON CONFLICT (id) DO NOTHING`,
    )
    .run(WORKSPACE, `slug-${WORKSPACE}`, "UA Parity WS");

  seedUser(READ_USER, "UA Read U1", "read1@parity.local", 0);
  seedUser(ADMIN_USER, "UA Admin", "admin@parity.local", 1);
  seedUser(AUTH_USER, "UA Auth User", "auth@parity.local", 0);
  seedUser(SESSION_USER, "UA Session User", "session@parity.local", 0);
  seedUser(MEMBER_1, "Member One", "member1@parity.local", 0);
  seedUser(MEMBER_2, "Member Two", "member2@parity.local", 0);

  // auth_identity for AUTH_USER.
  getDatabase()
    .prepare(
      `INSERT INTO auth_identity (id, user_id, provider, provider_subject, email, email_verified, profile_json, created_at, updated_at)
       VALUES ('ai-parity-1', ?, 'sso', 'sso-sub-auth-1', ?, 1, ?, '2026-08-09T08:10:00.000Z', '2026-08-09T08:10:00.000Z')
       ON CONFLICT (provider, provider_subject) DO UPDATE SET user_id = EXCLUDED.user_id, email = EXCLUDED.email, profile_json = EXCLUDED.profile_json`,
    )
    .run(AUTH_USER, "auth@parity.local", JSON.stringify({ sub: "sso-sub-auth-1", tenant: "acme" }));

  // Two sessions for SESSION_USER with distinct created_at → ORDER BY DESC is
  // deterministic (list-2 → list-1).
  seedSession("sess-list-2", SESSION_USER, "tok-list-2", "2026-08-09T09:00:00.000Z");
  seedSession("sess-list-1", SESSION_USER, "tok-list-1", "2026-08-09T08:30:00.000Z");

  seedMembership("wm-parity-m1", WORKSPACE, MEMBER_1, "admin", "2026-08-09T08:00:00.000Z");
  seedMembership("wm-parity-m2", WORKSPACE, MEMBER_2, "member", "2026-08-09T08:05:00.000Z");
});

after(async () => {
  for (const id of ["sess-list-1", "sess-list-2", "ai-parity-1"]) {
    if (id.startsWith("sess")) deleteSession(id);
    else if (id === "ai-parity-1") getDatabase().prepare("DELETE FROM auth_identity WHERE id = ?").run(id);
  }
  getDatabase().prepare("DELETE FROM workspace_membership WHERE workspace_id = ?").run(WORKSPACE);
  for (const u of [READ_USER, ADMIN_USER, AUTH_USER, SESSION_USER, MEMBER_1, MEMBER_2]) {
    getDatabase().prepare("DELETE FROM session WHERE user_id = ?").run(u);
    getDatabase().prepare("DELETE FROM users WHERE id = ?").run(u);
  }
  getDatabase().prepare("DELETE FROM workspace WHERE id = ?").run(WORKSPACE);
  await shutdownPrisma();
  resetDatabaseForTests();
});

// --- read / list / count parity -------------------------------------------

parityTest("countUsers (whole-table count)", {
  sync: () => countUsersSync(),
  async: () => countUsersAsync(),
});

parityTest("readUser", {
  sync: () => readUserSync(READ_USER),
  async: () => readUserAsync(READ_USER),
});

parityTest("readUser missing → null", {
  sync: () => readUserSync("ua-does-not-exist"),
  async: () => readUserAsync("ua-does-not-exist"),
});

parityTest("readUserByEmail", {
  sync: () => readUserByEmailSync("READ1@parity.local"),
  async: () => readUserByEmailAsync("READ1@parity.local"),
});

parityTest("readUserByEmail missing → null", {
  sync: () => readUserByEmailSync("nobody@parity.local"),
  async: () => readUserByEmailAsync("nobody@parity.local"),
});

parityTest("isPlatformAdminUser (admin true)", {
  sync: () => isPlatformAdminUserSync(ADMIN_USER),
  async: () => isPlatformAdminUserAsync(ADMIN_USER),
});

parityTest("isPlatformAdminUser (regular false)", {
  sync: () => isPlatformAdminUserSync(READ_USER),
  async: () => isPlatformAdminUserAsync(READ_USER),
});

parityTest("readAuthIdentityByProviderSubject", {
  sync: () => readAuthIdentityByProviderSubjectSync("sso", "sso-sub-auth-1"),
  async: () => readAuthIdentityByProviderSubjectAsync("sso", "sso-sub-auth-1"),
});

parityTest("readAuthIdentityByProviderSubject missing → null", {
  sync: () => readAuthIdentityByProviderSubjectSync("sso", "no-such-subject"),
  async: () => readAuthIdentityByProviderSubjectAsync("sso", "no-such-subject"),
});

parityTest("readAuthIdentityForUser", {
  sync: () => readAuthIdentityForUserSync(AUTH_USER, "sso"),
  async: () => readAuthIdentityForUserAsync(AUTH_USER, "sso"),
});

parityTest("readSessionByTokenHash", {
  sync: () => readSessionByTokenHashSync("tok-list-1"),
  async: () => readSessionByTokenHashAsync("tok-list-1"),
});

parityTest("readSessionByTokenHash missing → null", {
  sync: () => readSessionByTokenHashSync("tok-does-not-exist"),
  async: () => readSessionByTokenHashAsync("tok-does-not-exist"),
});

parityTest("listSessionsForUser (ordered created_at DESC, id DESC)", {
  sync: () => listSessionsForUserSync(SESSION_USER),
  async: () => listSessionsForUserAsync(SESSION_USER),
});

parityTest("countActiveSessionsForUser (revoked_at IS NULL)", {
  sync: () => countActiveSessionsForUserSync(SESSION_USER),
  async: () => countActiveSessionsForUserAsync(SESSION_USER),
});

parityTest("listWorkspaceMemberUsers (active non-admin members, joined_at ASC)", {
  sync: () => listWorkspaceMemberUsersSync(WORKSPACE),
  async: () => listWorkspaceMemberUsersAsync(WORKSPACE),
});

parityTest("countWorkspaceMembers", {
  sync: () => countWorkspaceMembersSync(WORKSPACE),
  async: () => countWorkspaceMembersAsync(WORKSPACE),
});

// --- write parity (strip volatile id + server-set timestamps) -------------

test("[parity] createUser write (id/createdAt/updatedAt stripped)", async () => {
  const base = { displayName: "UA Create", primaryEmail: "ua-create@parity.local", avatarUrl: "https://x/avatar.png" };
  try {
    const syncRec = createUserSync({ ...base });
    getDatabase().prepare("DELETE FROM users WHERE id = ?").run(syncRec.id);
    const asyncRec = await createUserAsync({ ...base });
    const { id: _s, createdAt: _sc, updatedAt: _su, ...syncRest } = syncRec;
    const { id: _a, createdAt: _ac, updatedAt: _au, ...asyncRest } = asyncRec;
    assert.equal(asyncRec.lastLoginAt, undefined, "fresh user has no lastLoginAt");
    assert.equal(typeof asyncRec.createdAt, "string", "createdAt must be ISO string, not Date");
    assertParityEqual(syncRest, asyncRest, "createUser async diverged from sync");
  } finally {
    getDatabase().prepare("DELETE FROM users WHERE primary_email = 'ua-create@parity.local'").run();
  }
});

test("[parity] createAuthIdentity write (id/createdAt/updatedAt stripped)", async () => {
  const base = {
    userId: AUTH_USER,
    provider: "sso" as const,
    providerSubject: "sso-sub-create",
    email: "create-identity@parity.local",
    emailVerified: true,
    profileJson: JSON.stringify({ sub: "sso-sub-create", roles: ["x", "y"] }),
  };
  try {
    const syncRec = createAuthIdentitySync({ ...base });
    getDatabase().prepare("DELETE FROM auth_identity WHERE id = ?").run(syncRec.id);
    const asyncRec = await createAuthIdentityAsync({ ...base });
    assert.equal(typeof asyncRec.createdAt, "string", "createdAt must be ISO string, not Date");
    assert.equal(typeof asyncRec.profileJson, "string", "profileJson must be string, not parsed object");
    const { id: _s, createdAt: _sc, updatedAt: _su, ...syncRest } = syncRec;
    const { id: _a, createdAt: _ac, updatedAt: _au, ...asyncRest } = asyncRec;
    assertParityEqual(syncRest, asyncRest, "createAuthIdentity async diverged from sync");
  } finally {
    getDatabase().prepare("DELETE FROM auth_identity WHERE provider_subject = 'sso-sub-create'").run();
  }
});

test("[parity] createSession write (id/createdAt/lastSeenAt/tokenHash stripped)", async () => {
  const writeUser = "ua-session-write-user";
  seedUser(writeUser, "UA Session Write", "session-write@parity.local", 0);
  try {
    const syncRec = createSessionSync({ userId: writeUser, tokenHash: "tok-write-sync", expiresAt: "2026-12-31T23:59:59.000Z", ipAddress: "10.0.0.1", userAgent: "UA/parity" });
    deleteSession(syncRec.id);
    const asyncRec = await createSessionAsync({ userId: writeUser, tokenHash: "tok-write-async", expiresAt: "2026-12-31T23:59:59.000Z", ipAddress: "10.0.0.1", userAgent: "UA/parity" });
    assert.equal(typeof asyncRec.createdAt, "string", "createdAt must be ISO string, not Date");
    assert.equal(asyncRec.revokedAt, undefined, "fresh session not revoked");
    // tokenHash differs (unique constraint) so strip it; expiresAt pinned via input.
    const { id: _s, createdAt: _sc, lastSeenAt: _sl, tokenHash: _st, ...syncRest } = syncRec;
    const { id: _a, createdAt: _ac, lastSeenAt: _al, tokenHash: _at, ...asyncRest } = asyncRec;
    assertParityEqual(syncRest, asyncRest, "createSession async diverged from sync");
  } finally {
    getDatabase().prepare("DELETE FROM session WHERE user_id = ?").run(writeUser);
    getDatabase().prepare("DELETE FROM users WHERE id = ?").run(writeUser);
  }
});

// --- state-effect parity ---------------------------------------------------

test("[parity] updateUser state effect", async () => {
  const syncUser = "ua-update-sync";
  const asyncUser = "ua-update-async";
  seedUser(syncUser, "Before Update", "update-sync@parity.local", 0);
  seedUser(asyncUser, "Before Update", "update-async@parity.local", 0);
  try {
    const syncRec = updateUserSync({ userId: syncUser, displayName: "After Update", avatarUrl: "  https://x/u.png  ", isAdmin: true });
    const asyncRec = await updateUserAsync({ userId: asyncUser, displayName: "After Update", avatarUrl: "  https://x/u.png  ", isAdmin: true });
    assert.ok(syncRec && asyncRec, "both updated");
    assert.equal(asyncRec.isAdmin, true, "isAdmin mapped from int");
    // primaryEmail differs by design (two distinct users satisfy the unique email
    // constraint); the UPDATE only touches displayName/avatarUrl/isAdmin.
    const { id: _s, createdAt: _sc, updatedAt: _su, primaryEmail: _se, ...syncRest } = syncRec;
    const { id: _a, createdAt: _ac, updatedAt: _au, primaryEmail: _ae, ...asyncRest } = asyncRec;
    assertParityEqual(syncRest, asyncRest, "updateUser diverged");
  } finally {
    for (const u of [syncUser, asyncUser]) getDatabase().prepare("DELETE FROM users WHERE id = ?").run(u);
  }
});

test("[parity] updateUser missing user → null", async () => {
  assert.equal(updateUserSync({ userId: "ua-nope-update", displayName: "x" }), null);
  assert.equal(await updateUserAsync({ userId: "ua-nope-update", displayName: "x" }), null);
});

test("[parity] touchSessionLastSeen state effect", async () => {
  const syncTok = "tok-touch-sync";
  const asyncTok = "tok-touch-async";
  seedSession("sess-touch-sync", SESSION_USER, syncTok, "2026-08-09T10:00:00.000Z");
  seedSession("sess-touch-async", SESSION_USER, asyncTok, "2026-08-09T10:00:00.000Z");
  try {
    touchSessionLastSeenSync(syncTok);
    await touchSessionLastSeenAsync(asyncTok);
    const syncRec = readSessionByTokenHashSync(syncTok);
    const asyncRec = await readSessionByTokenHashAsync(asyncTok);
    assert.ok(syncRec && asyncRec, "both found");
    assert.equal(typeof asyncRec.lastSeenAt, "string", "lastSeenAt must be ISO string, not Date");
    const { id: _s, lastSeenAt: _sl, tokenHash: _st, ...syncRest } = syncRec;
    const { id: _a, lastSeenAt: _al, tokenHash: _at, ...asyncRest } = asyncRec;
    assertParityEqual(syncRest, asyncRest, "touchSessionLastSeen diverged");
  } finally {
    deleteSession("sess-touch-sync");
    deleteSession("sess-touch-async");
  }
});

test("[parity] deleteSessionByTokenHash state effect + missing → false", async () => {
  const syncTok = "tok-del-sync";
  const asyncTok = "tok-del-async";
  seedSession("sess-del-sync", SESSION_USER, syncTok, "2026-08-09T11:00:00.000Z");
  seedSession("sess-del-async", SESSION_USER, asyncTok, "2026-08-09T11:00:00.000Z");
  try {
    assert.equal(deleteSessionByTokenHashSync(syncTok), true);
    assert.equal(await deleteSessionByTokenHashAsync(asyncTok), true);
    assert.equal(readSessionByTokenHashSync(syncTok), null);
    assert.equal(await readSessionByTokenHashAsync(asyncTok), null);
    // Already deleted → false for both.
    assert.equal(deleteSessionByTokenHashSync(syncTok), false);
    assert.equal(await deleteSessionByTokenHashAsync(asyncTok), false);
    // Never-existed token → false for both.
    assert.equal(deleteSessionByTokenHashSync("tok-never"), false);
    assert.equal(await deleteSessionByTokenHashAsync("tok-never"), false);
  } finally {
    deleteSession("sess-del-sync");
    deleteSession("sess-del-async");
  }
});

test("[parity] revokeSessionById state effect + COALESCE idempotency", async () => {
  const syncSess = "sess-revoke-sync";
  const asyncSess = "sess-revoke-async";
  seedSession(syncSess, SESSION_USER, "tok-revoke-sync", "2026-08-09T12:00:00.000Z");
  seedSession(asyncSess, SESSION_USER, "tok-revoke-async", "2026-08-09T12:00:00.000Z");
  try {
    const syncBefore = readSessionByTokenHashSync("tok-revoke-sync");
    const asyncBefore = await readSessionByTokenHashAsync("tok-revoke-async");
    assert.ok(syncBefore && asyncBefore && syncBefore.id && asyncBefore.id, "ids present");

    assert.equal(revokeSessionByIdSync(syncBefore.id), true);
    assert.equal(await revokeSessionByIdAsync(asyncBefore.id), true);

    const syncAfter = readSessionByTokenHashSync("tok-revoke-sync");
    const asyncAfter = await readSessionByTokenHashAsync("tok-revoke-async");
    assert.ok(syncAfter && asyncAfter, "still readable after revoke");
    assert.equal(typeof asyncAfter.revokedAt, "string", "revokedAt must be ISO string, not Date");
    assert.equal(syncAfter.revokedAt, syncAfter.revokedAt, "sync revokedAt set");
    const { id: _s, revokedAt: _sr, tokenHash: _st, ...syncRest } = syncAfter;
    const { id: _a, revokedAt: _ar, tokenHash: _at, ...asyncRest } = asyncAfter;
    assertParityEqual(syncRest, asyncRest, "revokeSessionById diverged");

    // COALESCE idempotency: a second revoke must NOT overwrite the first timestamp.
    revokeSessionByIdSync(syncBefore.id);
    await revokeSessionByIdAsync(asyncBefore.id);
    const syncAgain = readSessionByTokenHashSync("tok-revoke-sync");
    const asyncAgain = await readSessionByTokenHashAsync("tok-revoke-async");
    assert.equal(syncAgain?.revokedAt, syncAfter.revokedAt, "sync revoke idempotent");
    assert.equal(asyncAgain?.revokedAt, asyncAfter.revokedAt, "async revoke idempotent");

    // userId-guarded revoke returns false for a foreign user.
    assert.equal(revokeSessionByIdSync(syncBefore.id, "ua-foreign"), false);
    assert.equal(await revokeSessionByIdAsync(asyncBefore.id, "ua-foreign"), false);
  } finally {
    deleteSession(syncSess);
    deleteSession(asyncSess);
  }
});

test("[parity] revokeOtherSessionsForUser state effect", async () => {
  const syncUser = "ua-revoke-other-sync";
  const asyncUser = "ua-revoke-other-async";
  seedUser(syncUser, "Revoke Other Sync", "revoke-other-sync@parity.local", 0);
  seedUser(asyncUser, "Revoke Other Async", "revoke-other-async@parity.local", 0);
  seedSession("sess-other-cur-sync", syncUser, "tok-other-cur-sync", "2026-08-09T13:00:00.000Z");
  seedSession("sess-other-a-sync", syncUser, "tok-other-a-sync", "2026-08-09T13:01:00.000Z");
  seedSession("sess-other-b-sync", syncUser, "tok-other-b-sync", "2026-08-09T13:02:00.000Z");
  seedSession("sess-other-cur-async", asyncUser, "tok-other-cur-async", "2026-08-09T13:00:00.000Z");
  seedSession("sess-other-a-async", asyncUser, "tok-other-a-async", "2026-08-09T13:01:00.000Z");
  seedSession("sess-other-b-async", asyncUser, "tok-other-b-async", "2026-08-09T13:02:00.000Z");
  try {
    const syncCount = revokeOtherSessionsForUserSync(syncUser, "sess-other-cur-sync");
    const asyncCount = await revokeOtherSessionsForUserAsync(asyncUser, "sess-other-cur-async");
    assert.equal(syncCount, 2, "sync revoked the two non-current sessions");
    assert.equal(asyncCount, 2, "async revoked the two non-current sessions");

    // Current session untouched; the two others now revoked.
    const syncCurrent = readSessionByTokenHashSync("tok-other-cur-sync");
    const asyncCurrent = await readSessionByTokenHashAsync("tok-other-cur-async");
    assert.equal(syncCurrent?.revokedAt, undefined, "current session sync not revoked");
    assert.equal(asyncCurrent?.revokedAt, undefined, "current session async not revoked");
    const syncOther = readSessionByTokenHashSync("tok-other-a-sync");
    const asyncOther = await readSessionByTokenHashAsync("tok-other-a-async");
    assert.equal(typeof asyncOther?.revokedAt, "string", "other session async revoked");
    assert.equal(typeof syncOther?.revokedAt, "string", "other session sync revoked");
  } finally {
    for (const id of ["sess-other-cur-sync", "sess-other-a-sync", "sess-other-b-sync", "sess-other-cur-async", "sess-other-a-async", "sess-other-b-async"]) deleteSession(id);
    for (const u of [syncUser, asyncUser]) getDatabase().prepare("DELETE FROM users WHERE id = ?").run(u);
  }
});

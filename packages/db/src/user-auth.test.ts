import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { before, beforeEach } from "node:test";
import {
  countActiveSessionsForUserSync,
  countWorkspaceMembersSync,
  countUsersSync,
  createAuthIdentitySync,
  createSessionSync,
  createUserSync,
  createWorkspaceMembershipSync,
  createWorkspaceSync,
  deleteSessionByTokenHashSync,
  getDatabase,
  listSessionsForUserSync,
  listWorkspaceMemberUsersSync,
  readAuthIdentityByProviderSubjectSync,
  readSessionByTokenHashSync,
  readUserByEmailSync,
  readUserSync,
  revokeOtherSessionsForUserSync,
  revokeSessionByIdSync,
  transferWorkspaceOwnershipSync,
  upsertWorkspaceMembershipSync,
  updateUserSync,
} from "./index.ts";

const originalCwd = process.cwd();
const tempRoot = mkdtempSync(join(tmpdir(), "dofe-agent-user-auth-"));

before(() => {
  writeFileSync(join(tempRoot, "Target.md"), "# test\n");
  mkdirSync(join(tempRoot, "data"), { recursive: true });
  process.chdir(tempRoot);
});

beforeEach(() => {
  getDatabase().exec(`
    DELETE FROM session;
    DELETE FROM auth_identity;
    DELETE FROM workspace_membership;
    DELETE FROM workspace;
    DELETE FROM users;
  `);
});

test("user auth persists users, SSO identities, and sessions", () => {
  const user = createUserSync({
    displayName: "Mina",
    primaryEmail: "mina@example.com",
    isAdmin: true,
  });
  assert.equal(countUsersSync(), 1);
  assert.equal(readUserSync(user.id)?.displayName, "Mina");
  assert.equal(readUserSync(user.id)?.isAdmin, true);
  assert.equal(readUserByEmailSync("MINA@example.com")?.id, user.id);
  assert.equal(readUserByEmailSync("MINA@example.com")?.isAdmin, true);

  const identity = createAuthIdentitySync({
    userId: user.id,
    provider: "sso",
    providerSubject: "sso-mina-1",
    email: "mina@example.com",
    emailVerified: true,
  });
  assert.equal(identity.userId, user.id);
  assert.equal(readAuthIdentityByProviderSubjectSync("sso", "sso-mina-1")?.id, identity.id);

  const session = createSessionSync({
    userId: user.id,
    tokenHash: "token-hash-1",
    expiresAt: "2099-01-01T00:00:00.000Z",
  });
  assert.equal(session.userId, user.id);
  assert.ok(readUserSync(user.id)?.lastLoginAt);
  assert.equal(readSessionByTokenHashSync("token-hash-1")?.id, session.id);
  assert.equal(deleteSessionByTokenHashSync("token-hash-1"), true);
  assert.equal(readSessionByTokenHashSync("token-hash-1"), null);
});

test("workspace member user listing joins active memberships with users", () => {
  const workspace = createWorkspaceSync({
    slug: "team-alpha",
    name: "Team Alpha",
    createdBy: "system",
  });
  const owner = createUserSync({
    displayName: "Owner",
    primaryEmail: "owner@example.com",
  });
  const admin = createUserSync({
    displayName: "Admin",
    primaryEmail: "admin@example.com",
  });

  createWorkspaceMembershipSync({
    workspaceId: workspace.id,
    userId: owner.id,
    role: "owner",
  });
  createWorkspaceMembershipSync({
    workspaceId: workspace.id,
    userId: admin.id,
    role: "admin",
  });

  assert.deepEqual(listWorkspaceMemberUsersSync(workspace.id), [
    {
      userId: owner.id,
      displayName: "Owner",
      primaryEmail: "owner@example.com",
      role: "owner",
    },
    {
      userId: admin.id,
      displayName: "Admin",
      primaryEmail: "admin@example.com",
      role: "admin",
    },
  ]);
});

test("sessions can be listed and revoked without deleting history", () => {
  const user = createUserSync({
    displayName: "Mina",
    primaryEmail: "mina@example.com",
  });
  const first = createSessionSync({
    userId: user.id,
    tokenHash: "token-hash-1",
    expiresAt: "2099-01-01T00:00:00.000Z",
    ipAddress: "127.0.0.1",
    userAgent: "unit-test",
  });
  const second = createSessionSync({
    userId: user.id,
    tokenHash: "token-hash-2",
    expiresAt: "2099-01-02T00:00:00.000Z",
  });

  assert.equal(listSessionsForUserSync(user.id).length, 2);
  assert.equal(countActiveSessionsForUserSync(user.id), 2);
  assert.equal(revokeSessionByIdSync(first.id, user.id), true);
  assert.match(listSessionsForUserSync(user.id).find((session) => session.id === first.id)?.revokedAt ?? "", /T/);
  assert.equal(countActiveSessionsForUserSync(user.id), 1);

  assert.equal(revokeOtherSessionsForUserSync(user.id, first.id), 1);
  assert.match(listSessionsForUserSync(user.id).find((session) => session.id === second.id)?.revokedAt ?? "", /T/);
  assert.equal(listSessionsForUserSync(user.id).filter((session) => session.revokedAt).length, 2);
  assert.equal(countActiveSessionsForUserSync(user.id), 0);
});

test("workspace memberships can be reactivated after removal", () => {
  const workspace = createWorkspaceSync({
    slug: "team-reactivate",
    name: "Team Reactivate",
    createdBy: "system",
  });
  const user = createUserSync({
    displayName: "Reactivate User",
    primaryEmail: "reactivate@example.com",
  });

  createWorkspaceMembershipSync({
    workspaceId: workspace.id,
    userId: user.id,
    role: "member",
  });
  getDatabase().prepare(
    "UPDATE workspace_membership SET status = 'removed' WHERE workspace_id = ? AND user_id = ?",
  ).run(workspace.id, user.id);

  const restored = upsertWorkspaceMembershipSync({
    workspaceId: workspace.id,
    userId: user.id,
    role: "admin",
  });

  assert.equal(restored.role, "admin");
  assert.equal(restored.status, "active");
  assert.deepEqual(listWorkspaceMemberUsersSync(workspace.id), [
    {
      userId: user.id,
      displayName: "Reactivate User",
      primaryEmail: "reactivate@example.com",
      role: "admin",
    },
  ]);
  assert.equal(countWorkspaceMembersSync(workspace.id), 1);
});

test("workspace member counts only include active memberships", () => {
  const workspace = createWorkspaceSync({
    slug: "team-counts",
    name: "Team Counts",
    createdBy: "system",
  });
  const owner = createUserSync({
    displayName: "Owner",
    primaryEmail: "owner-counts@example.com",
  });
  const removed = createUserSync({
    displayName: "Removed",
    primaryEmail: "removed-counts@example.com",
  });

  createWorkspaceMembershipSync({
    workspaceId: workspace.id,
    userId: owner.id,
    role: "owner",
  });
  createWorkspaceMembershipSync({
    workspaceId: workspace.id,
    userId: removed.id,
    role: "member",
  });
  getDatabase().prepare(
    "UPDATE workspace_membership SET status = 'removed' WHERE workspace_id = ? AND user_id = ?",
  ).run(workspace.id, removed.id);

  assert.equal(countWorkspaceMembersSync(workspace.id), 1);
});

test("workspace ownership can be transferred transactionally", () => {
  const workspace = createWorkspaceSync({
    slug: "team-transfer",
    name: "Team Transfer",
    createdBy: "system",
  });
  const owner = createUserSync({
    displayName: "Owner User",
    primaryEmail: "owner-transfer@example.com",
  });
  const admin = createUserSync({
    displayName: "Admin User",
    primaryEmail: "admin-transfer@example.com",
  });

  createWorkspaceMembershipSync({
    workspaceId: workspace.id,
    userId: owner.id,
    role: "owner",
  });
  createWorkspaceMembershipSync({
    workspaceId: workspace.id,
    userId: admin.id,
    role: "admin",
  });

  transferWorkspaceOwnershipSync(workspace.id, owner.id, admin.id);

  assert.deepEqual(listWorkspaceMemberUsersSync(workspace.id), [
    {
      userId: owner.id,
      displayName: "Owner User",
      primaryEmail: "owner-transfer@example.com",
      role: "admin",
    },
    {
      userId: admin.id,
      displayName: "Admin User",
      primaryEmail: "admin-transfer@example.com",
      role: "owner",
    },
  ]);
});

test("generic auth identities can be created and existing users updated", () => {
  const user = createUserSync({
    displayName: "Mina",
    primaryEmail: "mina@example.com",
  });

  const identity = createAuthIdentitySync({
    userId: user.id,
    provider: "sso",
    providerSubject: "sso-sub-1",
    email: "mina@example.com",
    emailVerified: true,
    profileJson: JSON.stringify({ locale: "en" }),
  });

  assert.equal(identity.provider, "sso");
  assert.equal(readAuthIdentityByProviderSubjectSync("sso", "sso-sub-1")?.id, identity.id);

  const updated = updateUserSync({
    userId: user.id,
    displayName: "Mina Updated",
    avatarUrl: "https://example.com/avatar.png",
  });

  assert.equal(updated?.displayName, "Mina Updated");
  assert.equal(updated?.avatarUrl, "https://example.com/avatar.png");
});

test.after(() => {
  process.chdir(originalCwd);
});

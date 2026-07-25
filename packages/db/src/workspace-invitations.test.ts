import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { before, beforeEach } from "node:test";
import {
  acceptWorkspaceInvitationSync,
  countActiveWorkspaceInvitationsSync,
  createUserSync,
  createWorkspaceInvitationSync,
  createWorkspaceMembershipSync,
  createWorkspaceSync,
  getDatabase,
  listWorkspaceInvitationsSync,
  listWorkspaceMemberUsersSync,
  readActiveWorkspaceInvitationByTokenSync,
  revokeWorkspaceInvitationSync,
} from "./index.ts";

const originalCwd = process.cwd();
const tempRoot = mkdtempSync(join(tmpdir(), "dofe-agent-workspace-invitations-"));

before(() => {
  writeFileSync(join(tempRoot, "Target.md"), "# test\n");
  mkdirSync(join(tempRoot, "data"), { recursive: true });
  process.chdir(tempRoot);
});

beforeEach(() => {
  getDatabase().exec(`
    DELETE FROM workspace_invitation;
    DELETE FROM workspace_membership;
    DELETE FROM workspace;
    DELETE FROM users;
  `);
});

test("workspace invitations can be created, listed, and revoked", () => {
  const workspace = createWorkspaceSync({
    name: "Invite Workspace",
    createdBy: "system",
  });

  const created = createWorkspaceInvitationSync({
    workspaceId: workspace.id,
    email: "alex@example.com",
    role: "member",
    invitedBy: "user-owner",
  });

  assert.ok(created.token.startsWith("wsi_"));
  assert.equal(readActiveWorkspaceInvitationByTokenSync(created.token)?.email, "alex@example.com");
  assert.equal(listWorkspaceInvitationsSync(workspace.id).length, 1);
  assert.equal(countActiveWorkspaceInvitationsSync(workspace.id), 1);

  assert.equal(revokeWorkspaceInvitationSync(created.id, workspace.id), true);
  assert.equal(readActiveWorkspaceInvitationByTokenSync(created.token), null);
  assert.equal(countActiveWorkspaceInvitationsSync(workspace.id), 0);
});

test("workspace invitations can be accepted by matching user email", () => {
  const workspace = createWorkspaceSync({
    name: "Accepted Workspace",
    createdBy: "system",
  });
  const invitedUser = createUserSync({
    displayName: "Alex",
    primaryEmail: "alex@example.com",
  });

  const created = createWorkspaceInvitationSync({
    workspaceId: workspace.id,
    email: "alex@example.com",
    role: "admin",
    invitedBy: "user-owner",
  });

  const accepted = acceptWorkspaceInvitationSync(created.token, invitedUser.id);

  assert.equal(accepted.status, "accepted");
  assert.equal(listWorkspaceMemberUsersSync(workspace.id)[0]?.role, "admin");
});

test("accepting an invitation preserves a stronger existing membership role", () => {
  const workspace = createWorkspaceSync({
    name: "Existing Role Workspace",
    createdBy: "system",
  });
  const user = createUserSync({
    displayName: "Owner",
    primaryEmail: "owner@example.com",
  });

  createWorkspaceMembershipSync({
    workspaceId: workspace.id,
    userId: user.id,
    role: "owner",
  });
  const created = createWorkspaceInvitationSync({
    workspaceId: workspace.id,
    email: "owner@example.com",
    role: "member",
    invitedBy: "user-owner",
  });

  acceptWorkspaceInvitationSync(created.token, user.id);

  assert.equal(listWorkspaceMemberUsersSync(workspace.id)[0]?.role, "owner");
});

test("active invitation counts ignore expired rows", () => {
  const workspace = createWorkspaceSync({
    name: "Expired Count Workspace",
    createdBy: "system",
  });

  createWorkspaceInvitationSync({
    workspaceId: workspace.id,
    email: "fresh@example.com",
    role: "member",
    invitedBy: "user-owner",
  });
  const expired = createWorkspaceInvitationSync({
    workspaceId: workspace.id,
    email: "expired@example.com",
    role: "member",
    invitedBy: "user-owner",
  });

  getDatabase().prepare(
    "UPDATE workspace_invitation SET expires_at = ? WHERE id = ?",
  ).run("2000-01-01T00:00:00.000Z", expired.id);

  assert.equal(countActiveWorkspaceInvitationsSync(workspace.id), 1);
});

test.after(() => {
  process.chdir(originalCwd);
});

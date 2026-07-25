import test, { before, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createUserSync,
  createWorkspaceMembershipSync,
  createWorkspaceSync,
  getDatabase,
  listAgentGoogleWorkspaceDelegationsSync,
  listGoogleOAuthCredentialsSync,
  readActiveAgentGoogleWorkspaceDelegationSync,
  readActiveGoogleOAuthCredentialSync,
  revokeAgentGoogleWorkspaceDelegationSync,
  revokeGoogleOAuthCredentialSync,
  upsertAgentGoogleWorkspaceDelegationSync,
  upsertGoogleOAuthCredentialSync,
} from "./index.ts";

const originalCwd = process.cwd();
const tempRoot = mkdtempSync(join(tmpdir(), "dofe-agent-google-oauth-"));

before(() => {
  writeFileSync(join(tempRoot, "Target.md"), "# test\n");
  mkdirSync(join(tempRoot, "data"), { recursive: true });
  mkdirSync(join(tempRoot, "packages"), { recursive: true });
  symlinkSync(join(originalCwd, "packages", "db"), join(tempRoot, "packages", "db"), "dir");
  process.chdir(tempRoot);
});

beforeEach(() => {
  getDatabase().exec(`
    DELETE FROM agent_google_workspace_delegation;
    DELETE FROM google_oauth_credential;
    DELETE FROM workspace_membership;
    DELETE FROM workspace;
    DELETE FROM users;
  `);
});

test("Agent Google Workspace delegations point at user credentials and can be revoked independently", () => {
  const workspace = createWorkspaceSync({
    slug: "workspace-agent-google",
    name: "Workspace Agent Google",
    createdBy: "system",
  });
  const user = createUserSync({
    displayName: "Mina",
    primaryEmail: "mina@example.com",
  });
  createWorkspaceMembershipSync({
    workspaceId: workspace.id,
    userId: user.id,
    role: "owner",
  });
  const credential = upsertGoogleOAuthCredentialSync({
    workspaceId: workspace.id,
    userId: user.id,
    googleSubject: "google-sub-1",
    googleEmail: "mina@example.com",
    scopes: "openid email https://www.googleapis.com/auth/drive.file",
    accessTokenEncrypted: "access-v1",
    refreshTokenEncrypted: "refresh-v1",
    expiresAt: "2026-05-01T00:00:00.000Z",
  });

  const delegation = upsertAgentGoogleWorkspaceDelegationSync({
    workspaceId: workspace.id,
    employeeName: "表格数据分析",
    userId: user.id,
    googleOAuthCredentialId: credential.id,
    scopes: credential.scopes,
    googleEmail: credential.googleEmail,
    grantedByUserId: user.id,
  });

  assert.equal(delegation.status, "active");
  assert.equal(delegation.employeeName, "表格数据分析");
  assert.equal(delegation.googleOAuthCredentialId, credential.id);
  assert.equal(readActiveAgentGoogleWorkspaceDelegationSync({
    workspaceId: workspace.id,
    employeeName: "表格数据分析",
  })?.id, delegation.id);
  assert.equal(listAgentGoogleWorkspaceDelegationsSync(workspace.id).length, 1);

  const revoked = revokeAgentGoogleWorkspaceDelegationSync({
    workspaceId: workspace.id,
    employeeName: "表格数据分析",
    userId: user.id,
  });
  assert.equal(revoked.status, "revoked");
  assert.equal(readActiveAgentGoogleWorkspaceDelegationSync({
    workspaceId: workspace.id,
    employeeName: "表格数据分析",
  }), null);
  assert.equal(readActiveGoogleOAuthCredentialSync({ workspaceId: workspace.id, userId: user.id })?.id, credential.id);
});

test("Google OAuth credentials can be upserted, read, and revoked", () => {
  const workspace = createWorkspaceSync({
    slug: "workspace-google",
    name: "Workspace Google",
    createdBy: "system",
  });
  const user = createUserSync({
    displayName: "Mina",
    primaryEmail: "mina@example.com",
  });
  createWorkspaceMembershipSync({
    workspaceId: workspace.id,
    userId: user.id,
    role: "owner",
  });

  const created = upsertGoogleOAuthCredentialSync({
    workspaceId: workspace.id,
    userId: user.id,
    googleSubject: "google-sub-1",
    googleEmail: "MINA@EXAMPLE.COM",
    scopes: "openid email https://www.googleapis.com/auth/drive.file",
    accessTokenEncrypted: "access-v1",
    refreshTokenEncrypted: "refresh-v1",
    expiresAt: "2026-05-01T00:00:00.000Z",
  });

  assert.equal(created.status, "active");
  assert.equal(created.googleEmail, "mina@example.com");
  assert.equal(created.refreshTokenEncrypted, "refresh-v1");
  assert.equal(listGoogleOAuthCredentialsSync(workspace.id).length, 1);

  const updated = upsertGoogleOAuthCredentialSync({
    workspaceId: workspace.id,
    userId: user.id,
    googleSubject: "google-sub-1",
    googleEmail: "mina@example.com",
    scopes: "https://www.googleapis.com/auth/drive.file",
    accessTokenEncrypted: "access-v2",
    expiresAt: "2026-05-02T00:00:00.000Z",
  });

  assert.equal(updated.accessTokenEncrypted, "access-v2");
  assert.equal(updated.refreshTokenEncrypted, "refresh-v1");
  assert.equal(new Date(updated.expiresAt ?? "").toISOString(), "2026-05-02T00:00:00.000Z");

  const revoked = revokeGoogleOAuthCredentialSync({
    workspaceId: workspace.id,
    userId: user.id,
  });
  assert.equal(revoked.status, "revoked");
  assert.equal(revoked.accessTokenEncrypted, undefined);
  assert.equal(revoked.refreshTokenEncrypted, undefined);
  assert.equal(readActiveGoogleOAuthCredentialSync({ workspaceId: workspace.id, userId: user.id }), null);
});

test.after(() => {
  process.chdir(originalCwd);
});

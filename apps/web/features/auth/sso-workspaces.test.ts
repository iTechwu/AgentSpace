import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { getDatabase, listUserWorkspacesSync, readWorkspaceSync } from "@agent-space/db";
import { buildSsoWorkspaceScopes, syncSsoWorkspacesForUserSync } from "./sso-workspaces";

const originalCwd = process.cwd();
const tempRoot = mkdtempSync(join(tmpdir(), "agent-space-sso-workspaces-"));

beforeAll(() => {
  writeFileSync(join(tempRoot, "Target.md"), "# test\n");
  mkdirSync(join(tempRoot, "data"), { recursive: true });
  process.chdir(tempRoot);
});

beforeEach(() => {
  const db = getDatabase();
  db.exec("DELETE FROM workspace_membership");
  db.exec("DELETE FROM workspace");
  db.exec("DELETE FROM workspace_snapshot");
  db.exec("DELETE FROM users");
  const now = new Date().toISOString();
  db.prepare(
    `INSERT INTO users (id, display_name, avatar_url, primary_email, created_at, updated_at, last_login_at)
     VALUES ('user-1', 'Mina', NULL, 'mina@example.test', ?, ?, NULL)`,
  ).run(now, now);
});

afterAll(() => {
  process.chdir(originalCwd);
});

describe("SSO workspace synchronization", () => {
  it("creates a tenant/team workspace and revokes it when the SSO membership is removed", () => {
    const scopes = buildSsoWorkspaceScopes({
      preferredTenantId: "tenant-1",
      teams: [{
        teamId: "team-1",
        teamSlug: "engineering",
        teamName: "Engineering",
        tenantId: "tenant-1",
        tenantSlug: "orbit",
        tenantName: "Orbit",
        role: "ADMIN",
      }],
      tenants: [{
        tenantId: "tenant-1",
        tenantSlug: "orbit",
        tenantName: "Orbit",
        tenantDisplayName: null,
        role: "ADMIN",
      }],
    });

    syncSsoWorkspacesForUserSync({ displayName: "Mina", scopes, userId: "user-1" });

    const workspaceId = scopes[0]!.id;
    expect(readWorkspaceSync(workspaceId)?.name).toBe("Orbit / Engineering");
    expect(listUserWorkspacesSync("user-1")).toMatchObject([{ workspaceId, role: "admin" }]);

    syncSsoWorkspacesForUserSync({ displayName: "Mina", scopes: [], userId: "user-1" });
    expect(listUserWorkspacesSync("user-1")).toEqual([]);
  });
});

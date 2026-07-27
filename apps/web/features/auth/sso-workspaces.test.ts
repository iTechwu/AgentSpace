import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { getDatabase, listUserWorkspacesSync, readWorkspaceSync, updateWorkspaceSync } from "@dofe-agent/db";
import {
  buildSsoWorkspaceScopes,
  buildSsoWorkspaceScopesForUser,
  syncSsoWorkspacesForUserSync,
} from "./sso-workspaces";

const originalCwd = process.cwd();
const tempRoot = mkdtempSync(join(tmpdir(), "dofe-agent-sso-workspaces-"));

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
  it("expands a global SSO admin to every active tenant team as a workspace admin", async () => {
    const listTeams = vi.fn().mockResolvedValue({
      list: [
        {
          id: "team-alpha",
          tenantId: "tenant-alpha",
          slug: "all",
          name: "All",
          description: null,
          type: "default",
          status: "ACTIVE",
          externalId: null,
          metadata: null,
          createdAt: "2026-07-25T00:00:00.000Z",
          updatedAt: "2026-07-25T00:00:00.000Z",
        },
        {
          id: "team-beta",
          tenantId: "tenant-beta",
          slug: "engineering",
          name: "Engineering",
          description: null,
          type: "default",
          status: "ACTIVE",
          externalId: null,
          metadata: null,
          createdAt: "2026-07-25T00:00:00.000Z",
          updatedAt: "2026-07-25T00:00:00.000Z",
        },
      ],
      total: 2,
    });
    const listTenants = vi.fn().mockResolvedValue({
      list: [
        { id: "tenant-alpha", slug: "alpha", name: "Alpha", type: "standard", plan: "free", status: "ACTIVE" },
        { id: "tenant-beta", slug: "beta", name: "Beta", type: "standard", plan: "free", status: "ACTIVE" },
      ],
      total: 2,
    });

    const scopes = await buildSsoWorkspaceScopesForUser({
      client: {
        teams: { list: listTeams },
        tenants: { list: listTenants },
      } as never,
      isAdmin: true,
      preferredTenantId: "tenant-beta",
      teams: [],
      tenants: [],
    });

    expect(scopes).toMatchObject([
      { name: "Beta / Engineering", role: "admin", tenantId: "tenant-beta", teamId: "team-beta" },
      { name: "Alpha / All", role: "admin", tenantId: "tenant-alpha", teamId: "team-alpha" },
    ]);
    expect(listTeams).toHaveBeenCalledWith({ limit: 100, page: 1, status: "ACTIVE" });
    expect(listTenants).toHaveBeenCalledWith({ limit: 100, page: 1, status: "ACTIVE" });
  });

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
    expect(readWorkspaceSync(workspaceId)?.slug).toMatch(/^orbit-engineering-/);
    expect(listUserWorkspacesSync("user-1")).toMatchObject([{ workspaceId, role: "admin" }]);

    updateWorkspaceSync(workspaceId, { slug: `sso-workspace-${workspaceId.slice(-6)}` });
    syncSsoWorkspacesForUserSync({ displayName: "Mina", scopes, userId: "user-1" });
    expect(readWorkspaceSync(workspaceId)?.slug).toMatch(/^orbit-engineering-/);

    syncSsoWorkspacesForUserSync({ displayName: "Mina", scopes: [], userId: "user-1" });
    expect(listUserWorkspacesSync("user-1")).toEqual([]);
  });

  it("syncs platform workspace scope without materializing a team membership", () => {
    const scopes = buildSsoWorkspaceScopes({
      preferredTenantId: "tenant-platform",
      teams: [{
        teamId: "team-platform",
        teamSlug: "operations",
        teamName: "Operations",
        tenantId: "tenant-platform",
        tenantSlug: "platform",
        tenantName: "Platform",
        role: "ADMIN",
      }],
      tenants: [],
    });

    syncSsoWorkspacesForUserSync({
      displayName: "Platform operator",
      materializeMemberships: false,
      scopes,
      userId: "user-1",
    });

    expect(readWorkspaceSync(scopes[0]!.id)?.name).toBe("Platform / Operations");
    expect(listUserWorkspacesSync("user-1")).toEqual([]);
  });

  it("uses tenant and team names for a non-ASCII SSO workspace URL", () => {
    const scopes = buildSsoWorkspaceScopes({
      teams: [{
        teamId: "team-chinese",
        teamSlug: "",
        teamName: "产品",
        tenantId: "tenant-chinese",
        tenantSlug: "",
        tenantName: "全体",
        role: "ADMIN",
      }],
      tenants: [],
    });

    syncSsoWorkspacesForUserSync({ displayName: "Mina", scopes, userId: "user-1" });
    expect(readWorkspaceSync(scopes[0]!.id)?.slug).toMatch(/^全体-产品-/);
  });
});

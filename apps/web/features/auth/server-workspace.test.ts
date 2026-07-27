import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createWorkspaceMembershipSync, createWorkspaceSync, getDatabase, listUserWorkspacesSync } from "@dofe-agent/db";
import type { AuthUser } from "./server-auth";
import {
  resolveCurrentWorkspaceContextForUserSync,
  resolveWorkspaceAccessForIdentifierSync,
} from "./server-workspace-resolver";

const originalCwd = process.cwd();
const tempRoot = mkdtempSync(join(tmpdir(), "dofe-agent-server-workspace-"));

beforeAll(() => {
  writeFileSync(join(tempRoot, "Target.md"), "# test\n");
  mkdirSync(join(tempRoot, "data"), { recursive: true });
  process.chdir(tempRoot);
});

beforeEach(() => {
  const db = getDatabase();
  db.exec("DELETE FROM workspace_membership");
  db.exec("DELETE FROM workspace");
  db.exec("DELETE FROM users");
});

afterAll(() => {
  process.chdir(originalCwd);
});

describe("server workspace context", () => {
  it("rejects users without an SSO workspace membership", () => {
    const user: AuthUser = {
      id: "user-1",
      organizationName: "Northstar Labs",
      displayName: "techwu",
      role: "Founder",
      email: "techwu@example.com",
      isPlatformAdmin: false,
    };
    seedUser(user);

    expect(() => resolveCurrentWorkspaceContextForUserSync(user)).toThrow("auth.sso_no_workspace");
  });

  it("prefers existing user memberships instead of forcing default workspace", () => {
    const user: AuthUser = {
      id: "user-2",
      organizationName: "Northstar Labs",
      displayName: "Alex",
      role: "Member",
      email: "alex@example.com",
      isPlatformAdmin: false,
    };
    seedUser(user);

    const workspace = createWorkspaceSync({
      id: "sso-team-alex",
      slug: "sso-team-alex",
      name: "Alex Workspace",
      createdBy: user.id,
    });
    createWorkspaceMembershipSync({
      workspaceId: workspace.id,
      userId: user.id,
      role: "member",
    });

    const context = resolveCurrentWorkspaceContextForUserSync(user);

    expect(context.currentWorkspace.id).toBe("sso-team-alex");
    expect(context.currentMembership.workspaceId).toBe("sso-team-alex");
    expect(listUserWorkspacesSync(user.id)).toHaveLength(1);
    expect(listUserWorkspacesSync(user.id)[0]?.workspaceId).toBe("sso-team-alex");
  });

  it("uses the selected workspace when it belongs to the user", () => {
    const user: AuthUser = {
      id: "user-3",
      organizationName: "Northstar Labs",
      displayName: "Mina",
      role: "Owner",
      email: "mina@example.com",
      isPlatformAdmin: false,
    };
    seedUser(user);

    createWorkspaceSync({
      id: "sso-team-alpha",
      slug: "sso-team-alpha",
      name: "Alpha Workspace",
      createdBy: user.id,
    });
    createWorkspaceSync({
      id: "sso-team-beta",
      slug: "sso-team-beta",
      name: "Beta Workspace",
      createdBy: user.id,
    });
    createWorkspaceMembershipSync({
      workspaceId: "sso-team-alpha",
      userId: user.id,
      role: "owner",
    });
    createWorkspaceMembershipSync({
      workspaceId: "sso-team-beta",
      userId: user.id,
      role: "admin",
    });

    const context = resolveCurrentWorkspaceContextForUserSync(user, "sso-team-beta");

    expect(context.currentWorkspace.id).toBe("sso-team-beta");
    expect(context.currentWorkspace.slug).toBe("sso-team-beta");
    expect(context.currentMembership.workspaceId).toBe("sso-team-beta");
    expect(context.workspaces.map((workspace) => workspace.id)).toEqual(["sso-team-beta", "sso-team-alpha"]);
  });

  it("falls back to the next recent workspace when the latest selection is unavailable", () => {
    const user: AuthUser = {
      id: "user-3b",
      organizationName: "Northstar Labs",
      displayName: "Mina",
      role: "Owner",
      email: "mina-2@example.com",
      isPlatformAdmin: false,
    };
    seedUser(user);

    createWorkspaceSync({
      id: "sso-team-alpha-2",
      slug: "sso-team-alpha-2",
      name: "Alpha Workspace",
      createdBy: user.id,
    });
    createWorkspaceSync({
      id: "sso-team-beta-2",
      slug: "sso-team-beta-2",
      name: "Beta Workspace",
      createdBy: user.id,
    });
    createWorkspaceMembershipSync({
      workspaceId: "sso-team-alpha-2",
      userId: user.id,
      role: "owner",
    });
    createWorkspaceMembershipSync({
      workspaceId: "sso-team-beta-2",
      userId: user.id,
      role: "admin",
    });

    const context = resolveCurrentWorkspaceContextForUserSync(user, [
      "missing-workspace",
      "sso-team-beta-2",
      "sso-team-alpha-2",
    ]);

    expect(context.currentWorkspace.id).toBe("sso-team-beta-2");
    expect(context.currentWorkspace.slug).toBe("sso-team-beta-2");
    expect(context.currentMembership.workspaceId).toBe("sso-team-beta-2");
    expect(context.workspaces.map((workspace) => workspace.id)).toEqual([
      "sso-team-beta-2",
      "sso-team-alpha-2",
    ]);
  });

  it("returns not_found when the requested workspace does not exist", () => {
    const user: AuthUser = {
      id: "user-4",
      organizationName: "Northstar Labs",
      displayName: "Mina",
      role: "Owner",
      email: "mina@example.com",
      isPlatformAdmin: false,
    };
    seedUser(user);
    createSsoWorkspace(user.id, "sso-team-existing");

    const resolution = resolveWorkspaceAccessForIdentifierSync(user, "missing-workspace");

    expect(resolution.status).toBe("not_found");
  });

  it("returns forbidden when the user does not belong to the requested workspace", () => {
    const user: AuthUser = {
      id: "user-5",
      organizationName: "Northstar Labs",
      displayName: "Mina",
      role: "Owner",
      email: "mina@example.com",
      isPlatformAdmin: false,
    };
    seedUser(user);

    createWorkspaceSync({
      id: "sso-team-allowed",
      slug: "sso-team-allowed",
      name: "Allowed Workspace",
      createdBy: user.id,
    });
    createWorkspaceSync({
      id: "sso-team-locked",
      slug: "sso-team-locked",
      name: "Locked Workspace",
      createdBy: "other-user",
    });
    createWorkspaceMembershipSync({
      workspaceId: "sso-team-allowed",
      userId: user.id,
      role: "owner",
    });

    const resolution = resolveWorkspaceAccessForIdentifierSync(user, "sso-team-locked");

    expect(resolution.status).toBe("forbidden");
    if (resolution.status === "forbidden") {
      expect(resolution.workspaces.map((workspace) => workspace.id)).toEqual(["sso-team-allowed"]);
    }
  });
});

function seedUser(user: AuthUser): void {
  const now = new Date().toISOString();
  getDatabase().prepare(
    `INSERT INTO users (id, display_name, avatar_url, primary_email, created_at, updated_at, last_login_at)
     VALUES (?, ?, NULL, ?, ?, ?, NULL)`,
  ).run(user.id, user.displayName, user.email, now, now);
}

function createSsoWorkspace(userId: string, id: string): void {
  createWorkspaceSync({ id, slug: id, name: id, createdBy: userId });
  createWorkspaceMembershipSync({ workspaceId: id, userId, role: "member" });
}

import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  archiveWorkspaceSync,
  createWorkspaceSync,
  getDatabase,
  readWorkspaceSync,
  upsertWorkspaceSsoBindingSync,
  type StoredWorkspaceRecord,
  type WorkspaceSsoBindingRecord,
} from "@dofe-agent/db";
import {
  applySsoWorkspaceMaintenanceSync,
  assertSsoWorkspaceScopeConfirmation,
  assertUniqueWorkspaceSsoBindings,
  createSsoWorkspaceScopeDigest,
  isDisposableTestWorkspace,
  planSsoWorkspaceMaintenanceSync,
} from "./sso-workspace-maintenance";

const originalCwd = process.cwd();
const tempRoot = mkdtempSync(join(tmpdir(), "dofe-agent-sso-maintenance-"));

beforeAll(() => {
  writeFileSync(join(tempRoot, "Target.md"), "# test\n");
  mkdirSync(join(tempRoot, "data"), { recursive: true });
  process.chdir(tempRoot);
});

beforeEach(() => {
  const db = getDatabase();
  db.exec("DELETE FROM workspace_membership");
  db.exec("DELETE FROM workspace_sso_binding");
  db.exec("DELETE FROM workspace_snapshot");
  db.exec("DELETE FROM workspace");
  db.exec("DELETE FROM users");
});

afterAll(() => {
  process.chdir(originalCwd);
});

describe("SSO workspace maintenance", () => {
  it("requires apply confirmation for the exact authoritative scope set", () => {
    const activeWorkspaceIds = new Set(["sso-team-b", "sso-team-a"]);
    const digest = createSsoWorkspaceScopeDigest(activeWorkspaceIds);

    expect(digest).toMatch(/^[a-f0-9]{64}$/);
    expect(createSsoWorkspaceScopeDigest(new Set(["sso-team-a", "sso-team-b"]))).toBe(digest);
    expect(() => assertSsoWorkspaceScopeConfirmation(activeWorkspaceIds, undefined)).toThrow(
      /confirm-scope-digest/,
    );
    expect(() => assertSsoWorkspaceScopeConfirmation(activeWorkspaceIds, "wrong")).toThrow(
      /confirm-scope-digest/,
    );
    expect(() => assertSsoWorkspaceScopeConfirmation(activeWorkspaceIds, digest)).not.toThrow();
  });

  it("rejects duplicate team and tenant-only bindings", () => {
    expect(() => assertUniqueWorkspaceSsoBindings([
      bindingRecord({ workspaceId: "workspace-a", teamId: "team-duplicate" }),
      bindingRecord({ workspaceId: "workspace-b", teamId: "team-duplicate" }),
    ])).toThrow(/team-duplicate.*workspace-a.*workspace-b/);
    expect(() => assertUniqueWorkspaceSsoBindings([
      bindingRecord({ workspaceId: "workspace-a", tenantId: "tenant-duplicate", source: "tenant" }),
      bindingRecord({ workspaceId: "workspace-b", tenantId: "tenant-duplicate", source: "tenant" }),
    ])).toThrow(/tenant-duplicate.*workspace-a.*workspace-b/);
  });

  it("requires strict test identity and no SSO binding", () => {
    expect(isDisposableTestWorkspace(workspaceRecord({
      id: "sso-team-e2e-abc123-def456",
      name: "E2E Workspace abc123-def456",
    }), false)).toBe(true);
    expect(isDisposableTestWorkspace(workspaceRecord({
      id: "sso-team-real",
      name: "E2E Workspace customer",
    }), true)).toBe(false);
    expect(isDisposableTestWorkspace(workspaceRecord({
      id: "sso-team-e2e-abc123-def456",
      name: "Customer",
    }), false)).toBe(false);
    expect(isDisposableTestWorkspace(workspaceRecord({
      id: "sso-visual-check",
      name: "Loading Visual Check",
    }), false)).toBe(true);
  });

  it("plans without writing and applies archival and restoration idempotently", () => {
    seedBoundWorkspace("sso-team-active", "team-active");
    archiveWorkspaceSync("sso-team-active");
    seedBoundWorkspace("sso-team-stale", "team-stale");
    createWorkspaceSync({
      id: "sso-team-e2e-abc123-def456",
      slug: "sso-team-e2e-abc123-def456",
      name: "E2E Workspace abc123-def456",
      createdBy: "system",
    });
    createWorkspaceSync({
      id: "sso-team-customer",
      slug: "sso-team-customer",
      name: "Customer Workspace",
      createdBy: "system",
    });

    const plan = planSsoWorkspaceMaintenanceSync(new Set(["sso-team-active"]));

    expect(plan).toMatchObject({
      activeWorkspaceIds: ["sso-team-active"],
      archiveStaleBindingIds: ["sso-team-stale"],
      archiveTestWorkspaceIds: ["sso-team-e2e-abc123-def456"],
      restoreWorkspaceIds: ["sso-team-active"],
    });
    expect(readWorkspaceSync("sso-team-active")?.archivedAt).toBeTruthy();
    expect(readWorkspaceSync("sso-team-stale")?.archivedAt).toBeUndefined();
    expect(readWorkspaceSync("sso-team-e2e-abc123-def456")?.archivedAt).toBeUndefined();

    expect(applySsoWorkspaceMaintenanceSync(plan)).toEqual({
      archivedIds: ["sso-team-e2e-abc123-def456", "sso-team-stale"],
      restoredIds: ["sso-team-active"],
    });
    expect(readWorkspaceSync("sso-team-active")?.archivedAt).toBeUndefined();
    expect(readWorkspaceSync("sso-team-stale")?.archivedAt).toBeTruthy();
    expect(readWorkspaceSync("sso-team-e2e-abc123-def456")?.archivedAt).toBeTruthy();
    expect(readWorkspaceSync("sso-team-customer")?.archivedAt).toBeUndefined();

    expect(applySsoWorkspaceMaintenanceSync(plan)).toEqual({
      archivedIds: [],
      restoredIds: [],
    });
  });
});

function seedBoundWorkspace(workspaceId: string, teamId: string): void {
  createWorkspaceSync({
    id: workspaceId,
    slug: workspaceId,
    name: `Workspace ${teamId}`,
    createdBy: "system",
  });
  upsertWorkspaceSsoBindingSync({
    workspaceId,
    tenantId: `tenant-${teamId}`,
    tenantName: `Tenant ${teamId}`,
    teamId,
    teamName: `Team ${teamId}`,
    source: "team",
  });
}

function workspaceRecord(input: { id: string; name: string }): StoredWorkspaceRecord {
  return {
    id: input.id,
    slug: input.id,
    name: input.name,
    createdBy: "system",
    createdAt: "2026-08-05T00:00:00.000Z",
    updatedAt: "2026-08-05T00:00:00.000Z",
  };
}

function bindingRecord(input: {
  source?: "team" | "tenant";
  teamId?: string;
  tenantId?: string;
  workspaceId: string;
}): WorkspaceSsoBindingRecord {
  return {
    workspaceId: input.workspaceId,
    tenantId: input.tenantId ?? "tenant-default",
    tenantName: "Tenant",
    teamId: input.teamId,
    teamName: input.teamId ? "Team" : undefined,
    source: input.source ?? "team",
    syncedAt: "2026-08-05T00:00:00.000Z",
  };
}

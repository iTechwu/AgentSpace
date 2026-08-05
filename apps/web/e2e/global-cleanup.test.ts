import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  createWorkspaceSync,
  getDatabase,
  readWorkspaceSync,
  upsertWorkspaceSsoBindingSync,
} from "../../../packages/db/src/index.ts";
import { cleanupE2eWorkspacesSync } from "./global-cleanup";

const originalCwd = process.cwd();
const tempRoot = mkdtempSync(join(tmpdir(), "dofe-agent-e2e-cleanup-"));

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

describe("Playwright global workspace cleanup", () => {
  it("does nothing outside the isolated E2E environment", () => {
    seedE2eWorkspace("sso-team-e2e-abc123-def456", "E2E Workspace abc123-def456");

    expect(cleanupE2eWorkspacesSync({ DOFE_AGENT_E2E: "0" })).toEqual([]);
    expect(readWorkspaceSync("sso-team-e2e-abc123-def456")).not.toBeNull();
  });

  it("hard-deletes only strictly matched unbound E2E workspaces", () => {
    seedE2eWorkspace("sso-team-e2e-abc123-def456", "E2E Workspace abc123-def456");
    seedE2eWorkspace("sso-team-e2e-customer", "Customer Workspace");
    seedE2eWorkspace("sso-team-e2e-bound1-bound2", "E2E Workspace bound1-bound2");
    upsertWorkspaceSsoBindingSync({
      workspaceId: "sso-team-e2e-bound1-bound2",
      tenantId: "tenant-bound",
      tenantName: "Bound Tenant",
      teamId: "team-bound",
      teamName: "Bound Team",
      source: "team",
    });

    expect(cleanupE2eWorkspacesSync({ DOFE_AGENT_E2E: "1" })).toEqual([
      "sso-team-e2e-abc123-def456",
    ]);
    expect(readWorkspaceSync("sso-team-e2e-abc123-def456")).toBeNull();
    expect(readWorkspaceSync("sso-team-e2e-customer")).not.toBeNull();
    expect(readWorkspaceSync("sso-team-e2e-bound1-bound2")).not.toBeNull();
  });
});

function seedE2eWorkspace(id: string, name: string): void {
  createWorkspaceSync({ id, slug: id, name, createdBy: "system" });
}

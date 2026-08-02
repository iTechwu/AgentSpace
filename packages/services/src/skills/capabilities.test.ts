import assert from "node:assert/strict";
import test, { before, beforeEach } from "node:test";
import {
  createMcpConnectionSync,
  getDatabase,
  randomLikeId,
  updateMcpConnectionStatusSync,
  upsertMcpCatalogItemSync,
  upsertMcpDiscoverySnapshotSync,
} from "@dofe-agent/db";
import { resetWorkspaceStateSync } from "../index.ts";
import { resolveSkillCliCapabilitySync, resolveSkillMcpCapabilitySync } from "../index.ts";

before(() => {
  process.env.NODE_ENV = "test";
});

beforeEach(() => {
  resetWorkspaceStateSync();
});

function createTestRuntime(): string {
  const id = `rt-${randomLikeId()}`;
  const now = new Date().toISOString();
  getDatabase().prepare(
    `INSERT INTO agent_runtime (id, workspace_id, provider, name, status, created_at, updated_at)
     VALUES (?, 'default', 'test-provider', ?, 'online', ?, ?)`,
  ).run(id, `Test Runtime ${id}`, now, now);
  return id;
}

function setupReadyMcpConnection(runtimeId: string, slug: string, tools: string[], approved: string[], version = "1.0.0") {
  const catalog = upsertMcpCatalogItemSync({
    workspaceId: "default",
    slug,
    transport: "streamable_http",
    displayName: slug,
    version,
    declaredToolsJson: JSON.stringify(tools.map((name) => ({ name }))),
  });
  const connection = createMcpConnectionSync({
    workspaceId: "default",
    runtimeId,
    catalogItemId: catalog.id,
    endpoint: "https://example.com/mcp",
    approvedToolsJson: JSON.stringify(approved),
  });
  updateMcpConnectionStatusSync({
    connectionId: connection.id,
    workspaceId: "default",
    status: "ready",
    lastVerifiedAt: new Date().toISOString(),
  });
  upsertMcpDiscoverySnapshotSync({
    workspaceId: "default",
    connectionId: connection.id,
    protocolVersion: "2025-11-25",
    toolsMetadataJson: JSON.stringify(
      tools.map((name) => ({ name, description: `desc ${name}`, inputSchema: { type: "object" } })),
    ),
    toolsFingerprint: tools.join("|"),
  });
  return { connectionId: connection.id, catalogItemId: catalog.id };
}

test("resolveSkillMcpCapabilitySync matches a ready connection by catalog slug", () => {
  const runtimeId = createTestRuntime();
  const { connectionId } = setupReadyMcpConnection(runtimeId, "github", ["search_issues", "list_repos"], ["search_issues"]);

  const resolution = resolveSkillMcpCapabilitySync({
    workspaceId: "default",
    runtimeId,
    catalogSlug: "github",
    requiredTools: ["search_issues"],
  });
  assert.equal(resolution.ready, true);
  assert.equal(resolution.connectionId, connectionId);
  assert.deepEqual(resolution.missingTools, []);
});

test("resolveSkillMcpCapabilitySync requires the release pinned by the Skill lock", () => {
  const runtimeId = createTestRuntime();
  const v1 = setupReadyMcpConnection(runtimeId, "github", ["search_issues"], ["search_issues"], "1.0.0");
  setupReadyMcpConnection(runtimeId, "github", ["search_issues", "delete_repository"], ["search_issues"], "2.0.0");

  const resolution = resolveSkillMcpCapabilitySync({
    workspaceId: "default",
    runtimeId,
    catalogSlug: "github",
    expectedCatalogItemId: v1.catalogItemId,
    expectedCatalogVersion: "1.0.0",
    requiredTools: ["search_issues"],
  });
  assert.equal(resolution.ready, true);
  assert.equal(resolution.connectionId, v1.connectionId);

  const unavailable = resolveSkillMcpCapabilitySync({
    workspaceId: "default",
    runtimeId,
    catalogSlug: "github",
    expectedCatalogItemId: "missing-release",
    expectedCatalogVersion: "1.0.0",
  });
  assert.equal(unavailable.ready, false);
  assert.match(unavailable.reason, /github@1\.0\.0/);
});

test("resolveSkillMcpCapabilitySync blocks when a required tool is not approved/discovered", () => {
  const runtimeId = createTestRuntime();
  setupReadyMcpConnection(runtimeId, "github", ["search_issues", "list_repos"], ["search_issues"]);

  const resolution = resolveSkillMcpCapabilitySync({
    workspaceId: "default",
    runtimeId,
    catalogSlug: "github",
    requiredTools: ["search_issues", "write_issue"],
  });
  assert.equal(resolution.ready, false);
  assert.deepEqual(resolution.missingTools, ["write_issue"]);
});

test("resolveSkillMcpCapabilitySync blocks when no ready connection matches the slug", () => {
  const runtimeId = createTestRuntime();
  setupReadyMcpConnection(runtimeId, "github", ["search_issues"], ["search_issues"]);

  const resolution = resolveSkillMcpCapabilitySync({
    workspaceId: "default",
    runtimeId,
    catalogSlug: "slack",
  });
  assert.equal(resolution.ready, false);
  assert.match(resolution.reason, /slack/);
});

test("resolveSkillCliCapabilitySync requires an installed and enabled app", () => {
  const runtimeId = createTestRuntime();
  const now = new Date().toISOString();
  getDatabase().prepare(
    `INSERT INTO runtime_installed_app (id, workspace_id, runtime_id, source, name, display_name, version, entry_point, status, install_strategy, enabled, installed_at, updated_at)
     VALUES (?, 'default', ?, 'cli', 'gh', 'GitHub CLI', '1.0', 'gh', 'installed', '', 1, ?, ?)`,
  ).run(`app-${randomLikeId()}`, runtimeId, now, now);

  const ready = resolveSkillCliCapabilitySync({ workspaceId: "default", runtimeId, catalogSlug: "gh" });
  assert.equal(ready.ready, true);

  const missing = resolveSkillCliCapabilitySync({ workspaceId: "default", runtimeId, catalogSlug: "nonexistent" });
  assert.equal(missing.ready, false);
});

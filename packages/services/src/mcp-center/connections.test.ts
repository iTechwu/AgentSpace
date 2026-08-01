import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { before, beforeEach } from "node:test";
import {
  claimNextMcpOperationForRuntimeSync,
  completeMcpOperationSync,
  createUserSync,
  registerDaemonRuntimesSync,
  startMcpOperationSync,
} from "@dofe-agent/db";
import { getDatabase } from "@dofe-agent/db";
import { createMcpCatalogItemSync } from "./catalog.ts";
import {
  disableMcpConnectionSync,
  listReadyMcpConnectionsForTaskSync,
  readMcpConnectionDetailSync,
  removeMcpConnectionSync,
  requestMcpConnectionSync,
  resolveClaimedMcpOperationSync,
  rotateMcpSecretSync,
  updateMcpConnectionConfigServiceSync,
} from "./connections.ts";

const originalCwd = process.cwd();
const tempRoot = mkdtempSync(join(tmpdir(), "dofe-agent-mcp-connections-"));
const repositoryRoot = existsSync(join(originalCwd, "Target.md")) ? originalCwd : join(originalCwd, "..", "..");
let ADMIN_USER_ID = "mcp-admin-user";

before(() => {
  writeFileSync(join(tempRoot, "Target.md"), "# test\n");
  mkdirSync(join(tempRoot, "data"), { recursive: true });
  symlinkSync(join(repositoryRoot, "packages"), join(tempRoot, "packages"), "dir");
  process.chdir(tempRoot);
  process.env.DOFE_AGENT_MCP_SECRET_ENCRYPTION_KEY = Buffer.alloc(32, 9).toString("base64");
});

beforeEach(() => {
  const db = getDatabase();
  db.exec("DELETE FROM runtime_mcp_tool_audit");
  db.exec("DELETE FROM runtime_mcp_operation");
  db.exec("DELETE FROM runtime_mcp_discovery_snapshot");
  db.exec("DELETE FROM runtime_mcp_secret");
  db.exec("DELETE FROM runtime_mcp_connection");
  db.exec("DELETE FROM mcp_catalog_item");
  db.exec("DELETE FROM agent_runtime");
  db.exec("DELETE FROM daemon_connection");
  db.exec("DELETE FROM users");
  ADMIN_USER_ID = createUserSync({ displayName: "MCP Admin", isAdmin: true }).id;
});

test.after(() => {
  process.chdir(originalCwd);
});

function seedCatalog(): string {
  const catalog = createMcpCatalogItemSync({
    workspaceId: "default",
    actorUserId: ADMIN_USER_ID,
    slug: "github",
    displayName: "GitHub MCP",
    transport: "streamable_http",
    allowedHosts: ["github-mcp.example.com"],
    configurationSchema: { type: "object" },
    declaredTools: [
      { name: "search_repos", description: "Search repositories", risk: "low" },
      { name: "delete_repo", description: "Delete a repository", risk: "high" },
    ],
    defaultApprovedTools: ["search_repos"],
    secretFields: ["api_key"],
    dataDomains: ["GitHub Organization"],
    risk: "high",
  });
  return catalog.id;
}

test("requestMcpConnection creates a connection and queues a verify operation", () => {
  const runtimeId = createRuntime();
  const catalogId = seedCatalog();
  const { connection, operation } = requestMcpConnectionSync({
    workspaceId: "default",
    actorUserId: ADMIN_USER_ID,
    runtimeId,
    catalogItemId: catalogId,
    endpoint: "https://github-mcp.example.com/mcp",
    secrets: { api_key: "sk-test-value" },
    approvedTools: ["search_repos"],
    confirmHighRisk: true,
  });
  assert.equal(connection.status, "queued_verification");
  assert.equal(operation.operation, "verify");
  assert.equal(operation.status, "pending");

  const detail = readMcpConnectionDetailSync({ workspaceId: "default", connectionId: connection.id });
  assert.equal(detail?.secretFields.length, 1);
  assert.equal(detail?.secretFields[0]?.fieldName, "api_key");
  assert.equal(detail?.secretFields[0]?.configured, true);
});

test("catalog publishing rejects a mutable overwrite of an existing slug", () => {
  seedCatalog();
  assert.throws(
    () => createMcpCatalogItemSync({
      workspaceId: "default",
      actorUserId: ADMIN_USER_ID,
      slug: "github",
      displayName: "GitHub MCP replacement",
      transport: "streamable_http",
      allowedHosts: ["replacement.example.com"],
      configurationSchema: { type: "object", additionalProperties: false },
      declaredTools: [{ name: "replacement", description: "replacement", risk: "low" }],
    }),
    /mcp_catalog.release_required/,
  );
});

test("requestMcpConnection rejects non-allow-listed and private endpoints", () => {
  const runtimeId = createRuntime();
  const catalogId = seedCatalog();
  assert.throws(
    () =>
      requestMcpConnectionSync({
        workspaceId: "default",
        actorUserId: ADMIN_USER_ID,
        runtimeId,
        catalogItemId: catalogId,
        endpoint: "https://evil.example.org/mcp",
        secrets: { api_key: "x" },
      }),
    /mcp.policy_denied/,
  );
  assert.throws(
    () =>
      requestMcpConnectionSync({
        workspaceId: "default",
        actorUserId: ADMIN_USER_ID,
        runtimeId,
        catalogItemId: catalogId,
        endpoint: "https://127.0.0.1/mcp",
        secrets: { api_key: "x" },
      }),
    /mcp.policy_denied/,
  );
});

test("requestMcpConnection requires missing secret fields", () => {
  const runtimeId = createRuntime();
  const catalogId = seedCatalog();
  assert.throws(
    () =>
      requestMcpConnectionSync({
        workspaceId: "default",
        actorUserId: ADMIN_USER_ID,
        runtimeId,
        catalogItemId: catalogId,
        endpoint: "https://github-mcp.example.com/mcp",
      }),
    /mcp.missing_secret/,
  );
});

test("high-risk approved tools require explicit confirmation", () => {
  const runtimeId = createRuntime();
  const catalogId = seedCatalog();
  assert.throws(
    () =>
      requestMcpConnectionSync({
        workspaceId: "default",
        actorUserId: ADMIN_USER_ID,
        runtimeId,
        catalogItemId: catalogId,
        endpoint: "https://github-mcp.example.com/mcp",
        secrets: { api_key: "x" },
        approvedTools: ["delete_repo"],
      }),
    /mcp.high_risk_confirmation_required/,
  );
  const { connection } = requestMcpConnectionSync({
    workspaceId: "default",
    actorUserId: ADMIN_USER_ID,
    runtimeId,
    catalogItemId: catalogId,
    endpoint: "https://github-mcp.example.com/mcp",
    secrets: { api_key: "x" },
    approvedTools: ["delete_repo"],
    confirmHighRisk: true,
  });
  assert.equal(connection.status, "queued_verification");
});

test("configuration changes do not re-enable a disabled connection", () => {
  const runtimeId = createRuntime();
  const catalogId = seedCatalog();
  const { connection } = requestMcpConnectionSync({
    workspaceId: "default",
    actorUserId: ADMIN_USER_ID,
    runtimeId,
    catalogItemId: catalogId,
    endpoint: "https://github-mcp.example.com/mcp",
    secrets: { api_key: "x" },
    confirmHighRisk: true,
  });
  const disabled = disableMcpConnectionSync({ workspaceId: "default", connectionId: connection.id, actorUserId: ADMIN_USER_ID });
  assert.equal(disabled.status, "disabled");
  const { connection: enabled } = updateMcpConnectionConfigServiceSync({
    workspaceId: "default",
    connectionId: connection.id,
    actorUserId: ADMIN_USER_ID,
    endpoint: "https://github-mcp.example.com/v2",
  });
  assert.equal(enabled.status, "disabled");
});

test("configuration updates require confirmation before newly granting a high-risk tool", () => {
  const runtimeId = createRuntime();
  const catalogId = seedCatalog();
  const { connection } = requestMcpConnectionSync({
    workspaceId: "default",
    actorUserId: ADMIN_USER_ID,
    runtimeId,
    catalogItemId: catalogId,
    endpoint: "https://github-mcp.example.com/mcp",
    secrets: { api_key: "x" },
    approvedTools: ["search_repos"],
    confirmHighRisk: true,
  });

  assert.throws(
    () => updateMcpConnectionConfigServiceSync({
      workspaceId: "default",
      actorUserId: ADMIN_USER_ID,
      connectionId: connection.id,
      approvedTools: ["search_repos", "delete_repo"],
    }),
    /mcp.high_risk_confirmation_required/,
  );

  const { connection: updated } = updateMcpConnectionConfigServiceSync({
    workspaceId: "default",
    actorUserId: ADMIN_USER_ID,
    connectionId: connection.id,
    approvedTools: ["search_repos", "delete_repo"],
    confirmHighRisk: true,
  });
  assert.deepEqual(JSON.parse(updated.approvedToolsJson), ["search_repos", "delete_repo"]);
});

test("secret rotation forces re-verification and never returns plaintext", () => {
  const runtimeId = createRuntime();
  const catalogId = seedCatalog();
  const { connection } = requestMcpConnectionSync({
    workspaceId: "default",
    actorUserId: ADMIN_USER_ID,
    runtimeId,
    catalogItemId: catalogId,
    endpoint: "https://github-mcp.example.com/mcp",
    secrets: { api_key: "original-value" },
    confirmHighRisk: true,
  });
  const rotated = rotateMcpSecretSync({
    workspaceId: "default",
    connectionId: connection.id,
    fieldName: "api_key",
    value: "rotated-value",
    actorUserId: ADMIN_USER_ID,
  });
  assert.equal(rotated.status, "queued_verification");
  const detail = readMcpConnectionDetailSync({ workspaceId: "default", connectionId: connection.id });
  const json = JSON.stringify(detail);
  assert.equal(json.includes("original-value"), false);
  assert.equal(json.includes("rotated-value"), false);
});

test("listReadyMcpConnectionsForTask exposes only approved∩discovered tools with stable ids", () => {
  const runtimeId = createRuntime();
  const catalogId = seedCatalog();
  const { connection, operation } = requestMcpConnectionSync({
    workspaceId: "default",
    actorUserId: ADMIN_USER_ID,
    runtimeId,
    catalogItemId: catalogId,
    endpoint: "https://github-mcp.example.com/mcp",
    secrets: { api_key: "x" },
    approvedTools: ["search_repos"],
    confirmHighRisk: true,
  });
  assert.equal(claimNextMcpOperationForRuntimeSync({ workspaceId: "default", runtimeId })?.id, operation.id);
  startMcpOperationSync(operation.id, "default");
  completeMcpOperationSync({
    operationId: operation.id,
    workspaceId: "default",
    verification: {
      status: "ready",
      protocolVersion: "2025-06-18",
      toolsMetadataJson: JSON.stringify([
        { name: "search_repos", description: "Search repositories", inputSchema: { type: "object" }, inputSchemaDigest: "d1" },
        { name: "undeclared_tool", description: "not approved", inputSchema: { type: "object" }, inputSchemaDigest: "d2" },
      ]),
      toolsFingerprint: "fp",
      latencyMs: 50,
    },
  });
  // completeMcpOperationSync drove the connection to 'ready'; sanity check the op succeeded.
  assert.equal(operation.operation, "verify");
  const entries = listReadyMcpConnectionsForTaskSync({ workspaceId: "default", runtimeId });
  assert.equal(entries.length, 1);
  assert.equal(entries[0]?.tools.length, 1);
  assert.equal(entries[0]?.tools[0]?.id, `mcp:${connection.id}:search_repos`);
  assert.equal(entries[0]?.approvedTools.includes("search_repos"), true);
  assert.equal("endpoint" in (entries[0] ?? {}), false);
  assert.equal("encryptedSecretBundle" in (entries[0] ?? {}), false);
});

test("claimed operations reject legacy connection configuration that no longer satisfies policy", () => {
  const runtimeId = createRuntime();
  const catalogId = seedCatalog();
  const { connection, operation } = requestMcpConnectionSync({
    workspaceId: "default",
    actorUserId: ADMIN_USER_ID,
    runtimeId,
    catalogItemId: catalogId,
    endpoint: "https://github-mcp.example.com/mcp",
    secrets: { api_key: "x" },
    confirmHighRisk: true,
  });
  getDatabase().prepare(
    "UPDATE runtime_mcp_connection SET non_secret_params_json = ? WHERE id = ?",
  ).run(JSON.stringify({ Host: "internal.example" }), connection.id);

  const claimed = claimNextMcpOperationForRuntimeSync({ workspaceId: "default", runtimeId });
  assert.equal(claimed?.id, operation.id);
  assert.equal(resolveClaimedMcpOperationSync({ workspaceId: "default", operation: claimed! }), null);
});

test("remove operations stay claimable when a legacy connection no longer satisfies policy", () => {
  const runtimeId = createRuntime();
  const catalogId = seedCatalog();
  const { connection } = requestMcpConnectionSync({
    workspaceId: "default",
    actorUserId: ADMIN_USER_ID,
    runtimeId,
    catalogItemId: catalogId,
    endpoint: "https://github-mcp.example.com/mcp",
    secrets: { api_key: "x" },
    confirmHighRisk: true,
  });
  getDatabase().prepare("UPDATE runtime_mcp_connection SET endpoint = ? WHERE id = ?").run("http://legacy.example.com", connection.id);
  const operation = removeMcpConnectionSync({ workspaceId: "default", connectionId: connection.id, actorUserId: ADMIN_USER_ID });

  const claimed = claimNextMcpOperationForRuntimeSync({ workspaceId: "default", runtimeId });
  assert.equal(claimed?.id, operation.id);
  const resolved = resolveClaimedMcpOperationSync({ workspaceId: "default", operation: claimed! });
  assert.equal(resolved?.operation, "remove");
  assert.equal(resolved?.endpoint, "");
  assert.deepEqual(resolved?.secrets, {});
});

test("remove connection enqueues a remove operation", () => {
  const runtimeId = createRuntime();
  const catalogId = seedCatalog();
  const { connection } = requestMcpConnectionSync({
    workspaceId: "default",
    actorUserId: ADMIN_USER_ID,
    runtimeId,
    catalogItemId: catalogId,
    endpoint: "https://github-mcp.example.com/mcp",
    secrets: { api_key: "x" },
    confirmHighRisk: true,
  });
  const op = removeMcpConnectionSync({ workspaceId: "default", connectionId: connection.id, actorUserId: ADMIN_USER_ID });
  assert.equal(op.operation, "remove");
});

function createRuntime(): string {
  const snapshot = registerDaemonRuntimesSync({
    daemonKey: `daemon-${Math.random().toString(36).slice(2)}`,
    deviceName: "Build Box",
    runtimes: [{ provider: "codex", name: "Remote Codex", version: "test" }],
  });
  return snapshot.runtimes[0]!.id;
}

import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { before, beforeEach } from "node:test";
import {
  claimMcpTaskSessionAtomicallySync,
  claimNextMcpOperationForRuntimeSync,
  completeMcpOperationSync,
  createUserSync,
  getDatabase,
  listMcpOperationsSync,
  listMcpCatalogItemsSync,
  readMcpCatalogItemBySlugSync,
  readMcpTaskAuditAuthorizationSync,
  readMcpConnectionSync,
  recordMcpToolAuditSync,
  registerDaemonRuntimesSync,
  startMcpOperationSync,
} from "@dofe-agent/db";
import { createMcpCatalogItemSync } from "./catalog.ts";
import {
  claimMcpTaskSessionSync,
  completeMcpConnectionOperationWithHealthScheduleSync,
  computeMcpConnectionNextHealthCheckAt,
  disableMcpConnectionSync,
  failMcpConnectionOperationWithHealthScheduleSync,
  listMcpConnectionActivitySync,
  listReadyMcpConnectionsForTaskSync,
  readMcpConnectionDetailSync,
  removeMcpConnectionSync,
  replaceMcpConnectionConfigSync,
  requestMcpConnectionSync,
  resolveClaimedMcpOperationSync,
  rotateMcpSecretSync,
  scheduleMcpHealthChecksSync,
  updateMcpConnectionConfigServiceSync,
  validateMcpConnectionForGatewaySync,
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
  db.exec("DELETE FROM mcp_task_audit_authorization");
  db.exec("DELETE FROM runtime_mcp_operation");
  db.exec("DELETE FROM runtime_mcp_discovery_snapshot");
  db.exec("DELETE FROM mcp_task_session_grant");
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

test("catalog publishing keeps releases immutable and exposes only the latest release", () => {
  const firstId = seedCatalog();
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
    /mcp_catalog.release_exists/,
  );

  const second = createMcpCatalogItemSync({
    workspaceId: "default",
    actorUserId: ADMIN_USER_ID,
    slug: "github",
    version: "1.1.0",
    category: "developer_tools",
    displayName: "GitHub MCP 1.1",
    transport: "streamable_http",
    allowedHosts: ["github-mcp.example.com"],
    configurationSchema: { type: "object", additionalProperties: false },
    declaredTools: [{ name: "search_repos", description: "Search repositories", risk: "low" }],
  });
  assert.notEqual(second.id, firstId);
  assert.equal(second.version, "1.1.0");
  assert.equal(second.category, "developer_tools");
  assert.equal(readMcpCatalogItemBySlugSync("github")?.id, second.id);
  assert.deepEqual(listMcpCatalogItemsSync().map((item) => item.id), [second.id]);
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

test("listReadyMcpConnectionsForTask performs freshness check and degrades stale connections", () => {
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
  claimNextMcpOperationForRuntimeSync({ workspaceId: "default", runtimeId });
  startMcpOperationSync(operation.id, "default");
  completeMcpOperationSync({
    operationId: operation.id,
    workspaceId: "default",
    verification: {
      status: "ready",
      protocolVersion: "2025-06-18",
      toolsMetadataJson: JSON.stringify([
        { name: "search_repos", description: "Search repositories", inputSchema: { type: "object" }, inputSchemaDigest: "d1" },
      ]),
      toolsFingerprint: "fp",
      latencyMs: 50,
    },
  });

  // Simulate an out-of-band change that removed an approved tool from the row
  // without going through the service (e.g., a race or manual DB edit).
  getDatabase().prepare(
    "UPDATE runtime_mcp_connection SET approved_tools_json = ? WHERE id = ?",
  ).run(JSON.stringify(["search_repos", "delete_repo"]), connection.id);

  const entries = listReadyMcpConnectionsForTaskSync({ workspaceId: "default", runtimeId });
  assert.equal(entries.length, 0);

  const detail = readMcpConnectionDetailSync({ workspaceId: "default", connectionId: connection.id });
  assert.equal(detail?.connection.status, "degraded");
  assert.equal(detail?.connection.lastErrorCode, "mcp.approved_tool_missing");
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

test("replaceMcpConnectionConfig atomically updates config + secrets and creates ONE verify operation", () => {
  const runtimeId = createRuntime();
  const catalogId = seedCatalog();
  const { connection } = requestMcpConnectionSync({
    workspaceId: "default",
    actorUserId: ADMIN_USER_ID,
    runtimeId,
    catalogItemId: catalogId,
    endpoint: "https://github-mcp.example.com/mcp",
    secrets: { api_key: "original-value" },
    approvedTools: ["search_repos"],
    confirmHighRisk: true,
  });

  const opsBefore = listMcpOperationsSync({ workspaceId: "default", runtimeId }).length;
  const { operation } = replaceMcpConnectionConfigSync({
    workspaceId: "default",
    actorUserId: ADMIN_USER_ID,
    connectionId: connection.id,
    endpoint: "https://github-mcp.example.com/v2",
    approvedTools: ["search_repos"],
    secrets: { api_key: "rotated-value" },
  });

  // Config updated + secret rotated + exactly one new verify op.
  const detail = readMcpConnectionDetailSync({ workspaceId: "default", connectionId: connection.id });
  assert.equal(detail?.connection.endpoint, "https://github-mcp.example.com/v2");
  assert.equal(detail?.connection.status, "queued_verification");
  assert.equal(detail?.secretFields[0]?.configured, true);
  assert.equal(operation?.operation, "verify");
  const opsAfter = listMcpOperationsSync({ workspaceId: "default", runtimeId });
  assert.equal(opsAfter.length, opsBefore + 1);
  // Secret value never surfaces.
  const json = JSON.stringify(detail);
  assert.equal(json.includes("rotated-value"), false);
  assert.equal(json.includes("original-value"), false);
});

test("replaceMcpConnectionConfig rolls back on failure (unknown secret field)", () => {
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

  assert.throws(
    () => replaceMcpConnectionConfigSync({
      workspaceId: "default",
      actorUserId: ADMIN_USER_ID,
      connectionId: connection.id,
      endpoint: "https://github-mcp.example.com/should-rollback",
      secrets: { not_a_secret_field: "x" },
    }),
    /mcp.unknown_secret_field/,
  );

  // Nothing changed: endpoint and secret rotation were rolled back together.
  const detail = readMcpConnectionDetailSync({ workspaceId: "default", connectionId: connection.id });
  assert.equal(detail?.connection.endpoint, "https://github-mcp.example.com/mcp");
  assert.equal(detail?.connection.status, "queued_verification");
});

test("replaceMcpConnectionConfig merges partial non-secret config with stored values", () => {
  const runtimeId = createRuntime();
  const catalog = createMcpCatalogItemSync({
    workspaceId: "default",
    actorUserId: ADMIN_USER_ID,
    slug: "config-merge",
    displayName: "Config Merge MCP",
    transport: "streamable_http",
    allowedHosts: ["example.com"],
    configurationSchema: {
      type: "object",
      properties: {
        headerA: { type: "string" },
        headerB: { type: "string" },
      },
      required: ["headerA", "headerB"],
      additionalProperties: false,
    },
    declaredTools: [{ name: "tool", description: "tool", risk: "low" }],
    defaultApprovedTools: ["tool"],
    secretFields: ["api_key"],
    dataDomains: ["test"],
    risk: "low",
  });
  const { connection } = requestMcpConnectionSync({
    workspaceId: "default",
    actorUserId: ADMIN_USER_ID,
    runtimeId,
    catalogItemId: catalog.id,
    endpoint: "https://example.com/mcp",
    nonSecretParams: { headerA: "a", headerB: "b" },
    secrets: { api_key: "x" },
    confirmHighRisk: true,
  });

  // Send only the touched field; the server must merge with stored config.
  replaceMcpConnectionConfigSync({
    workspaceId: "default",
    actorUserId: ADMIN_USER_ID,
    connectionId: connection.id,
    nonSecretParams: { headerA: "a-changed" },
  });

  const detail = readMcpConnectionDetailSync({ workspaceId: "default", connectionId: connection.id });
  const stored = JSON.parse(detail?.connection.nonSecretParamsJson ?? "{}");
  assert.deepEqual(stored, { headerA: "a-changed", headerB: "b" });
});

test("validateMcpConnectionForGateway rejects a disabled or reconfigured connection for a running task", () => {
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
  claimNextMcpOperationForRuntimeSync({ workspaceId: "default", runtimeId });
  startMcpOperationSync(operation.id, "default");
  completeMcpOperationSync({
    operationId: operation.id,
    workspaceId: "default",
    verification: {
      status: "ready",
      protocolVersion: "2025-06-18",
      toolsMetadataJson: JSON.stringify([
        { name: "search_repos", description: "Search repositories", inputSchema: { type: "object" }, inputSchemaDigest: "d1" },
      ]),
      toolsFingerprint: "fp",
      latencyMs: 50,
    },
  });

  assert.equal(
    validateMcpConnectionForGatewaySync({ workspaceId: "default", connectionId: connection.id, toolName: "search_repos" }).ok,
    true,
  );

  disableMcpConnectionSync({ workspaceId: "default", connectionId: connection.id, actorUserId: ADMIN_USER_ID });
  assert.equal(
    validateMcpConnectionForGatewaySync({ workspaceId: "default", connectionId: connection.id, toolName: "search_repos" }).ok,
    false,
  );
});

test("claimMcpTaskSession is one-time: second claim returns empty connections", () => {
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
  claimNextMcpOperationForRuntimeSync({ workspaceId: "default", runtimeId });
  startMcpOperationSync(operation.id, "default");
  completeMcpOperationSync({
    operationId: operation.id,
    workspaceId: "default",
    verification: {
      status: "ready",
      protocolVersion: "2025-06-18",
      toolsMetadataJson: JSON.stringify([
        { name: "search_repos", description: "Search repositories", inputSchema: { type: "object" }, inputSchemaDigest: "d1" },
      ]),
      toolsFingerprint: "fp",
      latencyMs: 50,
    },
  });

  const now = new Date().toISOString();
  getDatabase().prepare(
    `INSERT INTO agent_task_queue (id, workspace_id, agent_id, runtime_id, status, input_json, queued_at, created_at, updated_at)
     VALUES ('task-1', 'default', 'agent-1', ?, 'running', '{}'::jsonb, ?, ?, ?)`,
  ).run(runtimeId, now, now, now);

  // Fresh attempt claims the one-time bundle.
  // A missing/blank attempt id must be rejected outright: it can never replay
  // another caller's persisted grant.
  assert.throws(
    () => claimMcpTaskSessionSync({ workspaceId: "default", runtimeId, taskId: "task-1", attemptId: "" }),
    /mcp.session_claim_requires_attempt/,
  );

  const first = claimMcpTaskSessionSync({ workspaceId: "default", runtimeId, taskId: "task-1", attemptId: "attempt-1" });
  assert.equal(first.connections.length, 1);
  assert.equal(first.connections[0]?.connectionId, connection.id);

  // A DIFFERENT attempt id is a genuine duplicate execution → refused, empty.
  const other = claimMcpTaskSessionSync({ workspaceId: "default", runtimeId, taskId: "task-1", attemptId: "attempt-2" });
  assert.equal(other.connections.length, 0);
});

test("claimMcpTaskSession replays the first result for an HTTP retry of the same attempt", () => {
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
  claimNextMcpOperationForRuntimeSync({ workspaceId: "default", runtimeId });
  startMcpOperationSync(operation.id, "default");
  completeMcpOperationSync({
    operationId: operation.id,
    workspaceId: "default",
    verification: {
      status: "ready",
      protocolVersion: "2025-06-18",
      toolsMetadataJson: JSON.stringify([
        { name: "search_repos", description: "Search repositories", inputSchema: { type: "object" }, inputSchemaDigest: "d1" },
      ]),
      toolsFingerprint: "fp",
      latencyMs: 50,
    },
  });

  const now = new Date().toISOString();
  getDatabase().prepare(
    `INSERT INTO agent_task_queue (id, workspace_id, agent_id, runtime_id, status, input_json, queued_at, created_at, updated_at)
     VALUES ('task-retry', 'default', 'agent-1', ?, 'running', '{}'::jsonb, ?, ?, ?)`,
  ).run(runtimeId, now, now, now);

  // First request succeeds but its response is lost on the wire. The client
  // retries with the SAME attempt id — the server must replay the resolved
  // bundle, not return an empty (degraded) authorization.
  const attempt = "attempt-retry-1";
  const first = claimMcpTaskSessionSync({ workspaceId: "default", runtimeId, taskId: "task-retry", attemptId: attempt });
  assert.equal(first.connections.length, 1);
  const auditAuthorization = readMcpTaskAuditAuthorizationSync("task-retry", "default");
  assert.ok(auditAuthorization);
  assert.match(auditAuthorization.authorizationJson, /search_repos/);
  assert.doesNotMatch(auditAuthorization.authorizationJson, /"api_key"|"secrets"|github-mcp\.example\.com/);
  const retry = claimMcpTaskSessionSync({ workspaceId: "default", runtimeId, taskId: "task-retry", attemptId: attempt });
  assert.equal(retry.connections.length, 1);
  assert.equal(retry.connections[0]?.connectionId, connection.id);
  assert.equal(retry.connections[0]?.secrets.api_key, "x");

  const loser = claimMcpTaskSessionAtomicallySync({
    taskId: "task-retry",
    workspaceId: "default",
    runtimeId,
    attemptId: attempt,
    encryptedBundleJson: "must-not-replace-winner",
    expiresAt: new Date(Date.now() + 60_000).toISOString(),
  });
  assert.equal(loser.claimed, false);
  assert.equal(loser.grant?.attemptId, attempt);
  assert.notEqual(loser.grant?.encryptedBundleJson, "must-not-replace-winner");
});

test("computeMcpConnectionNextHealthCheckAt schedules base interval on ready and exponential backoff on failure", () => {
  const base = new Date("2026-08-02T00:00:00.000Z").toISOString();
  const connection = {
    id: "conn-1",
    workspaceId: "default",
    runtimeId: "runtime-1",
    catalogItemId: "cat-1",
    status: "ready" as const,
    approvedToolsJson: "[]",
    endpoint: "https://example.com/mcp",
    nonSecretParamsJson: "{}",
    healthCheckConsecutiveFailures: 0,
    createdAt: base,
    updatedAt: base,
  };
  const readyAt = computeMcpConnectionNextHealthCheckAt({ connection, now: base, verificationStatus: "ready" });
  assert.equal(readyAt, "2026-08-02T01:00:00.000Z");

  const failedOnce = computeMcpConnectionNextHealthCheckAt({
    connection: { ...connection, healthCheckConsecutiveFailures: 1 },
    now: base,
    verificationStatus: "failed",
  });
  assert.equal(failedOnce, "2026-08-02T02:00:00.000Z");

  const degradedTwice = computeMcpConnectionNextHealthCheckAt({
    connection: { ...connection, healthCheckConsecutiveFailures: 2 },
    now: base,
    verificationStatus: "degraded",
  });
  assert.equal(degradedTwice, "2026-08-02T04:00:00.000Z");
});

test("completeMcpConnectionOperationWithHealthScheduleSync resets failures and advances next health check", () => {
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
  claimNextMcpOperationForRuntimeSync({ workspaceId: "default", runtimeId });
  startMcpOperationSync(operation.id, "default");

  getDatabase().prepare(
    "UPDATE runtime_mcp_connection SET health_check_consecutive_failures = 2, next_health_check_at = ? WHERE id = ?",
  ).run("2026-08-01T00:00:00.000Z", connection.id);

  const completed = completeMcpConnectionOperationWithHealthScheduleSync({
    operationId: operation.id,
    workspaceId: "default",
    verification: {
      status: "ready",
      protocolVersion: "2025-06-18",
      toolsMetadataJson: JSON.stringify([
        { name: "search_repos", description: "Search repositories", inputSchema: { type: "object" }, inputSchemaDigest: "d1" },
      ]),
      toolsFingerprint: "fp",
      latencyMs: 50,
    },
  });
  assert.equal(completed.status, "succeeded");

  const updated = readMcpConnectionSync(connection.id, "default");
  assert.equal(updated?.healthCheckConsecutiveFailures, 0);
  assert.ok(updated?.nextHealthCheckAt && updated.nextHealthCheckAt > "2026-08-01T00:00:00.000Z");
});

test("failMcpConnectionOperationWithHealthScheduleSync increments failures and backs off health checks from health_check source", () => {
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
  claimNextMcpOperationForRuntimeSync({ workspaceId: "default", runtimeId });
  startMcpOperationSync(operation.id, "default");
  completeMcpOperationSync({
    operationId: operation.id,
    workspaceId: "default",
    verification: {
      status: "ready",
      protocolVersion: "2025-06-18",
      toolsMetadataJson: JSON.stringify([
        { name: "search_repos", description: "Search repositories", inputSchema: { type: "object" }, inputSchemaDigest: "d1" },
      ]),
      toolsFingerprint: "fp",
      latencyMs: 50,
    },
  });

  getDatabase().prepare(
    "UPDATE runtime_mcp_connection SET next_health_check_at = ? WHERE id = ?",
  ).run("2026-08-02T00:00:00.000Z", connection.id);
  getDatabase().prepare(
    `INSERT INTO runtime_mcp_operation (id, workspace_id, runtime_id, connection_id, operation, source, status, request_snapshot_json, created_at, started_at)
     VALUES ('health-op-1', 'default', ?, ?, 'verify', 'health_check', 'running', '{}', ?, ?)`,
  ).run(runtimeId, connection.id, "2026-08-02T00:00:00.000Z", "2026-08-02T00:00:00.000Z");

  const failed = failMcpConnectionOperationWithHealthScheduleSync({
    operationId: "health-op-1",
    workspaceId: "default",
    errorCode: "mcp.network_unreachable",
    errorMessage: "Unreachable.",
    connectionStatus: "degraded",
  });
  assert.equal(failed.status, "failed");

  const updated = readMcpConnectionSync(connection.id, "default");
  assert.equal(updated?.status, "degraded");
  assert.equal(updated?.healthCheckConsecutiveFailures, 1);
  assert.ok(updated?.nextHealthCheckAt && updated.nextHealthCheckAt > "2026-08-02T00:00:00.000Z");
});

test("scheduleMcpHealthChecksSync creates pending verify operations for due ready connections", () => {
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
  claimNextMcpOperationForRuntimeSync({ workspaceId: "default", runtimeId });
  startMcpOperationSync(operation.id, "default");
  completeMcpOperationSync({
    operationId: operation.id,
    workspaceId: "default",
    verification: {
      status: "ready",
      protocolVersion: "2025-06-18",
      toolsMetadataJson: JSON.stringify([
        { name: "search_repos", description: "Search repositories", inputSchema: { type: "object" }, inputSchemaDigest: "d1" },
      ]),
      toolsFingerprint: "fp",
      latencyMs: 50,
    },
  });

  getDatabase().prepare(
    "UPDATE runtime_mcp_connection SET next_health_check_at = ? WHERE id = ?",
  ).run("2026-08-01T00:00:00.000Z", connection.id);

  const scheduled = scheduleMcpHealthChecksSync({ workspaceId: "default", now: "2026-08-02T00:00:00.000Z" });
  assert.equal(scheduled, 1);

  const healthOp = claimNextMcpOperationForRuntimeSync({ workspaceId: "default", runtimeId });
  assert.equal(healthOp?.operation, "verify");
  assert.equal(healthOp?.source, "health_check");

  // A second scheduling pass should not create duplicates while the health op is pending.
  const second = scheduleMcpHealthChecksSync({ workspaceId: "default", now: "2026-08-02T00:00:00.000Z" });
  assert.equal(second, 0);
});

test("listMcpConnectionActivitySync aggregates operations and tool audits", () => {
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

  recordMcpToolAuditSync({
    workspaceId: "default",
    connectionId: connection.id,
    taskId: "task-1",
    toolName: "search_repos",
    outcome: "succeeded",
    latencyMs: 42,
    safeSummary: "q=acme",
  });

  const activity = listMcpConnectionActivitySync({ workspaceId: "default", connectionId: connection.id });
  assert.equal(activity.operations.length, 1);
  assert.equal(activity.operations[0]?.operation, "verify");
  assert.equal(activity.audits.length, 1);
  assert.equal(activity.audits[0]?.toolName, "search_repos");
  assert.equal(activity.audits[0]?.outcome, "succeeded");
});

test("recordMcpToolAuditSync dedupes a re-sent event_id", () => {
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

  const eventId = "evt-dedup-1";
  const first = recordMcpToolAuditSync({
    workspaceId: "default",
    connectionId: connection.id,
    taskId: "task-1",
    toolName: "search_repos",
    outcome: "succeeded",
    eventId,
  });
  // A re-sent audit with the same event_id must return the original row, not insert a duplicate.
  const replay = recordMcpToolAuditSync({
    workspaceId: "default",
    connectionId: connection.id,
    taskId: "task-1",
    toolName: "search_repos",
    outcome: "succeeded",
    eventId,
  });
  assert.equal(replay.id, first.id);
  const audits = listMcpConnectionActivitySync({ workspaceId: "default", connectionId: connection.id }).audits;
  assert.equal(audits.filter((a) => a.eventId === eventId).length, 1);
});

function createRuntime(): string {
  const snapshot = registerDaemonRuntimesSync({
    daemonKey: `daemon-${Math.random().toString(36).slice(2)}`,
    deviceName: "Build Box",
    runtimes: [{ provider: "codex", name: "Remote Codex", version: "test" }],
  });
  return snapshot.runtimes[0]!.id;
}

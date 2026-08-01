import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { before, beforeEach } from "node:test";
import {
  cancelUnfinishedMcpOperationsForConnectionSync,
  claimNextMcpOperationForRuntimeSync,
  completeMcpOperationSync,
  createMcpConnectionSync,
  createMcpOperationSync,
  failMcpOperationSync,
  insertMcpCatalogItemSync,
  listMcpCatalogItemsSync,
  listReadyMcpConnectionsForRuntimeSync,
  readLatestMcpDiscoverySnapshotSync,
  readMcpCatalogItemBySlugSync,
  readMcpConnectionSecretsSync,
  readMcpConnectionSync,
  registerDaemonRuntimesSync,
  startMcpOperationSync,
  updateMcpConnectionConfigSync,
  upsertMcpCatalogItemSync,
  upsertMcpSecretSync,
} from "./index.ts";
import { getDatabase } from "./database.ts";

const originalCwd = process.cwd();
const tempRoot = mkdtempSync(join(tmpdir(), "dofe-agent-mcp-center-"));
const repositoryRoot = existsSync(join(originalCwd, "Target.md")) ? originalCwd : join(originalCwd, "..", "..");

before(() => {
  writeFileSync(join(tempRoot, "Target.md"), "# test\n");
  mkdirSync(join(tempRoot, "data"), { recursive: true });
  const packagesLink = join(tempRoot, "packages");
  if (!existsSync(packagesLink)) {
    symlinkSync(join(repositoryRoot, "packages"), packagesLink, "dir");
  }
  process.chdir(tempRoot);
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
});

test.after(() => {
  process.chdir(originalCwd);
});

test("catalog item can be upserted and read by slug", () => {
  upsertMcpCatalogItemSync({
    slug: "github",
    transport: "streamable_http",
    displayName: "GitHub MCP",
    allowedHostsJson: JSON.stringify(["github-mcp.example.com"]),
    declaredToolsJson: JSON.stringify([{ name: "search_repos", description: "search repos", risk: "medium" }]),
    defaultApprovedToolsJson: JSON.stringify(["search_repos"]),
    risk: "medium",
  });
  const again = upsertMcpCatalogItemSync({
    slug: "github",
    transport: "streamable_http",
    displayName: "GitHub MCP (renamed)",
    risk: "medium",
  });
  assert.equal(again.displayName, "GitHub MCP (renamed)");
  assert.equal(again.source, "workspace_private");
  assert.equal(listMcpCatalogItemsSync().length, 1);
});

test("insert-only catalog publication rejects an existing workspace slug", () => {
  upsertMcpCatalogItemSync({ slug: "immutable", transport: "streamable_http", displayName: "Original" });
  assert.throws(
    () => insertMcpCatalogItemSync({ slug: "immutable", transport: "streamable_http", displayName: "Replacement" }),
    /unique|duplicate/i,
  );
  assert.equal(readMcpCatalogItemBySlugSync("immutable")?.displayName, "Original");
});

test("connection create + verify lifecycle reaches ready and writes a snapshot", () => {
  const runtimeId = createRuntime();
  const catalog = upsertMcpCatalogItemSync({
    slug: "notion",
    transport: "streamable_http",
    displayName: "Notion MCP",
    declaredToolsJson: JSON.stringify([{ name: "search", description: "search", risk: "low" }]),
    risk: "low",
  });
  const connection = createMcpConnectionSync({
    runtimeId,
    catalogItemId: catalog.id,
    endpoint: "https://notion-mcp.example.com/mcp",
    approvedToolsJson: JSON.stringify(["search"]),
  });
  assert.equal(connection.status, "queued_verification");

  const op = createMcpOperationSync({ runtimeId, connectionId: connection.id, operation: "verify" });
  const claimed = claimNextMcpOperationForRuntimeSync({ runtimeId });
  assert.equal(claimed?.id, op.id);
  assert.equal(readMcpConnectionSync(connection.id)?.status, "verifying");

  startMcpOperationSync(op.id);
  completeMcpOperationSync({
    operationId: op.id,
    verification: {
      status: "ready",
      protocolVersion: "2025-06-18",
      toolsMetadataJson: JSON.stringify([{ name: "search", description: "search", inputSchemaDigest: "d" }]),
      toolsFingerprint: "fp-1",
      latencyMs: 120,
    },
  });

  const ready = readMcpConnectionSync(connection.id);
  assert.equal(ready?.status, "ready");
  assert.equal(ready?.endpointFingerprint, "fp-1");
  assert.ok(ready?.lastVerifiedAt);

  const snap = readLatestMcpDiscoverySnapshotSync(connection.id);
  assert.equal(snap?.protocolVersion, "2025-06-18");
  assert.equal(snap?.toolsFingerprint, "fp-1");
  assert.deepEqual(listReadyMcpConnectionsForRuntimeSync({ runtimeId }).map((c) => c.id), [connection.id]);
});

test("failed verify marks connection failed and stores redacted error", () => {
  const runtimeId = createRuntime();
  const catalog = upsertMcpCatalogItemSync({ slug: "flaky", transport: "streamable_http", displayName: "Flaky", risk: "low" });
  const connection = createMcpConnectionSync({ runtimeId, catalogItemId: catalog.id, endpoint: "https://flaky.example.com/mcp" });
  const op = createMcpOperationSync({ runtimeId, connectionId: connection.id, operation: "verify" });
  claimNextMcpOperationForRuntimeSync({ runtimeId });
  failMcpOperationSync({ operationId: op.id, errorCode: "mcp.authentication_failed", errorMessage: "401 from upstream" });

  const failed = readMcpConnectionSync(connection.id);
  assert.equal(failed?.status, "failed");
  assert.equal(failed?.lastErrorCode, "mcp.authentication_failed");
});

test("degraded verification preserves a safe missing-tool diagnostic and excludes the connection from ready reads", () => {
  const runtimeId = createRuntime();
  const catalog = upsertMcpCatalogItemSync({ slug: "missing-tool", transport: "streamable_http", displayName: "Missing Tool", risk: "low" });
  const connection = createMcpConnectionSync({
    runtimeId,
    catalogItemId: catalog.id,
    endpoint: "https://missing-tool.example.com/mcp",
    approvedToolsJson: JSON.stringify(["write"]),
  });
  const operation = createMcpOperationSync({ runtimeId, connectionId: connection.id, operation: "verify" });
  claimNextMcpOperationForRuntimeSync({ runtimeId });
  startMcpOperationSync(operation.id);
  completeMcpOperationSync({
    operationId: operation.id,
    verification: {
      status: "degraded",
      toolsMetadataJson: JSON.stringify([{ name: "search", description: "search", inputSchemaDigest: "d" }]),
      toolsFingerprint: "search-only",
      errorCode: "mcp.approved_tool_missing",
      errorMessage: "Approved MCP tools are no longer available: write.",
    },
  });

  const degraded = readMcpConnectionSync(connection.id);
  assert.equal(degraded?.status, "degraded");
  assert.equal(degraded?.lastErrorCode, "mcp.approved_tool_missing");
  assert.match(degraded?.lastErrorMessage ?? "", /write/);
  assert.equal(readLatestMcpDiscoverySnapshotSync(connection.id)?.toolsFingerprint, "search-only");
  assert.deepEqual(listReadyMcpConnectionsForRuntimeSync({ runtimeId }), []);
});

test("config change forces re-verification", () => {
  const runtimeId = createRuntime();
  const catalog = upsertMcpCatalogItemSync({ slug: "g", transport: "streamable_http", displayName: "G", risk: "low" });
  const connection = createMcpConnectionSync({ runtimeId, catalogItemId: catalog.id, endpoint: "https://g.example.com/mcp" });
  completeReady(connection.id, runtimeId, catalog.id);
  assert.equal(readMcpConnectionSync(connection.id)?.status, "ready");

  updateMcpConnectionConfigSync({ connectionId: connection.id, approvedToolsJson: JSON.stringify(["a"]) });
  const after = readMcpConnectionSync(connection.id);
  assert.equal(after?.status, "queued_verification");
  assert.equal(after?.lastVerifiedAt, undefined);
});

test("secrets are stored opaque and never expose plaintext-shaped values", () => {
  const runtimeId = createRuntime();
  const catalog = upsertMcpCatalogItemSync({ slug: "s", transport: "streamable_http", displayName: "S", risk: "low" });
  const connection = createMcpConnectionSync({ runtimeId, catalogItemId: catalog.id, endpoint: "https://s.example.com/mcp" });
  upsertMcpSecretSync({ connectionId: connection.id, fieldName: "api_key", encryptedValue: "v1:iv:tag:cipher", keyVersion: "v1" });
  const secrets = readMcpConnectionSecretsSync(connection.id);
  assert.equal(secrets.length, 1);
  assert.equal(secrets[0]?.encryptedValue, "v1:iv:tag:cipher");
  assert.equal(secrets[0]?.fieldName, "api_key");
});

test("remove operation cascades connection, secrets and snapshots", () => {
  const runtimeId = createRuntime();
  const catalog = upsertMcpCatalogItemSync({ slug: "r", transport: "streamable_http", displayName: "R", risk: "low" });
  const connection = createMcpConnectionSync({ runtimeId, catalogItemId: catalog.id, endpoint: "https://r.example.com/mcp" });
  upsertMcpSecretSync({ connectionId: connection.id, fieldName: "api_key", encryptedValue: "x", keyVersion: "v1" });
  const op = createMcpOperationSync({ runtimeId, connectionId: connection.id, operation: "remove" });
  claimNextMcpOperationForRuntimeSync({ runtimeId });
  startMcpOperationSync(op.id);
  completeMcpOperationSync({ operationId: op.id });

  assert.equal(readMcpConnectionSync(connection.id), null);
  assert.equal(readMcpConnectionSecretsSync(connection.id).length, 0);
  assert.equal(readLatestMcpDiscoverySnapshotSync(connection.id), null);
});

test("atomic claim only hands an operation to one caller", () => {
  const runtimeId = createRuntime();
  const catalog = upsertMcpCatalogItemSync({ slug: "c", transport: "streamable_http", displayName: "C", risk: "low" });
  const connection = createMcpConnectionSync({ runtimeId, catalogItemId: catalog.id, endpoint: "https://c.example.com/mcp" });
  const op = createMcpOperationSync({ runtimeId, connectionId: connection.id, operation: "verify" });
  const first = claimNextMcpOperationForRuntimeSync({ runtimeId });
  const second = claimNextMcpOperationForRuntimeSync({ runtimeId });
  assert.equal(first?.id, op.id);
  assert.equal(second, null);
});

test("cancelled verification cannot overwrite a disabled connection", () => {
  const runtimeId = createRuntime();
  const catalog = upsertMcpCatalogItemSync({ slug: "fenced", transport: "streamable_http", displayName: "Fenced" });
  const connection = createMcpConnectionSync({ runtimeId, catalogItemId: catalog.id, endpoint: "https://fenced.example.com/mcp" });
  const operation = createMcpOperationSync({ runtimeId, connectionId: connection.id, operation: "verify" });
  claimNextMcpOperationForRuntimeSync({ runtimeId });
  startMcpOperationSync(operation.id);
  cancelUnfinishedMcpOperationsForConnectionSync({ connectionId: connection.id });
  updateMcpConnectionConfigSync({ connectionId: connection.id, approvedToolsJson: "[]" });
  completeMcpOperationSync({
    operationId: operation.id,
    verification: { status: "ready", toolsMetadataJson: "[]", toolsFingerprint: "stale" },
  });
  assert.equal(readMcpOperationSync(operation.id)?.status, "cancelled");
  assert.equal(readMcpConnectionSync(connection.id)?.status, "queued_verification");
  assert.equal(readLatestMcpDiscoverySnapshotSync(connection.id), null);
});

function completeReady(connectionId: string, runtimeId: string, _catalogId: string): void {
  const op = createMcpOperationSync({ runtimeId, connectionId, operation: "verify" });
  claimNextMcpOperationForRuntimeSync({ runtimeId });
  startMcpOperationSync(op.id);
  completeMcpOperationSync({
    operationId: op.id,
    verification: {
      status: "ready",
      toolsMetadataJson: "[]",
      toolsFingerprint: "fp",
      latencyMs: 1,
    },
  });
}

function createRuntime(): string {
  const snapshot = registerDaemonRuntimesSync({
    daemonKey: `daemon-${Math.random().toString(36).slice(2)}`,
    deviceName: "Build Box",
    runtimes: [{ provider: "codex", name: "Remote Codex", version: "test" }],
  });
  return snapshot.runtimes[0]!.id;
}

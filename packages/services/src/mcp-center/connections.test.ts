import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { before, beforeEach } from "node:test";
import {
  claimMcpTaskSessionAtomicallySync,
  claimNextMcpOperationForRuntimeSync,
  claimNextRuntimeAppOperationForRuntimeSync,
  completeMcpOperationSync,
  completeRuntimeAppOperationSync,
  createRuntimeAppOperationSync,
  createUserSync,
  getDatabase,
  insertWorkspaceRuntimeAppReleaseSync,
  listMcpOperationsSync,
  listMcpCatalogItemsSync,
  readMcpCatalogItemBySlugSync,
  readMcpTaskAuditAuthorizationSync,
  readMcpConnectionSync,
  readRuntimeAppCatalogItemSync,
  recordMcpToolAuditSync,
  registerDaemonRuntimesSync,
  startMcpOperationSync,
  startRuntimeAppOperationSync,
} from "@dofe-agent/db";
import { assessRuntimeAppInstallability, buildRuntimeAppInstallPlan } from "../clihub/install-plan.ts";
import { createMcpCatalogItemSync } from "./catalog.ts";
import {
  CHROME_DEVTOOLS_MCP_PACKAGE_SPEC,
  MINIMAX_TOKEN_PLAN_MCP_PACKAGE,
  MINIMAX_TOKEN_PLAN_MCP_PACKAGE_SPEC,
  MINIMAX_TOKEN_PLAN_MCP_SLUG,
  OPENMONTAGE_MCP_VERSION,
  resolveOfficialManagedStdioProfile,
  resolveOfficialMcpRuntimeAppRequirement,
  syncOfficialMcpCatalogForWorkspaceSync,
} from "./official-catalog.ts";
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
  rotateMcpEncryptionKeySync,
  scheduleMcpHealthChecksSync,
  updateMcpConnectionConfigServiceSync,
  validateMcpConnectionForGatewaySync,
} from "./connections.ts";
import { decryptMcpGrant, decryptMcpSecret, encryptMcpGrant } from "./security.ts";
import { digestMcpCatalogRelease } from "./egress.ts";

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
  db.exec("DELETE FROM runtime_app_operation");
  db.exec("DELETE FROM runtime_installed_app");
  db.exec("DELETE FROM runtime_app_catalog_item");
  db.exec("DELETE FROM runtime_app_release");
  db.exec("DELETE FROM runtime_app_package");
  db.exec("DELETE FROM agent_runtime");
  db.exec("DELETE FROM daemon_connection");
  db.exec("DELETE FROM users");
  delete process.env.DOFE_AGENT_MCP_SECRET_ENCRYPTION_KEY_VERSION;
  delete process.env.DOFE_AGENT_MCP_SECRET_ENCRYPTION_PREVIOUS_KEYS;
  process.env.DOFE_AGENT_MCP_SECRET_ENCRYPTION_KEY = Buffer.alloc(32, 9).toString("base64");
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

test("managed stdio catalog connects an installed Runtime entrypoint without an egress lease", () => {
  const runtimeId = createRuntime();
  const release = seedInstalledPrivateRuntimeApp(runtimeId, "internal-mcp");
  const catalog = createMcpCatalogItemSync({
    workspaceId: "default",
    actorUserId: ADMIN_USER_ID,
    slug: "internal-stdio",
    displayName: "Internal stdio MCP",
    transport: "managed_stdio",
    allowedHosts: [],
    endpointTemplate: "stdio://internal-mcp",
    configurationSchema: {
      type: "object",
      properties: { TENANT_ID: { type: "string" } },
      required: ["TENANT_ID"],
      additionalProperties: false,
    },
    declaredTools: [{ name: "search", description: "Search", risk: "low" }],
    defaultApprovedTools: ["search"],
    secretFields: ["API_TOKEN"],
    requiredRuntimeApp: {
      source: "workspace_private",
      name: release.id,
      version: release.version,
    },
  });
  assert.deepEqual(catalog.requiredRuntimeApp, {
    source: "workspace_private",
    name: release.id,
    version: release.version,
  });
  assert.notEqual(
    digestMcpCatalogRelease(catalog),
    digestMcpCatalogRelease({
      ...catalog,
      requiredRuntimeApp: { ...catalog.requiredRuntimeApp!, name: "different-release" },
    }),
  );
  const { connection, operation } = requestMcpConnectionSync({
    workspaceId: "default",
    actorUserId: ADMIN_USER_ID,
    runtimeId,
    catalogItemId: catalog.id,
    endpoint: "stdio://internal-mcp",
    nonSecretParams: { TENANT_ID: "tenant-1" },
    secrets: { API_TOKEN: "secret" },
    approvedTools: ["search"],
    confirmHighRisk: true,
  });
  const claimed = resolveClaimedMcpOperationSync({ workspaceId: "default", operation });

  assert.equal(connection.endpoint, "stdio://internal-mcp");
  assert.equal(claimed?.transport, "managed_stdio");
  assert.equal(claimed?.egressProxyLease, undefined);
  assert.equal(claimed?.nonSecretParams.TENANT_ID, "tenant-1");
  assert.equal(claimed?.secrets.API_TOKEN, "secret");
  assert.throws(() => requestMcpConnectionSync({
    workspaceId: "default",
    actorUserId: ADMIN_USER_ID,
    runtimeId,
    catalogItemId: catalog.id,
    endpoint: "stdio://different-installed-command",
    nonSecretParams: { TENANT_ID: "tenant-1" },
    secrets: { API_TOKEN: "secret" },
    approvedTools: ["search"],
    confirmHighRisk: true,
  }), /mcp\.policy_denied/);
});

test("official Chrome DevTools MCP requires the pinned Runtime app and resolves a trusted launch profile", () => {
  const runtimeId = createRuntime();
  const catalog = syncOfficialMcpCatalogForWorkspaceSync("default");
  const declaredTools = JSON.parse(catalog.declaredToolsJson) as Array<{ name: string }>;
  assert.equal(declaredTools.length, 29);
  assert.equal(declaredTools.some((tool) => tool.name === "lighthouse_audit"), true);
  assert.equal(declaredTools.some((tool) => tool.name === "upload_file"), true);
  const runtimeApp = readRuntimeAppCatalogItemSync("clihub_public", "chrome-devtools-mcp");
  assert.ok(runtimeApp);
  const plan = buildRuntimeAppInstallPlan({ item: runtimeApp, operation: "install", cliHubAvailable: false });
  assert.deepEqual(plan.commands, [{ executable: "npm", args: ["install", "--global", CHROME_DEVTOOLS_MCP_PACKAGE_SPEC] }]);
  assert.throws(() => requestMcpConnectionSync({
    workspaceId: "default",
    actorUserId: ADMIN_USER_ID,
    runtimeId,
    catalogItemId: catalog.id,
    endpoint: catalog.endpointTemplate!,
    approvedTools: ["list_pages"],
    confirmHighRisk: true,
  }), /mcp\.runtime_app_required/);

  const installOperation = createRuntimeAppOperationSync({
    workspaceId: "default",
    runtimeId,
    appSource: "clihub_public",
    appName: "chrome-devtools-mcp",
    operation: "install",
    commandPlanJson: JSON.stringify(plan),
  });
  assert.equal(claimNextRuntimeAppOperationForRuntimeSync({ workspaceId: "default", runtimeId })?.id, installOperation.id);
  startRuntimeAppOperationSync(installOperation.id, "default");
  completeRuntimeAppOperationSync({
    workspaceId: "default",
    operationId: installOperation.id,
    installedApp: {
      displayName: runtimeApp.displayName,
      version: runtimeApp.version,
      entryPoint: runtimeApp.entryPoint,
      installStrategy: "npm",
    },
  });

  const requested = requestMcpConnectionSync({
    workspaceId: "default",
    actorUserId: ADMIN_USER_ID,
    runtimeId,
    catalogItemId: catalog.id,
    endpoint: catalog.endpointTemplate!,
    approvedTools: ["list_pages"],
    confirmHighRisk: true,
  });
  const claimed = resolveClaimedMcpOperationSync({ workspaceId: "default", operation: requested.operation });
  assert.deepEqual(claimed?.managedStdioProfile?.args, ["--headless", "--isolated", "--no-usage-statistics", "--no-performance-crux"]);
  assert.equal(claimed?.managedStdioProfile?.managedArgs?.includes("--executable-path=/usr/bin/chromium"), true);
  assert.equal(claimed?.managedStdioProfile?.env.CHROME_DEVTOOLS_MCP_NO_UPDATE_CHECKS, "1");
});

test("official MiniMax Token Plan MCP exposes two tools and a pinned secret-backed Runtime app", () => {
  syncOfficialMcpCatalogForWorkspaceSync("default");
  const catalog = readMcpCatalogItemBySlugSync(MINIMAX_TOKEN_PLAN_MCP_SLUG, "default");
  assert.ok(catalog);
  assert.deepEqual(JSON.parse(catalog.allowedHostsJson), ["api.minimaxi.com"]);
  assert.deepEqual(JSON.parse(catalog.secretFieldsJson), ["MINIMAX_API_KEY"]);
  assert.deepEqual(
    (JSON.parse(catalog.declaredToolsJson) as Array<{ name: string }>).map((tool) => tool.name),
    ["web_search", "understand_image"],
  );
  assert.deepEqual(resolveOfficialMcpRuntimeAppRequirement(catalog), {
    source: "clihub_public",
    name: MINIMAX_TOKEN_PLAN_MCP_PACKAGE,
    version: "0.0.4",
  });
  assert.deepEqual(resolveOfficialManagedStdioProfile(catalog)?.env, {
    MINIMAX_API_HOST: "https://api.minimaxi.com",
  });

  const runtimeApp = readRuntimeAppCatalogItemSync("clihub_public", MINIMAX_TOKEN_PLAN_MCP_PACKAGE);
  assert.ok(runtimeApp);
  assert.equal(assessRuntimeAppInstallability(runtimeApp).status, "installable");
  const plan = buildRuntimeAppInstallPlan({ item: runtimeApp, operation: "install", cliHubAvailable: true });
  assert.deepEqual(plan.commands, [{
    executable: "python3",
    args: ["-m", "pip", "install", "--user", MINIMAX_TOKEN_PLAN_MCP_PACKAGE_SPEC],
    env: { PIP_BREAK_SYSTEM_PACKAGES: "1" },
  }]);
});

test("official OpenMontage MCP uses an opaque managed-service reference and needs no Runtime app", () => {
  syncOfficialMcpCatalogForWorkspaceSync("default");
  const catalog = readMcpCatalogItemBySlugSync("official-openmontage", "default");
  assert.ok(catalog);
  assert.equal(catalog.version, OPENMONTAGE_MCP_VERSION);
  assert.equal(catalog.transport, "managed_service");
  assert.equal(catalog.endpointTemplate, "managed-service://openmontage");
  assert.deepEqual(JSON.parse(catalog.secretFieldsJson), []);
  assert.deepEqual(
    (JSON.parse(catalog.declaredToolsJson) as Array<{ name: string }>).map((tool) => tool.name),
    ["openmontage_capabilities", "submit_video_job", "get_video_job", "cancel_video_job", "approve_video_stage", "list_video_job_events", "list_video_artifacts"],
  );
  assert.equal(resolveOfficialMcpRuntimeAppRequirement(catalog), undefined);

  const runtimeId = createRuntime();
  const requested = requestMcpConnectionSync({
    workspaceId: "default",
    actorUserId: ADMIN_USER_ID,
    runtimeId,
    catalogItemId: catalog.id,
    endpoint: catalog.endpointTemplate,
    approvedTools: ["submit_video_job", "get_video_job", "list_video_job_events", "list_video_artifacts"],
    confirmHighRisk: true,
  });
  const claimed = resolveClaimedMcpOperationSync({ workspaceId: "default", operation: requested.operation });
  assert.equal(claimed?.transport, "managed_service");
  assert.equal(claimed?.endpoint, "managed-service://openmontage");
  assert.equal(claimed?.egressProxyLease, undefined);
});

test("workspace catalog cannot claim the platform-managed service transport", () => {
  assert.throws(() => createMcpCatalogItemSync({
    workspaceId: "default",
    actorUserId: ADMIN_USER_ID,
    slug: "private-managed-service",
    displayName: "Private managed service",
    transport: "managed_service",
    allowedHosts: [],
    endpointTemplate: "managed-service://openmontage",
    configurationSchema: { type: "object" },
    declaredTools: [{ name: "submit_video_job", description: "Submit", risk: "high" }],
  }), /managed_service_not_supported/);
});

test("managed stdio catalog rejects untrusted commands and reserved environment names", () => {
  assert.throws(() => createMcpCatalogItemSync({
    workspaceId: "default",
    actorUserId: ADMIN_USER_ID,
    slug: "invalid-stdio-command",
    displayName: "Invalid stdio",
    transport: "managed_stdio",
    allowedHosts: [],
    endpointTemplate: "stdio://server/path",
    configurationSchema: { type: "object" },
    declaredTools: [{ name: "search", description: "Search", risk: "low" }],
  }), /invalid_managed_stdio_endpoint/);
  assert.throws(() => createMcpCatalogItemSync({
    workspaceId: "default",
    actorUserId: ADMIN_USER_ID,
    slug: "invalid-stdio-env",
    displayName: "Invalid stdio env",
    transport: "managed_stdio",
    allowedHosts: [],
    endpointTemplate: "stdio://server",
    configurationSchema: { type: "object", properties: { PATH: { type: "string" } } },
    declaredTools: [{ name: "search", description: "Search", risk: "low" }],
  }), /invalid_managed_stdio_environment/);
});

test("managed stdio catalog requires an existing private CLI release with a matching entrypoint", () => {
  const release = insertWorkspaceRuntimeAppReleaseSync({
    workspaceId: "default",
    slug: "bound-mcp-cli",
    displayName: "Bound MCP CLI",
    version: "2.0.0",
    artifactKind: "npm",
    artifactName: "@workspace/bound-mcp-cli",
    artifactUrl: "https://registry.npmjs.org/@workspace/bound-mcp-cli/-/bound-mcp-cli-2.0.0.tgz",
    artifactIntegrity: "sha512-test",
    entryPoint: "bound-mcp",
    manifestJson: "{}",
  });
  const base = {
    workspaceId: "default",
    actorUserId: ADMIN_USER_ID,
    displayName: "Bound MCP",
    transport: "managed_stdio" as const,
    allowedHosts: [],
    configurationSchema: { type: "object" },
    declaredTools: [{ name: "search", description: "Search", risk: "low" as const }],
  };
  assert.throws(() => createMcpCatalogItemSync({
    ...base,
    slug: "missing-release-binding",
    endpointTemplate: "stdio://bound-mcp",
  }), /required_runtime_app_required/);
  assert.throws(() => createMcpCatalogItemSync({
    ...base,
    slug: "wrong-release-entrypoint",
    endpointTemplate: "stdio://other-mcp",
    requiredRuntimeApp: { source: "workspace_private", name: release.id, version: release.version },
  }), /required_runtime_app_entrypoint_mismatch/);
});

test("catalog publishing keeps releases immutable and exposes only the latest release", () => {
  const firstId = seedCatalog();
  const firstRelease = readMcpCatalogItemBySlugSync("github", "default");
  assert.ok(firstRelease);
  const firstDigest = digestMcpCatalogRelease(firstRelease);
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
  assert.notEqual(digestMcpCatalogRelease(second), firstDigest);
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
    validateMcpConnectionForGatewaySync({
      workspaceId: "default",
      runtimeId,
      taskId: "task-validation",
      connectionId: connection.id,
      toolName: "search_repos",
    }).ok,
    true,
  );

  disableMcpConnectionSync({ workspaceId: "default", connectionId: connection.id, actorUserId: ADMIN_USER_ID });
  assert.equal(
    validateMcpConnectionForGatewaySync({
      workspaceId: "default",
      runtimeId,
      taskId: "task-validation",
      connectionId: connection.id,
      toolName: "search_repos",
    }).ok,
    false,
  );
});

test("validateMcpConnectionForGateway issues a fresh task-call lease on every validation", () => {
  const originalSigningSecret = process.env.MCP_EGRESS_PROXY_LEASE_SIGNING_SECRET;
  process.env.MCP_EGRESS_PROXY_LEASE_SIGNING_SECRET = "test-signing-secret-that-is-at-least-32-bytes";
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

  try {
    const input = {
      workspaceId: "default",
      runtimeId,
      taskId: "task-fresh-lease",
      connectionId: connection.id,
      toolName: "search_repos",
    };
    const first = validateMcpConnectionForGatewaySync(input);
    const second = validateMcpConnectionForGatewaySync(input);
    assert.equal(first.ok, true);
    assert.equal(second.ok, true);
    assert.ok(first.ok && first.egressProxyLease);
    assert.ok(second.ok && second.egressProxyLease);
    assert.notEqual(first.ok && first.egressProxyLease, second.ok && second.egressProxyLease);
  } finally {
    if (originalSigningSecret === undefined) delete process.env.MCP_EGRESS_PROXY_LEASE_SIGNING_SECRET;
    else process.env.MCP_EGRESS_PROXY_LEASE_SIGNING_SECRET = originalSigningSecret;
  }
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
    actorType: "agent",
    actorId: "agent-1",
    runtimeId,
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
    actorType: "agent",
    actorId: "agent-1",
    runtimeId,
  });
  // A re-sent audit with the same event_id must return the original row, not insert a duplicate.
  const replay = recordMcpToolAuditSync({
    workspaceId: "default",
    connectionId: connection.id,
    taskId: "task-1",
    toolName: "search_repos",
    outcome: "succeeded",
    eventId,
    actorType: "agent",
    actorId: "agent-1",
    runtimeId,
  });
  assert.equal(replay.id, first.id);
  const audits = listMcpConnectionActivitySync({ workspaceId: "default", connectionId: connection.id }).audits;
  assert.equal(audits.filter((a) => a.eventId === eventId).length, 1);
});

test("rotateMcpEncryptionKeySync re-encrypts secrets and active grants atomically", () => {
  const oldKey = Buffer.alloc(32, 9).toString("base64");
  const newKey = Buffer.alloc(32, 10).toString("base64");
  const runtimeId = createRuntime();
  const catalogId = seedCatalog();
  const { connection } = requestMcpConnectionSync({
    workspaceId: "default",
    actorUserId: ADMIN_USER_ID,
    runtimeId,
    catalogItemId: catalogId,
    endpoint: "https://github-mcp.example.com/mcp",
    secrets: { api_key: "rotate-me" },
    confirmHighRisk: true,
  });
  const oldGrant = encryptMcpGrant('{"connections":[]}');
  getDatabase().prepare(
    `INSERT INTO mcp_task_session_grant (
       task_id, workspace_id, runtime_id, attempt_id, encrypted_bundle_json, expires_at, created_at
     ) VALUES ('rotation-task', 'default', ?, 'attempt-1', ?, ?, ?)`,
  ).run(runtimeId, oldGrant, new Date(Date.now() + 60_000).toISOString(), new Date().toISOString());

  process.env.DOFE_AGENT_MCP_SECRET_ENCRYPTION_KEY_VERSION = "mcp2";
  process.env.DOFE_AGENT_MCP_SECRET_ENCRYPTION_KEY = newKey;
  process.env.DOFE_AGENT_MCP_SECRET_ENCRYPTION_PREVIOUS_KEYS = JSON.stringify({ mcp1: oldKey });
  const result = rotateMcpEncryptionKeySync({ workspaceId: "default" });

  assert.deepEqual(result, { rotatedSecrets: 1, rotatedSessionGrants: 1, keyVersion: "mcp2" });
  const secret = getDatabase().prepare(
    "SELECT encrypted_value AS encryptedValue, key_version AS keyVersion FROM runtime_mcp_secret WHERE connection_id = ?",
  ).get(connection.id) as { encryptedValue: string; keyVersion: string };
  const grant = getDatabase().prepare(
    "SELECT encrypted_bundle_json FROM mcp_task_session_grant WHERE task_id = 'rotation-task'",
  ).get() as { encryptedBundleJson: string };
  assert.equal(secret.keyVersion, "mcp2");
  assert.match(secret.encryptedValue, /^mcp2:/);
  assert.equal(decryptMcpSecret(secret.encryptedValue), "rotate-me");
  assert.match(grant.encryptedBundleJson, /^mcpg2:/);
  assert.equal(decryptMcpGrant(grant.encryptedBundleJson), '{"connections":[]}');
});

function seedInstalledPrivateRuntimeApp(runtimeId: string, entryPoint: string) {
  const release = insertWorkspaceRuntimeAppReleaseSync({
    workspaceId: "default",
    slug: `${entryPoint}-cli`,
    displayName: `${entryPoint} CLI`,
    version: "1.0.0",
    artifactKind: "npm",
    artifactName: `@workspace/${entryPoint}`,
    artifactUrl: `https://registry.npmjs.org/@workspace/${entryPoint}/-/${entryPoint}-1.0.0.tgz`,
    artifactIntegrity: "sha512-test",
    entryPoint,
    manifestJson: "{}",
  });
  const operation = createRuntimeAppOperationSync({
    workspaceId: "default",
    runtimeId,
    appSource: "workspace_private",
    appName: release.id,
    operation: "install",
    commandPlanJson: "{}",
  });
  assert.equal(claimNextRuntimeAppOperationForRuntimeSync({ workspaceId: "default", runtimeId })?.id, operation.id);
  startRuntimeAppOperationSync(operation.id, "default");
  completeRuntimeAppOperationSync({
    workspaceId: "default",
    operationId: operation.id,
    installedApp: {
      displayName: release.displayName,
      version: release.version,
      entryPoint: release.entryPoint,
      installStrategy: "npm",
    },
  });
  return release;
}

function createRuntime(): string {
  const snapshot = registerDaemonRuntimesSync({
    daemonKey: `daemon-${Math.random().toString(36).slice(2)}`,
    deviceName: "Build Box",
    runtimes: [{ provider: "codex", name: "Remote Codex", version: "test" }],
  });
  return snapshot.runtimes[0]!.id;
}

import assert from "node:assert/strict";
import test from "node:test";
import type { ResolvedMcpConnection } from "@dofe-agent/domain";
import * as mcpClientModule from "./client.ts";
import { createPinnedLookup, createRuntimeMcpClient, normalizeDiscoveredTools } from "./client.ts";
import { McpGateway } from "./gateway.ts";
import { assertSafeGeoProjectList } from "./geo-project-list.ts";

test("MCP tool calls use a bounded timeout separate from protocol discovery", () => {
  const resolver = (mcpClientModule as {
    resolveMcpToolCallTimeoutMs?: (environment: NodeJS.ProcessEnv) => number;
  }).resolveMcpToolCallTimeoutMs;
  assert.equal(typeof resolver, "function");
  assert.equal(resolver!({}), 120_000);
  assert.equal(resolver!({ DOFE_AGENT_MCP_TOOL_TIMEOUT_MS: "1000" }), 15_000);
  assert.equal(resolver!({ DOFE_AGENT_MCP_TOOL_TIMEOUT_MS: "900000" }), 600_000);
  assert.equal(resolver!({ DOFE_AGENT_MCP_TOOL_TIMEOUT_MS: "invalid" }), 120_000);
});

test("MCP SDK request timeout is classified as a stable timeout error", () => {
  const classifier = (mcpClientModule as {
    classifyMcpError?: (error: unknown) => { code: string; safeMessage: string };
  }).classifyMcpError;
  assert.equal(typeof classifier, "function");
  assert.deepEqual(classifier!(new Error("MCP error -32001: Request timed out")), {
    code: "mcp.timeout",
    safeMessage: "Request to the MCP server timed out.",
  });
});

test("assertSafeGeoProjectList accepts bounded tenant metadata", () => {
  const items = assertSafeGeoProjectList({
    tenant_id: "workspace-a",
    count: 1,
    items: [{
      id: 16,
      name: "AgentSpace GEO regression mt6av9lu",
      description: "Regression fixture",
      status: "published",
      published_knowledge_base_id: 15,
      updated_at: "2026-08-24T00:00:00Z",
    }],
  }, "workspace-a");

  assert.equal(items.length, 1);
});

test("assertSafeGeoProjectList rejects cross-tenant, inconsistent, and content-bearing results", () => {
  assert.throws(
    () => assertSafeGeoProjectList({ tenant_id: "workspace-b", count: 0, items: [] }, "workspace-a"),
    /scoped to the task workspace/,
  );
  assert.throws(
    () => assertSafeGeoProjectList({ tenant_id: "workspace-a", count: 2, items: [] }, "workspace-a"),
    /count must match/,
  );
  assert.throws(
    () => assertSafeGeoProjectList({ tenant_id: "workspace-a", count: 0, items: null }, "workspace-a"),
    /must return an items array/,
  );
  assert.throws(
    () => assertSafeGeoProjectList({ tenant_id: "workspace-a", count: 1, items: [{ id: 16, draft_content: "secret" }] }, "workspace-a"),
    /leaked non-metadata fields: draft_content/,
  );
});

test("normalizeDiscoveredTools accepts bounded unique tool definitions", () => {
  const result = normalizeDiscoveredTools([
    { name: "search_repos", description: "Search repositories", inputSchema: { type: "object" } },
    { name: "geoflow.enterprise_knowledge.publish", description: "Publish knowledge", inputSchema: { type: "object" } },
  ]);
  assert.equal(result.ok, true);
  if (result.ok) {
    assert.equal(result.tools.length, 2);
    assert.equal(result.tools[0]?.name, "search_repos");
    assert.equal(result.tools[1]?.name, "geoflow.enterprise_knowledge.publish");
  }
});

test("normalizeDiscoveredTools rejects duplicate names and oversized schemas", () => {
  const duplicate = normalizeDiscoveredTools([
    { name: "search", inputSchema: {} },
    { name: "search", inputSchema: {} },
  ]);
  assert.equal(duplicate.ok, false);

  const tooLarge = normalizeDiscoveredTools([
    { name: "search", inputSchema: { example: "x".repeat(16_385) } },
  ]);
  assert.equal(tooLarge.ok, false);
});

test("createPinnedLookup supports Node single-address and all-address callback shapes", async () => {
  const lookup = createPinnedLookup({ address: "203.0.113.10", family: 4 });

  const single = await new Promise<{ address: unknown; family: unknown }>((resolve, reject) => {
    lookup("mcp.example.test", { all: false }, (error, address, family) => {
      if (error) reject(error);
      else resolve({ address, family });
    });
  });
  assert.deepEqual(single, { address: "203.0.113.10", family: 4 });

  const all = await new Promise<unknown>((resolve, reject) => {
    lookup("mcp.example.test", { all: true }, (error, addresses) => {
      if (error) reject(error);
      else resolve(addresses);
    });
  });
  assert.deepEqual(all, [{ address: "203.0.113.10", family: 4 }]);
});

test("call rejects when egress is enforced and no proxy lease is present", async () => {
  const original = process.env.MCP_EGRESS_ENFORCE;
  process.env.MCP_EGRESS_ENFORCE = "true";
  try {
    const result = await createRuntimeMcpClient().call({
      connection: {
        connectionId: "conn-1",
        runtimeId: "rt-1",
        workspaceId: "ws-1",
        transport: "streamable_http",
        endpoint: "https://mcp.example.test/mcp",
        allowedHosts: ["mcp.example.test"],
        approvedTools: ["tool"],
        secrets: {},
        nonSecretParams: {},
      } as unknown as ResolvedMcpConnection,
      toolName: "tool",
      arguments: {},
      taskId: "task-1",
    });
    assert.equal(result.ok, false);
    if (!result.ok) {
      assert.equal(result.error.code, "mcp.policy_denied");
    }
  } finally {
    process.env.MCP_EGRESS_ENFORCE = original;
  }
});

test("managed service transport completes MCP discovery and a tool call over its daemon-resolved endpoint", async () => {
  let backendCalls = 0;
  const backend = new McpGateway(
    () => undefined,
    {
      verify: async () => ({ status: "ready", discoveredTools: [] }),
      call: async () => {
        backendCalls += 1;
        return { ok: true, result: { ok: true } };
      },
    },
  );
  await backend.start();
  const session = backend.createTaskSession({
    taskId: "task-backend",
    workspaceId: "ws-1",
    runtimeId: "rt-1",
    employeeId: "employee-1",
    conversationId: "conversation-1",
    connections: [{
      connectionId: "backend-connection",
      workspaceId: "ws-1",
      catalogItemId: "catalog-1",
      catalogItemSlug: "backend",
      catalogItemVersion: "1.0.0",
      displayName: "Backend",
      transport: "streamable_http",
      endpoint: "https://backend.example/mcp",
      allowedHosts: ["backend.example"],
      approvedTools: ["render"],
      secrets: {},
      nonSecretParams: {},
      tools: [{
        id: "mcp:backend-connection:render",
        connectionId: "backend-connection",
        name: "render",
        description: "Render",
        inputSchema: { type: "object" },
      }],
    }],
  });
  const connection: ResolvedMcpConnection = {
    connectionId: "openmontage-connection",
    runtimeId: "rt-1",
    workspaceId: "ws-1",
    transport: "managed_service",
    endpoint: "managed-service://openmontage",
    managedServiceEndpoint: session.url,
    allowedHosts: [],
    approvedTools: ["mcp_backend-connection_render"],
    secrets: { Authorization: "Bearer service-token" },
    nonSecretParams: {},
  };

  try {
    const client = createRuntimeMcpClient();
    const verification = await client.verify(connection);
    assert.equal(verification.status, "ready");
    const toolName = verification.discoveredTools?.[0]?.name;
    assert.ok(toolName);
    connection.approvedTools = [toolName];
    const result = await client.call({ connection, toolName, arguments: {}, taskId: "task-1" });
    assert.equal(result.ok, true);
    assert.equal(backendCalls, 1);
  } finally {
    session.revoke();
    await backend.close();
  }
});

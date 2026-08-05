import assert from "node:assert/strict";
import test from "node:test";
import type { ResolvedMcpConnection } from "@dofe-agent/domain";
import { createPinnedLookup, createRuntimeMcpClient, normalizeDiscoveredTools } from "./client.ts";
import { McpGateway } from "./gateway.ts";

test("normalizeDiscoveredTools accepts bounded unique tool definitions", () => {
  const result = normalizeDiscoveredTools([
    { name: "search_repos", description: "Search repositories", inputSchema: { type: "object" } },
  ]);
  assert.equal(result.ok, true);
  if (result.ok) {
    assert.equal(result.tools.length, 1);
    assert.equal(result.tools[0]?.name, "search_repos");
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

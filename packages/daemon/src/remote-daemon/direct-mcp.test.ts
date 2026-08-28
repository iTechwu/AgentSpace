import assert from "node:assert/strict";
import test from "node:test";
import { buildDirectMcpToolSurface } from "./task-execution.ts";

function connection(overrides: Record<string, unknown> = {}) {
  return {
    connectionId: "conn-1",
    workspaceId: "ws-1",
    catalogItemId: "catalog-1",
    catalogItemSlug: "github",
    catalogItemVersion: "1.0.0",
    displayName: "GitHub",
    transport: "streamable_http" as const,
    endpoint: "https://github.example/mcp",
    allowedHosts: ["github.example"],
    approvedTools: ["search_repositories"],
    nonSecretParams: { "X-Tenant": "acme" },
    secrets: {},
    tools: [{
      id: "mcp:conn-1:search_repositories" as `mcp:${string}:${string}`,
      connectionId: "conn-1",
      name: "search_repositories",
      description: "Search repositories",
      inputSchema: { type: "object" },
    }],
    ...overrides,
  };
}

test("direct MCP surface supports multiple endpoints and stable server keys", () => {
  const result = buildDirectMcpToolSurface("task-1", [
    connection(),
    connection({ connectionId: "conn-2", catalogItemSlug: "github" }),
  ]);
  assert.ok(result);
  assert.deepEqual(result.toolSurface.clientConfig, {
    mcpServers: [
      { name: "mcp_github", url: "https://github.example/mcp", headers: { "X-Tenant": "acme" } },
      { name: "mcp_github_2", url: "https://github.example/mcp", headers: { "X-Tenant": "acme" } },
    ],
  });
  assert.deepEqual(result.permissionNames, [
    "mcp__mcp_github__search_repositories",
    "mcp__mcp_github_2__search_repositories",
  ]);
});

test("direct MCP surface refuses secret-bearing or non-HTTP connections", () => {
  assert.equal(buildDirectMcpToolSurface("task-1", [connection({ secrets: { API_KEY: "secret" } })]), undefined);
  assert.equal(buildDirectMcpToolSurface("task-1", [connection({ transport: "stdio" })]), undefined);
  assert.equal(buildDirectMcpToolSurface("task-1", [connection({ endpoint: "https://user:pass@example.com/mcp" })]), undefined);
});

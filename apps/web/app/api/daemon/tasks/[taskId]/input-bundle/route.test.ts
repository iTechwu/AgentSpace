import { describe, expect, it } from "vitest";
import type { RuntimeMcpConnectionContextEntry } from "@dofe-agent/domain";
import { buildMcpConnectionsForTaskBundle } from "./route";

describe("buildMcpConnectionsForTaskBundle", () => {
  it("projects only the approved non-secret tool manifest", () => {
    const connection = {
      connectionId: "connection-1",
      catalogItemSlug: "github",
      displayName: "GitHub MCP",
      transport: "streamable_http",
      approvedTools: ["search"],
      tools: [{
        id: "mcp:connection-1:search",
        connectionId: "connection-1",
        name: "search",
        description: "Search repositories",
        inputSchema: {
          type: "object",
          properties: { token: { type: "string", default: "secret-schema-value" } },
        },
      }],
      endpoint: "https://mcp.example.com/mcp?token=secret",
      nonSecretParams: { "X-Tenant": "workspace-1" },
      secrets: { Authorization: "Bearer secret" },
    } as RuntimeMcpConnectionContextEntry;

    const bundle = buildMcpConnectionsForTaskBundle([connection]);

    expect(bundle.status).toBe("available");
    expect(bundle.connections).toEqual([{
      connectionId: "connection-1",
      catalogItemSlug: "github",
      displayName: "GitHub MCP",
      transport: "streamable_http",
      approvedTools: ["search"],
      tools: [{
        id: "mcp:connection-1:search",
        connectionId: "connection-1",
        name: "search",
        description: "Search repositories",
        inputSchema: {
          type: "object",
          properties: { token: { type: "string" } },
        },
      }],
    }]);
    expect(JSON.stringify(bundle)).not.toContain("mcp.example.com");
    expect(JSON.stringify(bundle)).not.toContain("Bearer secret");
    expect(JSON.stringify(bundle)).not.toContain("workspace-1");
    expect(JSON.stringify(bundle)).not.toContain("secret-schema-value");
  });

  it("reports no MCP capability when there are no ready connections", () => {
    expect(buildMcpConnectionsForTaskBundle([])).toEqual({ status: "none", connections: [] });
  });
});

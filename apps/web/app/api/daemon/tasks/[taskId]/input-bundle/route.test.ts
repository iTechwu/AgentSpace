import { describe, expect, it } from "vitest";
import type { RuntimeMcpConnectionContextEntry, TaskSkillExecutionSnapshot } from "@dofe-agent/domain";
import { buildMcpConnectionsForTaskBundle, buildSkillDependencyEnvironmentsForTaskBundle } from "./route";

describe("buildMcpConnectionsForTaskBundle", () => {
  it("projects only the approved non-secret tool manifest", () => {
    const connection = {
      connectionId: "connection-1",
      catalogItemId: "catalog-1",
      catalogItemSlug: "github",
      catalogItemVersion: "1.2.3",
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
      catalogItemId: "catalog-1",
      catalogItemSlug: "github",
      catalogItemVersion: "1.2.3",
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

describe("buildSkillDependencyEnvironmentsForTaskBundle", () => {
  it("projects only frozen installation references that require dependency environments", () => {
    const snapshot: TaskSkillExecutionSnapshot = {
      workspaceId: "workspace-1",
      runtimeId: "runtime-1",
      resolvedAt: "2026-08-03T00:00:00.000Z",
      entries: [
        {
          skillId: "skill-with-deps",
          skillName: "With deps",
          artifactDigest: "a".repeat(64),
          installationId: "installation-1",
          revision: "v2",
          status: "ready",
          releaseLockDigest: "b".repeat(64),
          dependencyEnvironmentRequired: true,
        },
        {
          skillId: "skill-without-deps",
          skillName: "Without deps",
          artifactDigest: "c".repeat(64),
          installationId: "installation-2",
          revision: "v1",
          status: "ready",
        },
      ],
    };

    expect(buildSkillDependencyEnvironmentsForTaskBundle(snapshot)).toEqual([{
      installationId: "installation-1",
      artifactDigest: "a".repeat(64),
      releaseLockDigest: "b".repeat(64),
    }]);
  });
});

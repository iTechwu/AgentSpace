import {
  listMcpConnectionsSync,
  readLatestMcpDiscoverySnapshotSync,
  readMcpCatalogItemSync,
  readMcpConnectionSync,
  updateMcpConnectionStatusSync,
  type McpCatalogItemRecord,
  type RuntimeMcpConnectionRecord,
} from "@dofe-agent/db";
import type { McpDiscoveredTool, RuntimeMcpConnectionContextEntry, RuntimeMcpTool } from "@dofe-agent/domain";
import type { McpDeclaredTool } from "./catalog.ts";
import { redactToolInputSchema } from "./security.ts";

export interface ResolvedReadyMcpConnection {
  connectionId: string;
  catalog: McpCatalogItemRecord;
  fresh: RuntimeMcpConnectionRecord;
  approved: string[];
  tools: RuntimeMcpTool[];
}

/** Applies the task-claim freshness and authorization policy to one connection. */
export function resolveReadyMcpConnectionForTask(input: {
  workspaceId: string;
  connection: RuntimeMcpConnectionRecord;
  markDegradedOnMissingTool: boolean;
}): ResolvedReadyMcpConnection | null {
  const { workspaceId, connection, markDegradedOnMissingTool } = input;
  const catalog = readMcpCatalogItemSync(connection.catalogItemId, workspaceId);
  if (!catalog) return null;
  const fresh = readMcpConnectionSync(connection.id, workspaceId);
  if (!fresh || fresh.status !== "ready") return null;
  const snapshot = readLatestMcpDiscoverySnapshotSync(connection.id, workspaceId);
  if (!snapshot) return null;

  const discovered = parseDiscoveredTools(snapshot.toolsMetadataJson);
  const discoveredByName = new Map(discovered.map((tool) => [tool.name, tool]));
  const approved = parseJsonArray(fresh.approvedToolsJson);
  const declaredNames = new Set(parseDeclaredTools(catalog.declaredToolsJson).map((tool) => tool.name));
  const approvedDeclared = approved.every((name) => declaredNames.has(name));
  const approvedPresent = approved.every((name) => discoveredByName.has(name));
  if (!approvedDeclared || !approvedPresent) {
    if (markDegradedOnMissingTool) {
      updateMcpConnectionStatusSync({
        connectionId: connection.id,
        workspaceId,
        status: "degraded",
        lastErrorCode: "mcp.approved_tool_missing",
        lastErrorMessage: approvedDeclared
          ? "An approved tool is no longer discoverable; the connection was removed from this task."
          : "An approved tool is no longer declared by the catalog; the connection was removed from this task.",
      });
    }
    return null;
  }

  const tools: RuntimeMcpTool[] = approved.flatMap((name) => {
    const tool = discoveredByName.get(name);
    return tool ? [{
      id: `mcp:${connection.id}:${name}`,
      connectionId: connection.id,
      name,
      description: tool.description,
      inputSchema: redactToolInputSchema(tool.inputSchema),
    }] : [];
  });
  if (tools.length === 0) return null;
  return { connectionId: connection.id, catalog, fresh, approved, tools };
}

export function listReadyMcpConnectionsForTaskSync(input: {
  workspaceId: string;
  runtimeId: string;
}): RuntimeMcpConnectionContextEntry[] {
  return listMcpConnectionsSync({
    workspaceId: input.workspaceId,
    runtimeId: input.runtimeId,
    status: "ready",
    limit: 500,
  }).flatMap((connection) => {
    const resolved = resolveReadyMcpConnectionForTask({
      workspaceId: input.workspaceId,
      connection,
      markDegradedOnMissingTool: true,
    });
    return resolved ? [{
      connectionId: resolved.connectionId,
      catalogItemId: resolved.catalog.id,
      catalogItemSlug: resolved.catalog.slug,
      catalogItemVersion: resolved.catalog.version,
      displayName: resolved.catalog.displayName,
      transport: resolved.catalog.transport,
      approvedTools: resolved.approved,
      tools: resolved.tools,
    }] : [];
  });
}

function parseJsonArray(value: string): string[] {
  try {
    const parsed = JSON.parse(value) as unknown;
    return Array.isArray(parsed) ? parsed.filter((item): item is string => typeof item === "string") : [];
  } catch {
    return [];
  }
}

function parseDeclaredTools(value: string): McpDeclaredTool[] {
  try {
    const parsed = JSON.parse(value) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed.flatMap((entry): McpDeclaredTool[] => {
      if (!entry || typeof entry !== "object") return [];
      const object = entry as Record<string, unknown>;
      if (typeof object.name !== "string") return [];
      return [{
        name: object.name,
        description: typeof object.description === "string" ? object.description : "",
        risk: object.risk === "low" || object.risk === "high" ? object.risk : "medium",
      }];
    });
  } catch {
    return [];
  }
}

function parseDiscoveredTools(value: string): McpDiscoveredTool[] {
  try {
    const parsed = JSON.parse(value) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed.flatMap((entry): McpDiscoveredTool[] => {
      if (!entry || typeof entry !== "object") return [];
      const object = entry as Record<string, unknown>;
      if (typeof object.name !== "string") return [];
      return [{
        name: object.name,
        description: typeof object.description === "string" ? object.description : "",
        inputSchema: object.inputSchema && typeof object.inputSchema === "object"
          ? object.inputSchema as Record<string, unknown>
          : {},
        inputSchemaDigest: typeof object.inputSchemaDigest === "string" ? object.inputSchemaDigest : "",
      }];
    });
  } catch {
    return [];
  }
}

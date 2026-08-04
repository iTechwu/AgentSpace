import {
  readAgentRuntimeSync,
  readMcpCatalogItemSync,
  readMcpConnectionSync,
} from "@dofe-agent/db";
import { listMcpConnectionActivitySync } from "@dofe-agent/services";
import type { McpConnectionDetailPageData } from "@/features/market/mcp-connection-detail-client";
import { parseMcpDeclaredTools } from "@/features/market/mcp-declared-tools";

export function loadMcpConnectionDetailPageData(input: {
  workspaceId: string;
  connectionId: string;
  canManage: boolean;
}): McpConnectionDetailPageData {
  const connection = readMcpConnectionSync(input.connectionId, input.workspaceId);
  if (!connection) {
    throw new Error("mcp_connection.not_found");
  }
  const catalog = readMcpCatalogItemSync(connection.catalogItemId, input.workspaceId);
  const runtime = readAgentRuntimeSync(connection.runtimeId);
  const declaredTools = parseMcpDeclaredTools(catalog?.declaredToolsJson);
  const approvedTools = safeJsonArray(connection.approvedToolsJson);
  return {
    workspaceId: input.workspaceId,
    canManage: input.canManage,
    connection: {
      id: connection.id,
      runtimeId: connection.runtimeId,
      runtimeLabel: runtime?.name ?? connection.runtimeId,
      catalogItemId: connection.catalogItemId,
      catalogSlug: catalog?.slug ?? "",
      catalogDisplayName: catalog?.displayName ?? connection.id,
      catalogDescription: catalog?.description ?? "",
      status: connection.status,
      transport: catalog?.transport ?? "streamable_http",
      endpoint: connection.endpoint,
      allowedHosts: safeJsonArray(catalog?.allowedHostsJson),
      dataDomains: safeJsonArray(catalog?.dataDomainsJson),
      approvedTools,
      declaredTools,
      nonSecretParams: safeJsonObject(connection.nonSecretParamsJson),
      lastVerifiedAt: connection.lastVerifiedAt,
      lastErrorCode: connection.lastErrorCode,
      lastErrorMessage: connection.lastErrorMessage,
      nextHealthCheckAt: connection.nextHealthCheckAt,
      healthCheckConsecutiveFailures: connection.healthCheckConsecutiveFailures,
    },
    activity: {
      operations: listMcpConnectionActivitySync({
        workspaceId: input.workspaceId,
        connectionId: input.connectionId,
        limit: 50,
      }).operations.map((operation) => ({
        id: operation.id,
        operation: operation.operation,
        source: operation.source,
        status: operation.status,
        stage: operation.stage,
        failedStage: operation.failedStage,
        createdAt: operation.createdAt,
        completedAt: operation.completedAt,
        errorMessage: operation.errorMessage,
      })),
      audits: listMcpConnectionActivitySync({
        workspaceId: input.workspaceId,
        connectionId: input.connectionId,
        limit: 50,
      }).audits.map((audit) => ({
        id: audit.id,
        toolName: audit.toolName,
        outcome: audit.outcome,
        latencyMs: audit.latencyMs,
        safeSummary: audit.safeSummary,
        actorId: audit.actorId,
        runtimeId: audit.runtimeId,
        createdAt: audit.createdAt,
      })),
    },
  };
}

function safeJsonArray(value: string | undefined): string[] {
  try {
    const parsed = JSON.parse(value ?? "[]") as unknown;
    return Array.isArray(parsed) ? parsed.filter((v): v is string => typeof v === "string") : [];
  } catch {
    return [];
  }
}

function safeJsonObject(value: string | undefined): Record<string, unknown> {
  try {
    const parsed = JSON.parse(value ?? "{}") as unknown;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

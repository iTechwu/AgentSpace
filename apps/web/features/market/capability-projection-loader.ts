import type {
  McpCatalogItemRecord,
  RuntimeAppCatalogItemRecord,
  RuntimeAppOperationRecord,
  RuntimeInstalledAppRecord,
  RuntimeMcpConnectionRecord,
  RuntimeMcpOperationRecord,
} from "@dofe-agent/db";
import {
  projectCliCapabilityAvailability,
  projectMcpCapabilityAvailability,
  selectCliHubReadiness,
  type CapabilityAvailabilityProjection,
} from "@dofe-agent/services";

/**
 * Compute the server-side 9-state projection for the (workspace, runtime)
 * tuple currently visible on the market page. The page treats this as the
 * single source of truth for the primary button — `installability` (the old
 * client-side boolean) is kept only for backwards-compatible display.
 */
export function computeMarketCapabilityProjections(input: {
  workspaceId: string;
  canManage: boolean;
  runtimes: Array<{
    id: string;
    label: string;
    status: "online" | "offline";
    metadataJson?: string;
    daemonMetadataJson?: string;
  }>;
  cliCatalog: RuntimeAppCatalogItemRecord[];
  installedApps: RuntimeInstalledAppRecord[];
  cliOperations: RuntimeAppOperationRecord[];
  mcpCatalog: McpCatalogItemRecord[];
  mcpConnections: RuntimeMcpConnectionRecord[];
  mcpOperations: RuntimeMcpOperationRecord[];
}): {
  projections: CapabilityAvailabilityProjection[];
  byPackageKey: Map<string, CapabilityAvailabilityProjection>;
} {
  const projections: CapabilityAvailabilityProjection[] = [];
  const byPackageKey = new Map<string, CapabilityAvailabilityProjection>();
  for (const runtime of input.runtimes) {
    const readiness = selectCliHubReadiness(runtime.metadataJson, runtime.daemonMetadataJson);
    const workspaceInput = {
      workspaceId: input.workspaceId,
      runtimeId: runtime.id,
      runtimeStatus: runtime.status,
      canManage: input.canManage,
      readiness: {
        npm: readiness.npm.available,
        python: readiness.python.available,
        pip: readiness.pip.available,
        cliHub: readiness.cliHub.available,
      },
    };
    for (const item of input.cliCatalog) {
      const installed = input.installedApps.find(
        (app) => app.runtimeId === runtime.id && app.source === item.source && app.name === item.name,
      ) ?? null;
      const itemOps = input.cliOperations.filter(
        (op) => op.runtimeId === runtime.id && op.appSource === item.source && op.appName === item.name,
      );
      const projection = projectCliCapabilityAvailability({
        workspace: workspaceInput,
        item,
        installed,
        activeOperations: itemOps,
      });
      projections.push(projection);
      byPackageKey.set(`${projection.runtimeId}:cli:${item.source}:${item.name}`, projection);
    }
    for (const catalogItem of input.mcpCatalog) {
      const connection = input.mcpConnections.find((c) => c.runtimeId === runtime.id && c.catalogItemId === catalogItem.id) ?? null;
      const itemOps = input.mcpOperations.filter(
        (op) => op.runtimeId === runtime.id && (connection ? op.connectionId === connection.id : false),
      );
      const projection = projectMcpCapabilityAvailability({
        workspace: workspaceInput,
        catalogItem: {
          id: catalogItem.id,
          transport: catalogItem.transport as "streamable_http" | "stdio" | "managed_stdio",
          slug: catalogItem.slug,
          displayName: catalogItem.displayName,
          risk: catalogItem.risk,
          declaredToolsJson: catalogItem.declaredToolsJson,
          requiredRuntimeCapabilitiesJson: catalogItem.requiredRuntimeCapabilitiesJson,
        },
        connectionStatus: connection?.status ?? null,
        activeOperations: itemOps,
      });
      projections.push(projection);
      byPackageKey.set(`${projection.runtimeId}:mcp:${catalogItem.id}`, projection);
    }
  }
  return { projections, byPackageKey };
}
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
  type CapabilityNextAction,
} from "@dofe-agent/services";
import { isActiveCapabilityOperationStatus } from "./capability-presentation";

/**
 * Minimal view of a capability_request used to overlay request state onto the
 * market projection (P1-2). We accept the raw DB record shape; only these
 * fields are read.
 */
interface CapabilityRequestProjectionInput {
  id: string;
  runtimeId?: string;
  packageKind: "cli" | "mcp" | "service";
  packageSource: string;
  packageSlug: string;
  status: string;
}

const TERMINAL_REQUEST_STATUS = new Set(["completed", "failed", "rejected", "cancelled"]);

/**
 * When a non-terminal capability_request covers this (runtime, package) tuple,
 * it becomes the source of truth for the button:
 *   pending            → wait_for_approval (admin must approve)
 *   approved + mcp     → configure_credentials (applicant must finish the
 *                        connection — dispatch cannot auto-connect a
 *                        credential/endpoint-bearing MCP, so it lingers in
 *                        approved; the market panel routes this to the same
 *                        connect form as `connect`)
 *   approved + non-mcp → wait_for_approval (defensive; CLI/zero-config MCP
 *                        auto-dispatch to running on approval, so this is at
 *                        most a transient frame)
 *   running            → wait_for_operation
 * We attach the request id so the UI can deep-link to "我的请求". Terminal
 * requests do not overlay — the package reflects its actual installed/
 * connection state.
 */
export function overlayCapabilityRequestState(
  projection: CapabilityAvailabilityProjection,
  request: CapabilityRequestProjectionInput | undefined,
): CapabilityAvailabilityProjection {
  if (!request || TERMINAL_REQUEST_STATUS.has(request.status)) return projection;
  let nextAction: CapabilityNextAction;
  if (request.status === "running") {
    nextAction = "wait_for_operation";
  } else if (request.status === "approved" && request.packageKind === "mcp") {
    nextAction = "configure_credentials";
  } else {
    nextAction = "wait_for_approval";
  }
  return { ...projection, capabilityRequestId: request.id, nextAction };
}

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
  capabilityRequests: CapabilityRequestProjectionInput[];
}): {
  projections: CapabilityAvailabilityProjection[];
  byPackageKey: Map<string, CapabilityAvailabilityProjection>;
} {
  const projections: CapabilityAvailabilityProjection[] = [];
  const byPackageKey = new Map<string, CapabilityAvailabilityProjection>();
  for (const runtime of input.runtimes) {
    const readiness = selectCliHubReadiness(runtime.metadataJson, runtime.daemonMetadataJson);
    const profile = readiness.executionProfile;
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
      // Execution profile negotiation: only map explicit assertions; unknown
      // profile items (older daemon) are left undefined and never degrade.
      profile: {
        writableHome: profile?.writableHome?.available,
        persistentHome: profile?.persistentHome?.available,
        runtimePackageExecutor: profile?.runtimePackageExecutor?.available,
        mcpGateway: profile?.mcpGateway?.available,
        managedServiceReachable: profile?.managedServiceReachable?.available,
      },
    };
    for (const item of input.cliCatalog) {
      const installed = input.installedApps.find(
        (app) => app.runtimeId === runtime.id && app.source === item.source && app.name === item.name,
      ) ?? null;
      // Only pending/claimed/running operations block a new action; terminal
      // (succeeded/failed/cancelled) ops must not be treated as in-flight.
      const itemOps = input.cliOperations.filter(
        (op) =>
          op.runtimeId === runtime.id &&
          op.appSource === item.source &&
          op.appName === item.name &&
          isActiveCapabilityOperationStatus(op.status),
      );
      const baseProjection = projectCliCapabilityAvailability({
        workspace: workspaceInput,
        item,
        installed,
        activeOperations: itemOps,
      });
      const cliRequest = input.capabilityRequests.find(
        (r) =>
          r.runtimeId === runtime.id &&
          r.packageKind === "cli" &&
          r.packageSource === item.source &&
          r.packageSlug === item.name,
      );
      const projection = overlayCapabilityRequestState(baseProjection, cliRequest);
      projections.push(projection);
      byPackageKey.set(`${projection.runtimeId}:cli:${item.source}:${item.name}`, projection);
    }
    for (const catalogItem of input.mcpCatalog) {
      const connection = input.mcpConnections.find((c) => c.runtimeId === runtime.id && c.catalogItemId === catalogItem.id) ?? null;
      const itemOps = input.mcpOperations.filter(
        (op) =>
          op.runtimeId === runtime.id &&
          (connection ? op.connectionId === connection.id : false) &&
          isActiveCapabilityOperationStatus(op.status),
      );
      const baseProjection = projectMcpCapabilityAvailability({
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
      const mcpRequest = input.capabilityRequests.find(
        (r) =>
          r.runtimeId === runtime.id &&
          r.packageKind === "mcp" &&
          r.packageSource === catalogItem.source &&
          r.packageSlug === catalogItem.slug,
      );
      const projection = overlayCapabilityRequestState(baseProjection, mcpRequest);
      projections.push(projection);
      byPackageKey.set(`${projection.runtimeId}:mcp:${catalogItem.id}`, projection);
    }
  }
  return { projections, byPackageKey };
}
import {
  listDaemonSnapshotsSync,
  listMcpConnectionsSync,
  listMcpOperationsSync,
  listRuntimeAppCatalogItemsSync,
  listRuntimeAppOperationsSync,
  listRuntimeInstalledAppsSync,
  readAgentRuntimeSync,
  type RuntimeAppCatalogItemRecord,
  type RuntimeInstalledAppRecord,
} from "@dofe-agent/db";
import {
  isCapabilityProjectionEnabled,
  listActiveCapabilityRequestsForRuntime,
  listMcpCatalogItemsForWorkspaceSync,
  listWorkspaceRuntimeAppCatalogItemsSync,
  projectCliCapabilityAvailability,
  projectMcpCapabilityAvailability,
  selectCliHubReadiness,
  type CapabilityAvailabilityProjection,
} from "@dofe-agent/services";
import { getCurrentWorkspaceContext } from "@/features/auth/server-workspace";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * GET /api/workspaces/:workspaceId/capabilities/availability
 *
 * Server-side `nextAction` projection. The page never decides "what to do
 * next" from multiple independent flags — it asks the server, which reads the
 * catalog, runtime readiness, installed/connected records, active operations
 * and active capability_requests to produce a single 9-state enum per
 * (runtime, package) tuple.
 */
export async function GET(
  request: Request,
  context: { params: Promise<{ workspaceId: string }> },
): Promise<Response> {
  const workspaceContext = await getCurrentWorkspaceContext();
  if (!workspaceContext) {
    return Response.json({ error: "Unauthorized." }, { status: 401 });
  }
  const { workspaceId } = await context.params;
  if (workspaceId !== workspaceContext.currentWorkspace.id) {
    return Response.json({ error: "Forbidden." }, { status: 403 });
  }
  const url = new URL(request.url);
  const runtimeId = url.searchParams.get("runtimeId")?.trim() ?? "";
  // `kind` (cli|mcp|service) or the multi-implementation alias `implementation`
  // (cli|mcp) — lets an admin request a specific implementation's projection for
  // the admin switch (docs §4.5). Defaults to all kinds.
  const kind = (url.searchParams.get("implementation")?.trim() || url.searchParams.get("kind")?.trim()) || undefined;
  if (!runtimeId) {
    return Response.json({ error: "Query parameter `runtimeId` is required." }, { status: 400 });
  }
  if (kind && !["cli", "mcp", "service"].includes(kind)) {
    return Response.json({ error: "`kind`/`implementation` must be cli | mcp | service." }, { status: 400 });
  }

  // Phase 7 rollback switch. Disabling the projection keeps the legacy
  // client-side installability path active so the page still renders.
  if (!isCapabilityProjectionEnabled()) {
    return Response.json(
      { runtimeId, projections: [], activeRequests: [], disabled: true },
      { headers: { "Cache-Control": "private, no-store" } },
    );
  }

  const runtime = readAgentRuntimeSync(runtimeId);
  if (!runtime || runtime.workspaceId !== workspaceId) {
    return Response.json({ error: "Runtime not found." }, { status: 404 });
  }

  const daemonSnapshot = listDaemonSnapshotsSync(workspaceId)
    .find((snapshot) => snapshot.runtimes.some((rt) => rt.id === runtimeId));
  const readiness = selectCliHubReadiness(
    runtime.metadataJson,
    daemonSnapshot?.daemon.metadataJson,
  );
  const canManage = isWorkspaceAdmin(workspaceContext.currentMembership.role);

  const profile = readiness.executionProfile;
  const workspace: Parameters<typeof projectCliCapabilityAvailability>[0]["workspace"] = {
    workspaceId,
    runtimeId,
    runtimeStatus: daemonSnapshot?.runtimes.find((rt) => rt.id === runtimeId)?.status ?? "unknown",
    canManage,
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

  const installedApps = listRuntimeInstalledAppsSync({ workspaceId, runtimeId });
  // Query active statuses directly. Fetching the latest N operations and then
  // filtering in memory lets terminal history hide a real pending/running task
  // and makes projection treat completed work as still in flight.
  const activeOps = (['pending', 'claimed', 'running'] as const).flatMap((status) =>
    listRuntimeAppOperationsSync({ workspaceId, runtimeId, status, limit: 50 }),
  );
  const mcpConnections = listMcpConnectionsSync({ workspaceId, runtimeId, limit: 500 });
  const mcpOps = (['pending', 'claimed', 'running'] as const).flatMap((status) =>
    listMcpOperationsSync({ workspaceId, runtimeId, status, limit: 50 }),
  );
  // Permission boundary: owners/admins see the full workspace queue (the
  // projections they render need the overlay); non-admins only ever see their
  // own requests so the API cannot leak other members' requests, states or
  // timestamps.
  const capabilityRequests = listActiveCapabilityRequestsForRuntime({ workspaceId, runtimeId })
    .filter((request) => canManage || request.requestedByUserId === workspaceContext.currentUser?.id);

  const projections: CapabilityAvailabilityProjection[] = [];

  if (kind === undefined || kind === "cli") {
    const allItems: RuntimeAppCatalogItemRecord[] = [
      ...listRuntimeAppCatalogItemsSync({ limit: 1000 }),
      ...listWorkspaceRuntimeAppCatalogItemsSync(workspaceId),
    ];
    for (const item of allItems) {
      const installed = findInstalled(installedApps, item.source, item.name);
      const itemOps = activeOps.filter((op) => op.appSource === item.source && op.appName === item.name);
      projections.push(
        projectCliCapabilityAvailability({
          workspace,
          item,
          installed,
          activeOperations: itemOps,
        }),
      );
    }
  }

  if (kind === undefined || kind === "mcp" || kind === "service") {
    const mcpCatalog = listMcpCatalogItemsForWorkspaceSync(workspaceId);
    for (const catalogItem of mcpCatalog) {
      const connection = mcpConnections.find((c) => c.catalogItemId === catalogItem.id);
      const itemOps = mcpOps.filter((op) =>
        connection ? op.connectionId === connection.id : false
      );
      projections.push(
        projectMcpCapabilityAvailability({
          workspace,
          catalogItem: {
            id: catalogItem.id,
            transport: catalogItem.transport as "streamable_http" | "stdio" | "managed_stdio",
            slug: catalogItem.slug,
            displayName: catalogItem.displayName,
            risk: catalogItem.risk,
            declaredToolsJson: catalogItem.declaredToolsJson,
            requiredRuntimeCapabilitiesJson: catalogItem.requiredRuntimeCapabilitiesJson,
            requiredRuntimeApp: catalogItem.requiredRuntimeApp ?? null,
          },
          connectionStatus: connection?.status ?? null,
          activeOperations: itemOps,
        }),
      );
    }
  }

  return Response.json(
    {
      runtimeId,
      projections,
      activeRequests: capabilityRequests.map((request) => ({
        id: request.id,
        packageKind: request.packageKind,
        packageSlug: request.packageSlug,
        packageDisplayName: request.packageDisplayName,
        deploymentMode: request.deploymentMode,
        requestedAction: request.requestedAction,
        status: request.status,
        createdAt: request.createdAt,
      })),
    },
    { headers: { "Cache-Control": "private, no-store" } },
  );
}

function findInstalled(
  installed: RuntimeInstalledAppRecord[],
  source: string,
  name: string,
): RuntimeInstalledAppRecord | null {
  return installed.find((app) => app.source === source && app.name === name) ?? null;
}

function isWorkspaceAdmin(role: string): boolean {
  return role === "owner" || role === "admin";
}

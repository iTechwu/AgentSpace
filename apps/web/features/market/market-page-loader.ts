import {
  listDaemonSnapshotsSync,
  listMcpConnectionsSync,
  listMcpOperationsSync,
  listRuntimeAppCatalogItemsSync,
  listRuntimeAppOperationsSync,
  listRuntimeInstalledAppsSync,
  readRuntimeAppCatalogHealthSync,
  readMcpCatalogItemSync,
} from "@dofe-agent/db";
import {
  assessRuntimeAppInstallability,
  assessRuntimeAppRisk,
  listMcpCatalogItemsForWorkspaceSync,
  readCliHubReadinessForRuntimeSync,
  resolveOfficialMcpRuntimeAppRequirement,
  syncOfficialMcpCatalogForWorkspaceSync,
  syncCliHubCatalog,
} from "@dofe-agent/services";
import type { MarketPageData } from "@/features/market/market-page-client";
import { parseMcpDeclaredTools } from "@/features/market/mcp-declared-tools";

export async function loadMarketPageData(input: {
  workspaceId: string;
  canManage: boolean;
}): Promise<MarketPageData> {
  let catalogHealth = readRuntimeAppCatalogHealthSync();
  if (catalogHealth.itemCount === 0) {
    await syncCliHubCatalog();
  }
  syncOfficialMcpCatalogForWorkspaceSync(input.workspaceId);

  const daemonSnapshots = listDaemonSnapshotsSync(input.workspaceId);
  const mcpCatalogRecords = listMcpCatalogItemsForWorkspaceSync(input.workspaceId);
  const mcpCatalogById = new Map(mcpCatalogRecords.map((item) => [item.id, item]));
  const officialRuntimeApps = new Set(mcpCatalogRecords.flatMap((item) => {
    const requirement = resolveOfficialMcpRuntimeAppRequirement(item);
    return requirement ? [`${requirement.source}:${requirement.name}`] : [];
  }));
  const catalogRecords = listRuntimeAppCatalogItemsSync({ limit: 1000 });
  catalogHealth = projectCliCatalogHealth(catalogRecords, officialRuntimeApps);
  return {
    catalog: catalogRecords.map((item) => {
      const installability = assessRuntimeAppInstallability(item);
      return {
        source: item.source,
        productSource: officialRuntimeApps.has(`${item.source}:${item.name}`) ? "official" : item.source,
        name: item.name,
        displayName: item.displayName,
        description: item.description,
        version: item.version,
        category: item.category,
        entryPoint: item.entryPoint,
        installStrategy: item.installStrategy,
        installCmd: item.installCmd,
        skillMd: item.skillMd,
        requiresText: item.requiresText,
        homepage: item.homepage,
        risk: assessRuntimeAppRisk(item),
        installability,
      };
    }),
    catalogHealth,
    runtimes: daemonSnapshots.flatMap((snapshot) =>
      snapshot.runtimes.filter((runtime) => runtime.status === "online").map((runtime) => {
        const readiness = readCliHubReadinessForRuntimeSync({
          workspaceId: input.workspaceId,
          runtimeId: runtime.id,
          runtimeMetadataJson: runtime.metadataJson,
        });
        return {
          id: runtime.id,
          label: runtime.name,
          provider: runtime.provider,
          status: runtime.status,
          daemonKey: snapshot.daemon.daemonKey,
          cliHubReady: readiness.cliHub.available,
          cliReadiness: {
            npm: readiness.npm.available,
            python: readiness.python.available,
            pip: readiness.pip.available,
            cliHub: readiness.cliHub.available,
          },
          // MCP gateway eligibility: neither claude nor codex has passed real CLI
          // E2E (call, revoke, audit, lifecycle) in the designated CI env, so BOTH
          // are opt-in experimental flags, default OFF — "being able to build
          // launch args" is not "supported". Only after the CI env validates a
          // provider do we flip its flag to default-on. Other providers are not
          // eligible yet.
          mcpEligible:
            (runtime.provider === "claude" && process.env.MCP_CLAUDE_EXPERIMENTAL_ENABLED === "1")
            || (runtime.provider === "codex" && process.env.MCP_CODEX_EXPERIMENTAL_ENABLED === "1"),
        };
      }),
    ),
    installedApps: listRuntimeInstalledAppsSync({ workspaceId: input.workspaceId }).map((app) => ({
      runtimeId: app.runtimeId,
      source: app.source,
      name: app.name,
      status: app.status,
      enabled: app.enabled,
      version: app.version,
      entryPoint: app.entryPoint,
      lastError: app.lastError,
      updatedAt: app.updatedAt,
    })),
    operations: listRuntimeAppOperationsSync({ workspaceId: input.workspaceId, limit: 200 }).map((operation) => ({
      id: operation.id,
      runtimeId: operation.runtimeId,
      appSource: operation.appSource,
      appName: operation.appName,
      operation: operation.operation,
      status: operation.status,
      stage: operation.stage,
      failedStage: operation.failedStage,
      createdAt: operation.createdAt,
      errorMessage: operation.errorMessage,
    })),
    mcpCatalog: mcpCatalogRecords.map((item) => ({
      id: item.id,
      source: item.source,
      slug: item.slug,
      displayName: item.displayName,
      description: item.description,
      version: item.version,
      category: item.category,
      transport: item.transport,
      risk: item.risk,
      allowedHosts: safeJsonArray(item.allowedHostsJson),
      dataDomains: safeJsonArray(item.dataDomainsJson),
      declaredTools: parseMcpDeclaredTools(item.declaredToolsJson),
      defaultApprovedTools: safeJsonArray(item.defaultApprovedToolsJson),
      secretFields: safeJsonArray(item.secretFieldsJson),
      configurationFields: safeConfigurationFields(item.configurationSchemaJson),
      endpointTemplate: item.endpointTemplate,
      documentationUrl: item.documentationUrl,
      requiredRuntimeApp: resolveOfficialMcpRuntimeAppRequirement(item),
    })),
    mcpConnections: listMcpConnectionsSync({ workspaceId: input.workspaceId, limit: 500 }).map((connection) => {
      const catalog = mcpCatalogById.get(connection.catalogItemId) ?? readMcpCatalogItemSync(connection.catalogItemId, input.workspaceId);
      const declared = parseMcpDeclaredTools(catalog?.declaredToolsJson);
      return {
        id: connection.id,
        runtimeId: connection.runtimeId,
        catalogItemId: connection.catalogItemId,
        catalogSlug: catalog?.slug ?? "",
        catalogDisplayName: catalog?.displayName ?? connection.id,
        status: connection.status,
        transport: catalog?.transport ?? "streamable_http",
        approvedTools: safeJsonArray(connection.approvedToolsJson),
        declaredToolCount: declared.length,
        lastVerifiedAt: connection.lastVerifiedAt,
        lastErrorCode: connection.lastErrorCode,
        lastErrorMessage: connection.lastErrorMessage,
      };
    }),
    mcpOperations: listMcpOperationsSync({ workspaceId: input.workspaceId, limit: 200 }).map((operation) => ({
      id: operation.id,
      runtimeId: operation.runtimeId,
      connectionId: operation.connectionId,
      operation: operation.operation,
      status: operation.status,
      createdAt: operation.createdAt,
      errorMessage: operation.errorMessage,
    })),
    canManage: input.canManage,
  };
}

function projectCliCatalogHealth(
  records: ReturnType<typeof listRuntimeAppCatalogItemsSync>,
  officialRuntimeApps: Set<string>,
): MarketPageData["catalogHealth"] {
  const upstreamSyncTimes = records
    .filter((item) => (
      (item.source === "clihub_harness" || item.source === "clihub_public")
      && !officialRuntimeApps.has(`${item.source}:${item.name}`)
    ))
    .map((item) => new Date(item.syncedAt).getTime())
    .filter(Number.isFinite);
  const lastSyncedTime = upstreamSyncTimes.length > 0 ? Math.max(...upstreamSyncTimes) : undefined;
  const ageMs = lastSyncedTime === undefined ? Number.POSITIVE_INFINITY : Date.now() - lastSyncedTime;
  return {
    itemCount: records.length,
    lastSyncedAt: lastSyncedTime === undefined ? undefined : new Date(lastSyncedTime).toISOString(),
    stale: !Number.isFinite(ageMs) || ageMs > 24 * 60 * 60 * 1000,
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

function safeConfigurationFields(value: string | undefined): Array<{ name: string; required: boolean; maxLength?: number }> {
  try {
    const parsed = JSON.parse(value ?? "{}") as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return [];
    const schema = parsed as Record<string, unknown>;
    if (schema.type !== "object" || !schema.properties || typeof schema.properties !== "object" || Array.isArray(schema.properties)) {
      return [];
    }
    const required = new Set(Array.isArray(schema.required) ? schema.required.filter((name): name is string => typeof name === "string") : []);
    return Object.entries(schema.properties as Record<string, unknown>)
      .filter(([name, definition]) =>
        /^[!#$%&'*+.^_`|~0-9A-Za-z-]{1,128}$/.test(name) &&
        Boolean(definition) &&
        typeof definition === "object" &&
        !Array.isArray(definition) &&
        (definition as Record<string, unknown>).type === "string",
      )
      .map(([name, definition]) => {
        const maxLength = (definition as Record<string, unknown>).maxLength;
        return {
          name,
          required: required.has(name),
          maxLength: typeof maxLength === "number" && Number.isInteger(maxLength) && maxLength >= 0 && maxLength <= 4096
            ? maxLength
            : undefined,
        };
      });
  } catch {
    return [];
  }
}

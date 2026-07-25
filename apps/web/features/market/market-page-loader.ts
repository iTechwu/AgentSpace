import {
  listDaemonSnapshotsSync,
  listRuntimeAppCatalogItemsSync,
  listRuntimeAppOperationsSync,
  listRuntimeInstalledAppsSync,
  readRuntimeAppCatalogHealthSync,
} from "@dofe-agent/db";
import {
  assessRuntimeAppRisk,
  readCliHubReadinessForRuntimeSync,
  syncCliHubCatalog,
} from "@dofe-agent/services";
import type { MarketPageData } from "@/features/market/market-page-client";

export async function loadMarketPageData(input: {
  workspaceId: string;
  canManage: boolean;
}): Promise<MarketPageData> {
  let catalogHealth = readRuntimeAppCatalogHealthSync();
  if (catalogHealth.itemCount === 0) {
    await syncCliHubCatalog();
    catalogHealth = readRuntimeAppCatalogHealthSync();
  }

  const daemonSnapshots = listDaemonSnapshotsSync(input.workspaceId);
  return {
    catalog: listRuntimeAppCatalogItemsSync({ limit: 1000 }).map((item) => ({
      source: item.source,
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
    })),
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
    })),
    operations: listRuntimeAppOperationsSync({ workspaceId: input.workspaceId, limit: 200 }).map((operation) => ({
      id: operation.id,
      runtimeId: operation.runtimeId,
      appSource: operation.appSource,
      appName: operation.appName,
      operation: operation.operation,
      status: operation.status,
      createdAt: operation.createdAt,
      errorMessage: operation.errorMessage,
    })),
    canManage: input.canManage,
  };
}

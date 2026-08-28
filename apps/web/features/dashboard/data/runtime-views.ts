// dashboard daemon 快照/令牌/供应商账号视图（从 features/dashboard/data.ts 拆出，3.4/3.6 巨型文件项）。

import type { DaemonSnapshotView, DaemonTokenView, ProviderAccountView, RuntimeGrantMember, RuntimeProvisionRequestView } from "../data-types";
import { DEFAULT_WORKSPACE_ID } from "@dofe-agent/db";
import { normalizeRuntimeProviderHealth } from "@dofe-agent/services/runtime";
import { safeParseJson } from "./agent-record.ts";
import { listDaemonApiTokensCached, listDaemonSnapshotsCached, listProviderAccountsCached, listRuntimeProvisionRequestsCached, listWorkspaceRuntimeDisplayNamesCached } from "./cached.ts";

export function listDaemonSnapshotViews(workspaceId = DEFAULT_WORKSPACE_ID): DaemonSnapshotView[] {
  const runtimeDisplayNames = buildRuntimeDisplayNameIndex(workspaceId);
  const providerAccounts = new Map(listProviderAccountsCached(workspaceId).map((account) => [account.id, account]));
  return listDaemonSnapshotsCached(workspaceId).map((snapshot) => {
    const daemonMetadata = safeParseJson(snapshot.daemon.metadataJson);
    const runtimeName = typeof daemonMetadata.runtimeName === "string" && daemonMetadata.runtimeName.trim()
      ? daemonMetadata.runtimeName.trim()
      : undefined;
    return {
      daemonKey: snapshot.daemon.daemonKey,
      deviceName: snapshot.daemon.deviceName,
      status: snapshot.daemon.status,
      lastHeartbeatAt: snapshot.daemon.lastHeartbeatAt,
      mode: daemonMetadata.mode === "remote" ? "remote" : "local",
      serverUrl: typeof daemonMetadata.serverUrl === "string" ? daemonMetadata.serverUrl : undefined,
      runtimeName,
      runtimes: snapshot.runtimes.map((runtime) => ({
        id: runtime.id,
        provider: runtime.provider,
        providerAccountId: runtime.providerAccountId,
        providerAccountName: runtime.providerAccountId ? providerAccounts.get(runtime.providerAccountId)?.name : undefined,
        name: runtime.name,
        displayName: runtimeDisplayNames.get(runtime.id),
        status: runtime.status,
        providerHealth: normalizeRuntimeProviderHealth({
          runtimeStatus: runtime.status,
          runtimeMetadata: safeParseJson(runtime.metadataJson),
          lastError: runtime.lastError,
        }),
        lastHeartbeatAt: runtime.lastHeartbeatAt,
        version: runtime.version,
      })),
    };
  });
}
export function buildRuntimeDisplayNameIndex(workspaceId: string): Map<string, string> {
  return new Map(
    listWorkspaceRuntimeDisplayNamesCached(workspaceId)
      .map((record) => [record.runtimeId, record.displayName.trim()] as const)
      .filter((entry) => entry[1].length > 0),
  );
}
export function listDaemonTokenViews(
  workspaceId = DEFAULT_WORKSPACE_ID,
  memberByUserId = new Map<string, RuntimeGrantMember>(),
): DaemonTokenView[] {
  return listDaemonApiTokensCached(workspaceId).map((token) => ({
    id: token.id,
    label: token.label,
    status: token.status,
    createdBy: memberByUserId.get(token.createdBy)?.displayName ?? token.createdBy,
    lastUsedAt: token.lastUsedAt,
    createdAt: token.createdAt,
    revokedAt: token.revokedAt,
  }));
}
export function listProviderAccountViews(workspaceId = DEFAULT_WORKSPACE_ID): ProviderAccountView[] {
  return listProviderAccountsCached(workspaceId).map((account) => ({
    id: account.id,
    provider: account.provider,
    name: account.name,
    billingAccountId: account.billingAccountId,
    allowedModels: account.allowedModels,
    status: account.status,
  }));
}
export function listRuntimeProvisionRequestViews(workspaceId = DEFAULT_WORKSPACE_ID): RuntimeProvisionRequestView[] {
  const accountNames = new Map(listProviderAccountsCached(workspaceId).map((account) => [account.id, account.name]));
  return listRuntimeProvisionRequestsCached(workspaceId).map((request) => ({
    id: request.id,
    provider: request.provider,
    providerAccountId: request.providerAccountId,
    providerAccountName: accountNames.get(request.providerAccountId) ?? request.providerAccountId,
    runtimeName: request.runtimeName,
    targetServer: request.targetServer,
    status: request.status,
    createdAt: request.createdAt,
  }));
}

import { heartbeatDaemonSync, listPendingManagedRuntimeCleanupRequestsForDaemonSync, markManagedRuntimeCleanupRequestRunningSync, readDaemonSnapshotSync, recordAuditLogSync } from "@dofe-agent/db";
import type { HeartbeatDaemonRequest, HeartbeatDaemonResponse } from "@dofe-agent/domain";
import { buildManagedCleanupCommands, resolveAgentRuntimeMode, resumePendingRuntimeCredentialRecoveriesAsync } from "@dofe-agent/services/runtime";
import { readDaemonConnectionForDaemon, requireDaemonAuth, requireManagedNodeBootstrapToken } from "../_lib/auth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request: Request): Promise<Response> {
  const auth = requireDaemonAuth(request);
  if (auth instanceof Response) {
    return auth;
  }
  const isRemoteMode = resolveAgentRuntimeMode() === "remote";
  if (isRemoteMode) {
    const tokenError = requireManagedNodeBootstrapToken(auth);
    if (tokenError) {
      return tokenError;
    }
  }

  let body: Partial<HeartbeatDaemonRequest>;
  try {
    body = (await request.json()) as Partial<HeartbeatDaemonRequest>;
  } catch {
    return Response.json({ error: "Request body must be valid JSON." }, { status: 400 });
  }
  if (!body || !body.daemonKey?.trim()) {
    return Response.json({ error: "daemonKey is required." }, { status: 400 });
  }

  const daemon = readDaemonConnectionForDaemon(body.daemonKey.trim(), auth);
  if (daemon instanceof Response) {
    return daemon;
  }

  const previousSnapshot = readDaemonSnapshotSync(daemon.daemonKey);
  const snapshot = heartbeatDaemonSync(daemon.daemonKey, {
    metadata: isRecord(body.metadata) ? body.metadata : undefined,
    runtimes: Array.isArray(body.runtimes)
      ? body.runtimes
          .filter((runtime) => runtime && isRecord(runtime))
          .map((runtime) => ({
            id: typeof runtime.id === "string" ? runtime.id : undefined,
            provider: typeof runtime.provider === "string" ? runtime.provider : undefined,
            metadata: isRecord(runtime.metadata) ? runtime.metadata : undefined,
          }))
      : undefined,
  });
  recordProviderHealthTransitions(previousSnapshot, snapshot);

  const cleanupRequests = isRemoteMode
    ? listPendingManagedRuntimeCleanupRequestsForDaemonSync(daemon.id)
      .map((req) => {
        const claimed = markManagedRuntimeCleanupRequestRunningSync(req.id);
        if (!claimed) {
          return null;
        }
        return {
          requestId: req.id,
          workspaceId: req.workspaceId,
          runtimeId: req.runtimeId,
          runtimeType: req.runtimeType,
          commands: buildManagedCleanupCommands(req.runtimeType, req.runtimeId),
        };
      })
      .filter((request): request is NonNullable<typeof request> => request !== null)
    : [];

  if (isRemoteMode) {
    await resumePendingRuntimeCredentialRecoveriesAsync({
      workspaceId: auth.workspaceId,
    }).catch(() => []);
  }

  const response: HeartbeatDaemonResponse = {
    daemon: {
      daemonKey: snapshot.daemon.daemonKey,
      status: snapshot.daemon.status,
      workspaceId: snapshot.daemon.workspaceId,
      lastHeartbeatAt: snapshot.daemon.lastHeartbeatAt,
    },
    runtimes: snapshot.runtimes.map((runtime) => {
      const metadata = safeParseRecord(runtime.metadataJson) ?? {};
      const responseMetadata = isRemoteMode ? metadata : omitManagedRuntimeMetadata(metadata);
      return {
        id: runtime.id,
        provider: runtime.provider,
        status: runtime.status,
        lastHeartbeatAt: runtime.lastHeartbeatAt,
        metadata: {
          ...responseMetadata,
          ...(isRemoteMode && runtime.managedCredentialId ? { managedCredentialId: runtime.managedCredentialId } : {}),
          ...(isRemoteMode && runtime.provisioningState ? { provisioningState: runtime.provisioningState } : {}),
        },
      };
    }),
    managedRuntimeCleanupRequests: cleanupRequests,
  };

  return Response.json(response);
}

function recordProviderHealthTransitions(
  previous: ReturnType<typeof readDaemonSnapshotSync>,
  current: ReturnType<typeof heartbeatDaemonSync>,
): void {
  const previousHealthByRuntimeId = new Map(
    previous.runtimes.map((runtime) => [runtime.id, readProviderHealth(runtime.metadataJson)?.status ?? "unknown"]),
  );
  for (const runtime of current.runtimes) {
    if (!runtime.managedCredentialId) continue;
    const health = readProviderHealth(runtime.metadataJson);
    if (!health || health.status === "unknown") continue;
    const previousStatus = previousHealthByRuntimeId.get(runtime.id) ?? "unknown";
    if (previousStatus === health.status) continue;
    try {
      recordAuditLogSync({
        workspaceId: runtime.workspaceId,
        title: "Managed runtime provider health changed",
        note: `Runtime ${runtime.id} provider health changed from ${previousStatus} to ${health.status}.`,
        code: "runtime.provider_health_changed",
        source: "runtime_lifecycle",
        data: {
          runtimeId: runtime.id,
          runtimeType: runtime.provider,
          previousStatus,
          status: health.status,
          errorCode: health.errorCode,
          verificationKind: health.verificationKind,
          checkedAt: health.checkedAt,
          protocols: runtime.protocols?.join(",") ?? "",
          defaultModel: runtime.defaultModel ?? "",
        },
      });
    } catch {
      // Health reporting must remain available even if audit persistence is unavailable.
    }
  }
}

function readProviderHealth(metadataJson: string): {
  status: "healthy" | "degraded" | "broken" | "unknown";
  errorCode?: string;
  verificationKind?: string;
  checkedAt?: string;
} | undefined {
  try {
    const metadata = JSON.parse(metadataJson) as { providerHealth?: unknown };
    if (!metadata.providerHealth || typeof metadata.providerHealth !== "object" || Array.isArray(metadata.providerHealth)) {
      return undefined;
    }
    const health = metadata.providerHealth as Record<string, unknown>;
    const status = health.status;
    if (status !== "healthy" && status !== "degraded" && status !== "broken" && status !== "unknown") {
      return undefined;
    }
    const error = health.error && typeof health.error === "object" && !Array.isArray(health.error)
      ? health.error as Record<string, unknown>
      : undefined;
    return {
      status,
      errorCode: typeof error?.code === "string" ? error.code : undefined,
      verificationKind: typeof health.verificationKind === "string" ? health.verificationKind : undefined,
      checkedAt: typeof health.checkedAt === "string" ? health.checkedAt : undefined,
    };
  } catch {
    return undefined;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function safeParseRecord(value: string): Record<string, unknown> | undefined {
  try {
    const parsed = JSON.parse(value) as unknown;
    return isRecord(parsed) ? parsed : undefined;
  } catch {
    return undefined;
  }
}

function omitManagedRuntimeMetadata(metadata: Record<string, unknown>): Record<string, unknown> {
  const { managedCredentialId: _managedCredentialId, provisioningState: _provisioningState, ...localMetadata } = metadata;
  return localMetadata;
}

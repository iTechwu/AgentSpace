// 3.5-4：自 remote-daemon.ts 拆出——注册期 runtime 记录构建、心跳对账与
// 托管 runtime 凭据恢复、心跳元数据与 CLI-hub 就绪探测。
import { isDaemonProvider, type DaemonProvider } from "@dofe-agent/domain";
import type { HeartbeatDaemonResponse, RegisterDaemonResponse } from "../daemon-api.ts";
import {
  buildProviderRuntimeMetadata,
  type DetectedProvider,
  type RemoteRuntimeRecord,
} from "../provider-runtime.ts";
import {
  readCliHubReadiness,
  readManagedCliHubReadiness,
  type CliHubReadiness,
} from "../runtime-apps.ts";
import type { ManagedCredentialResolver } from "../managed-provider-credentials.ts";
import type { RemoteDaemonConfig } from "./config.ts";
import { ensureManagedRuntimeHomeDir } from "./mcp.ts";

export interface ManagedRuntimeEntry {
  id: string;
  provider: DaemonProvider;
  runtimeCredentialId: string;
  executablePath: string;
  status: "online" | "offline";
}

export function buildRemoteRuntimeRecords(
  config: RemoteDaemonConfig,
  registered: RegisterDaemonResponse,
  detected: DetectedProvider[],
): RemoteRuntimeRecord[] {
  return registered.runtimes.flatMap((runtime) => {
    const detectedProvider = detected.find((provider) => provider.provider === runtime.provider);
    if (!detectedProvider) {
      return [];
    }

    return [{
      id: runtime.id,
      workspaceId: registered.daemon.workspaceId,
      provider: detectedProvider.provider,
      name: runtime.name,
      version: detectedProvider.version,
      status: runtime.status,
      deviceInfo: config.deviceName,
      metadata: {
        executablePath: detectedProvider.executablePath,
        mode: "remote",
        ...buildProviderRuntimeMetadata({
          provider: detectedProvider.provider,
          metadata: {
            executablePath: detectedProvider.executablePath,
            mode: "remote",
          },
        }),
      },
    } satisfies RemoteRuntimeRecord];
  });
}

export function reconcileRemoteRuntimesWithHeartbeat(
  current: RemoteRuntimeRecord[],
  heartbeat: HeartbeatDaemonResponse,
  workspaceId: string,
  deviceName: string,
): RemoteRuntimeRecord[] {
  const currentById = new Map(current.map((runtime) => [runtime.id, runtime]));
  const heartbeatById = new Map(heartbeat.runtimes.map((runtime) => [runtime.id, runtime]));
  const result: RemoteRuntimeRecord[] = [];

  for (const runtime of current) {
    const heartbeatRuntime = heartbeatById.get(runtime.id);
    if (!heartbeatRuntime) {
      continue;
    }
    result.push({
      ...runtime,
      status: heartbeatRuntime.status,
      metadata: {
        ...runtime.metadata,
        ...(heartbeatRuntime.metadata ?? {}),
      },
    });
  }

  for (const heartbeatRuntime of heartbeat.runtimes) {
    if (currentById.has(heartbeatRuntime.id)) {
      continue;
    }
    if (!isDaemonProvider(heartbeatRuntime.provider)) {
      continue;
    }
    const metadata = heartbeatRuntime.metadata ?? {};
    const executablePath = typeof metadata.executablePath === "string" ? metadata.executablePath : "";
    result.push({
      id: heartbeatRuntime.id,
      workspaceId,
      provider: heartbeatRuntime.provider,
      name: typeof metadata.name === "string" ? metadata.name : heartbeatRuntime.id,
      version: typeof metadata.version === "string" ? metadata.version : undefined,
      status: heartbeatRuntime.status,
      deviceInfo: deviceName,
      metadata: {
        executablePath,
        mode: "remote",
        managedCredentialId: typeof metadata.managedCredentialId === "string" ? metadata.managedCredentialId : undefined,
        provisioningState: typeof metadata.provisioningState === "string" ? metadata.provisioningState : undefined,
        ...metadata,
      },
    });
  }

  return result;
}

/**
 * A managed daemon keeps executable profiles only in memory. After it restarts,
 * the control plane still reports its completed managed runtimes in the
 * heartbeat response. Rehydrate their credential profiles before accepting
 * work so that an "online" runtime is actually executable.
 */
export async function restoreManagedRuntimesFromHeartbeat(
  heartbeat: HeartbeatDaemonResponse,
  managedRuntimes: Map<string, ManagedRuntimeEntry>,
  credentialResolver: ManagedCredentialResolver,
): Promise<void> {
  for (const runtime of heartbeat.runtimes) {
    if (!isDaemonProvider(runtime.provider) || managedRuntimes.has(runtime.id)) {
      continue;
    }
    const metadata = runtime.metadata ?? {};
    if (metadata.provisioningState !== "managed" || typeof metadata.managedCredentialId !== "string") {
      continue;
    }
    const profile = await credentialResolver.resolve(runtime.id, metadata.managedCredentialId);
    if (!profile) {
      continue;
    }
    managedRuntimes.set(runtime.id, {
      id: runtime.id,
      provider: runtime.provider,
      runtimeCredentialId: metadata.managedCredentialId,
      executablePath: credentialResolver.getExecutablePath(runtime.id, runtime.provider),
      status: "online",
    });
  }
}

export function buildRemoteRuntimeHeartbeatMetadata(
  runtimes: RemoteRuntimeRecord[],
  managedRuntimes?: Map<string, ManagedRuntimeEntry>,
  verificationEnvironments?: Map<string, Record<string, string>>,
  cliHubReadiness?: Map<string, CliHubReadiness>,
): Array<{
  id: string;
  provider: RemoteRuntimeRecord["provider"];
  metadata: Record<string, unknown>;
}> {
  const records: Array<{
    id: string;
    provider: RemoteRuntimeRecord["provider"];
    metadata: Record<string, unknown>;
  }> = runtimes.map((runtime) => {
    const managedRuntime = managedRuntimes?.get(runtime.id);
    const heartbeatRuntime = managedRuntime
      ? {
        ...runtime,
        status: managedRuntime.status,
        metadata: {
          ...runtime.metadata,
          executablePath: managedRuntime.executablePath,
          mode: "remote" as const,
          managedCredentialId: managedRuntime.runtimeCredentialId,
          provisioningState: "managed",
        },
      }
      : runtime;
    return {
      id: heartbeatRuntime.id,
      provider: heartbeatRuntime.provider,
      metadata: {
        ...buildProviderRuntimeMetadata(heartbeatRuntime, {
          environment: verificationEnvironments?.get(runtime.id),
        }),
        ...(cliHubReadiness?.get(runtime.id) ? { cliHubReadiness: cliHubReadiness.get(runtime.id) } : {}),
      },
    };
  });
  const knownRuntimeIds = new Set(records.map((runtime) => runtime.id));
  for (const runtime of managedRuntimes?.values() ?? []) {
    if (knownRuntimeIds.has(runtime.id)) {
      continue;
    }
    records.push({
      id: runtime.id,
      provider: runtime.provider,
      metadata: {
        executablePath: runtime.executablePath,
        mode: "remote",
        managedCredentialId: runtime.runtimeCredentialId,
        provisioningState: "managed",
        ...(cliHubReadiness?.get(runtime.id) ? { cliHubReadiness: cliHubReadiness.get(runtime.id) } : {}),
      },
    });
  }
  return records;
}

export function resolveRemoteRuntimeCliHubReadiness(
  config: Pick<RemoteDaemonConfig, "stateDir" | "managedNode">,
  runtimes: RemoteRuntimeRecord[],
  managedRuntimes: Map<string, ManagedRuntimeEntry>,
): Map<string, CliHubReadiness> {
  const result = new Map<string, CliHubReadiness>();
  const runtimeById = new Map(runtimes.map((runtime) => [runtime.id, runtime]));
  for (const runtimeId of new Set([...runtimeById.keys(), ...managedRuntimes.keys()])) {
    const runtime = runtimeById.get(runtimeId);
    const managed = managedRuntimes.get(runtimeId);
    const provider = managed?.provider ?? runtime?.provider;
    if (!provider) continue;
    const runtimeHomeDir = ensureManagedRuntimeHomeDir(config.stateDir, runtimeId);
    result.set(runtimeId, managed || config.managedNode
      ? readManagedCliHubReadiness({
          image: `dofe/agent-runtime-${provider}:${process.env.MANAGED_RUNTIME_IMAGE_TAG?.trim() || "latest"}`,
          runtimeHomeDir,
          user: `${process.getuid?.() ?? 10001}:${process.getgid?.() ?? 10001}`,
        })
      : readCliHubReadiness({ runtimeHomeDir }));
  }
  return result;
}

export async function resolveManagedProviderVerificationEnvironments(
  runtimes: RemoteRuntimeRecord[],
  credentialResolver: Pick<ManagedCredentialResolver, "resolve">,
): Promise<Map<string, Record<string, string>>> {
  const environments = new Map<string, Record<string, string>>();
  await Promise.all(runtimes.map(async (runtime) => {
    if (
      !runtime.metadata.managedCredentialId
      || (!hasPendingProviderVerification(runtime) && runtime.provider !== "openclaw")
    ) {
      return;
    }
    const profile = await credentialResolver.resolve(runtime.id, runtime.metadata.managedCredentialId);
    if (profile) {
      environments.set(runtime.id, profile.environment);
    }
  }));
  return environments;
}

export function hasPendingProviderVerification(runtime: RemoteRuntimeRecord): boolean {
  const requestedAt = runtime.metadata.providerVerificationRequestedAt;
  if (!requestedAt) {
    return false;
  }
  const health = runtime.metadata.providerHealth as { checkedAt?: unknown } | undefined;
  if (typeof health?.checkedAt !== "string") {
    return true;
  }
  return new Date(health.checkedAt).getTime() < new Date(requestedAt).getTime();
}

export function buildManagedRuntimeHeartbeatMetadata(
  managedRuntimes: Map<string, ManagedRuntimeEntry>,
): Array<{ id: string; provider: string; status: string; managedCredentialId: string; executablePath: string }> {
  return Array.from(managedRuntimes.values()).map((runtime) => ({
    id: runtime.id,
    provider: runtime.provider,
    status: runtime.status,
    managedCredentialId: runtime.runtimeCredentialId,
    executablePath: runtime.executablePath,
  }));
}

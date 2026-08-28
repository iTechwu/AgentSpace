// 3.5-4：自 remote-daemon.ts 拆出——网关请求用量的合并、增量上报与落盘读取。
import { existsSync, readFileSync } from "node:fs";
import type { DaemonTaskUsage } from "@dofe-agent/domain";

export type RemoteTaskUsageEntry = DaemonTaskUsage;

interface RemoteGatewayUsageEntry {
  requestId: string;
  gatewayUsageId?: string;
  inputTokens: number;
  outputTokens: number;
  cacheTokens?: number;
  protocol?: string;
  requestStartedAt?: string;
  requestEndedAt?: string;
}

export interface RemoteGatewayUsageReporter {
  flush(): Promise<void>;
  stop(): Promise<void>;
}

export function mergeRemoteGatewayUsages(
  providerUsages: RemoteTaskUsageEntry[],
  gatewayUsages: RemoteGatewayUsageEntry[],
  context: Pick<RemoteTaskUsageEntry, "modelId" | "runtimeCredentialId" | "routerSessionId" | "protocol">,
): RemoteTaskUsageEntry[] {
  const usagesByRequestId = new Map<string, RemoteTaskUsageEntry>();
  for (const usage of providerUsages) {
    if (usage.gatewayRequestId) usagesByRequestId.set(usage.gatewayRequestId, usage);
  }
  for (const usage of gatewayUsages) {
    usagesByRequestId.set(usage.requestId, {
      ...context,
      gatewayRequestId: usage.requestId,
      gatewayUsageId: usage.gatewayUsageId,
      inputTokens: usage.inputTokens,
      outputTokens: usage.outputTokens,
      cacheTokens: usage.cacheTokens,
      protocol: usage.protocol ?? context.protocol,
      requestStartedAt: usage.requestStartedAt,
      requestEndedAt: usage.requestEndedAt,
    });
  }
  return [...usagesByRequestId.values()];
}

/**
 * Watches the append-only gateway log while the provider is still running.
 * A request id is acknowledged locally only after the control plane accepts
 * it, so transient failures are retried and completion can safely replay it.
 */
export function createRemoteGatewayUsageReporter(input: {
  path: string;
  context: Pick<RemoteTaskUsageEntry, "modelId" | "runtimeCredentialId" | "routerSessionId" | "protocol">;
  report: (usages: RemoteTaskUsageEntry[]) => Promise<unknown>;
  pollIntervalMs?: number;
  onError?: (error: unknown) => void;
}): RemoteGatewayUsageReporter {
  const acknowledged = new Set<string>();
  let queue = Promise.resolve();
  const flush = (): Promise<void> => {
    const operation = queue.then(async () => {
      const entries = readRemoteGatewayUsages(input.path)
        .filter((entry) => !acknowledged.has(entry.requestId));
      if (entries.length === 0) return;
      const usages = mergeRemoteGatewayUsages([], entries, input.context);
      await input.report(usages);
      for (const entry of entries) acknowledged.add(entry.requestId);
    });
    queue = operation.catch(() => undefined);
    return operation;
  };
  const interval = input.pollIntervalMs === 0
    ? undefined
    : setInterval(() => {
        void flush().catch((error) => input.onError?.(error));
      }, Math.max(50, input.pollIntervalMs ?? 500));
  interval?.unref();
  return {
    flush,
    async stop() {
      if (interval) clearInterval(interval);
      await flush();
    },
  };
}

export function readFiniteNumber(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : 0;
}

export function readRemoteGatewayUsages(path: string): RemoteGatewayUsageEntry[] {
  if (!existsSync(path)) return [];
  return readFileSync(path, "utf8")
    .split("\n")
    .flatMap((line) => {
      if (!line.trim()) return [];
      try {
        const value = JSON.parse(line) as {
          requestId?: unknown;
          gatewayUsageId?: unknown;
          protocol?: unknown;
          inputTokens?: unknown;
          outputTokens?: unknown;
          cacheTokens?: unknown;
          requestStartedAt?: unknown;
          requestEndedAt?: unknown;
        };
        const requestId = typeof value.requestId === "string" ? value.requestId.trim() : "";
        const inputTokens = readFiniteNumber(value.inputTokens);
        const outputTokens = readFiniteNumber(value.outputTokens);
        const cacheTokens = readFiniteNumber(value.cacheTokens);
        return requestId && (inputTokens > 0 || outputTokens > 0)
          ? [{
              requestId,
              gatewayUsageId: typeof value.gatewayUsageId === "string" ? value.gatewayUsageId : undefined,
              inputTokens,
              outputTokens,
              cacheTokens,
              protocol: typeof value.protocol === "string" ? value.protocol : undefined,
              requestStartedAt: typeof value.requestStartedAt === "string" ? value.requestStartedAt : undefined,
              requestEndedAt: typeof value.requestEndedAt === "string" ? value.requestEndedAt : undefined,
            }]
          : [];
      } catch {
        return [];
      }
    });
}

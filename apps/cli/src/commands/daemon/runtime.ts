// daemon CLI 的provider 运行时适配（从 commands/daemon.ts 拆出，3.6 巨型文件项）。

import { HttpDaemonClient } from "../../lib/daemon-client.ts";
import { prepareDaemonTaskContext } from "../../lib/daemon-task-context.ts";
import { chooseProviderSessionForTaskSync, listAgentRouterEventsSync, listAgentTaskAttemptsSync, readAgentRouterSessionForTaskSync, readDaemonSnapshotSync, readLatestAgentRouterContextSnapshotSync } from "@dofe-agent/db";
import type { AgentRuntimeRecord, QueuedTaskRecord } from "@dofe-agent/db";
import { buildProviderRuntimeMetadata, resolveModelId as resolveSharedModelId, runProviderTask as runSharedProviderTask } from "dofe-agent-daemon";
import type { ProviderRuntimeRecord } from "dofe-agent-daemon";
import type { DaemonConfig, DetectedProvider } from "./config.ts";
import type { ProviderTaskOptions } from "./task-runner.ts";

export async function runProviderTask(
  runtime: AgentRuntimeRecord,
  prompt: string,
  workDir: string,
  options: ProviderTaskOptions = {},
): Promise<{ output: string; sessionId?: string }> {
  return runSharedProviderTask(toProviderRuntimeRecord(runtime), prompt, workDir, options);
}
export async function runProviderTaskWithModel(
  runtime: AgentRuntimeRecord,
  prompt: string,
  workDir: string,
  modelId: string | undefined,
  options: ProviderTaskOptions = {},
): Promise<{ output: string; sessionId?: string }> {
  return runProviderTask(runtime, prompt, workDir, {
    ...options,
    modelId,
  });
}
export function resolveModelId(runtime: AgentRuntimeRecord): string | undefined {
  return resolveSharedModelId(toProviderRuntimeRecord(runtime));
}
export function buildRouterSessionPromptContext(task: QueuedTaskRecord): Parameters<typeof prepareDaemonTaskContext>[0]["routerSessionContext"] {
  const routerSession = readAgentRouterSessionForTaskSync(task);
  if (!routerSession) {
    return undefined;
  }
  const providerSession = chooseProviderSessionForTaskSync({ task });
  const attempts = listAgentTaskAttemptsSync({
    workspaceId: task.workspaceId,
    routerSessionId: routerSession.id,
    limit: 80,
  });
  const taskAttempts = attempts.filter((attempt) => attempt.taskQueueId === task.id);
  const previousAttempt = taskAttempts.length > 1 ? taskAttempts[taskAttempts.length - 2] : undefined;
  const latestAttempt = taskAttempts[taskAttempts.length - 1];
  const metadata = latestAttempt ? safeParseJsonObject(latestAttempt.metadataJson) : {};
  const fallbackReason = readStringValue(metadata.fallbackReason);
  const latestHandoff = readLatestAgentRouterContextSnapshotSync({
    workspaceId: task.workspaceId,
    routerSessionId: routerSession.id,
    snapshotType: "handoff",
  });
  const events = listAgentRouterEventsSync({
    workspaceId: task.workspaceId,
    routerSessionId: routerSession.id,
    order: "asc",
    limit: 80,
  });
  return {
    routerSessionId: routerSession.id,
    conversationKey: routerSession.conversationKey,
    sourceType: routerSession.sourceType,
    memorySummary: routerSession.memorySummary,
    providerSessionId: providerSession?.providerSessionId,
    continuationMode: fallbackReason ? "fallback" : providerSession ? "same_provider_resume" : "cold_rebuild",
    previousRuntimeId: previousAttempt?.runtimeId,
    selectedRuntimeId: task.runtimeId,
    fallbackReason,
    transcriptLines: events.map((event) => {
      const actor = event.actorId ? `${event.actorType}:${event.actorId}` : event.actorType;
      return `${event.createdAt} | ${event.type} | ${actor} | ${event.summary ?? ""}`;
    }),
    latestHandoffSnapshot: latestHandoff?.contentMarkdown,
    attemptCount: attempts.length,
  };
}
export function toProviderRuntimeRecord(runtime: AgentRuntimeRecord): ProviderRuntimeRecord {
  let metadata: Record<string, unknown> = {};
  try {
    metadata = JSON.parse(runtime.metadataJson) as Record<string, unknown>;
  } catch {
    metadata = {};
  }

  return {
    id: runtime.id,
    workspaceId: runtime.workspaceId,
    provider: runtime.provider as ProviderRuntimeRecord["provider"],
    name: runtime.name,
    version: runtime.version,
    status: runtime.status,
    deviceInfo: runtime.deviceInfo,
    metadata: {
      executablePath: typeof metadata.executablePath === "string" ? metadata.executablePath : "",
      mode: metadata.mode === "remote" ? "remote" : "local",
      providerHealth: isRecord(metadata.providerHealth) ? metadata.providerHealth : undefined,
      providerVerificationRequestedAt: typeof metadata.providerVerificationRequestedAt === "string"
        ? metadata.providerVerificationRequestedAt
        : undefined,
      openClawProfile: typeof metadata.openClawProfile === "string" ? metadata.openClawProfile : undefined,
      openClawModel: typeof metadata.openClawModel === "string" ? metadata.openClawModel : undefined,
    },
  };
}
export function listLocalRuntimeHeartbeatMetadata(daemonKey: string): Array<{
  id: string;
  provider: ProviderRuntimeRecord["provider"];
  metadata: Record<string, unknown>;
}> {
  return readDaemonSnapshotSync(daemonKey).runtimes.map((runtime) => {
    const providerRuntime = toProviderRuntimeRecord(runtime);
    return {
      id: runtime.id,
      provider: runtime.provider as ProviderRuntimeRecord["provider"],
      metadata: buildProviderRuntimeMetadata(providerRuntime),
    };
  });
}
export function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
export function safeParseJsonObject(value: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(value) as unknown;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed as Record<string, unknown> : {};
  } catch {
    return {};
  }
}
export function readStringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value : undefined;
}
export function buildRemoteRuntimeRecords(
  config: DaemonConfig,
  registered: Awaited<ReturnType<HttpDaemonClient["register"]>>,
  detected: DetectedProvider[],
): AgentRuntimeRecord[] {
  const now = new Date().toISOString();
  const runtimes: AgentRuntimeRecord[] = [];

  for (const runtime of registered.runtimes) {
    const detectedProvider = detected.find((provider) => provider.provider === runtime.provider);
    if (!detectedProvider) {
      continue;
    }

    runtimes.push({
      id: runtime.id,
      workspaceId: registered.daemon.workspaceId,
      provider: detectedProvider.provider,
      name: runtime.name,
      version: detectedProvider.version,
      status: runtime.status,
      deviceInfo: config.deviceName,
      metadataJson: JSON.stringify(buildProviderRuntimeMetadata({
        provider: detectedProvider.provider,
        metadata: {
          executablePath: detectedProvider.executablePath,
          mode: "remote",
        },
      })),
      connectedAt: now,
      createdAt: now,
      updatedAt: now,
    });
  }

  return runtimes;
}

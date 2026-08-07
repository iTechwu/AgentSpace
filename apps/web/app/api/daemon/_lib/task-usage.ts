import {
  enqueueTokenUsageRetrySync,
  recordTokenUsageSync,
} from "@dofe-agent/db";
import type { DaemonTaskUsage } from "@dofe-agent/domain";

export const MAX_TASK_USAGE_BATCH_SIZE = 500;

export function isPersistableManagedTaskUsage(
  usage: DaemonTaskUsage,
  runtimeCredentialId: string,
): boolean {
  const modelId = usage.modelId?.trim();
  const gatewayRequestId = usage.gatewayRequestId?.trim();
  const gatewayUsageId = usage.gatewayUsageId?.trim();
  const protocol = usage.protocol?.trim();
  return usage.runtimeCredentialId === runtimeCredentialId
    && Boolean(modelId && modelId.length <= 256)
    && (!gatewayRequestId || gatewayRequestId.length <= 256)
    && (!gatewayUsageId || gatewayUsageId.length <= 256)
    && (!protocol || protocol.length <= 64)
    && Number.isSafeInteger(usage.inputTokens)
    && Number.isSafeInteger(usage.outputTokens)
    && usage.inputTokens >= 0
    && usage.outputTokens >= 0
    && usage.inputTokens + usage.outputTokens > 0;
}

export function persistManagedTaskUsagesBestEffort(input: {
  usages: DaemonTaskUsage[];
  workspaceId: string;
  taskId: string;
  agentId: string;
  routerSessionId?: string;
  employeeId?: string;
  runtimeId?: string;
  runtimeCredentialId?: string;
  recordUsage?: typeof recordTokenUsageSync;
  enqueueRetry?: typeof enqueueTokenUsageRetrySync;
  onError?: (error: unknown) => void;
}): boolean {
  const recordUsage = input.recordUsage ?? recordTokenUsageSync;
  const enqueueRetry = input.enqueueRetry ?? enqueueTokenUsageRetrySync;
  let allPersisted = true;
  for (const usage of input.usages) {
    if (!input.runtimeCredentialId || !isPersistableManagedTaskUsage(usage, input.runtimeCredentialId)) continue;
    const usageRecord = {
      workspaceId: input.workspaceId,
      taskQueueId: input.taskId,
      agentId: input.agentId,
      employeeId: input.employeeId ?? input.agentId,
      runtimeId: input.runtimeId,
      modelId: usage.modelId.trim(),
      runtimeCredentialId: usage.runtimeCredentialId,
      routerSessionId: input.routerSessionId,
      gatewayRequestId: usage.gatewayRequestId,
      gatewayUsageId: usage.gatewayUsageId,
      sourceInvocationId: usage.gatewayRequestId,
      protocol: usage.protocol,
      inputTokens: usage.inputTokens,
      outputTokens: usage.outputTokens,
      cacheTokens: usage.cacheTokens,
      requestStartedAt: usage.requestStartedAt,
      requestEndedAt: usage.requestEndedAt,
    };
    try {
      recordUsage(usageRecord);
    } catch (error) {
      allPersisted = false;
      try {
        enqueueRetry(usageRecord, error);
      } catch (retryError) {
        try {
          input.onError?.(retryError);
        } catch {
          // Task completion remains successful if warning reporting also fails.
        }
        throw new Error("token_usage.durability_unavailable", { cause: retryError });
      }
      try {
        input.onError?.(error);
      } catch {
        // Durable retry is already queued; diagnostic reporting is best effort.
      }
    }
  }
  return allPersisted;
}

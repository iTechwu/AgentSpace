// @deprecated — Phase 2 pg 原型 cutover，保留作 Prisma 接入迁移期 fallback。
// 生产路径走 task-queue-prisma-cutover.ts。
//
// task-queue read cutover runner：把 sync `listQueuedTasksSync` 与 async
// primary `listQueuedTasksAsync` 接到通用 cutover-runner，落地 Phase 2 协议
// （与 audit-log / notifications 同款）。

import { listQueuedTasksSync } from "../task-queue.ts";
import type { QueuedTaskRecord } from "../types.ts";
import {
  isTaskQueueAsyncReadEnabled,
  isTaskQueueShadowReadEnabled,
  listQueuedTasksAsync,
} from "./task-queue-async.ts";
import { buildDomainCutover } from "./cutover-runner.ts";
import type { ReadCutoverMetric } from "./read-cutover.ts";

export type ListTaskQueueCutoverMetric = ReadCutoverMetric;
export type ListTaskQueueCutoverMetricSink = (
  metric: ListTaskQueueCutoverMetric,
) => void;

/**
 * @deprecated Use {@link listQueuedTasksPrismaCutover} instead. Kept as
 * Prisma 接入迁移期 fallback + 影子对比驱动。
 */
export function listQueuedTasksCutover(
  options?: { workspaceId?: string; runtimeId?: string },
  metricSink?: ListTaskQueueCutoverMetricSink,
): Promise<QueuedTaskRecord[]> {
  return buildDomainCutover<
    { workspaceId?: string; runtimeId?: string } | undefined,
    QueuedTaskRecord[],
    ListTaskQueueCutoverMetric
  >({
    isEnabled: isTaskQueueAsyncReadEnabled,
    isShadowEnabled: isTaskQueueShadowReadEnabled,
    runPrimary: async (opts) => listQueuedTasksAsync(opts),
    runFallback: (opts) => listQueuedTasksSync(opts),
    compare: (primary, fallback) => recordsEqual(primary, fallback),
  })(options, metricSink);
}

export function recordsEqual(
  primary: QueuedTaskRecord[],
  fallback: QueuedTaskRecord[],
): boolean {
  if (primary.length !== fallback.length) return false;
  for (let i = 0; i < primary.length; i += 1) {
    if (!recordEqual(primary[i]!, fallback[i]!)) return false;
  }
  return true;
}

function recordEqual(
  primary: QueuedTaskRecord,
  fallback: QueuedTaskRecord,
): boolean {
  return (
    primary.id === fallback.id &&
    primary.workspaceId === fallback.workspaceId &&
    primary.employeeId === fallback.employeeId &&
    primary.employeeName === fallback.employeeName &&
    primary.agentId === fallback.agentId &&
    primary.runtimeId === fallback.runtimeId &&
    primary.runtimeCredentialId === fallback.runtimeCredentialId &&
    primary.routerSessionId === fallback.routerSessionId &&
    primary.issueId === fallback.issueId &&
    primary.triggerType === fallback.triggerType &&
    primary.priority === fallback.priority &&
    primary.status === fallback.status &&
    primary.inputJson === fallback.inputJson &&
    primary.requestedByUserId === fallback.requestedByUserId &&
    primary.requestedByDisplayName === fallback.requestedByDisplayName &&
    primary.resultJson === fallback.resultJson &&
    primary.errorText === fallback.errorText &&
    primary.sessionId === fallback.sessionId &&
    primary.workDir === fallback.workDir &&
    primary.bindingGeneration === fallback.bindingGeneration &&
    primary.queuedAt === fallback.queuedAt &&
    primary.claimedAt === fallback.claimedAt &&
    primary.startedAt === fallback.startedAt &&
    primary.finishedAt === fallback.finishedAt &&
    primary.mcpSessionClaimedAt === fallback.mcpSessionClaimedAt &&
    primary.createdAt === fallback.createdAt &&
    primary.updatedAt === fallback.updatedAt
  );
}
// task-queue read cutover runner（真 Prisma Client primary）：
// Phase 2 第六域生产路径。pg 原型同款 runner 见 task-queue-cutover.ts（@deprecated）。

import { listQueuedTasksSync } from "../task-queue.ts";
import type { QueuedTaskRecord } from "../types.ts";
import { buildDomainCutover } from "./cutover-runner.ts";
import type { ReadCutoverMetric } from "./read-cutover.ts";
import {
  isTaskQueuePrismaReadEnabled,
  isTaskQueuePrismaShadowReadEnabled,
  listQueuedTasksPrisma,
} from "./task-queue-prisma.ts";

export type ListTaskQueuePrismaCutoverMetric = ReadCutoverMetric;
export type ListTaskQueuePrismaCutoverMetricSink = (
  metric: ListTaskQueuePrismaCutoverMetric,
) => void;

const listQueuedTasksPrismaCutoverImpl = buildDomainCutover<
  { workspaceId?: string; runtimeId?: string } | undefined,
  QueuedTaskRecord[],
  ListTaskQueuePrismaCutoverMetric
>({
  isEnabled: isTaskQueuePrismaReadEnabled,
  isShadowEnabled: isTaskQueuePrismaShadowReadEnabled,
  runPrimary: async (options) => listQueuedTasksPrisma(options),
  runFallback: (options) => listQueuedTasksSync(options),
  compare: (primary, fallback) => recordsEqual(primary, fallback),
});

export function listQueuedTasksPrismaCutover(
  options?: { workspaceId?: string; runtimeId?: string },
  metricSink?: ListTaskQueuePrismaCutoverMetricSink,
): Promise<QueuedTaskRecord[]> {
  return listQueuedTasksPrismaCutoverImpl(options, metricSink);
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
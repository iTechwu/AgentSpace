// task-execution-events read cutover runner（真 Prisma Client primary）：
// 与 audit-log / notifications 同款双 runner 模式。

import { listTaskExecutionEventsSync } from "../task-execution-events.ts";
import type { TaskExecutionEventListOptions } from "../task-execution-events.ts";
import type { TaskExecutionEventRecord } from "../types.ts";
import {
  isTaskExecutionEventsPrismaReadEnabled,
  isTaskExecutionEventsPrismaShadowReadEnabled,
  listTaskExecutionEventsPrisma,
} from "./task-execution-events-prisma.ts";
import { buildDomainCutover } from "./cutover-runner.ts";
import { createPrismaCutoverMetricSink } from "./cutover-observability.ts";
import type { ReadCutoverMetric } from "./read-cutover.ts";

export type ListTaskExecutionEventsPrismaCutoverMetric = ReadCutoverMetric;
export type ListTaskExecutionEventsPrismaCutoverMetricSink = (
  metric: ListTaskExecutionEventsPrismaCutoverMetric,
) => void;

const listTaskExecutionEventsPrismaCutoverImpl = buildDomainCutover<
  TaskExecutionEventListOptions,
  TaskExecutionEventRecord[],
  ListTaskExecutionEventsPrismaCutoverMetric
>({
  isEnabled: isTaskExecutionEventsPrismaReadEnabled,
  isShadowEnabled: isTaskExecutionEventsPrismaShadowReadEnabled,
  runPrimary: async (options) => listTaskExecutionEventsPrisma(options),
  runFallback: (options) => listTaskExecutionEventsSync(options),
  compare: (primary, fallback) => recordsEqual(primary, fallback),
  emitMetric: createPrismaCutoverMetricSink({ domain: "task_execution_events", operation: "list" }),
});

export function listTaskExecutionEventsPrismaCutover(
  options: TaskExecutionEventListOptions = {},
  metricSink?: ListTaskExecutionEventsPrismaCutoverMetricSink,
): Promise<TaskExecutionEventRecord[]> {
  return listTaskExecutionEventsPrismaCutoverImpl(options, metricSink);
}

export function recordsEqual(
  primary: TaskExecutionEventRecord[],
  fallback: TaskExecutionEventRecord[],
): boolean {
  if (primary.length !== fallback.length) return false;
  for (let i = 0; i < primary.length; i += 1) {
    if (!recordEqual(primary[i]!, fallback[i]!)) return false;
  }
  return true;
}

function recordEqual(
  primary: TaskExecutionEventRecord,
  fallback: TaskExecutionEventRecord,
): boolean {
  const dataEqual = JSON.stringify(primary.dataJson ?? {}) ===
    JSON.stringify(fallback.dataJson ?? {});
  return (
    primary.id === fallback.id &&
    primary.workspaceId === fallback.workspaceId &&
    primary.taskId === fallback.taskId &&
    primary.channelName === fallback.channelName &&
    primary.agentId === fallback.agentId &&
    primary.runtimeId === fallback.runtimeId &&
    primary.runId === fallback.runId &&
    primary.type === fallback.type &&
    primary.title === fallback.title &&
    primary.summary === fallback.summary &&
    primary.severity === fallback.severity &&
    primary.status === fallback.status &&
    dataEqual &&
    primary.createdAt === fallback.createdAt
  );
}

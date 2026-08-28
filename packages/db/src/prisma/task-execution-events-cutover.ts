// @deprecated — Phase 2 pg 原型 cutover，保留作 Prisma 接入迁移期 fallback。
// 生产路径走 task-execution-events-prisma-cutover.ts。
//
// task-execution-events read cutover runner：把 sync `listTaskExecutionEventsSync`
// 与 async primary `listTaskExecutionEventsAsync` 接到通用 cutover-runner，
// 落地 Phase 2 协议（与 audit-log / notifications 同款）：
// - Flag OFF  → 直接走 sync fallback（与 cut 1 前一致，零额外开销）
// - Flag ON   → 走 async primary；shadow ON 时同时跑 sync fallback 并 compare
// - 列表 compare 用结构化 JSON 比较，处理 pg JSONB / sqlite JSON.stringify
//   的格式差异

import { listTaskExecutionEventsSync } from "../task-execution-events.ts";
import type { TaskExecutionEventListOptions } from "../task-execution-events.ts";
import type { TaskExecutionEventRecord } from "../types.ts";
import {
  isTaskExecutionEventsAsyncReadEnabled,
  isTaskExecutionEventsShadowReadEnabled,
  listTaskExecutionEventsAsync,
} from "./task-execution-events-async.ts";
import { buildDomainCutover } from "./cutover-runner.ts";
import type { ReadCutoverMetric } from "./read-cutover.ts";

export type ListTaskExecutionEventsCutoverMetric = ReadCutoverMetric;
export type ListTaskExecutionEventsCutoverMetricSink = (metric: ListTaskExecutionEventsCutoverMetric) => void;

const listTaskExecutionEventsCutoverImpl = buildDomainCutover<
  TaskExecutionEventListOptions,
  TaskExecutionEventRecord[],
  ListTaskExecutionEventsCutoverMetric
>({
  isEnabled: isTaskExecutionEventsAsyncReadEnabled,
  isShadowEnabled: isTaskExecutionEventsShadowReadEnabled,
  runPrimary: async (options) => listTaskExecutionEventsAsync(options),
  runFallback: (options) => listTaskExecutionEventsSync(options),
  compare: (primary, fallback) => recordsEqual(primary, fallback),
});

/**
 * @deprecated Use {@link listTaskExecutionEventsPrismaCutover} instead.
 * Kept as Prisma 接入迁移期 fallback + 影子对比驱动。
 */
export function listTaskExecutionEventsCutover(
  options: TaskExecutionEventListOptions = {},
  metricSink?: ListTaskExecutionEventsCutoverMetricSink,
): Promise<TaskExecutionEventRecord[]> {
  return listTaskExecutionEventsCutoverImpl(options, metricSink);
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

const defaultMetricSink: ListTaskExecutionEventsCutoverMetricSink = () => {
  // Default no-op sink: callers can pass their own for telemetry. Tests inject
  // an array-pushing sink to inspect emitted metrics.
};
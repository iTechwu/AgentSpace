// task-execution-events read cutover runner：把 sync `listTaskExecutionEventsSync`
// 与 async primary `listTaskExecutionEventsAsync` 接到 withReadCutover，落地
// Phase 2 协议（与 audit-log / notifications 同款）：
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
import { withReadCutover } from "./read-cutover.ts";

export interface ListTaskExecutionEventsCutoverMetric {
  source: "primary" | "fallback";
  mismatch: 0 | 1;
  durationMs: number;
  error?: string;
}

export type ListTaskExecutionEventsCutoverMetricSink = (
  metric: ListTaskExecutionEventsCutoverMetric,
) => void;

/**
 * Async read cutover for task-execution-events list. Returns the async
 * primary result when Phase 2 flag is on; falls back to the legacy sync
 * result on primary error.
 */
export async function listTaskExecutionEventsCutover(
  options: TaskExecutionEventListOptions = {},
  metricSink: ListTaskExecutionEventsCutoverMetricSink = defaultMetricSink,
): Promise<TaskExecutionEventRecord[]> {
  return withReadCutover<TaskExecutionEventRecord[]>({
    isEnabled: isTaskExecutionEventsAsyncReadEnabled,
    isShadowEnabled: isTaskExecutionEventsShadowReadEnabled,
    runPrimary: async () => listTaskExecutionEventsAsync(options),
    runFallback: () => listTaskExecutionEventsSync(options),
    compare: (primary, fallback) => recordsEqual(primary, fallback),
    emitMetric: (m) => metricSink({ ...m, source: m.source }),
  });
}

function recordsEqual(
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
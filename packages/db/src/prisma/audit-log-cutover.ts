// audit-log read cutover runner：把 sync `readAuditLogSync` 与 async primary
// `readAuditLogAsync` 接到 withReadCutover，落地 Phase 2 协议：
// - Flag OFF  → 直接走 sync fallback（与 cut 1 前一致，零额外开销）
// - Flag ON   → 走 async primary；shadow ON 时同时跑 sync fallback 并 compare
//   - shadow fallback 抛错 → 按模块级契约传播（fallback 仅作比较）
//   - primary 抛错 → 走 fallback（不抛错）
// - emitMetric 失败与业务读取隔离（已在 read-cutover.ts 实现）
//
// 调用约定：cutover runner 是 async，调用方必须 await。同步业务路径继续用
// readAuditLogSync（legacy，零开销）；新代码或迁移目标改用
// readAuditLogCutover 异步版本。同步 facade 不可在主线程上做（参见 commit
// 调研：Atomics.wait busy-poll 阻塞事件循环，pg 客户端的 microtask 无法
// resolve），故本版本不提供 sync wrapper。

import { readAuditLogSync } from "../audit-log.ts";
import type { AuditLogRecord } from "../types.ts";
import {
  asyncToAuditLogRecord,
  isAuditLogAsyncReadEnabled,
  isAuditLogShadowReadEnabled,
  readAuditLogAsync,
} from "./audit-log-async.ts";
import { withReadCutover } from "./read-cutover.ts";

export interface ReadAuditLogCutoverMetric {
  source: "primary" | "fallback";
  mismatch: 0 | 1;
  durationMs: number;
  error?: string;
}

export type ReadAuditLogCutoverMetricSink = (metric: ReadAuditLogCutoverMetric) => void;

/**
 * Async read cutover for audit-log domain. Returns the async primary result
 * when Phase 2 flag is on; falls back to the legacy sync result on primary
 * error. Shadow compare runs only when both flags are on.
 */
export async function readAuditLogCutover(
  input: { id: string; workspaceId?: string },
  metricSink: ReadAuditLogCutoverMetricSink = defaultMetricSink,
): Promise<AuditLogRecord | null> {
  return withReadCutover<AuditLogRecord | null>({
    isEnabled: isAuditLogAsyncReadEnabled,
    isShadowEnabled: isAuditLogShadowReadEnabled,
    runPrimary: async () => {
      const record = await readAuditLogAsync(input);
      return record ? asyncToAuditLogRecord(record) : null;
    },
    runFallback: () => readAuditLogSync(input.id, input.workspaceId),
    compare: (primary, fallback) => recordsEqual(primary, fallback),
    emitMetric: (m) => metricSink({ ...m, source: m.source }),
  });
}

function recordsEqual(
  primary: AuditLogRecord | null,
  fallback: AuditLogRecord | null,
): boolean {
  if (primary === null && fallback === null) return true;
  if (primary === null || fallback === null) return false;
  // dataJson formatting differs between sqlite's JSON.stringify output (with
  // whitespace) and pg's JSONB re-serialization; compare structurally.
  const dataJsonEqual = normalizeJsonEqual(primary.dataJson, fallback.dataJson);
  return (
    primary.id === fallback.id &&
    primary.workspaceId === fallback.workspaceId &&
    primary.title === fallback.title &&
    primary.note === fallback.note &&
    (primary.code ?? null) === (fallback.code ?? null) &&
    dataJsonEqual &&
    primary.source === fallback.source &&
    primary.sourceIndex === fallback.sourceIndex &&
    primary.createdAt === fallback.createdAt
  );
}

function normalizeJsonEqual(a: string, b: string): boolean {
  try {
    return JSON.stringify(JSON.parse(a)) === JSON.stringify(JSON.parse(b));
  } catch {
    return a === b;
  }
}

const defaultMetricSink: ReadAuditLogCutoverMetricSink = () => {
  // Default no-op sink: callers can pass their own for telemetry. Tests inject
  // an array-pushing sink to inspect emitted metrics.
};
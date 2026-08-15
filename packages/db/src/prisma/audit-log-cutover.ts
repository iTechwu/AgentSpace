// audit-log read cutover runner：把 sync `readAuditLogSync` 与 async primary
// `readAuditLogAsync` 接到通用 cutover-runner，落地 Phase 2 协议：
// - Flag OFF  → 直接走 sync fallback（与 cut 1 前一致，零额外开销）
// - Flag ON   → 走 async primary；shadow ON 时同时跑 sync fallback 并 compare
// - 影子 fallback 抛错 → 按 read-cutover 模块级契约传播（fallback 仅作比较）

import { readAuditLogSync } from "../audit-log.ts";
import type { AuditLogRecord } from "../types.ts";
import {
  asyncToAuditLogRecord,
  isAuditLogAsyncReadEnabled,
  isAuditLogShadowReadEnabled,
  readAuditLogAsync,
} from "./audit-log-async.ts";
import { buildDomainCutover } from "./cutover-runner.ts";
import type { ReadCutoverMetric } from "./read-cutover.ts";

export interface ReadAuditLogCutoverInput {
  id: string;
  workspaceId?: string;
}

export type ReadAuditLogCutoverMetric = ReadCutoverMetric;

export type ReadAuditLogCutoverMetricSink = (metric: ReadAuditLogCutoverMetric) => void;

const readAuditLogCutoverImpl = buildDomainCutover<ReadAuditLogCutoverInput, AuditLogRecord | null, ReadAuditLogCutoverMetric>({
  isEnabled: isAuditLogAsyncReadEnabled,
  isShadowEnabled: isAuditLogShadowReadEnabled,
  runPrimary: async (input) => {
    const record = await readAuditLogAsync(input);
    return record ? asyncToAuditLogRecord(record) : null;
  },
  runFallback: (input) => readAuditLogSync(input.id, input.workspaceId),
  compare: (primary, fallback) => recordsEqual(primary, fallback),
});

/**
 * Async read cutover for audit-log. Returns the async primary result when
 * Phase 2 flag is on; falls back to the legacy sync result on primary error.
 */
export function readAuditLogCutover(
  input: ReadAuditLogCutoverInput,
  metricSink?: ReadAuditLogCutoverMetricSink,
): Promise<AuditLogRecord | null> {
  return readAuditLogCutoverImpl(input, metricSink);
}

export function recordsEqual(
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
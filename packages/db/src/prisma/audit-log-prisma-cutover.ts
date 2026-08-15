// audit-log read cutover runner（真 Prisma Client primary）：
// - Phase 2 真接入路径：readAuditLogPrisma 通过 @prisma/client 替代
//   pg.Client 直连；通过 schema.prisma 编译出来的 AuditLog 模型查询。
// - 切流 flag 由 env var 控制：AUDIT_LOG_PRISMA_READ_ENABLED=1 /
//   AUDIT_LOG_PRISMA_SHADOW_READ_ENABLED=1。
// - 与 audit-log-cutover.ts（pg 原型）共存：pg 原型走 AUDIT_LOG_ASYNC_* ，
//   Prisma 切流走 AUDIT_LOG_PRISMA_* ，两个 runner 互不干扰。

import { readAuditLogSync } from "../audit-log.ts";
import type { AuditLogRecord } from "../types.ts";
import {
  isAuditLogPrismaReadEnabled,
  isAuditLogPrismaShadowReadEnabled,
  readAuditLogPrisma,
} from "./audit-log-prisma.ts";
import { buildDomainCutover } from "./cutover-runner.ts";
import type { ReadCutoverMetric } from "./read-cutover.ts";

export type ReadAuditLogPrismaCutoverMetric = ReadCutoverMetric;
export type ReadAuditLogPrismaCutoverMetricSink = (
  metric: ReadAuditLogPrismaCutoverMetric,
) => void;

const readAuditLogPrismaCutoverImpl = buildDomainCutover<
  { id: string; workspaceId?: string },
  AuditLogRecord | null,
  ReadAuditLogPrismaCutoverMetric
>({
  isEnabled: isAuditLogPrismaReadEnabled,
  isShadowEnabled: isAuditLogPrismaShadowReadEnabled,
  runPrimary: async (input) => readAuditLogPrisma(input),
  runFallback: (input) => readAuditLogSync(input.id, input.workspaceId),
  compare: (primary, fallback) => recordsEqual(primary, fallback),
});

/**
 * Async read cutover for audit-log using real Prisma Client as primary.
 */
export function readAuditLogPrismaCutover(
  input: { id: string; workspaceId?: string },
  metricSink?: ReadAuditLogPrismaCutoverMetricSink,
): Promise<AuditLogRecord | null> {
  return readAuditLogPrismaCutoverImpl(input, metricSink);
}

export function recordsEqual(
  primary: AuditLogRecord | null,
  fallback: AuditLogRecord | null,
): boolean {
  if (primary === null && fallback === null) return true;
  if (primary === null || fallback === null) return false;
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

// audit-log Phase 2 真 Prisma Client write path：createAuditLogPrisma 通过
// @prisma/client 的 prisma.auditLog.create 插入行；createAuditLogPrismaCutover
// 通过 buildDomainWriteCutover 工厂接线：
// - Flag OFF  → 直接走 sync recordAuditLogSync（与 cut 1 前一致）
// - Flag ON   → 走 Prisma primary；primary 抛错时 fail closed
// - 写语义与读 cutover 区别：primary 成功即返回（不并行 dual-write）；
//   primary 的事务结果不明确时禁止 legacy 重写，避免重复审计。

import type { Prisma, PrismaClient } from "@prisma/client";
import { recordAuditLogSync } from "../audit-log.ts";
import {
  assertAuditLogIdempotencyMatch,
  resolveAuditLogWrite,
} from "../audit-log-idempotency.ts";
import type { AuditLogRecord, AuditLogSource } from "../types.ts";
import {
  buildDomainWriteCutover,
  type DomainWriteCutoverMetric,
} from "./cutover-runner.ts";
import { createPrismaCutoverMetricSink } from "./cutover-observability.ts";
// Reuse the read-path PrismaClient + setter + disconnect so mock injection
// covers both read and write without duplicating the cache plumbing.
import {
  disconnectAuditLogPrismaForTests,
  getPrismaClient,
  setAuditLogPrismaClientForTests,
} from "./audit-log-prisma.ts";

export interface CreateAuditLogInput {
  workspaceId?: string;
  idempotencyKey?: string;
  title: string;
  note: string;
  code?: string;
  source?: AuditLogSource;
  data?: Record<string, unknown>;
}

export function isAuditLogPrismaWriteEnabled(): boolean {
  return process.env.AUDIT_LOG_PRISMA_WRITE_ENABLED === "1";
}

// Re-export the shared disconnect so callers (tests / shutdown paths) only
// import this module and the read module doesn't need to be imported too.
export { disconnectAuditLogPrismaForTests };

/**
 * Direct Prisma insert. Caller controls when to invoke this (typically via
 * the createAuditLogPrismaCutover wrapper). Returns the persisted row.
 */
export async function createAuditLogPrisma(
  input: CreateAuditLogInput,
  client?: PrismaClient,
): Promise<AuditLogRecord> {
  const prisma = client ?? getPrismaClient();
  const workspaceId = input.workspaceId ?? "default";
  const resolved = resolveAuditLogWrite({
    ...input,
    workspaceId,
    createRandomId: () => `audit-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
  });
  const now = new Date();
  const args = {
    where: { id: resolved.id },
    create: {
      id: resolved.id,
      workspaceId: resolved.workspaceId,
      title: resolved.title,
      note: resolved.note,
      code: resolved.code,
      source: resolved.source,
      sourceIndex: 0,
      dataJson: JSON.parse(resolved.dataJson) as Prisma.InputJsonValue,
      createdAt: now,
    },
    update: {},
  } satisfies Prisma.AuditLogUpsertArgs;
  const row = await prisma.auditLog.upsert(args);
  const record: AuditLogRecord = {
    id: row.id,
    workspaceId: row.workspaceId,
    title: row.title,
    note: row.note,
    code: row.code ?? undefined,
    dataJson: serializeJson(row.dataJson),
    source: row.source as AuditLogRecord["source"],
    sourceIndex: row.sourceIndex,
    createdAt: row.createdAt.toISOString(),
  };
  assertAuditLogIdempotencyMatch(record, resolved);
  return record;
}

export type CreateAuditLogPrismaCutoverMetric = DomainWriteCutoverMetric;
export type CreateAuditLogPrismaCutoverMetricSink = (
  metric: CreateAuditLogPrismaCutoverMetric,
) => void;

const createAuditLogPrismaCutoverImpl = buildDomainWriteCutover<
  CreateAuditLogInput,
  AuditLogRecord,
  CreateAuditLogPrismaCutoverMetric
>({
  isEnabled: isAuditLogPrismaWriteEnabled,
  runPrimary: async (input) => createAuditLogPrisma(input),
  runFallback: (input) => recordAuditLogSync(input),
  emitMetric: createPrismaCutoverMetricSink({ domain: "audit_log", operation: "create" }),
});

/**
 * Write cutover for audit-log: uses Prisma primary when the flag is on and
 * propagates ambiguous primary failures without attempting a second insert.
 */
export function createAuditLogPrismaCutover(
  input: CreateAuditLogInput,
  metricSink?: CreateAuditLogPrismaCutoverMetricSink,
): Promise<AuditLogRecord> {
  return createAuditLogPrismaCutoverImpl(input, metricSink);
}

// Re-export setter so tests can inject a mock PrismaClient.
export { setAuditLogPrismaClientForTests };

function serializeJson(value: unknown): string {
  if (value === null || value === undefined) return "{}";
  if (typeof value === "string") {
    try {
      return JSON.stringify(JSON.parse(value));
    } catch {
      return value;
    }
  }
  try {
    return JSON.stringify(value);
  } catch {
    return "{}";
  }
}

// audit-log Phase 2 真 Prisma Client primary：
// - 使用 prisma generate 产出的 @prisma/client 替代 pg.Client 直连。
// - 模型字段映射通过 @map 注解保持与 postgres-schema.ts 的 snake_case
//   列名一致；查询语意（filter by id / workspace_id）与 sync readAuditLogSync
//   等价。
// - 切流 flag 由 env var 控制，与 audit-log-async.ts 同样语义：
//   AUDIT_LOG_PRISMA_READ_ENABLED=1 / AUDIT_LOG_PRISMA_SHADOW_READ_ENABLED=1
//   （独立于 pg 原型 flag，避免混用）。

import type { Prisma, PrismaClient } from "@prisma/client";
import type { AuditLogListOptions } from "../audit-log.ts";
import { canonicalizeAuditLogDataJson } from "../audit-log-idempotency.ts";
import type { AuditLogRecord } from "../types.ts";
import {
  disconnectDofePrismaClient,
  getDofePrismaClient,
  setDofePrismaClientForTests,
} from "./prisma-client.ts";

interface PrismaAuditLog {
  id: string;
  workspaceId: string;
  title: string;
  note: string;
  code: string | null;
  dataJson: unknown;
  source: string;
  sourceIndex: number;
  createdAt: Date;
}

/**
 * Read/write modules share the process-level PrismaClient so mock injection via
 * `setAuditLogPrismaClientForTests` covers both paths.
 */
export function getPrismaClient(): PrismaClient {
  return getDofePrismaClient();
}

/**
 * Override the cached PrismaClient (test/seed path). Pass null to clear.
 */
export function setAuditLogPrismaClientForTests(client: PrismaClient | null): void {
  setDofePrismaClientForTests(client);
}

export async function readAuditLogPrisma(input: {
  id: string;
  workspaceId?: string;
}, client?: PrismaClient): Promise<AuditLogRecord | null> {
  const prisma = client ?? getPrismaClient();
  const row = await prisma.auditLog.findFirst({
    where: input.workspaceId
      ? { id: input.id, workspaceId: input.workspaceId }
      : { id: input.id },
  });
  return row ? prismaAuditLogToRecord(row as unknown as PrismaAuditLog) : null;
}

export async function listAuditLogsPrisma(
  workspaceId: string,
  options: AuditLogListOptions = {},
  client?: PrismaClient,
): Promise<AuditLogRecord[]> {
  const prisma = client ?? getPrismaClient();
  const and: Prisma.AuditLogWhereInput[] = [];
  for (const [path, value] of [
    ["runtimeId", options.runtimeId],
    ["taskId", options.taskId],
  ] as const) {
    if (value) and.push(jsonPathEquals(path, value));
  }
  addJsonAlternatives(and, options.actorId, ["actorId", "requestedByUserId", "actorUserId"]);
  addJsonAlternatives(and, options.employeeId, ["employeeId", "agentId", "employeeName"]);
  addJsonAlternatives(and, options.sessionId, ["sessionId", "routerSessionId"]);
  addJsonAlternatives(and, options.modelId, ["modelId", "model", "defaultModel"]);
  const createdAt = options.createdFrom || options.createdTo
    ? {
        ...(options.createdFrom ? { gte: new Date(options.createdFrom) } : {}),
        ...(options.createdTo ? { lte: new Date(options.createdTo) } : {}),
      }
    : undefined;
  const rows = await prisma.auditLog.findMany({
    where: {
      workspaceId,
      ...(options.source ? { source: options.source } : {}),
      ...(options.code ? { code: options.code } : {}),
      ...(createdAt ? { createdAt } : {}),
      ...(and.length > 0 ? { AND: and } : {}),
    },
    orderBy: { createdAt: "desc" },
    take: Math.min(Math.max(options.limit ?? 100, 1), 500),
  });
  return rows.map((row) => prismaAuditLogToRecord(row as unknown as PrismaAuditLog));
}

function jsonPathEquals(path: string, value: string): Prisma.AuditLogWhereInput {
  return { dataJson: { path: [path], equals: value } };
}

function addJsonAlternatives(
  target: Prisma.AuditLogWhereInput[],
  value: string | undefined,
  paths: string[],
): void {
  if (!value) return;
  target.push({ OR: paths.map((path) => jsonPathEquals(path, value)) });
}

export function isAuditLogPrismaReadEnabled(): boolean {
  return process.env.AUDIT_LOG_PRISMA_READ_ENABLED === "1";
}

export function isAuditLogPrismaShadowReadEnabled(): boolean {
  return process.env.AUDIT_LOG_PRISMA_SHADOW_READ_ENABLED === "1";
}

export async function disconnectAuditLogPrismaForTests(): Promise<void> {
  await disconnectDofePrismaClient();
}

function prismaAuditLogToRecord(row: PrismaAuditLog): AuditLogRecord {
  const dataJson = canonicalizeAuditLogDataJson(row.dataJson ?? {});
  return {
    id: row.id,
    workspaceId: row.workspaceId,
    title: row.title,
    note: row.note,
    code: row.code ?? undefined,
    dataJson,
    source: row.source as AuditLogRecord["source"],
    sourceIndex: row.sourceIndex,
    createdAt: row.createdAt.toISOString(),
  };
}

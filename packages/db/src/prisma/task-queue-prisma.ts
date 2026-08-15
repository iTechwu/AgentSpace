// task-queue Phase 2 真 Prisma Client primary：与前 4 域同款双 runner 模式，
// pg 原型 runner 仅作迁移期 fallback（见 task-queue-async.ts 顶部）。
// 共享 prisma-client 单例（getDofePrismaClient / setDofePrismaClientForTests）。

import type { PrismaClient } from "@prisma/client";
import {
  disconnectDofePrismaClient,
  getDofePrismaClient,
  setDofePrismaClientForTests,
} from "./prisma-client.ts";
import type { QueuedTaskRecord } from "../types.ts";

const VALID_STATUSES = new Set([
  "queued",
  "claimed",
  "running",
  "preparing_commit",
  "committed",
  "completed",
  "failed",
  "cancelled",
]);

interface PrismaTask {
  id: string;
  workspaceId: string;
  employeeId: string;
  employeeName: string;
  agentId: string | null;
  runtimeId: string | null;
  runtimeCredentialId: string | null;
  routerSessionId: string | null;
  issueId: string | null;
  triggerType: string;
  priority: number;
  status: string;
  inputJson: string;
  requestedByUserId: string | null;
  requestedByDisplayName: string | null;
  resultJson: string | null;
  errorText: string | null;
  sessionId: string | null;
  workDir: string | null;
  bindingGeneration: number | null;
  queuedAt: Date;
  claimedAt: Date | null;
  startedAt: Date | null;
  finishedAt: Date | null;
  mcpSessionClaimedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

export async function listQueuedTasksPrisma(
  options?: { workspaceId?: string; runtimeId?: string },
  client?: PrismaClient,
): Promise<QueuedTaskRecord[]> {
  const prisma = client ?? getDofePrismaClient();
  const where: Record<string, unknown> = {};
  if (typeof options?.workspaceId === "string") where.workspaceId = options.workspaceId;
  if (typeof options?.runtimeId === "string") where.runtimeId = options.runtimeId;
  const rows = await prisma.agentTaskQueue.findMany({
    where,
    orderBy: [{ queuedAt: "asc" }, { id: "asc" }],
  });
  return rows
    .map((row) => mapPrismaRow(row as unknown as PrismaTask))
    .filter((r): r is QueuedTaskRecord => r !== null);
}

export function isTaskQueuePrismaReadEnabled(): boolean {
  return process.env.TASK_QUEUE_PRISMA_READ_ENABLED === "1";
}

export function isTaskQueuePrismaShadowReadEnabled(): boolean {
  return process.env.TASK_QUEUE_PRISMA_SHADOW_READ_ENABLED === "1";
}

export { setDofePrismaClientForTests as setTaskQueuePrismaClientForTests };

export async function disconnectTaskQueuePrismaForTests(): Promise<void> {
  await disconnectDofePrismaClient();
}

function mapPrismaRow(row: PrismaTask): QueuedTaskRecord | null {
  if (!VALID_STATUSES.has(row.status)) return null;
  const record: QueuedTaskRecord = {
    id: row.id,
    workspaceId: row.workspaceId,
    employeeId: row.employeeId,
    employeeName: row.employeeName,
    agentId: row.agentId ?? row.employeeId,
    runtimeId: row.runtimeId ?? "",
    triggerType: row.triggerType,
    priority: row.priority,
    status: row.status as QueuedTaskRecord["status"],
    inputJson: row.inputJson,
    queuedAt: row.queuedAt.toISOString(),
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
  if (row.runtimeCredentialId !== null) record.runtimeCredentialId = row.runtimeCredentialId;
  if (row.routerSessionId !== null) record.routerSessionId = row.routerSessionId;
  if (row.issueId !== null) record.issueId = row.issueId;
  if (row.requestedByUserId !== null) record.requestedByUserId = row.requestedByUserId;
  if (row.requestedByDisplayName !== null) record.requestedByDisplayName = row.requestedByDisplayName;
  if (row.resultJson !== null) record.resultJson = row.resultJson;
  if (row.errorText !== null) record.errorText = row.errorText;
  if (row.sessionId !== null) record.sessionId = row.sessionId;
  if (row.workDir !== null) record.workDir = row.workDir;
  if (row.bindingGeneration !== null) record.bindingGeneration = row.bindingGeneration;
  if (row.claimedAt) record.claimedAt = row.claimedAt.toISOString();
  if (row.startedAt) record.startedAt = row.startedAt.toISOString();
  if (row.finishedAt) record.finishedAt = row.finishedAt.toISOString();
  if (row.mcpSessionClaimedAt) record.mcpSessionClaimedAt = row.mcpSessionClaimedAt.toISOString();
  return record;
}
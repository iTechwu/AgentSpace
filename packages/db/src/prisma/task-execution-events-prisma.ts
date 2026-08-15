// task-execution-events Phase 2 真 Prisma Client primary：与 audit-log /
// notifications 同款双 runner 模式，切流 flag 走
// TASK_EXECUTION_EVENTS_PRISMA_*。

import type { PrismaClient } from "@prisma/client";
import type { TaskExecutionEventListOptions } from "../task-execution-events.ts";
import type { TaskExecutionEventRecord } from "../types.ts";
import {
  disconnectDofePrismaClient,
  getDofePrismaClient,
  setDofePrismaClientForTests,
} from "./prisma-client.ts";

/**
 * Override the cached PrismaClient (test/seed path). Pass null to clear.
 */
export function setTaskExecutionEventsPrismaClientForTests(client: PrismaClient | null): void {
  setDofePrismaClientForTests(client);
}

interface PrismaTaskEvent {
  id: string;
  workspaceId: string | null;
  taskId: string;
  channelName: string | null;
  agentId: string | null;
  runtimeId: string | null;
  runId: string | null;
  type: string;
  title: string | null;
  summary: string | null;
  severity: string;
  status: string | null;
  dataJson: unknown;
  createdAt: Date;
}

export async function listTaskExecutionEventsPrisma(
  options: TaskExecutionEventListOptions = {},
  client?: PrismaClient,
): Promise<TaskExecutionEventRecord[]> {
  const prisma = client ?? getDofePrismaClient();
  const where: Record<string, unknown> = {};
  if (typeof options.workspaceId === "string") where.workspaceId = options.workspaceId;
  if (typeof options.taskId === "string") where.taskId = options.taskId;
  if (typeof options.channelName === "string") where.channelName = options.channelName;
  if (typeof options.agentId === "string") where.agentId = options.agentId;
  if (typeof options.runtimeId === "string") where.runtimeId = options.runtimeId;

  const order = options.order === "desc" ? "desc" : "asc";
  const rows = await prisma.taskExecutionEvent.findMany({
    where,
    orderBy: [{ createdAt: order }, { id: order }],
    take: normalizePrismaLimit(options.limit),
  });
  return rows
    .map((row) => mapPrismaTaskEvent(row as unknown as PrismaTaskEvent))
    .filter((r): r is TaskExecutionEventRecord => r !== null);
}

export function isTaskExecutionEventsPrismaReadEnabled(): boolean {
  return process.env.TASK_EXECUTION_EVENTS_PRISMA_READ_ENABLED === "1";
}

export function isTaskExecutionEventsPrismaShadowReadEnabled(): boolean {
  return process.env.TASK_EXECUTION_EVENTS_PRISMA_SHADOW_READ_ENABLED === "1";
}

export async function disconnectTaskExecutionEventsPrismaForTests(): Promise<void> {
  await disconnectDofePrismaClient();
}

function normalizePrismaLimit(limit: number | undefined): number {
  return Math.min(Math.max(limit ?? 100, 1), 500);
}

function mapPrismaTaskEvent(
  row: PrismaTaskEvent,
): TaskExecutionEventRecord | null {
  return {
    id: row.id,
    workspaceId: row.workspaceId ?? "",
    taskId: row.taskId ?? "",
    channelName: row.channelName ?? "",
    agentId: row.agentId ?? "",
    runtimeId: row.runtimeId ?? undefined,
    runId: row.runId ?? undefined,
    type: row.type as TaskExecutionEventRecord["type"],
    title: row.title ?? "",
    summary: row.summary ?? undefined,
    severity: row.severity as TaskExecutionEventRecord["severity"],
    status: (row.status ?? undefined) as TaskExecutionEventRecord["status"],
    dataJson: serializeJson(row.dataJson),
    createdAt: row.createdAt.toISOString(),
  };
}

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

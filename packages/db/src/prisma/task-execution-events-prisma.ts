// task-execution-events Phase 2 真 Prisma Client primary：与 audit-log /
// notifications 同款双 runner 模式，切流 flag 走
// TASK_EXECUTION_EVENTS_PRISMA_*。

import { Prisma, type PrismaClient } from "@prisma/client";
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
  let taskIds: string[] = [];
  if (typeof options.workspaceId === "string") where.workspaceId = options.workspaceId;
  if (typeof options.taskId === "string") where.taskId = options.taskId;
  else if (options.taskIds) {
    taskIds = normalizeTaskIds(options.taskIds);
    if (taskIds.length === 0) return [];
    where.taskId = { in: taskIds };
  }
  if (typeof options.channelName === "string") where.channelName = options.channelName;
  if (typeof options.agentId === "string") where.agentId = options.agentId;
  if (typeof options.runtimeId === "string") where.runtimeId = options.runtimeId;

  const order = options.order === "desc" ? "desc" : "asc";
  const limitPerTask = taskIds.length > 0 && options.limitPerTask !== undefined
    ? normalizePrismaLimit(options.limitPerTask, 500)
    : null;
  const rows = limitPerTask === null
    ? await prisma.taskExecutionEvent.findMany({
      where,
      orderBy: [{ createdAt: order }, { id: order }],
      take: normalizePrismaLimit(options.limit, options.taskIds ? 5000 : 500),
    })
    : await listTaskExecutionEventsPerTaskPrisma(prisma, options, taskIds, limitPerTask, order);
  return rows
    .map((row) => mapPrismaTaskEvent(row as unknown as PrismaTaskEvent))
    .filter((r): r is TaskExecutionEventRecord => r !== null);
}

async function listTaskExecutionEventsPerTaskPrisma(
  prisma: PrismaClient,
  options: TaskExecutionEventListOptions,
  taskIds: string[],
  limitPerTask: number,
  order: "asc" | "desc",
): Promise<PrismaTaskEvent[]> {
  const filters: Prisma.Sql[] = [Prisma.sql`task_id IN (${Prisma.join(taskIds)})`];
  if (typeof options.workspaceId === "string") filters.push(Prisma.sql`workspace_id = ${options.workspaceId}`);
  if (typeof options.channelName === "string") filters.push(Prisma.sql`channel_name = ${options.channelName}`);
  if (typeof options.agentId === "string") filters.push(Prisma.sql`agent_id = ${options.agentId}`);
  if (typeof options.runtimeId === "string") filters.push(Prisma.sql`runtime_id = ${options.runtimeId}`);
  const direction = Prisma.raw(order === "desc" ? "DESC" : "ASC");
  const totalLimit = Math.min(5000, taskIds.length * limitPerTask);

  return prisma.$queryRaw<PrismaTaskEvent[]>(Prisma.sql`
    SELECT
      id,
      workspace_id AS "workspaceId",
      task_id AS "taskId",
      channel_name AS "channelName",
      agent_id AS "agentId",
      runtime_id AS "runtimeId",
      run_id AS "runId",
      type,
      title,
      summary,
      severity,
      status,
      data_json AS "dataJson",
      created_at AS "createdAt"
    FROM (
      SELECT task_execution_event.*,
             ROW_NUMBER() OVER (
               PARTITION BY task_id ORDER BY created_at ${direction}, id ${direction}
             ) AS task_rank
      FROM task_execution_event
      WHERE ${Prisma.join(filters, " AND ")}
    ) ranked
    WHERE task_rank <= ${limitPerTask}
    ORDER BY created_at ${direction}, id ${direction}
    LIMIT ${totalLimit}
  `);
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

function normalizePrismaLimit(limit: number | undefined, maximum: number): number {
  return Math.min(Math.max(limit ?? 100, 1), maximum);
}

function normalizeTaskIds(taskIds: string[]): string[] {
  return [...new Set(taskIds)].filter((taskId) => taskId.length > 0);
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

// Unit tests for the task-execution-events Prisma Client cutover runner.

import assert from "node:assert/strict";
import test from "node:test";
import type { TaskExecutionEventRecord } from "../types.ts";
import {
  setTaskExecutionEventsPrismaClientForTests,
  disconnectTaskExecutionEventsPrismaForTests,
} from "./task-execution-events-prisma.ts";
import {
  listTaskExecutionEventsPrismaCutover,
  type ListTaskExecutionEventsPrismaCutoverMetric,
} from "./task-execution-events-prisma-cutover.ts";

const ORIGINAL_ASYNC = process.env.TASK_EXECUTION_EVENTS_PRISMA_READ_ENABLED;
const ORIGINAL_SHADOW = process.env.TASK_EXECUTION_EVENTS_PRISMA_SHADOW_READ_ENABLED;

function resetFlags(): void {
  delete process.env.TASK_EXECUTION_EVENTS_PRISMA_READ_ENABLED;
  delete process.env.TASK_EXECUTION_EVENTS_PRISMA_SHADOW_READ_ENABLED;
}

test.before(() => {
  resetFlags();
});

test.after(async () => {
  setTaskExecutionEventsPrismaClientForTests(null);
  await disconnectTaskExecutionEventsPrismaForTests();
  if (ORIGINAL_ASYNC === undefined) delete process.env.TASK_EXECUTION_EVENTS_PRISMA_READ_ENABLED;
  else process.env.TASK_EXECUTION_EVENTS_PRISMA_READ_ENABLED = ORIGINAL_ASYNC;
  if (ORIGINAL_SHADOW === undefined) delete process.env.TASK_EXECUTION_EVENTS_PRISMA_SHADOW_READ_ENABLED;
  else process.env.TASK_EXECUTION_EVENTS_PRISMA_SHADOW_READ_ENABLED = ORIGINAL_SHADOW;
});

interface MockPrismaTaskEvent {
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

interface MockPrismaClient {
  taskExecutionEvent: {
    findMany: (args: unknown) => Promise<MockPrismaTaskEvent[]>;
  };
}

function makeMockPrisma(behavior: (args: unknown) => Promise<MockPrismaTaskEvent[]>): MockPrismaClient {
  return { taskExecutionEvent: { findMany: behavior } };
}

function toPrismaRow(record: TaskExecutionEventRecord): MockPrismaTaskEvent {
  return {
    id: record.id,
    workspaceId: record.workspaceId || null,
    taskId: record.taskId,
    channelName: record.channelName || null,
    agentId: record.agentId || null,
    runtimeId: record.runtimeId ?? null,
    runId: record.runId ?? null,
    type: record.type,
    title: record.title || null,
    summary: record.summary ?? null,
    severity: record.severity,
    status: record.status ?? null,
    dataJson: record.dataJson,
    createdAt: new Date(record.createdAt),
  };
}

test("listTaskExecutionEventsPrismaCutover returns sync result when flag is disabled", async () => {
  resetFlags();
  const metrics: ListTaskExecutionEventsPrismaCutoverMetric[] = [];
  const result = await listTaskExecutionEventsPrismaCutover(
    { channelName: "empty-prisma-cutover-channel" },
    (metric) => metrics.push(metric),
  );
  assert.deepEqual(result, []);
  assert.equal(metrics.length, 0);
});

test("listTaskExecutionEventsPrismaCutover uses Prisma primary when flag is on", async () => {
  resetFlags();
  process.env.TASK_EXECUTION_EVENTS_PRISMA_READ_ENABLED = "1";
  delete process.env.TASK_EXECUTION_EVENTS_PRISMA_SHADOW_READ_ENABLED;

  const mockedRow: TaskExecutionEventRecord = {
    id: "task-event-prisma-mock",
    workspaceId: "default",
    taskId: "task-prisma-mock",
    channelName: "empty-prisma-cutover-channel",
    agentId: "Atlas",
    runtimeId: undefined,
    runId: undefined,
    type: "task_execution.test.seed",
    title: "prisma mock seed",
    summary: undefined,
    severity: "info",
    status: "succeeded",
    dataJson: "{}",
    createdAt: new Date().toISOString(),
  };
  setTaskExecutionEventsPrismaClientForTests(
    makeMockPrisma(async () => [toPrismaRow(mockedRow)]) as unknown as Parameters<typeof setTaskExecutionEventsPrismaClientForTests>[0],
  );
  const metrics: ListTaskExecutionEventsPrismaCutoverMetric[] = [];
  const result = await listTaskExecutionEventsPrismaCutover(
    { channelName: mockedRow.channelName },
    (metric) => metrics.push(metric),
  );
  assert.equal(result.length, 1);
  assert.equal(metrics.length, 1);
  assert.equal(metrics[0]!.source, "primary");
});

test("listTaskExecutionEventsPrismaCutover falls back to sync when Prisma primary throws", async () => {
  resetFlags();
  process.env.TASK_EXECUTION_EVENTS_PRISMA_READ_ENABLED = "1";
  delete process.env.TASK_EXECUTION_EVENTS_PRISMA_SHADOW_READ_ENABLED;

  setTaskExecutionEventsPrismaClientForTests(
    makeMockPrisma(async () => {
      throw new Error("prisma task events unreachable");
    }) as unknown as Parameters<typeof setTaskExecutionEventsPrismaClientForTests>[0],
  );
  const metrics: ListTaskExecutionEventsPrismaCutoverMetric[] = [];
  const result = await listTaskExecutionEventsPrismaCutover(
    { channelName: "empty-prisma-cutover-channel" },
    (metric) => metrics.push(metric),
  );
  assert.deepEqual(result, []);
  assert.equal(metrics.length, 1);
  assert.equal(metrics[0]!.source, "fallback");
  assert.ok(metrics[0]!.error?.includes("prisma task events unreachable"));
});

test("listTaskExecutionEventsPrismaCutover compares the Prisma result when shadow is enabled", async () => {
  resetFlags();
  process.env.TASK_EXECUTION_EVENTS_PRISMA_READ_ENABLED = "1";
  process.env.TASK_EXECUTION_EVENTS_PRISMA_SHADOW_READ_ENABLED = "1";
  const row = toPrismaRow({
    id: "task-event-prisma-shadow",
    workspaceId: "default",
    taskId: "task-prisma-shadow",
    channelName: "empty-prisma-shadow-channel",
    agentId: "Atlas",
    type: "task_execution.test.seed",
    title: "shadow-only row",
    severity: "info",
    status: "succeeded",
    dataJson: "{}",
    createdAt: new Date().toISOString(),
  });
  setTaskExecutionEventsPrismaClientForTests(
    makeMockPrisma(async () => [row]) as unknown as Parameters<typeof setTaskExecutionEventsPrismaClientForTests>[0],
  );
  const metrics: ListTaskExecutionEventsPrismaCutoverMetric[] = [];

  const result = await listTaskExecutionEventsPrismaCutover(
    { channelName: "empty-prisma-shadow-channel" },
    (metric) => metrics.push(metric),
  );

  assert.equal(result[0]?.id, row.id);
  assert.equal(metrics[0]?.source, "primary");
  assert.equal(metrics[0]?.mismatch, 1);
});

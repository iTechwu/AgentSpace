// Unit tests for the task-queue Prisma Client cutover runner
// (Phase 2 6 域 production path).

import assert from "node:assert/strict";
import test from "node:test";
import type { QueuedTaskRecord } from "../types.ts";
import {
  setDofePrismaClientForTests,
  disconnectDofePrismaClient,
} from "./prisma-client.ts";
import {
  listQueuedTasksPrismaCutover,
  type ListTaskQueuePrismaCutoverMetric,
} from "./task-queue-prisma-cutover.ts";

const ORIGINAL_ASYNC = process.env.TASK_QUEUE_PRISMA_READ_ENABLED;
const ORIGINAL_SHADOW = process.env.TASK_QUEUE_PRISMA_SHADOW_READ_ENABLED;

function resetFlags(): void {
  delete process.env.TASK_QUEUE_PRISMA_READ_ENABLED;
  delete process.env.TASK_QUEUE_PRISMA_SHADOW_READ_ENABLED;
}

test.before(() => {
  resetFlags();
});

test.after(async () => {
  setDofePrismaClientForTests(null);
  await disconnectDofePrismaClient();
  if (ORIGINAL_ASYNC === undefined) delete process.env.TASK_QUEUE_PRISMA_READ_ENABLED;
  else process.env.TASK_QUEUE_PRISMA_READ_ENABLED = ORIGINAL_ASYNC;
  if (ORIGINAL_SHADOW === undefined) delete process.env.TASK_QUEUE_PRISMA_SHADOW_READ_ENABLED;
  else process.env.TASK_QUEUE_PRISMA_SHADOW_READ_ENABLED = ORIGINAL_SHADOW;
});

interface MockPrismaTask {
  id: string;
  workspaceId: string;
  employeeId: string;
  employeeName: string;
  agentId: string;
  runtimeId: string;
  runtimeCredentialId: string | null;
  routerSessionId: string | null;
  issueId: string | null;
  triggerType: string;
  priority: number;
  status: string;
  inputJson: unknown;
  requestedByUserId: string | null;
  requestedByDisplayName: string | null;
  resultJson: unknown | null;
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

interface MockPrismaClient {
  agentTaskQueue: {
    findMany: (args: unknown) => Promise<MockPrismaTask[]>;
  };
}

function makeMockPrisma(behavior: (args: unknown) => Promise<MockPrismaTask[]>): MockPrismaClient {
  return { agentTaskQueue: { findMany: behavior } };
}

function toPrismaRow(record: QueuedTaskRecord): MockPrismaTask {
  return {
    id: record.id,
    workspaceId: record.workspaceId,
    employeeId: record.employeeId,
    employeeName: record.employeeName,
    agentId: record.agentId,
    runtimeId: record.runtimeId,
    runtimeCredentialId: record.runtimeCredentialId ?? null,
    routerSessionId: record.routerSessionId ?? null,
    issueId: record.issueId ?? null,
    triggerType: record.triggerType,
    priority: record.priority,
    status: record.status,
    inputJson: JSON.parse(record.inputJson),
    requestedByUserId: record.requestedByUserId ?? null,
    requestedByDisplayName: record.requestedByDisplayName ?? null,
    resultJson: record.resultJson ? JSON.parse(record.resultJson) : null,
    errorText: record.errorText ?? null,
    sessionId: record.sessionId ?? null,
    workDir: record.workDir ?? null,
    bindingGeneration: record.bindingGeneration ?? null,
    queuedAt: new Date(record.queuedAt),
    claimedAt: record.claimedAt ? new Date(record.claimedAt) : null,
    startedAt: record.startedAt ? new Date(record.startedAt) : null,
    finishedAt: record.finishedAt ? new Date(record.finishedAt) : null,
    mcpSessionClaimedAt: record.mcpSessionClaimedAt ? new Date(record.mcpSessionClaimedAt) : null,
    createdAt: new Date(record.createdAt),
    updatedAt: new Date(record.updatedAt),
  };
}

test("listQueuedTasksPrismaCutover returns sync result when flag is disabled", async () => {
  resetFlags();
  const metrics: ListTaskQueuePrismaCutoverMetric[] = [];
  const result = await listQueuedTasksPrismaCutover(
    undefined,
    (metric) => metrics.push(metric),
  );
  assert.ok(Array.isArray(result));
  assert.equal(metrics.length, 0);
});

test("listQueuedTasksPrismaCutover uses Prisma primary when flag is on", async () => {
  resetFlags();
  process.env.TASK_QUEUE_PRISMA_READ_ENABLED = "1";
  delete process.env.TASK_QUEUE_PRISMA_SHADOW_READ_ENABLED;

  const mockedRow: QueuedTaskRecord = {
    id: "task-prisma-mock",
    workspaceId: "default",
    employeeId: "emp-mock",
    employeeName: "MockEmp",
    agentId: "emp-mock",
    runtimeId: "rt-mock",
    triggerType: "manual",
    priority: 5,
    status: "queued",
    inputJson: "{}",
    queuedAt: new Date().toISOString(),
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
  setDofePrismaClientForTests(
    makeMockPrisma(async () => [toPrismaRow(mockedRow)]) as unknown as Parameters<typeof setDofePrismaClientForTests>[0],
  );
  const metrics: ListTaskQueuePrismaCutoverMetric[] = [];
  const result = await listQueuedTasksPrismaCutover(
    undefined,
    (metric) => metrics.push(metric),
  );
  assert.equal(result.length, 1);
  assert.equal(result[0]!.id, "task-prisma-mock");
  assert.equal(metrics.length, 1);
  assert.equal(metrics[0]!.source, "primary");
});

test("listQueuedTasksPrismaCutover falls back to sync when Prisma primary throws", async () => {
  resetFlags();
  process.env.TASK_QUEUE_PRISMA_READ_ENABLED = "1";
  delete process.env.TASK_QUEUE_PRISMA_SHADOW_READ_ENABLED;

  setDofePrismaClientForTests(
    makeMockPrisma(async () => {
      throw new Error("prisma task queue unreachable");
    }) as unknown as Parameters<typeof setDofePrismaClientForTests>[0],
  );
  const metrics: ListTaskQueuePrismaCutoverMetric[] = [];
  const result = await listQueuedTasksPrismaCutover(
    undefined,
    (metric) => metrics.push(metric),
  );
  assert.ok(Array.isArray(result));
  assert.equal(metrics.length, 1);
  assert.equal(metrics[0]!.source, "fallback");
  assert.equal(metrics[0]!.error, "present");
});

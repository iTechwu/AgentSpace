// Unit tests for the workflow-trigger Prisma Client cutover runner
// (Phase 2 20 域).

import assert from "node:assert/strict";
import test from "node:test";
import type { WorkflowTriggerRecord } from "../types.ts";
import {
  setDofePrismaClientForTests,
  disconnectDofePrismaClient,
} from "./prisma-client.ts";
import {
  listWorkflowTriggersPrismaCutover,
  type ListWorkflowTriggersPrismaCutoverMetric,
} from "./workflow-triggers-prisma-cutover.ts";

const ORIGINAL_ASYNC = process.env.WORKFLOW_TRIGGERS_PRISMA_READ_ENABLED;
const ORIGINAL_SHADOW = process.env.WORKFLOW_TRIGGERS_PRISMA_SHADOW_READ_ENABLED;

function resetFlags(): void {
  delete process.env.WORKFLOW_TRIGGERS_PRISMA_READ_ENABLED;
  delete process.env.WORKFLOW_TRIGGERS_PRISMA_SHADOW_READ_ENABLED;
}

test.before(() => {
  resetFlags();
});

test.after(async () => {
  setDofePrismaClientForTests(null);
  await disconnectDofePrismaClient();
  if (ORIGINAL_ASYNC === undefined) delete process.env.WORKFLOW_TRIGGERS_PRISMA_READ_ENABLED;
  else process.env.WORKFLOW_TRIGGERS_PRISMA_READ_ENABLED = ORIGINAL_ASYNC;
  if (ORIGINAL_SHADOW === undefined) delete process.env.WORKFLOW_TRIGGERS_PRISMA_SHADOW_READ_ENABLED;
  else process.env.WORKFLOW_TRIGGERS_PRISMA_SHADOW_READ_ENABLED = ORIGINAL_SHADOW;
});

interface MockPrismaWorkflowTrigger {
  id: string;
  workspaceId: string;
  workflowId: string;
  type: string;
  configJson: string;
  timezone: string | null;
  status: string;
  nextFireAt: Date | null;
  lastFireAt: Date | null;
  misfirePolicy: string;
  dedupeWindowSeconds: number;
  leaseOwner: string | null;
  leaseExpiresAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

interface MockPrismaClient {
  workflowTrigger: {
    findMany: (args: unknown) => Promise<MockPrismaWorkflowTrigger[]>;
  };
}

function makeMockPrisma(
  behavior: (args: unknown) => Promise<MockPrismaWorkflowTrigger[]>,
): MockPrismaClient {
  return { workflowTrigger: { findMany: behavior } };
}

function toPrismaRow(record: WorkflowTriggerRecord): MockPrismaWorkflowTrigger {
  return {
    id: record.id,
    workspaceId: record.workspaceId,
    workflowId: record.workflowId,
    type: record.type,
    configJson: record.configJson,
    timezone: record.timezone ?? null,
    status: record.status,
    nextFireAt: record.nextFireAt ? new Date(record.nextFireAt) : null,
    lastFireAt: record.lastFireAt ? new Date(record.lastFireAt) : null,
    misfirePolicy: record.misfirePolicy,
    dedupeWindowSeconds: record.dedupeWindowSeconds,
    leaseOwner: record.leaseOwner ?? null,
    leaseExpiresAt: record.leaseExpiresAt ? new Date(record.leaseExpiresAt) : null,
    createdAt: new Date(record.createdAt),
    updatedAt: new Date(record.updatedAt),
  };
}

test("listWorkflowTriggersPrismaCutover returns sync result when flag is disabled", async () => {
  resetFlags();
  const metrics: ListWorkflowTriggersPrismaCutoverMetric[] = [];
  const result = await listWorkflowTriggersPrismaCutover(
    { workflowId: "wf-nonexistent", workspaceId: "default" },
    (metric) => metrics.push(metric),
  );
  assert.ok(Array.isArray(result));
  assert.equal(metrics.length, 0);
});

test("listWorkflowTriggersPrismaCutover uses Prisma primary when flag is on", async () => {
  resetFlags();
  process.env.WORKFLOW_TRIGGERS_PRISMA_READ_ENABLED = "1";
  delete process.env.WORKFLOW_TRIGGERS_PRISMA_SHADOW_READ_ENABLED;

  const mockedRow: WorkflowTriggerRecord = {
    id: "wt-prisma-mock",
    workspaceId: "default",
    workflowId: "wf-mock",
    type: "schedule",
    configJson: "{}",
    timezone: "Asia/Shanghai",
    status: "active",
    nextFireAt: new Date().toISOString(),
    misfirePolicy: "skip",
    dedupeWindowSeconds: 300,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
  let findManyArgs: unknown;
  setDofePrismaClientForTests(
    makeMockPrisma(async (args) => {
      findManyArgs = args;
      return [toPrismaRow(mockedRow)];
    }) as unknown as Parameters<typeof setDofePrismaClientForTests>[0],
  );
  const metrics: ListWorkflowTriggersPrismaCutoverMetric[] = [];
  const result = await listWorkflowTriggersPrismaCutover(
    { workflowId: "wf-mock", workspaceId: "default" },
    (metric) => metrics.push(metric),
  );
  assert.equal(result.length, 1);
  assert.equal(result[0]!.id, "wt-prisma-mock");
  assert.equal(result[0]!.type, "schedule");
  assert.equal(result[0]!.timezone, "Asia/Shanghai");
  assert.deepEqual(findManyArgs, {
    where: { workflowId: "wf-mock", workspaceId: "default" },
    orderBy: [{ createdAt: "asc" }, { id: "asc" }],
  });
  assert.equal(metrics.length, 1);
  assert.equal(metrics[0]!.source, "primary");
});

test("listWorkflowTriggersPrismaCutover falls back to sync when Prisma primary throws", async () => {
  resetFlags();
  process.env.WORKFLOW_TRIGGERS_PRISMA_READ_ENABLED = "1";
  delete process.env.WORKFLOW_TRIGGERS_PRISMA_SHADOW_READ_ENABLED;

  setDofePrismaClientForTests(
    makeMockPrisma(async () => {
      throw new Error("prisma workflow triggers unreachable");
    }) as unknown as Parameters<typeof setDofePrismaClientForTests>[0],
  );
  const metrics: ListWorkflowTriggersPrismaCutoverMetric[] = [];
  const result = await listWorkflowTriggersPrismaCutover(
    { workflowId: "wf-nonexistent", workspaceId: "default" },
    (metric) => metrics.push(metric),
  );
  assert.ok(Array.isArray(result));
  assert.equal(metrics.length, 1);
  assert.equal(metrics[0]!.source, "fallback");
  assert.equal(metrics[0]!.error, "present");
});

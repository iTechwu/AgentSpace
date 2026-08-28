// Unit tests for the workflow-run Prisma Client cutover runner
// (Phase 2 19 域).

import assert from "node:assert/strict";
import test from "node:test";
import type { WorkflowRunRecord } from "../types.ts";
import {
  setDofePrismaClientForTests,
  disconnectDofePrismaClient,
} from "./prisma-client.ts";
import {
  listWorkflowRunsPrismaCutover,
  type ListWorkflowRunsPrismaCutoverMetric,
} from "./workflow-runs-prisma-cutover.ts";

const ORIGINAL_ASYNC = process.env.WORKFLOW_RUNS_PRISMA_READ_ENABLED;
const ORIGINAL_SHADOW = process.env.WORKFLOW_RUNS_PRISMA_SHADOW_READ_ENABLED;

function resetFlags(): void {
  delete process.env.WORKFLOW_RUNS_PRISMA_READ_ENABLED;
  delete process.env.WORKFLOW_RUNS_PRISMA_SHADOW_READ_ENABLED;
}

test.before(() => {
  resetFlags();
});

test.after(async () => {
  setDofePrismaClientForTests(null);
  await disconnectDofePrismaClient();
  if (ORIGINAL_ASYNC === undefined) delete process.env.WORKFLOW_RUNS_PRISMA_READ_ENABLED;
  else process.env.WORKFLOW_RUNS_PRISMA_READ_ENABLED = ORIGINAL_ASYNC;
  if (ORIGINAL_SHADOW === undefined) delete process.env.WORKFLOW_RUNS_PRISMA_SHADOW_READ_ENABLED;
  else process.env.WORKFLOW_RUNS_PRISMA_SHADOW_READ_ENABLED = ORIGINAL_SHADOW;
});

interface MockPrismaWorkflowRun {
  id: string;
  workspaceId: string;
  workflowId: string;
  versionId: string;
  rootTaskId: string | null;
  triggerId: string | null;
  triggerType: string;
  triggerKey: string;
  inputJson: string;
  status: string;
  currentSequence: bigint | number;
  budgetJson: string;
  startedAt: Date | null;
  finishedAt: Date | null;
  createdBy: string;
  createdAt: Date;
  updatedAt: Date;
}

interface MockPrismaClient {
  workflowRun: {
    findMany: (args: unknown) => Promise<MockPrismaWorkflowRun[]>;
  };
}

function makeMockPrisma(
  behavior: (args: unknown) => Promise<MockPrismaWorkflowRun[]>,
): MockPrismaClient {
  return { workflowRun: { findMany: behavior } };
}

function toPrismaRow(record: WorkflowRunRecord): MockPrismaWorkflowRun {
  return {
    id: record.id,
    workspaceId: record.workspaceId,
    workflowId: record.workflowId,
    versionId: record.versionId,
    rootTaskId: record.rootTaskId ?? null,
    triggerId: record.triggerId ?? null,
    triggerType: record.triggerType,
    triggerKey: record.triggerKey,
    inputJson: record.inputJson,
    status: record.status,
    currentSequence: record.currentSequence,
    budgetJson: record.budgetJson,
    startedAt: record.startedAt ? new Date(record.startedAt) : null,
    finishedAt: record.finishedAt ? new Date(record.finishedAt) : null,
    createdBy: record.createdBy,
    createdAt: new Date(record.createdAt),
    updatedAt: new Date(record.updatedAt),
  };
}

test("listWorkflowRunsPrismaCutover returns sync result when flag is disabled", async () => {
  resetFlags();
  const metrics: ListWorkflowRunsPrismaCutoverMetric[] = [];
  const result = await listWorkflowRunsPrismaCutover(
    { workspaceId: "default" },
    (metric) => metrics.push(metric),
  );
  assert.ok(Array.isArray(result));
  assert.equal(metrics.length, 0);
});

test("listWorkflowRunsPrismaCutover uses Prisma primary when flag is on", async () => {
  resetFlags();
  process.env.WORKFLOW_RUNS_PRISMA_READ_ENABLED = "1";
  delete process.env.WORKFLOW_RUNS_PRISMA_SHADOW_READ_ENABLED;

  const mockedRow: WorkflowRunRecord = {
    id: "wr-prisma-mock",
    workspaceId: "default",
    workflowId: "wf-mock",
    versionId: "v1",
    triggerType: "manual",
    triggerKey: "k1",
    inputJson: "{}",
    status: "completed",
    currentSequence: 1,
    budgetJson: "{}",
    createdBy: "user-mock",
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
  setDofePrismaClientForTests(
    makeMockPrisma(async () => [toPrismaRow(mockedRow)]) as unknown as Parameters<typeof setDofePrismaClientForTests>[0],
  );
  const metrics: ListWorkflowRunsPrismaCutoverMetric[] = [];
  const result = await listWorkflowRunsPrismaCutover(
    { workspaceId: "default" },
    (metric) => metrics.push(metric),
  );
  assert.equal(result.length, 1);
  assert.equal(result[0]!.id, "wr-prisma-mock");
  assert.equal(metrics.length, 1);
  assert.equal(metrics[0]!.source, "primary");
});

test("listWorkflowRunsPrismaCutover falls back to sync when Prisma primary throws", async () => {
  resetFlags();
  process.env.WORKFLOW_RUNS_PRISMA_READ_ENABLED = "1";
  delete process.env.WORKFLOW_RUNS_PRISMA_SHADOW_READ_ENABLED;

  setDofePrismaClientForTests(
    makeMockPrisma(async () => {
      throw new Error("prisma workflow runs unreachable");
    }) as unknown as Parameters<typeof setDofePrismaClientForTests>[0],
  );
  const metrics: ListWorkflowRunsPrismaCutoverMetric[] = [];
  const result = await listWorkflowRunsPrismaCutover(
    { workspaceId: "default" },
    (metric) => metrics.push(metric),
  );
  assert.ok(Array.isArray(result));
  assert.equal(metrics.length, 1);
  assert.equal(metrics[0]!.source, "fallback");
  assert.equal(metrics[0]!.error, "present");
});
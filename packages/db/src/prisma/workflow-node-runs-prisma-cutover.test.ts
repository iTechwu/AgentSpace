// Unit tests for the workflow-node-run Prisma Client cutover runner
// (Phase 2 21 域).

import assert from "node:assert/strict";
import test from "node:test";
import type { WorkflowNodeRunRecord } from "../types.ts";
import {
  setDofePrismaClientForTests,
  disconnectDofePrismaClient,
} from "./prisma-client.ts";
import {
  listWorkflowNodeRunsPrismaCutover,
  type ListWorkflowNodeRunsPrismaCutoverMetric,
} from "./workflow-node-runs-prisma-cutover.ts";

const ORIGINAL_ASYNC = process.env.WORKFLOW_NODE_RUNS_PRISMA_READ_ENABLED;
const ORIGINAL_SHADOW = process.env.WORKFLOW_NODE_RUNS_PRISMA_SHADOW_READ_ENABLED;

function resetFlags(): void {
  delete process.env.WORKFLOW_NODE_RUNS_PRISMA_READ_ENABLED;
  delete process.env.WORKFLOW_NODE_RUNS_PRISMA_SHADOW_READ_ENABLED;
}

test.before(() => {
  resetFlags();
});

test.after(async () => {
  setDofePrismaClientForTests(null);
  await disconnectDofePrismaClient();
  if (ORIGINAL_ASYNC === undefined) delete process.env.WORKFLOW_NODE_RUNS_PRISMA_READ_ENABLED;
  else process.env.WORKFLOW_NODE_RUNS_PRISMA_READ_ENABLED = ORIGINAL_ASYNC;
  if (ORIGINAL_SHADOW === undefined) delete process.env.WORKFLOW_NODE_RUNS_PRISMA_SHADOW_READ_ENABLED;
  else process.env.WORKFLOW_NODE_RUNS_PRISMA_SHADOW_READ_ENABLED = ORIGINAL_SHADOW;
});

interface MockPrismaWorkflowNodeRun {
  id: string;
  workspaceId: string;
  runId: string;
  nodeId: string;
  nodeType: string;
  employeeId: string | null;
  employeeNameSnapshot: string | null;
  status: string;
  attemptCount: number;
  maxAttempts: number;
  availableAt: Date | null;
  taskQueueId: string | null;
  approvalId: string | null;
  approvalDeadline: Date | null;
  approvalScanAfter: Date | null;
  inputJson: string;
  outputJson: string | null;
  artifactManifestJson: string | null;
  errorCode: string | null;
  errorMessage: string | null;
  startedAt: Date | null;
  finishedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

interface MockPrismaClient {
  workflowNodeRun: {
    findMany: (args: unknown) => Promise<MockPrismaWorkflowNodeRun[]>;
  };
}

function makeMockPrisma(
  behavior: (args: unknown) => Promise<MockPrismaWorkflowNodeRun[]>,
): MockPrismaClient {
  return { workflowNodeRun: { findMany: behavior } };
}

function toPrismaRow(record: WorkflowNodeRunRecord): MockPrismaWorkflowNodeRun {
  return {
    id: record.id,
    workspaceId: record.workspaceId,
    runId: record.runId,
    nodeId: record.nodeId,
    nodeType: record.nodeType,
    employeeId: record.employeeId ?? null,
    employeeNameSnapshot: record.employeeNameSnapshot ?? null,
    status: record.status,
    attemptCount: record.attemptCount,
    maxAttempts: record.maxAttempts,
    availableAt: record.availableAt ? new Date(record.availableAt) : null,
    taskQueueId: record.taskQueueId ?? null,
    approvalId: record.approvalId ?? null,
    approvalDeadline: record.approvalDeadline ? new Date(record.approvalDeadline) : null,
    approvalScanAfter: record.approvalScanAfter ? new Date(record.approvalScanAfter) : null,
    inputJson: record.inputJson,
    outputJson: record.outputJson ?? null,
    artifactManifestJson: record.artifactManifestJson ?? null,
    errorCode: record.errorCode ?? null,
    errorMessage: record.errorMessage ?? null,
    startedAt: record.startedAt ? new Date(record.startedAt) : null,
    finishedAt: record.finishedAt ? new Date(record.finishedAt) : null,
    createdAt: new Date(record.createdAt),
    updatedAt: new Date(record.updatedAt),
  };
}

test("listWorkflowNodeRunsPrismaCutover returns sync result when flag is disabled", async () => {
  resetFlags();
  const metrics: ListWorkflowNodeRunsPrismaCutoverMetric[] = [];
  const result = await listWorkflowNodeRunsPrismaCutover(
    { workspaceId: "default", runId: "wr-nonexistent" },
    (metric) => metrics.push(metric),
  );
  assert.ok(Array.isArray(result));
  assert.equal(metrics.length, 0);
});

test("listWorkflowNodeRunsPrismaCutover uses Prisma primary when flag is on", async () => {
  resetFlags();
  process.env.WORKFLOW_NODE_RUNS_PRISMA_READ_ENABLED = "1";
  delete process.env.WORKFLOW_NODE_RUNS_PRISMA_SHADOW_READ_ENABLED;

  const mockedRow: WorkflowNodeRunRecord = {
    id: "wnr-prisma-mock",
    workspaceId: "default",
    runId: "wr-mock",
    nodeId: "node-1",
    nodeType: "agent_task",
    employeeId: "emp-mock",
    status: "succeeded",
    attemptCount: 1,
    maxAttempts: 3,
    inputJson: "{}",
    outputJson: '{"ok":true}',
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
  const metrics: ListWorkflowNodeRunsPrismaCutoverMetric[] = [];
  const result = await listWorkflowNodeRunsPrismaCutover(
    { workspaceId: "default", runId: "wr-mock" },
    (metric) => metrics.push(metric),
  );
  assert.equal(result.length, 1);
  assert.equal(result[0]!.id, "wnr-prisma-mock");
  assert.equal(result[0]!.employeeId, "emp-mock");
  assert.equal(result[0]!.outputJson, '{"ok":true}');
  assert.deepEqual(findManyArgs, {
    where: { workspaceId: "default", runId: "wr-mock" },
    orderBy: [{ createdAt: "asc" }, { id: "asc" }],
  });
  assert.equal(metrics.length, 1);
  assert.equal(metrics[0]!.source, "primary");
});

test("listWorkflowNodeRunsPrismaCutover falls back to sync when Prisma primary throws", async () => {
  resetFlags();
  process.env.WORKFLOW_NODE_RUNS_PRISMA_READ_ENABLED = "1";
  delete process.env.WORKFLOW_NODE_RUNS_PRISMA_SHADOW_READ_ENABLED;

  setDofePrismaClientForTests(
    makeMockPrisma(async () => {
      throw new Error("prisma workflow node runs unreachable");
    }) as unknown as Parameters<typeof setDofePrismaClientForTests>[0],
  );
  const metrics: ListWorkflowNodeRunsPrismaCutoverMetric[] = [];
  const result = await listWorkflowNodeRunsPrismaCutover(
    { workspaceId: "default", runId: "wr-nonexistent" },
    (metric) => metrics.push(metric),
  );
  assert.ok(Array.isArray(result));
  assert.equal(metrics.length, 1);
  assert.equal(metrics[0]!.source, "fallback");
  assert.equal(metrics[0]!.error, "present");
});

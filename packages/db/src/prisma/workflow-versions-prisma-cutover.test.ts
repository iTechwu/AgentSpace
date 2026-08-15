// Unit tests for the workflow-version Prisma Client cutover runner
// (Phase 2 22 域).

import assert from "node:assert/strict";
import test from "node:test";
import type { WorkflowVersionRecord } from "../types.ts";
import {
  setDofePrismaClientForTests,
  disconnectDofePrismaClient,
} from "./prisma-client.ts";
import {
  listWorkflowVersionsPrismaCutover,
  type ListWorkflowVersionsPrismaCutoverMetric,
} from "./workflow-versions-prisma-cutover.ts";

const ORIGINAL_ASYNC = process.env.WORKFLOW_VERSIONS_PRISMA_READ_ENABLED;
const ORIGINAL_SHADOW = process.env.WORKFLOW_VERSIONS_PRISMA_SHADOW_READ_ENABLED;

function resetFlags(): void {
  delete process.env.WORKFLOW_VERSIONS_PRISMA_READ_ENABLED;
  delete process.env.WORKFLOW_VERSIONS_PRISMA_SHADOW_READ_ENABLED;
}

test.before(() => {
  resetFlags();
});

test.after(async () => {
  setDofePrismaClientForTests(null);
  await disconnectDofePrismaClient();
  if (ORIGINAL_ASYNC === undefined) delete process.env.WORKFLOW_VERSIONS_PRISMA_READ_ENABLED;
  else process.env.WORKFLOW_VERSIONS_PRISMA_READ_ENABLED = ORIGINAL_ASYNC;
  if (ORIGINAL_SHADOW === undefined) delete process.env.WORKFLOW_VERSIONS_PRISMA_SHADOW_READ_ENABLED;
  else process.env.WORKFLOW_VERSIONS_PRISMA_SHADOW_READ_ENABLED = ORIGINAL_SHADOW;
});

interface MockPrismaWorkflowVersion {
  id: string;
  workspaceId: string;
  workflowId: string;
  versionNumber: number;
  schemaVersion: number;
  graphJson: string;
  inputSchemaJson: string;
  outputSchemaJson: string;
  governanceJson: string;
  contentHash: string;
  publishedBy: string;
  publishedAt: Date;
  createdAt: Date;
}

interface MockPrismaClient {
  workflowVersion: {
    findMany: (args: unknown) => Promise<MockPrismaWorkflowVersion[]>;
  };
}

function makeMockPrisma(
  behavior: (args: unknown) => Promise<MockPrismaWorkflowVersion[]>,
): MockPrismaClient {
  return { workflowVersion: { findMany: behavior } };
}

function toPrismaRow(record: WorkflowVersionRecord): MockPrismaWorkflowVersion {
  return {
    id: record.id,
    workspaceId: record.workspaceId,
    workflowId: record.workflowId,
    versionNumber: record.versionNumber,
    schemaVersion: record.schemaVersion,
    graphJson: record.graphJson,
    inputSchemaJson: record.inputSchemaJson,
    outputSchemaJson: record.outputSchemaJson,
    governanceJson: record.governanceJson,
    contentHash: record.contentHash,
    publishedBy: record.publishedBy,
    publishedAt: new Date(record.publishedAt),
    createdAt: new Date(record.createdAt),
  };
}

test("listWorkflowVersionsPrismaCutover returns sync result when flag is disabled", async () => {
  resetFlags();
  const metrics: ListWorkflowVersionsPrismaCutoverMetric[] = [];
  const result = await listWorkflowVersionsPrismaCutover(
    { workflowId: "wf-nonexistent", workspaceId: "default" },
    (metric) => metrics.push(metric),
  );
  assert.ok(Array.isArray(result));
  assert.equal(metrics.length, 0);
});

test("listWorkflowVersionsPrismaCutover uses Prisma primary when flag is on", async () => {
  resetFlags();
  process.env.WORKFLOW_VERSIONS_PRISMA_READ_ENABLED = "1";
  delete process.env.WORKFLOW_VERSIONS_PRISMA_SHADOW_READ_ENABLED;

  const mockedRow: WorkflowVersionRecord = {
    id: "wv-prisma-mock",
    workspaceId: "default",
    workflowId: "wf-mock",
    versionNumber: 3,
    schemaVersion: 1,
    graphJson: "{}",
    inputSchemaJson: "{}",
    outputSchemaJson: "{}",
    governanceJson: "{}",
    contentHash: "hash-mock",
    publishedBy: "user-mock",
    publishedAt: new Date().toISOString(),
    createdAt: new Date().toISOString(),
  };
  let findManyArgs: unknown;
  setDofePrismaClientForTests(
    makeMockPrisma(async (args) => {
      findManyArgs = args;
      return [toPrismaRow(mockedRow)];
    }) as unknown as Parameters<typeof setDofePrismaClientForTests>[0],
  );
  const metrics: ListWorkflowVersionsPrismaCutoverMetric[] = [];
  const result = await listWorkflowVersionsPrismaCutover(
    { workflowId: "wf-mock", workspaceId: "default" },
    (metric) => metrics.push(metric),
  );
  assert.equal(result.length, 1);
  assert.equal(result[0]!.id, "wv-prisma-mock");
  assert.equal(result[0]!.versionNumber, 3);
  assert.equal(result[0]!.contentHash, "hash-mock");
  assert.deepEqual(findManyArgs, {
    where: { workflowId: "wf-mock", workspaceId: "default" },
    orderBy: { versionNumber: "desc" },
  });
  assert.equal(metrics.length, 1);
  assert.equal(metrics[0]!.source, "primary");
});

test("listWorkflowVersionsPrismaCutover falls back to sync when Prisma primary throws", async () => {
  resetFlags();
  process.env.WORKFLOW_VERSIONS_PRISMA_READ_ENABLED = "1";
  delete process.env.WORKFLOW_VERSIONS_PRISMA_SHADOW_READ_ENABLED;

  setDofePrismaClientForTests(
    makeMockPrisma(async () => {
      throw new Error("prisma workflow versions unreachable");
    }) as unknown as Parameters<typeof setDofePrismaClientForTests>[0],
  );
  const metrics: ListWorkflowVersionsPrismaCutoverMetric[] = [];
  const result = await listWorkflowVersionsPrismaCutover(
    { workflowId: "wf-nonexistent", workspaceId: "default" },
    (metric) => metrics.push(metric),
  );
  assert.ok(Array.isArray(result));
  assert.equal(metrics.length, 1);
  assert.equal(metrics[0]!.source, "fallback");
  assert.equal(metrics[0]!.error, "present");
});

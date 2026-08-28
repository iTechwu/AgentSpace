// Unit tests for the workflow-definition Prisma Client cutover runner
// (Phase 2 14 域).

import assert from "node:assert/strict";
import test from "node:test";
import type { WorkflowDefinitionRecord } from "../types.ts";
import {
  setDofePrismaClientForTests,
  disconnectDofePrismaClient,
} from "./prisma-client.ts";
import {
  listWorkflowDefinitionsPrismaCutover,
  type ListWorkflowDefinitionsPrismaCutoverMetric,
} from "./workflow-definitions-prisma-cutover.ts";

const ORIGINAL_ASYNC = process.env.WORKFLOW_DEFINITIONS_PRISMA_READ_ENABLED;
const ORIGINAL_SHADOW = process.env.WORKFLOW_DEFINITIONS_PRISMA_SHADOW_READ_ENABLED;

function resetFlags(): void {
  delete process.env.WORKFLOW_DEFINITIONS_PRISMA_READ_ENABLED;
  delete process.env.WORKFLOW_DEFINITIONS_PRISMA_SHADOW_READ_ENABLED;
}

test.before(() => {
  resetFlags();
});

test.after(async () => {
  setDofePrismaClientForTests(null);
  await disconnectDofePrismaClient();
  if (ORIGINAL_ASYNC === undefined) delete process.env.WORKFLOW_DEFINITIONS_PRISMA_READ_ENABLED;
  else process.env.WORKFLOW_DEFINITIONS_PRISMA_READ_ENABLED = ORIGINAL_ASYNC;
  if (ORIGINAL_SHADOW === undefined) delete process.env.WORKFLOW_DEFINITIONS_PRISMA_SHADOW_READ_ENABLED;
  else process.env.WORKFLOW_DEFINITIONS_PRISMA_SHADOW_READ_ENABLED = ORIGINAL_SHADOW;
});

interface MockPrismaWorkflowDefinition {
  id: string;
  workspaceId: string;
  name: string;
  description: string | null;
  ownerUserId: string;
  channelName: string | null;
  status: string;
  draftGraphJson: string;
  draftVersion: number;
  activeVersionId: string | null;
  legacySourceType: string | null;
  legacySourceId: string | null;
  createdBy: string;
  createdAt: Date;
  updatedAt: Date;
  archivedAt: Date | null;
}

interface MockPrismaClient {
  workflowDefinition: {
    findMany: (args: unknown) => Promise<MockPrismaWorkflowDefinition[]>;
  };
}

function makeMockPrisma(
  behavior: (args: unknown) => Promise<MockPrismaWorkflowDefinition[]>,
): MockPrismaClient {
  return { workflowDefinition: { findMany: behavior } };
}

function toPrismaRow(record: WorkflowDefinitionRecord): MockPrismaWorkflowDefinition {
  return {
    id: record.id,
    workspaceId: record.workspaceId,
    name: record.name,
    description: record.description ?? null,
    ownerUserId: record.ownerUserId,
    channelName: record.channelName ?? null,
    status: record.status,
    draftGraphJson: record.draftGraphJson,
    draftVersion: record.draftVersion,
    activeVersionId: record.activeVersionId ?? null,
    legacySourceType: record.legacySourceType ?? null,
    legacySourceId: record.legacySourceId ?? null,
    createdBy: record.createdBy,
    createdAt: new Date(record.createdAt),
    updatedAt: new Date(record.updatedAt),
    archivedAt: record.archivedAt ? new Date(record.archivedAt) : null,
  };
}

test("listWorkflowDefinitionsPrismaCutover returns sync result when flag is disabled", async () => {
  resetFlags();
  const metrics: ListWorkflowDefinitionsPrismaCutoverMetric[] = [];
  const result = await listWorkflowDefinitionsPrismaCutover(
    "default",
    (metric) => metrics.push(metric),
  );
  assert.ok(Array.isArray(result));
  assert.equal(metrics.length, 0);
});

test("listWorkflowDefinitionsPrismaCutover uses Prisma primary when flag is on", async () => {
  resetFlags();
  process.env.WORKFLOW_DEFINITIONS_PRISMA_READ_ENABLED = "1";
  delete process.env.WORKFLOW_DEFINITIONS_PRISMA_SHADOW_READ_ENABLED;

  const mockedRow: WorkflowDefinitionRecord = {
    id: "wd-prisma-mock",
    workspaceId: "default",
    name: "MockWorkflow",
    ownerUserId: "user-mock",
    status: "published",
    draftGraphJson: "{}",
    draftVersion: 1,
    createdBy: "user-mock",
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
  setDofePrismaClientForTests(
    makeMockPrisma(async () => [toPrismaRow(mockedRow)]) as unknown as Parameters<typeof setDofePrismaClientForTests>[0],
  );
  const metrics: ListWorkflowDefinitionsPrismaCutoverMetric[] = [];
  const result = await listWorkflowDefinitionsPrismaCutover(
    "default",
    (metric) => metrics.push(metric),
  );
  assert.equal(result.length, 1);
  assert.equal(result[0]!.id, "wd-prisma-mock");
  assert.equal(metrics.length, 1);
  assert.equal(metrics[0]!.source, "primary");
});

test("listWorkflowDefinitionsPrismaCutover falls back to sync when Prisma primary throws", async () => {
  resetFlags();
  process.env.WORKFLOW_DEFINITIONS_PRISMA_READ_ENABLED = "1";
  delete process.env.WORKFLOW_DEFINITIONS_PRISMA_SHADOW_READ_ENABLED;

  setDofePrismaClientForTests(
    makeMockPrisma(async () => {
      throw new Error("prisma workflow definitions unreachable");
    }) as unknown as Parameters<typeof setDofePrismaClientForTests>[0],
  );
  const metrics: ListWorkflowDefinitionsPrismaCutoverMetric[] = [];
  const result = await listWorkflowDefinitionsPrismaCutover(
    "default",
    (metric) => metrics.push(metric),
  );
  assert.ok(Array.isArray(result));
  assert.equal(metrics.length, 1);
  assert.equal(metrics[0]!.source, "fallback");
  assert.equal(metrics[0]!.error, "present");
});
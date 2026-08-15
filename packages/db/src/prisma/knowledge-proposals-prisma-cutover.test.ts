// Unit tests for the knowledge-proposals Prisma Client cutover runner
// (Phase 2 8 域).

import assert from "node:assert/strict";
import test from "node:test";
import type { KnowledgeProposalRecord } from "../types.ts";
import {
  setDofePrismaClientForTests,
  disconnectDofePrismaClient,
} from "./prisma-client.ts";
import {
  listKnowledgeProposalsPrismaCutover,
  type ListKnowledgeProposalsPrismaCutoverMetric,
} from "./knowledge-proposals-prisma-cutover.ts";

const ORIGINAL_ASYNC = process.env.KNOWLEDGE_PROPOSALS_PRISMA_READ_ENABLED;
const ORIGINAL_SHADOW = process.env.KNOWLEDGE_PROPOSALS_PRISMA_SHADOW_READ_ENABLED;

function resetFlags(): void {
  delete process.env.KNOWLEDGE_PROPOSALS_PRISMA_READ_ENABLED;
  delete process.env.KNOWLEDGE_PROPOSALS_PRISMA_SHADOW_READ_ENABLED;
}

test.before(() => {
  resetFlags();
});

test.after(async () => {
  setDofePrismaClientForTests(null);
  await disconnectDofePrismaClient();
  if (ORIGINAL_ASYNC === undefined) delete process.env.KNOWLEDGE_PROPOSALS_PRISMA_READ_ENABLED;
  else process.env.KNOWLEDGE_PROPOSALS_PRISMA_READ_ENABLED = ORIGINAL_ASYNC;
  if (ORIGINAL_SHADOW === undefined) delete process.env.KNOWLEDGE_PROPOSALS_PRISMA_SHADOW_READ_ENABLED;
  else process.env.KNOWLEDGE_PROPOSALS_PRISMA_SHADOW_READ_ENABLED = ORIGINAL_SHADOW;
});

interface MockPrismaProposal {
  id: string;
  workspaceId: string;
  sourceTaskQueueId: string;
  sourceChannelName: string | null;
  sourceAgentName: string;
  operation: string;
  status: string;
  title: string;
  contentMarkdown: string;
  summary: string | null;
  reason: string | null;
  tagsJson: unknown;
  parentId: string | null;
  assignmentMode: string;
  assignedEmployeeNamesJson: unknown;
  targetKnowledgePageId: string | null;
  baseUpdatedAt: Date | null;
  createdKnowledgePageId: string | null;
  approvalId: string | null;
  decidedByUserId: string | null;
  decidedAt: Date | null;
  reviewerComment: string | null;
  createdAt: Date;
  updatedAt: Date;
}

interface MockPrismaClient {
  knowledgeProposal: {
    findMany: (args: unknown) => Promise<MockPrismaProposal[]>;
  };
}

function makeMockPrisma(
  behavior: (args: unknown) => Promise<MockPrismaProposal[]>,
): MockPrismaClient {
  return { knowledgeProposal: { findMany: behavior } };
}

function toPrismaRow(record: KnowledgeProposalRecord): MockPrismaProposal {
  return {
    id: record.id,
    workspaceId: record.workspaceId,
    sourceTaskQueueId: record.sourceTaskQueueId,
    sourceChannelName: record.sourceChannelName ?? null,
    sourceAgentName: record.sourceAgentName,
    operation: record.operation,
    status: record.status,
    title: record.title,
    contentMarkdown: record.contentMarkdown,
    summary: record.summary ?? null,
    reason: record.reason ?? null,
    tagsJson: record.tags,
    parentId: record.parentId ?? null,
    assignmentMode: record.assignmentMode,
    assignedEmployeeNamesJson: record.assignedEmployeeNames,
    targetKnowledgePageId: record.targetKnowledgePageId ?? null,
    baseUpdatedAt: record.baseUpdatedAt ? new Date(record.baseUpdatedAt) : null,
    createdKnowledgePageId: record.createdKnowledgePageId ?? null,
    approvalId: record.approvalId ?? null,
    decidedByUserId: record.decidedByUserId ?? null,
    decidedAt: record.decidedAt ? new Date(record.decidedAt) : null,
    reviewerComment: record.reviewerComment ?? null,
    createdAt: new Date(record.createdAt),
    updatedAt: new Date(record.updatedAt),
  };
}

test("listKnowledgeProposalsPrismaCutover returns sync result when flag is disabled", async () => {
  resetFlags();
  const metrics: ListKnowledgeProposalsPrismaCutoverMetric[] = [];
  const result = await listKnowledgeProposalsPrismaCutover(
    "default",
    undefined,
    (metric) => metrics.push(metric),
  );
  assert.ok(Array.isArray(result));
  assert.equal(metrics.length, 0);
});

test("listKnowledgeProposalsPrismaCutover uses Prisma primary when flag is on", async () => {
  resetFlags();
  process.env.KNOWLEDGE_PROPOSALS_PRISMA_READ_ENABLED = "1";
  delete process.env.KNOWLEDGE_PROPOSALS_PRISMA_SHADOW_READ_ENABLED;

  const mockedRow: KnowledgeProposalRecord = {
    id: "kp-prisma-mock",
    workspaceId: "default",
    sourceTaskQueueId: "task-prisma-mock",
    sourceAgentName: "MockEmp",
    operation: "create",
    status: "pending",
    title: "Mock proposal",
    contentMarkdown: "# mock",
    tags: ["mock"],
    assignedEmployeeNames: ["MockEmp"],
    assignmentMode: "selected_agents",
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
  setDofePrismaClientForTests(
    makeMockPrisma(async () => [toPrismaRow(mockedRow)]) as unknown as Parameters<typeof setDofePrismaClientForTests>[0],
  );
  const metrics: ListKnowledgeProposalsPrismaCutoverMetric[] = [];
  const result = await listKnowledgeProposalsPrismaCutover(
    "default",
    undefined,
    (metric) => metrics.push(metric),
  );
  assert.equal(result.length, 1);
  assert.equal(result[0]!.id, "kp-prisma-mock");
  assert.equal(metrics.length, 1);
  assert.equal(metrics[0]!.source, "primary");
});

test("listKnowledgeProposalsPrismaCutover falls back to sync when Prisma primary throws", async () => {
  resetFlags();
  process.env.KNOWLEDGE_PROPOSALS_PRISMA_READ_ENABLED = "1";
  delete process.env.KNOWLEDGE_PROPOSALS_PRISMA_SHADOW_READ_ENABLED;

  setDofePrismaClientForTests(
    makeMockPrisma(async () => {
      throw new Error("prisma knowledge proposals unreachable");
    }) as unknown as Parameters<typeof setDofePrismaClientForTests>[0],
  );
  const metrics: ListKnowledgeProposalsPrismaCutoverMetric[] = [];
  const result = await listKnowledgeProposalsPrismaCutover(
    "default",
    undefined,
    (metric) => metrics.push(metric),
  );
  assert.ok(Array.isArray(result));
  assert.equal(metrics.length, 1);
  assert.equal(metrics[0]!.source, "fallback");
  assert.ok(metrics[0]!.error?.includes("prisma knowledge proposals unreachable"));
});

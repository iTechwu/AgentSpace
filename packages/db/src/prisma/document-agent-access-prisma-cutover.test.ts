// Unit tests for the document-agent-access Prisma Client cutover runner
// (Phase 2 9 域).

import assert from "node:assert/strict";
import test from "node:test";
import type { DocumentAgentAccessRecord } from "../types.ts";
import {
  setDofePrismaClientForTests,
  disconnectDofePrismaClient,
} from "./prisma-client.ts";
import {
  listDocumentAgentAccessPrismaCutover,
  type ListDocumentAgentAccessPrismaCutoverMetric,
} from "./document-agent-access-prisma-cutover.ts";

const ORIGINAL_ASYNC = process.env.DOCUMENT_AGENT_ACCESS_PRISMA_READ_ENABLED;
const ORIGINAL_SHADOW = process.env.DOCUMENT_AGENT_ACCESS_PRISMA_SHADOW_READ_ENABLED;

function resetFlags(): void {
  delete process.env.DOCUMENT_AGENT_ACCESS_PRISMA_READ_ENABLED;
  delete process.env.DOCUMENT_AGENT_ACCESS_PRISMA_SHADOW_READ_ENABLED;
}

test.before(() => {
  resetFlags();
});

test.after(async () => {
  setDofePrismaClientForTests(null);
  await disconnectDofePrismaClient();
  if (ORIGINAL_ASYNC === undefined) delete process.env.DOCUMENT_AGENT_ACCESS_PRISMA_READ_ENABLED;
  else process.env.DOCUMENT_AGENT_ACCESS_PRISMA_READ_ENABLED = ORIGINAL_ASYNC;
  if (ORIGINAL_SHADOW === undefined) delete process.env.DOCUMENT_AGENT_ACCESS_PRISMA_SHADOW_READ_ENABLED;
  else process.env.DOCUMENT_AGENT_ACCESS_PRISMA_SHADOW_READ_ENABLED = ORIGINAL_SHADOW;
});

interface MockPrismaAccess {
  id: string;
  workspaceId: string;
  documentId: string;
  subjectType: string;
  subjectId: string;
  role: string;
  scope: string;
  grantedByUserId: string;
  createdAt: Date;
  updatedAt: Date;
  revokedAt: Date | null;
}

interface MockPrismaClient {
  documentAgentAccess: {
    findMany: (args: unknown) => Promise<MockPrismaAccess[]>;
  };
}

function makeMockPrisma(
  behavior: (args: unknown) => Promise<MockPrismaAccess[]>,
): MockPrismaClient {
  return { documentAgentAccess: { findMany: behavior } };
}

function toPrismaRow(record: DocumentAgentAccessRecord): MockPrismaAccess {
  return {
    id: record.id,
    workspaceId: record.workspaceId,
    documentId: record.documentId,
    subjectType: record.subjectType,
    subjectId: record.subjectId,
    role: record.role,
    scope: record.scope,
    grantedByUserId: record.grantedByUserId,
    createdAt: new Date(record.createdAt),
    updatedAt: new Date(record.updatedAt),
    revokedAt: record.revokedAt ? new Date(record.revokedAt) : null,
  };
}

test("listDocumentAgentAccessPrismaCutover returns sync result when flag is disabled", async () => {
  resetFlags();
  const metrics: ListDocumentAgentAccessPrismaCutoverMetric[] = [];
  const result = await listDocumentAgentAccessPrismaCutover(
    undefined,
    (metric) => metrics.push(metric),
  );
  assert.ok(Array.isArray(result));
  assert.equal(metrics.length, 0);
});

test("listDocumentAgentAccessPrismaCutover uses Prisma primary when flag is on", async () => {
  resetFlags();
  process.env.DOCUMENT_AGENT_ACCESS_PRISMA_READ_ENABLED = "1";
  delete process.env.DOCUMENT_AGENT_ACCESS_PRISMA_SHADOW_READ_ENABLED;

  const mockedRow: DocumentAgentAccessRecord = {
    id: "daa-prisma-mock",
    workspaceId: "default",
    documentId: "doc-mock",
    subjectType: "agent",
    subjectId: "agent-mock",
    role: "editor",
    scope: "document",
    grantedByUserId: "user-mock",
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
  setDofePrismaClientForTests(
    makeMockPrisma(async () => [toPrismaRow(mockedRow)]) as unknown as Parameters<typeof setDofePrismaClientForTests>[0],
  );
  const metrics: ListDocumentAgentAccessPrismaCutoverMetric[] = [];
  const result = await listDocumentAgentAccessPrismaCutover(
    undefined,
    (metric) => metrics.push(metric),
  );
  assert.equal(result.length, 1);
  assert.equal(result[0]!.id, "daa-prisma-mock");
  assert.equal(metrics.length, 1);
  assert.equal(metrics[0]!.source, "primary");
});

test("listDocumentAgentAccessPrismaCutover falls back to sync when Prisma primary throws", async () => {
  resetFlags();
  process.env.DOCUMENT_AGENT_ACCESS_PRISMA_READ_ENABLED = "1";
  delete process.env.DOCUMENT_AGENT_ACCESS_PRISMA_SHADOW_READ_ENABLED;

  setDofePrismaClientForTests(
    makeMockPrisma(async () => {
      throw new Error("prisma document agent access unreachable");
    }) as unknown as Parameters<typeof setDofePrismaClientForTests>[0],
  );
  const metrics: ListDocumentAgentAccessPrismaCutoverMetric[] = [];
  const result = await listDocumentAgentAccessPrismaCutover(
    undefined,
    (metric) => metrics.push(metric),
  );
  assert.ok(Array.isArray(result));
  assert.equal(metrics.length, 1);
  assert.equal(metrics[0]!.source, "fallback");
  assert.equal(metrics[0]!.error, "present");
});

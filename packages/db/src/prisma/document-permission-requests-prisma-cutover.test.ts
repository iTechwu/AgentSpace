// Unit tests for the document-permission-request Prisma Client cutover runner
// (Phase 2 10 域).

import assert from "node:assert/strict";
import test from "node:test";
import type { DocumentPermissionRequestRecord } from "../types.ts";
import {
  setDofePrismaClientForTests,
  disconnectDofePrismaClient,
} from "./prisma-client.ts";
import {
  listDocumentPermissionRequestsPrismaCutover,
  type ListDocumentPermissionRequestsPrismaCutoverMetric,
} from "./document-permission-requests-prisma-cutover.ts";

const ORIGINAL_ASYNC = process.env.DOCUMENT_PERMISSION_REQUESTS_PRISMA_READ_ENABLED;
const ORIGINAL_SHADOW = process.env.DOCUMENT_PERMISSION_REQUESTS_PRISMA_SHADOW_READ_ENABLED;

function resetFlags(): void {
  delete process.env.DOCUMENT_PERMISSION_REQUESTS_PRISMA_READ_ENABLED;
  delete process.env.DOCUMENT_PERMISSION_REQUESTS_PRISMA_SHADOW_READ_ENABLED;
}

test.before(() => {
  resetFlags();
});

test.after(async () => {
  setDofePrismaClientForTests(null);
  await disconnectDofePrismaClient();
  if (ORIGINAL_ASYNC === undefined) delete process.env.DOCUMENT_PERMISSION_REQUESTS_PRISMA_READ_ENABLED;
  else process.env.DOCUMENT_PERMISSION_REQUESTS_PRISMA_READ_ENABLED = ORIGINAL_ASYNC;
  if (ORIGINAL_SHADOW === undefined) delete process.env.DOCUMENT_PERMISSION_REQUESTS_PRISMA_SHADOW_READ_ENABLED;
  else process.env.DOCUMENT_PERMISSION_REQUESTS_PRISMA_SHADOW_READ_ENABLED = ORIGINAL_SHADOW;
});

interface MockPrismaPermissionRequest {
  id: string;
  workspaceId: string;
  documentId: string | null;
  externalProvider: string | null;
  externalFileId: string | null;
  externalUrl: string | null;
  requestedRole: string;
  requestedByAgentName: string;
  requestedForChannelName: string | null;
  triggeredByUserId: string | null;
  reason: string;
  status: string;
  decidedByUserId: string | null;
  decisionNote: string | null;
  sourceTaskId: string | null;
  createdAt: Date;
  decidedAt: Date | null;
}

interface MockPrismaClient {
  documentPermissionRequest: {
    findMany: (args: unknown) => Promise<MockPrismaPermissionRequest[]>;
  };
}

function makeMockPrisma(
  behavior: (args: unknown) => Promise<MockPrismaPermissionRequest[]>,
): MockPrismaClient {
  return { documentPermissionRequest: { findMany: behavior } };
}

function toPrismaRow(
  record: DocumentPermissionRequestRecord,
): MockPrismaPermissionRequest {
  return {
    id: record.id,
    workspaceId: record.workspaceId,
    documentId: record.documentId ?? null,
    externalProvider: record.externalProvider ?? null,
    externalFileId: record.externalFileId ?? null,
    externalUrl: record.externalUrl ?? null,
    requestedRole: record.requestedRole,
    requestedByAgentName: record.requestedByAgentName,
    requestedForChannelName: record.requestedForChannelName ?? null,
    triggeredByUserId: record.triggeredByUserId ?? null,
    reason: record.reason,
    status: record.status,
    decidedByUserId: record.decidedByUserId ?? null,
    decisionNote: record.decisionNote ?? null,
    sourceTaskId: record.sourceTaskId ?? null,
    createdAt: new Date(record.createdAt),
    decidedAt: record.decidedAt ? new Date(record.decidedAt) : null,
  };
}

test("listDocumentPermissionRequestsPrismaCutover returns sync result when flag is disabled", async () => {
  resetFlags();
  const metrics: ListDocumentPermissionRequestsPrismaCutoverMetric[] = [];
  const result = await listDocumentPermissionRequestsPrismaCutover(
    undefined,
    (metric) => metrics.push(metric),
  );
  assert.ok(Array.isArray(result));
  assert.equal(metrics.length, 0);
});

test("listDocumentPermissionRequestsPrismaCutover uses Prisma primary when flag is on", async () => {
  resetFlags();
  process.env.DOCUMENT_PERMISSION_REQUESTS_PRISMA_READ_ENABLED = "1";
  delete process.env.DOCUMENT_PERMISSION_REQUESTS_PRISMA_SHADOW_READ_ENABLED;

  const mockedRow: DocumentPermissionRequestRecord = {
    id: "dpr-prisma-mock",
    workspaceId: "default",
    requestedRole: "editor",
    requestedByAgentName: "MockAgent",
    reason: "Mock reason",
    status: "pending",
    createdAt: new Date().toISOString(),
  };
  setDofePrismaClientForTests(
    makeMockPrisma(async () => [toPrismaRow(mockedRow)]) as unknown as Parameters<typeof setDofePrismaClientForTests>[0],
  );
  const metrics: ListDocumentPermissionRequestsPrismaCutoverMetric[] = [];
  const result = await listDocumentPermissionRequestsPrismaCutover(
    undefined,
    (metric) => metrics.push(metric),
  );
  assert.equal(result.length, 1);
  assert.equal(result[0]!.id, "dpr-prisma-mock");
  assert.equal(metrics.length, 1);
  assert.equal(metrics[0]!.source, "primary");
});

test("listDocumentPermissionRequestsPrismaCutover falls back to sync when Prisma primary throws", async () => {
  resetFlags();
  process.env.DOCUMENT_PERMISSION_REQUESTS_PRISMA_READ_ENABLED = "1";
  delete process.env.DOCUMENT_PERMISSION_REQUESTS_PRISMA_SHADOW_READ_ENABLED;

  setDofePrismaClientForTests(
    makeMockPrisma(async () => {
      throw new Error("prisma document permission requests unreachable");
    }) as unknown as Parameters<typeof setDofePrismaClientForTests>[0],
  );
  const metrics: ListDocumentPermissionRequestsPrismaCutoverMetric[] = [];
  const result = await listDocumentPermissionRequestsPrismaCutover(
    undefined,
    (metric) => metrics.push(metric),
  );
  assert.ok(Array.isArray(result));
  assert.equal(metrics.length, 1);
  assert.equal(metrics[0]!.source, "fallback");
  assert.equal(metrics[0]!.error, "present");
});
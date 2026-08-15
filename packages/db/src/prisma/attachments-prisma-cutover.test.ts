// Unit tests for the attachment Prisma Client cutover runner (Phase 2 12 域).

import assert from "node:assert/strict";
import test from "node:test";
import type { StoredAttachmentRecord } from "../attachments.ts";
import {
  setDofePrismaClientForTests,
  disconnectDofePrismaClient,
} from "./prisma-client.ts";
import {
  listStoredAttachmentsPrismaCutover,
  type ListAttachmentsPrismaCutoverMetric,
} from "./attachments-prisma-cutover.ts";

const ORIGINAL_ASYNC = process.env.ATTACHMENTS_PRISMA_READ_ENABLED;
const ORIGINAL_SHADOW = process.env.ATTACHMENTS_PRISMA_SHADOW_READ_ENABLED;

function resetFlags(): void {
  delete process.env.ATTACHMENTS_PRISMA_READ_ENABLED;
  delete process.env.ATTACHMENTS_PRISMA_SHADOW_READ_ENABLED;
}

test.before(() => {
  resetFlags();
});

test.after(async () => {
  setDofePrismaClientForTests(null);
  await disconnectDofePrismaClient();
  if (ORIGINAL_ASYNC === undefined) delete process.env.ATTACHMENTS_PRISMA_READ_ENABLED;
  else process.env.ATTACHMENTS_PRISMA_READ_ENABLED = ORIGINAL_ASYNC;
  if (ORIGINAL_SHADOW === undefined) delete process.env.ATTACHMENTS_PRISMA_SHADOW_READ_ENABLED;
  else process.env.ATTACHMENTS_PRISMA_SHADOW_READ_ENABLED = ORIGINAL_SHADOW;
});

interface MockPrismaAttachment {
  id: string;
  workspaceId: string;
  messageId: string | null;
  channelName: string | null;
  speaker: string;
  role: string;
  fileName: string;
  mediaType: string | null;
  sizeBytes: number | null;
  contentDigest: string | null;
  storedPath: string;
  storageProvider: string | null;
  storageBucket: string | null;
  storageRegion: string | null;
  storageEndpoint: string | null;
  storageKey: string | null;
  storageUrl: string | null;
  note: string | null;
  uploadId: string | null;
  sourceMessageIndex: number;
  sourceMessageTime: Date | null;
  sourceSummary: string | null;
  deletedAt: Date | null;
  deletedByUserId: string | null;
  deletedByDisplayName: string | null;
  createdAt: Date;
  updatedAt: Date;
}

interface MockPrismaClient {
  attachment: {
    findMany: (args: unknown) => Promise<MockPrismaAttachment[]>;
  };
}

function makeMockPrisma(
  behavior: (args: unknown) => Promise<MockPrismaAttachment[]>,
): MockPrismaClient {
  return { attachment: { findMany: behavior } };
}

function toPrismaRow(record: StoredAttachmentRecord): MockPrismaAttachment {
  return {
    id: record.id,
    workspaceId: record.workspaceId,
    messageId: record.messageId ?? null,
    channelName: record.channelName ?? null,
    speaker: record.speaker,
    role: record.role,
    fileName: record.fileName,
    mediaType: record.mediaType ?? null,
    sizeBytes: record.sizeBytes ?? null,
    contentDigest: record.contentDigest ?? null,
    storedPath: record.storedPath,
    storageProvider: record.storageProvider ?? null,
    storageBucket: record.storageBucket ?? null,
    storageRegion: record.storageRegion ?? null,
    storageEndpoint: record.storageEndpoint ?? null,
    storageKey: record.storageKey ?? null,
    storageUrl: record.storageUrl ?? null,
    note: record.note ?? null,
    uploadId: record.uploadId ?? null,
    sourceMessageIndex: record.sourceMessageIndex,
    sourceMessageTime: record.sourceMessageTime ? new Date(record.sourceMessageTime) : null,
    sourceSummary: record.sourceSummary ?? null,
    deletedAt: record.deletedAt ? new Date(record.deletedAt) : null,
    deletedByUserId: record.deletedByUserId ?? null,
    deletedByDisplayName: record.deletedByDisplayName ?? null,
    createdAt: new Date(record.createdAt),
    updatedAt: new Date(record.updatedAt),
  };
}

test("listStoredAttachmentsPrismaCutover returns sync result when flag is disabled", async () => {
  resetFlags();
  const metrics: ListAttachmentsPrismaCutoverMetric[] = [];
  const result = await listStoredAttachmentsPrismaCutover(
    "default",
    (metric) => metrics.push(metric),
  );
  assert.ok(Array.isArray(result));
  assert.equal(metrics.length, 0);
});

test("listStoredAttachmentsPrismaCutover uses Prisma primary when flag is on", async () => {
  resetFlags();
  process.env.ATTACHMENTS_PRISMA_READ_ENABLED = "1";
  delete process.env.ATTACHMENTS_PRISMA_SHADOW_READ_ENABLED;

  const mockedRow: StoredAttachmentRecord = {
    id: "att-prisma-mock",
    workspaceId: "default",
    fileName: "mock.txt",
    storedPath: "/tmp/mock.txt",
    speaker: "MockSpeaker",
    role: "human",
    sourceMessageIndex: 0,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
  setDofePrismaClientForTests(
    makeMockPrisma(async () => [toPrismaRow(mockedRow)]) as unknown as Parameters<typeof setDofePrismaClientForTests>[0],
  );
  const metrics: ListAttachmentsPrismaCutoverMetric[] = [];
  const result = await listStoredAttachmentsPrismaCutover(
    "default",
    (metric) => metrics.push(metric),
  );
  assert.equal(result.length, 1);
  assert.equal(result[0]!.id, "att-prisma-mock");
  assert.equal(metrics.length, 1);
  assert.equal(metrics[0]!.source, "primary");
});

test("listStoredAttachmentsPrismaCutover falls back to sync when Prisma primary throws", async () => {
  resetFlags();
  process.env.ATTACHMENTS_PRISMA_READ_ENABLED = "1";
  delete process.env.ATTACHMENTS_PRISMA_SHADOW_READ_ENABLED;

  setDofePrismaClientForTests(
    makeMockPrisma(async () => {
      throw new Error("prisma attachments unreachable");
    }) as unknown as Parameters<typeof setDofePrismaClientForTests>[0],
  );
  const metrics: ListAttachmentsPrismaCutoverMetric[] = [];
  const result = await listStoredAttachmentsPrismaCutover(
    "default",
    (metric) => metrics.push(metric),
  );
  assert.ok(Array.isArray(result));
  assert.equal(metrics.length, 1);
  assert.equal(metrics[0]!.source, "fallback");
  assert.equal(metrics[0]!.error, "present");
});
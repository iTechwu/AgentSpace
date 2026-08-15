// Unit tests for the channel-access-request Prisma Client cutover runner
// (Phase 2 16 域).

import assert from "node:assert/strict";
import test from "node:test";
import type { StoredChannelAccessRequestRecord } from "../types.ts";
import {
  setDofePrismaClientForTests,
  disconnectDofePrismaClient,
} from "./prisma-client.ts";
import {
  listChannelAccessRequestsPrismaCutover,
  type ListChannelAccessRequestsPrismaCutoverMetric,
} from "./channel-access-requests-prisma-cutover.ts";

const ORIGINAL_ASYNC = process.env.CHANNEL_ACCESS_REQUESTS_PRISMA_READ_ENABLED;
const ORIGINAL_SHADOW = process.env.CHANNEL_ACCESS_REQUESTS_PRISMA_SHADOW_READ_ENABLED;

function resetFlags(): void {
  delete process.env.CHANNEL_ACCESS_REQUESTS_PRISMA_READ_ENABLED;
  delete process.env.CHANNEL_ACCESS_REQUESTS_PRISMA_SHADOW_READ_ENABLED;
}

test.before(() => {
  resetFlags();
});

test.after(async () => {
  setDofePrismaClientForTests(null);
  await disconnectDofePrismaClient();
  if (ORIGINAL_ASYNC === undefined) delete process.env.CHANNEL_ACCESS_REQUESTS_PRISMA_READ_ENABLED;
  else process.env.CHANNEL_ACCESS_REQUESTS_PRISMA_READ_ENABLED = ORIGINAL_ASYNC;
  if (ORIGINAL_SHADOW === undefined) delete process.env.CHANNEL_ACCESS_REQUESTS_PRISMA_SHADOW_READ_ENABLED;
  else process.env.CHANNEL_ACCESS_REQUESTS_PRISMA_SHADOW_READ_ENABLED = ORIGINAL_SHADOW;
});

interface MockPrismaChannelAccessRequest {
  id: string;
  workspaceId: string;
  channelName: string;
  userId: string;
  status: string;
  requestedAt: Date;
  resolvedAt: Date | null;
  resolvedBy: string | null;
  note: string | null;
}

interface MockPrismaClient {
  channelAccessRequest: {
    findMany: (args: unknown) => Promise<MockPrismaChannelAccessRequest[]>;
  };
}

function makeMockPrisma(
  behavior: (args: unknown) => Promise<MockPrismaChannelAccessRequest[]>,
): MockPrismaClient {
  return { channelAccessRequest: { findMany: behavior } };
}

function toPrismaRow(record: StoredChannelAccessRequestRecord): MockPrismaChannelAccessRequest {
  return {
    id: record.id,
    workspaceId: record.workspaceId,
    channelName: record.channelName,
    userId: record.userId,
    status: record.status,
    requestedAt: new Date(record.requestedAt),
    resolvedAt: record.resolvedAt ? new Date(record.resolvedAt) : null,
    resolvedBy: record.resolvedBy ?? null,
    note: record.note ?? null,
  };
}

test("listChannelAccessRequestsPrismaCutover returns sync result when flag is disabled", async () => {
  resetFlags();
  const metrics: ListChannelAccessRequestsPrismaCutoverMetric[] = [];
  const result = await listChannelAccessRequestsPrismaCutover(
    { workspaceId: "default" },
    (metric) => metrics.push(metric),
  );
  assert.ok(Array.isArray(result));
  assert.equal(metrics.length, 0);
});

test("listChannelAccessRequestsPrismaCutover uses Prisma primary when flag is on", async () => {
  resetFlags();
  process.env.CHANNEL_ACCESS_REQUESTS_PRISMA_READ_ENABLED = "1";
  delete process.env.CHANNEL_ACCESS_REQUESTS_PRISMA_SHADOW_READ_ENABLED;

  const mockedRow: StoredChannelAccessRequestRecord = {
    id: "car-prisma-mock",
    workspaceId: "default",
    channelName: "general",
    userId: "user-mock",
    status: "pending",
    requestedAt: new Date().toISOString(),
  };
  setDofePrismaClientForTests(
    makeMockPrisma(async () => [toPrismaRow(mockedRow)]) as unknown as Parameters<typeof setDofePrismaClientForTests>[0],
  );
  const metrics: ListChannelAccessRequestsPrismaCutoverMetric[] = [];
  const result = await listChannelAccessRequestsPrismaCutover(
    { workspaceId: "default" },
    (metric) => metrics.push(metric),
  );
  assert.equal(result.length, 1);
  assert.equal(result[0]!.id, "car-prisma-mock");
  assert.equal(metrics.length, 1);
  assert.equal(metrics[0]!.source, "primary");
});

test("listChannelAccessRequestsPrismaCutover falls back to sync when Prisma primary throws", async () => {
  resetFlags();
  process.env.CHANNEL_ACCESS_REQUESTS_PRISMA_READ_ENABLED = "1";
  delete process.env.CHANNEL_ACCESS_REQUESTS_PRISMA_SHADOW_READ_ENABLED;

  setDofePrismaClientForTests(
    makeMockPrisma(async () => {
      throw new Error("prisma channel access requests unreachable");
    }) as unknown as Parameters<typeof setDofePrismaClientForTests>[0],
  );
  const metrics: ListChannelAccessRequestsPrismaCutoverMetric[] = [];
  const result = await listChannelAccessRequestsPrismaCutover(
    { workspaceId: "default" },
    (metric) => metrics.push(metric),
  );
  assert.ok(Array.isArray(result));
  assert.equal(metrics.length, 1);
  assert.equal(metrics[0]!.source, "fallback");
  assert.equal(metrics[0]!.error, "present");
});
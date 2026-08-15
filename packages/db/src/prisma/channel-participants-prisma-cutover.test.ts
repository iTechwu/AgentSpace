// Unit tests for the channel-participant Prisma Client cutover runner
// (Phase 2 15 域).

import assert from "node:assert/strict";
import test from "node:test";
import type { StoredChannelParticipantRecord } from "../types.ts";
import {
  setDofePrismaClientForTests,
  disconnectDofePrismaClient,
} from "./prisma-client.ts";
import {
  listChannelParticipantsPrismaCutover,
  type ListChannelParticipantsPrismaCutoverMetric,
} from "./channel-participants-prisma-cutover.ts";

const ORIGINAL_ASYNC = process.env.CHANNEL_PARTICIPANTS_PRISMA_READ_ENABLED;
const ORIGINAL_SHADOW = process.env.CHANNEL_PARTICIPANTS_PRISMA_SHADOW_READ_ENABLED;

function resetFlags(): void {
  delete process.env.CHANNEL_PARTICIPANTS_PRISMA_READ_ENABLED;
  delete process.env.CHANNEL_PARTICIPANTS_PRISMA_SHADOW_READ_ENABLED;
}

test.before(() => {
  resetFlags();
});

test.after(async () => {
  setDofePrismaClientForTests(null);
  await disconnectDofePrismaClient();
  if (ORIGINAL_ASYNC === undefined) delete process.env.CHANNEL_PARTICIPANTS_PRISMA_READ_ENABLED;
  else process.env.CHANNEL_PARTICIPANTS_PRISMA_READ_ENABLED = ORIGINAL_ASYNC;
  if (ORIGINAL_SHADOW === undefined) delete process.env.CHANNEL_PARTICIPANTS_PRISMA_SHADOW_READ_ENABLED;
  else process.env.CHANNEL_PARTICIPANTS_PRISMA_SHADOW_READ_ENABLED = ORIGINAL_SHADOW;
});

interface MockPrismaChannelParticipant {
  id: string;
  workspaceId: string;
  channelName: string;
  userId: string;
  status: string;
  addedBy: string | null;
  joinedAt: Date;
  removedAt: Date | null;
  updatedAt: Date;
}

interface MockPrismaClient {
  channelParticipant: {
    findMany: (args: unknown) => Promise<MockPrismaChannelParticipant[]>;
  };
}

function makeMockPrisma(
  behavior: (args: unknown) => Promise<MockPrismaChannelParticipant[]>,
): MockPrismaClient {
  return { channelParticipant: { findMany: behavior } };
}

function toPrismaRow(record: StoredChannelParticipantRecord): MockPrismaChannelParticipant {
  return {
    id: record.id,
    workspaceId: record.workspaceId,
    channelName: record.channelName,
    userId: record.userId,
    status: record.status,
    addedBy: record.addedBy ?? null,
    joinedAt: new Date(record.joinedAt),
    removedAt: record.removedAt ? new Date(record.removedAt) : null,
    updatedAt: new Date(record.updatedAt),
  };
}

test("listChannelParticipantsPrismaCutover returns sync result when flag is disabled", async () => {
  resetFlags();
  const metrics: ListChannelParticipantsPrismaCutoverMetric[] = [];
  const result = await listChannelParticipantsPrismaCutover(
    { workspaceId: "default", channelName: "general" },
    (metric) => metrics.push(metric),
  );
  assert.ok(Array.isArray(result));
  assert.equal(metrics.length, 0);
});

test("listChannelParticipantsPrismaCutover uses Prisma primary when flag is on", async () => {
  resetFlags();
  process.env.CHANNEL_PARTICIPANTS_PRISMA_READ_ENABLED = "1";
  delete process.env.CHANNEL_PARTICIPANTS_PRISMA_SHADOW_READ_ENABLED;

  const mockedRow: StoredChannelParticipantRecord = {
    id: "cp-prisma-mock",
    workspaceId: "default",
    channelName: "general",
    userId: "user-mock",
    status: "active",
    joinedAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
  setDofePrismaClientForTests(
    makeMockPrisma(async () => [toPrismaRow(mockedRow)]) as unknown as Parameters<typeof setDofePrismaClientForTests>[0],
  );
  const metrics: ListChannelParticipantsPrismaCutoverMetric[] = [];
  const result = await listChannelParticipantsPrismaCutover(
    { workspaceId: "default", channelName: "general" },
    (metric) => metrics.push(metric),
  );
  assert.equal(result.length, 1);
  assert.equal(result[0]!.id, "cp-prisma-mock");
  assert.equal(metrics.length, 1);
  assert.equal(metrics[0]!.source, "primary");
});

test("listChannelParticipantsPrismaCutover falls back to sync when Prisma primary throws", async () => {
  resetFlags();
  process.env.CHANNEL_PARTICIPANTS_PRISMA_READ_ENABLED = "1";
  delete process.env.CHANNEL_PARTICIPANTS_PRISMA_SHADOW_READ_ENABLED;

  setDofePrismaClientForTests(
    makeMockPrisma(async () => {
      throw new Error("prisma channel participants unreachable");
    }) as unknown as Parameters<typeof setDofePrismaClientForTests>[0],
  );
  const metrics: ListChannelParticipantsPrismaCutoverMetric[] = [];
  const result = await listChannelParticipantsPrismaCutover(
    { workspaceId: "default", channelName: "general" },
    (metric) => metrics.push(metric),
  );
  assert.ok(Array.isArray(result));
  assert.equal(metrics.length, 1);
  assert.equal(metrics[0]!.source, "fallback");
  assert.equal(metrics[0]!.error, "present");
});
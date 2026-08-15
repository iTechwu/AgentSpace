// Unit tests for the channel-invitation Prisma Client cutover runner
// (Phase 2 17 域).

import assert from "node:assert/strict";
import test from "node:test";
import type { StoredChannelInvitationRecord } from "../types.ts";
import {
  setDofePrismaClientForTests,
  disconnectDofePrismaClient,
} from "./prisma-client.ts";
import {
  listChannelInvitationsPrismaCutover,
  type ListChannelInvitationsPrismaCutoverMetric,
} from "./channel-invitations-prisma-cutover.ts";

const ORIGINAL_ASYNC = process.env.CHANNEL_INVITATIONS_PRISMA_READ_ENABLED;
const ORIGINAL_SHADOW = process.env.CHANNEL_INVITATIONS_PRISMA_SHADOW_READ_ENABLED;

function resetFlags(): void {
  delete process.env.CHANNEL_INVITATIONS_PRISMA_READ_ENABLED;
  delete process.env.CHANNEL_INVITATIONS_PRISMA_SHADOW_READ_ENABLED;
}

test.before(() => {
  resetFlags();
});

test.after(async () => {
  setDofePrismaClientForTests(null);
  await disconnectDofePrismaClient();
  if (ORIGINAL_ASYNC === undefined) delete process.env.CHANNEL_INVITATIONS_PRISMA_READ_ENABLED;
  else process.env.CHANNEL_INVITATIONS_PRISMA_READ_ENABLED = ORIGINAL_ASYNC;
  if (ORIGINAL_SHADOW === undefined) delete process.env.CHANNEL_INVITATIONS_PRISMA_SHADOW_READ_ENABLED;
  else process.env.CHANNEL_INVITATIONS_PRISMA_SHADOW_READ_ENABLED = ORIGINAL_SHADOW;
});

interface MockPrismaChannelInvitation {
  id: string;
  workspaceId: string;
  channelName: string;
  inviteeUserId: string | null;
  inviteeEmail: string | null;
  invitedBy: string;
  status: string;
  createdAt: Date;
  expiresAt: Date | null;
  respondedAt: Date | null;
  respondedBy: string | null;
}

interface MockPrismaClient {
  channelInvitation: {
    findMany: (args: unknown) => Promise<MockPrismaChannelInvitation[]>;
  };
}

function makeMockPrisma(
  behavior: (args: unknown) => Promise<MockPrismaChannelInvitation[]>,
): MockPrismaClient {
  return { channelInvitation: { findMany: behavior } };
}

function toPrismaRow(record: StoredChannelInvitationRecord): MockPrismaChannelInvitation {
  return {
    id: record.id,
    workspaceId: record.workspaceId,
    channelName: record.channelName,
    inviteeUserId: record.inviteeUserId ?? null,
    inviteeEmail: record.inviteeEmail ?? null,
    invitedBy: record.invitedBy,
    status: record.status,
    createdAt: new Date(record.createdAt),
    expiresAt: record.expiresAt ? new Date(record.expiresAt) : null,
    respondedAt: record.respondedAt ? new Date(record.respondedAt) : null,
    respondedBy: record.respondedBy ?? null,
  };
}

test("listChannelInvitationsPrismaCutover returns sync result when flag is disabled", async () => {
  resetFlags();
  const metrics: ListChannelInvitationsPrismaCutoverMetric[] = [];
  const result = await listChannelInvitationsPrismaCutover(
    { workspaceId: "default" },
    (metric) => metrics.push(metric),
  );
  assert.ok(Array.isArray(result));
  assert.equal(metrics.length, 0);
});

test("listChannelInvitationsPrismaCutover uses Prisma primary when flag is on", async () => {
  resetFlags();
  process.env.CHANNEL_INVITATIONS_PRISMA_READ_ENABLED = "1";
  delete process.env.CHANNEL_INVITATIONS_PRISMA_SHADOW_READ_ENABLED;

  const mockedRow: StoredChannelInvitationRecord = {
    id: "ci-prisma-mock",
    workspaceId: "default",
    channelName: "general",
    invitedBy: "user-mock",
    status: "pending",
    createdAt: new Date().toISOString(),
  };
  setDofePrismaClientForTests(
    makeMockPrisma(async () => [toPrismaRow(mockedRow)]) as unknown as Parameters<typeof setDofePrismaClientForTests>[0],
  );
  const metrics: ListChannelInvitationsPrismaCutoverMetric[] = [];
  const result = await listChannelInvitationsPrismaCutover(
    { workspaceId: "default" },
    (metric) => metrics.push(metric),
  );
  assert.equal(result.length, 1);
  assert.equal(result[0]!.id, "ci-prisma-mock");
  assert.equal(metrics.length, 1);
  assert.equal(metrics[0]!.source, "primary");
});

test("listChannelInvitationsPrismaCutover falls back to sync when Prisma primary throws", async () => {
  resetFlags();
  process.env.CHANNEL_INVITATIONS_PRISMA_READ_ENABLED = "1";
  delete process.env.CHANNEL_INVITATIONS_PRISMA_SHADOW_READ_ENABLED;

  setDofePrismaClientForTests(
    makeMockPrisma(async () => {
      throw new Error("prisma channel invitations unreachable");
    }) as unknown as Parameters<typeof setDofePrismaClientForTests>[0],
  );
  const metrics: ListChannelInvitationsPrismaCutoverMetric[] = [];
  const result = await listChannelInvitationsPrismaCutover(
    { workspaceId: "default" },
    (metric) => metrics.push(metric),
  );
  assert.ok(Array.isArray(result));
  assert.equal(metrics.length, 1);
  assert.equal(metrics[0]!.source, "fallback");
  assert.equal(metrics[0]!.error, "present");
});
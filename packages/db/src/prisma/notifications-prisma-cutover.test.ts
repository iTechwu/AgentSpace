// Unit tests for the workspace-notifications Prisma Client cutover runner.

import assert from "node:assert/strict";
import test from "node:test";
import {
  createWorkspaceNotificationSync,
} from "../notifications.ts";
import type { WorkspaceNotificationRecord } from "../types.ts";
import {
  setNotificationsPrismaClientForTests,
  disconnectNotificationsPrismaForTests,
} from "./notifications-prisma.ts";
import {
  listWorkspaceNotificationsPrismaCutover,
  type ListNotificationsPrismaCutoverMetric,
} from "./notifications-prisma-cutover.ts";

const ORIGINAL_ASYNC = process.env.NOTIFICATIONS_PRISMA_READ_ENABLED;
const ORIGINAL_SHADOW = process.env.NOTIFICATIONS_PRISMA_SHADOW_READ_ENABLED;

function resetFlags(): void {
  delete process.env.NOTIFICATIONS_PRISMA_READ_ENABLED;
  delete process.env.NOTIFICATIONS_PRISMA_SHADOW_READ_ENABLED;
}

test.before(() => {
  resetFlags();
});

test.after(async () => {
  setNotificationsPrismaClientForTests(null);
  await disconnectNotificationsPrismaForTests();
  if (ORIGINAL_ASYNC === undefined) delete process.env.NOTIFICATIONS_PRISMA_READ_ENABLED;
  else process.env.NOTIFICATIONS_PRISMA_READ_ENABLED = ORIGINAL_ASYNC;
  if (ORIGINAL_SHADOW === undefined) delete process.env.NOTIFICATIONS_PRISMA_SHADOW_READ_ENABLED;
  else process.env.NOTIFICATIONS_PRISMA_SHADOW_READ_ENABLED = ORIGINAL_SHADOW;
});

interface MockPrismaNotification {
  id: string;
  workspaceId: string;
  recipientType: string;
  recipientId: string;
  actorType: string | null;
  actorId: string | null;
  type: string;
  resourceType: string;
  resourceId: string | null;
  channelName: string | null;
  title: string;
  body: string;
  actionHref: string | null;
  severity: string;
  status: string;
  dedupeKey: string | null;
  metadataJson: unknown;
  createdAt: Date;
  readAt: Date | null;
  archivedAt: Date | null;
}

interface MockPrismaClient {
  workspaceNotification: {
    findMany: (args: unknown) => Promise<MockPrismaNotification[]>;
  };
}

function makeMockPrisma(behavior: (args: unknown) => Promise<MockPrismaNotification[]>): MockPrismaClient {
  return { workspaceNotification: { findMany: behavior } };
}

function toPrismaRow(record: WorkspaceNotificationRecord): MockPrismaNotification {
  return {
    id: record.id,
    workspaceId: record.workspaceId,
    recipientType: record.recipientType,
    recipientId: record.recipientId,
    actorType: record.actorType ?? null,
    actorId: record.actorId ?? null,
    type: record.type,
    resourceType: record.resourceType,
    resourceId: record.resourceId ?? null,
    channelName: record.channelName ?? null,
    title: record.title,
    body: record.body,
    actionHref: record.actionHref ?? null,
    severity: record.severity,
    status: record.status,
    dedupeKey: record.dedupeKey ?? null,
    metadataJson: record.metadataJson,
    createdAt: new Date(record.createdAt),
    readAt: record.readAt ? new Date(record.readAt) : null,
    archivedAt: record.archivedAt ? new Date(record.archivedAt) : null,
  };
}

function seed(): WorkspaceNotificationRecord {
  return createWorkspaceNotificationSync({
    workspaceId: "default",
    recipientType: "human",
    recipientId: "prisma-cutover-recipient",
    type: "prisma.cutover.seed",
    resourceType: "task",
    title: "prisma cutover seed",
    body: "seeded for prisma cutover test",
    severity: "info",
    metadata: { marker: "fresh" },
  });
}

test("listWorkspaceNotificationsPrismaCutover returns sync result when flag is disabled", async () => {
  resetFlags();
  const s = seed();
  const metrics: ListNotificationsPrismaCutoverMetric[] = [];
  const result = await listWorkspaceNotificationsPrismaCutover(
    {
      workspaceId: "default",
      recipientType: "human",
      recipientId: s.recipientId,
    },
    (metric) => metrics.push(metric),
  );
  assert.ok(result.length >= 1);
  assert.equal(metrics.length, 0);
});

test("listWorkspaceNotificationsPrismaCutover uses Prisma primary when flag is on", async () => {
  resetFlags();
  process.env.NOTIFICATIONS_PRISMA_READ_ENABLED = "1";
  delete process.env.NOTIFICATIONS_PRISMA_SHADOW_READ_ENABLED;

  const s = seed();
  setNotificationsPrismaClientForTests(
    makeMockPrisma(async () => [toPrismaRow(s)]) as unknown as Parameters<typeof setNotificationsPrismaClientForTests>[0],
  );
  const metrics: ListNotificationsPrismaCutoverMetric[] = [];
  const result = await listWorkspaceNotificationsPrismaCutover(
    {
      workspaceId: "default",
      recipientType: "human",
      recipientId: s.recipientId,
    },
    (metric) => metrics.push(metric),
  );
  assert.ok(result.length >= 1);
  assert.equal(metrics.length, 1);
  assert.equal(metrics[0]!.source, "primary");
  assert.equal(metrics[0]!.mismatch, 0);
});

test("listWorkspaceNotificationsPrismaCutover falls back to sync when Prisma primary throws", async () => {
  resetFlags();
  process.env.NOTIFICATIONS_PRISMA_READ_ENABLED = "1";
  delete process.env.NOTIFICATIONS_PRISMA_SHADOW_READ_ENABLED;

  const s = seed();
  setNotificationsPrismaClientForTests(
    makeMockPrisma(async () => {
      throw new Error("prisma notifications unreachable");
    }) as unknown as Parameters<typeof setNotificationsPrismaClientForTests>[0],
  );
  const metrics: ListNotificationsPrismaCutoverMetric[] = [];
  const result = await listWorkspaceNotificationsPrismaCutover(
    {
      workspaceId: "default",
      recipientType: "human",
      recipientId: s.recipientId,
    },
    (metric) => metrics.push(metric),
  );
  assert.ok(result.length >= 1);
  assert.equal(metrics.length, 1);
  assert.equal(metrics[0]!.source, "fallback");
  assert.ok(metrics[0]!.error?.includes("prisma notifications unreachable"));
});
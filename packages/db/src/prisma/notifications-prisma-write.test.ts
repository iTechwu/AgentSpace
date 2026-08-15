// Unit tests for the notifications Prisma write cutover runner.
//
// Validates the buildDomainWriteCutover semantics（与 audit-log 写路径同款）:
// primary success returns primary result; an ambiguous primary failure is
// surfaced without a second non-idempotent insert。另覆盖 dedupe
// updateMany→create→读回语义。

import assert from "node:assert/strict";
import test from "node:test";
import { listWorkspaceNotificationsForRecipientSync } from "../notifications.ts";
import {
  setNotificationsPrismaClientForTests,
  disconnectNotificationsPrismaForTests,
} from "./notifications-prisma.ts";
import {
  createWorkspaceNotificationPrisma,
  createWorkspaceNotificationPrismaCutover,
  type CreateWorkspaceNotificationPrismaCutoverMetric,
} from "./notifications-prisma-write.ts";

const ORIGINAL_WRITE_FLAG = process.env.NOTIFICATIONS_PRISMA_WRITE_ENABLED;

function resetFlags(): void {
  delete process.env.NOTIFICATIONS_PRISMA_WRITE_ENABLED;
}

test.before(() => {
  resetFlags();
});

test.after(async () => {
  setNotificationsPrismaClientForTests(null);
  await disconnectNotificationsPrismaForTests();
  if (ORIGINAL_WRITE_FLAG === undefined) delete process.env.NOTIFICATIONS_PRISMA_WRITE_ENABLED;
  else process.env.NOTIFICATIONS_PRISMA_WRITE_ENABLED = ORIGINAL_WRITE_FLAG;
});

interface MockNotificationRow {
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
    create: (args: { data: Record<string, unknown> }) => Promise<MockNotificationRow>;
    updateMany: (args: {
      where: Record<string, unknown>;
      data: Record<string, unknown>;
    }) => Promise<{ count: number }>;
    findFirst: (args: Record<string, unknown>) => Promise<MockNotificationRow | null>;
  };
}

interface MockBehavior {
  create?: (args: { data: Record<string, unknown> }) => Promise<MockNotificationRow>;
  updateMany?: (args: {
    where: Record<string, unknown>;
    data: Record<string, unknown>;
  }) => Promise<{ count: number }>;
  findFirst?: (args: Record<string, unknown>) => Promise<MockNotificationRow | null>;
}

function makeMockPrisma(behavior: MockBehavior): MockPrismaClient {
  return {
    workspaceNotification: {
      create: behavior.create ?? (async () => {
        throw new Error("unexpected create call");
      }),
      updateMany: behavior.updateMany ?? (async () => ({ count: 0 })),
      findFirst: behavior.findFirst ?? (async () => null),
    },
  };
}

const BASE_INPUT = {
  workspaceId: "default",
  recipientType: "human" as const,
  recipientId: "user-mock",
  type: "task.completed",
  resourceType: "task" as const,
  title: "write cutover",
  body: "prisma write path",
  severity: "info" as const,
};

function makeRow(overrides: Partial<MockNotificationRow> = {}): MockNotificationRow {
  return {
    id: "notification-mock",
    workspaceId: "default",
    recipientType: "human",
    recipientId: "user-mock",
    actorType: null,
    actorId: null,
    type: "task.completed",
    resourceType: "task",
    resourceId: null,
    channelName: null,
    title: "write cutover",
    body: "prisma write path",
    actionHref: null,
    severity: "info",
    status: "unread",
    dedupeKey: null,
    metadataJson: { ok: true },
    createdAt: new Date(),
    readAt: null,
    archivedAt: null,
    ...overrides,
  };
}

test("createWorkspaceNotificationPrismaCutover uses sync fallback when flag is disabled", async () => {
  resetFlags();
  const metrics: CreateWorkspaceNotificationPrismaCutoverMetric[] = [];
  const dedupeKey = `write-flag-off-${Date.now()}`;
  const record = await createWorkspaceNotificationPrismaCutover(
    { ...BASE_INPUT, dedupeKey },
    (metric) => metrics.push(metric),
  );
  assert.equal(record.title, "write cutover");
  // Verify the row landed in the DB via the sync path (independent read).
  const fromDb = listWorkspaceNotificationsForRecipientSync({
    workspaceId: "default",
    recipientType: "human",
    recipientId: "user-mock",
  }).find((r) => r.id === record.id);
  assert.ok(fromDb);
  assert.equal(fromDb!.dedupeKey, dedupeKey);
  assert.equal(metrics.length, 0);
});

test("createWorkspaceNotificationPrismaCutover uses Prisma primary when flag is on", async () => {
  resetFlags();
  process.env.NOTIFICATIONS_PRISMA_WRITE_ENABLED = "1";

  const row = makeRow({ id: "notification-prisma-mock", dedupeKey: "dk-mock" });
  const calls: string[] = [];
  setNotificationsPrismaClientForTests(
    makeMockPrisma({
      updateMany: async () => {
        calls.push("updateMany");
        return { count: 0 };
      },
      create: async (args) => {
        calls.push("create");
        return makeRow({
          id: args.data.id as string,
          dedupeKey: (args.data.dedupeKey as string | null) ?? null,
        });
      },
      findFirst: async () => {
        calls.push("findFirst");
        return row;
      },
    }) as unknown as Parameters<typeof setNotificationsPrismaClientForTests>[0],
  );
  const metrics: CreateWorkspaceNotificationPrismaCutoverMetric[] = [];
  const record = await createWorkspaceNotificationPrismaCutover(
    { ...BASE_INPUT, dedupeKey: "dk-mock" },
    (metric) => metrics.push(metric),
  );
  assert.equal(record.id, "notification-prisma-mock");
  assert.deepEqual(calls, ["updateMany", "create", "findFirst"]);
  assert.equal(metrics.length, 1);
  assert.equal(metrics[0]!.source, "primary");
  assert.equal(metrics[0]!.fallbackInvoked, 0);
  // Prisma write did not touch the actual DB; the sync list read cannot see it.
  const fromDb = listWorkspaceNotificationsForRecipientSync({
    workspaceId: "default",
    recipientType: "human",
    recipientId: "user-mock",
  }).find((r) => r.id === record.id);
  assert.equal(fromDb, undefined);
});

test("createWorkspaceNotificationPrisma reuses the existing row when dedupe update hits", async () => {
  const updated: Array<{ where: Record<string, unknown>; data: Record<string, unknown> }> = [];
  let created = false;
  setNotificationsPrismaClientForTests(
    makeMockPrisma({
      updateMany: async (args) => {
        updated.push(args);
        return { count: 1 };
      },
      create: async () => {
        created = true;
        throw new Error("must not create when updateMany hit");
      },
      findFirst: async () => makeRow({ id: "notification-existing", dedupeKey: "dk-hit" }),
    }) as unknown as Parameters<typeof setNotificationsPrismaClientForTests>[0],
  );
  const record = await createWorkspaceNotificationPrisma({
    ...BASE_INPUT,
    dedupeKey: "dk-hit",
    title: "dedupe overwrite",
  });
  assert.equal(record.id, "notification-existing");
  assert.equal(created, false);
  assert.equal(updated.length, 1);
  assert.equal(updated[0]!.where.dedupeKey, "dk-hit");
  // DO UPDATE 列集不含 id/created_at/status/read_at/archived_at。
  assert.equal("id" in updated[0]!.data, false);
  assert.equal("status" in updated[0]!.data, false);
  assert.equal(updated[0]!.data.title, "dedupe overwrite");
});

test("createWorkspaceNotificationPrisma reads back after a concurrent unique violation", async () => {
  let createCalls = 0;
  setNotificationsPrismaClientForTests(
    makeMockPrisma({
      updateMany: async () => ({ count: 0 }),
      create: async () => {
        createCalls += 1;
        throw Object.assign(new Error("Unique constraint failed on the fields: (`workspace_id`,`dedupe_key`)"), {
          code: "P2002",
        });
      },
      findFirst: async () => makeRow({ id: "notification-race-winner", dedupeKey: "dk-race" }),
    }) as unknown as Parameters<typeof setNotificationsPrismaClientForTests>[0],
  );
  const record = await createWorkspaceNotificationPrisma({
    ...BASE_INPUT,
    dedupeKey: "dk-race",
  });
  assert.equal(record.id, "notification-race-winner");
  assert.equal(createCalls, 1);
});

test("createWorkspaceNotificationPrismaCutover does not duplicate a write when Prisma primary throws", async () => {
  resetFlags();
  process.env.NOTIFICATIONS_PRISMA_WRITE_ENABLED = "1";

  setNotificationsPrismaClientForTests(
    makeMockPrisma({
      updateMany: async () => {
        throw new Error("prisma notification write unreachable");
      },
    }) as unknown as Parameters<typeof setNotificationsPrismaClientForTests>[0],
  );
  const metrics: CreateWorkspaceNotificationPrismaCutoverMetric[] = [];
  await assert.rejects(
    createWorkspaceNotificationPrismaCutover(
      { ...BASE_INPUT, dedupeKey: "dk-fail" },
      (metric) => metrics.push(metric),
    ),
    /prisma notification write unreachable/,
  );
  assert.equal(metrics.length, 1);
  assert.equal(metrics[0]!.source, "primary");
  assert.equal(metrics[0]!.fallbackInvoked, 0);
  assert.equal(metrics[0]!.error, "present");
});

test("createWorkspaceNotificationPrisma rejects invalid enum inputs like sync", async () => {
  await assert.rejects(
    createWorkspaceNotificationPrisma({
      ...BASE_INPUT,
      recipientType: "bot" as "human",
    }),
    /Invalid notification recipient type/,
  );
  await assert.rejects(
    createWorkspaceNotificationPrisma({
      ...BASE_INPUT,
      severity: "fatal" as "info",
    }),
    /Invalid notification severity/,
  );
  await assert.rejects(
    createWorkspaceNotificationPrisma({
      ...BASE_INPUT,
      resourceType: "message" as "task",
    }),
    /Invalid notification resource type/,
  );
});

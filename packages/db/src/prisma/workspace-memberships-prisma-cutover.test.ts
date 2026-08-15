// Unit tests for the workspace-memberships Prisma Client cutover runner.

import assert from "node:assert/strict";
import test from "node:test";
import type { StoredWorkspaceMembershipRecord } from "../types.ts";
import {
  setWorkspaceMembershipsPrismaClientForTests,
  disconnectWorkspaceMembershipsPrismaForTests,
} from "./workspace-memberships-prisma.ts";
import {
  listWorkspaceMembershipsPrismaCutover,
  type ListWorkspaceMembershipsPrismaCutoverMetric,
} from "./workspace-memberships-prisma-cutover.ts";

const ORIGINAL_ASYNC = process.env.WORKSPACE_MEMBERSHIPS_PRISMA_READ_ENABLED;
const ORIGINAL_SHADOW = process.env.WORKSPACE_MEMBERSHIPS_PRISMA_SHADOW_READ_ENABLED;

function resetFlags(): void {
  delete process.env.WORKSPACE_MEMBERSHIPS_PRISMA_READ_ENABLED;
  delete process.env.WORKSPACE_MEMBERSHIPS_PRISMA_SHADOW_READ_ENABLED;
}

test.before(() => {
  resetFlags();
});

test.after(async () => {
  setWorkspaceMembershipsPrismaClientForTests(null);
  await disconnectWorkspaceMembershipsPrismaForTests();
  if (ORIGINAL_ASYNC === undefined) delete process.env.WORKSPACE_MEMBERSHIPS_PRISMA_READ_ENABLED;
  else process.env.WORKSPACE_MEMBERSHIPS_PRISMA_READ_ENABLED = ORIGINAL_ASYNC;
  if (ORIGINAL_SHADOW === undefined) delete process.env.WORKSPACE_MEMBERSHIPS_PRISMA_SHADOW_READ_ENABLED;
  else process.env.WORKSPACE_MEMBERSHIPS_PRISMA_SHADOW_READ_ENABLED = ORIGINAL_SHADOW;
});

interface MockPrismaMembership {
  id: string;
  workspaceId: string;
  userId: string;
  role: string;
  status: string;
  joinedAt: Date;
  invitedBy: string | null;
}

interface MockPrismaClient {
  workspaceMembership: {
    findMany: (args: unknown) => Promise<MockPrismaMembership[]>;
  };
}

function makeMockPrisma(behavior: (args: unknown) => Promise<MockPrismaMembership[]>): MockPrismaClient {
  return { workspaceMembership: { findMany: behavior } };
}

function toPrismaRow(record: StoredWorkspaceMembershipRecord): MockPrismaMembership {
  return {
    id: record.id,
    workspaceId: record.workspaceId,
    userId: record.userId,
    role: record.role,
    status: record.status,
    joinedAt: new Date(record.joinedAt),
    invitedBy: record.invitedBy ?? null,
  };
}

test("listWorkspaceMembershipsPrismaCutover returns sync result when flag is disabled", async () => {
  resetFlags();
  const metrics: ListWorkspaceMembershipsPrismaCutoverMetric[] = [];
  const result = await listWorkspaceMembershipsPrismaCutover(
    "default",
    (metric) => metrics.push(metric),
  );
  assert.ok(Array.isArray(result));
  assert.equal(metrics.length, 0);
});

test("listWorkspaceMembershipsPrismaCutover uses Prisma primary when flag is on", async () => {
  resetFlags();
  process.env.WORKSPACE_MEMBERSHIPS_PRISMA_READ_ENABLED = "1";
  delete process.env.WORKSPACE_MEMBERSHIPS_PRISMA_SHADOW_READ_ENABLED;

  const mockedRow: StoredWorkspaceMembershipRecord = {
    id: "membership-prisma-mock",
    workspaceId: "default",
    userId: "prisma-user",
    role: "member",
    status: "active",
    joinedAt: new Date().toISOString(),
  };
  setWorkspaceMembershipsPrismaClientForTests(
    makeMockPrisma(async () => [toPrismaRow(mockedRow)]) as unknown as Parameters<typeof setWorkspaceMembershipsPrismaClientForTests>[0],
  );
  const metrics: ListWorkspaceMembershipsPrismaCutoverMetric[] = [];
  const result = await listWorkspaceMembershipsPrismaCutover(
    "default",
    (metric) => metrics.push(metric),
  );
  assert.equal(result.length, 1);
  assert.equal(result[0]!.id, "membership-prisma-mock");
  assert.equal(metrics.length, 1);
  assert.equal(metrics[0]!.source, "primary");
});

test("listWorkspaceMembershipsPrismaCutover falls back to sync when Prisma primary throws", async () => {
  resetFlags();
  process.env.WORKSPACE_MEMBERSHIPS_PRISMA_READ_ENABLED = "1";
  delete process.env.WORKSPACE_MEMBERSHIPS_PRISMA_SHADOW_READ_ENABLED;

  setWorkspaceMembershipsPrismaClientForTests(
    makeMockPrisma(async () => {
      throw new Error("prisma memberships unreachable");
    }) as unknown as Parameters<typeof setWorkspaceMembershipsPrismaClientForTests>[0],
  );
  const metrics: ListWorkspaceMembershipsPrismaCutoverMetric[] = [];
  const result = await listWorkspaceMembershipsPrismaCutover(
    "default",
    (metric) => metrics.push(metric),
  );
  assert.ok(Array.isArray(result));
  assert.equal(metrics.length, 1);
  assert.equal(metrics[0]!.source, "fallback");
  assert.ok(metrics[0]!.error?.includes("prisma memberships unreachable"));
});

test("listWorkspaceMembershipsPrismaCutover compares the Prisma result when shadow is enabled", async () => {
  resetFlags();
  process.env.WORKSPACE_MEMBERSHIPS_PRISMA_READ_ENABLED = "1";
  process.env.WORKSPACE_MEMBERSHIPS_PRISMA_SHADOW_READ_ENABLED = "1";
  const row = toPrismaRow({
    id: "membership-prisma-shadow",
    workspaceId: "default",
    userId: "prisma-shadow-user",
    role: "member",
    status: "active",
    joinedAt: new Date().toISOString(),
  });
  setWorkspaceMembershipsPrismaClientForTests(
    makeMockPrisma(async () => [row]) as unknown as Parameters<typeof setWorkspaceMembershipsPrismaClientForTests>[0],
  );
  const metrics: ListWorkspaceMembershipsPrismaCutoverMetric[] = [];

  const result = await listWorkspaceMembershipsPrismaCutover(
    "default",
    (metric) => metrics.push(metric),
  );

  assert.equal(result[0]?.id, row.id);
  assert.equal(metrics[0]?.source, "primary");
  assert.equal(metrics[0]?.mismatch, 1);
});

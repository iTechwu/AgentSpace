// Unit tests for the audit-log Prisma Client cutover runner.
//
// Uses a mocked PrismaClient injected via setAuditLogPrismaClientForTests so
// the tests are independent of any real PG instance and exercise the cutover
// runner's flag / shadow / primary-failure branches deterministically.

import assert from "node:assert/strict";
import test from "node:test";
import {
  recordAuditLogSync,
} from "../audit-log.ts";
import type { AuditLogRecord } from "../types.ts";
import {
  setAuditLogPrismaClientForTests,
  disconnectAuditLogPrismaForTests,
} from "./audit-log-prisma.ts";
import {
  readAuditLogPrismaCutover,
  type ReadAuditLogPrismaCutoverMetric,
} from "./audit-log-prisma-cutover.ts";

interface MockPrismaAuditLog {
  id: string;
  workspaceId: string;
  title: string;
  note: string;
  code: string | null;
  dataJson: unknown;
  source: string;
  sourceIndex: number;
  createdAt: Date;
}

interface MockPrismaClient {
  auditLog: {
    findFirst: (args: unknown) => Promise<MockPrismaAuditLog | null>;
  };
}

function makeMockPrisma(behavior: (args: unknown) => Promise<MockPrismaAuditLog | null>): MockPrismaClient {
  return {
    auditLog: { findFirst: behavior },
  };
}

function toPrismaRow(record: AuditLogRecord): MockPrismaAuditLog {
  return {
    id: record.id,
    workspaceId: record.workspaceId,
    title: record.title,
    note: record.note,
    code: record.code ?? null,
    dataJson: record.dataJson,
    source: record.source,
    sourceIndex: record.sourceIndex,
    createdAt: new Date(record.createdAt),
  };
}

const ORIGINAL_ASYNC = process.env.AUDIT_LOG_PRISMA_READ_ENABLED;
const ORIGINAL_SHADOW = process.env.AUDIT_LOG_PRISMA_SHADOW_READ_ENABLED;

function resetFlags(): void {
  delete process.env.AUDIT_LOG_PRISMA_READ_ENABLED;
  delete process.env.AUDIT_LOG_PRISMA_SHADOW_READ_ENABLED;
}

test.before(() => {
  resetFlags();
});

test.after(async () => {
  setAuditLogPrismaClientForTests(null);
  await disconnectAuditLogPrismaForTests();
  if (ORIGINAL_ASYNC === undefined) delete process.env.AUDIT_LOG_PRISMA_READ_ENABLED;
  else process.env.AUDIT_LOG_PRISMA_READ_ENABLED = ORIGINAL_ASYNC;
  if (ORIGINAL_SHADOW === undefined) delete process.env.AUDIT_LOG_PRISMA_SHADOW_READ_ENABLED;
  else process.env.AUDIT_LOG_PRISMA_SHADOW_READ_ENABLED = ORIGINAL_SHADOW;
});

function seedAuditLog(): AuditLogRecord {
  return recordAuditLogSync({
    workspaceId: "default",
    title: "prisma cutover seed",
    note: "seeded for prisma cutover test",
    code: "prisma.cutover.seed",
    source: "runtime_lifecycle",
    data: { marker: "fresh" },
  });
}

test("readAuditLogPrismaCutover returns sync result when flag is disabled", async () => {
  resetFlags();
  const seeded = seedAuditLog();
  const metrics: ReadAuditLogPrismaCutoverMetric[] = [];
  const result = await readAuditLogPrismaCutover(
    { id: seeded.id, workspaceId: seeded.workspaceId },
    (metric) => metrics.push(metric),
  );
  assert.ok(result);
  assert.equal(result!.id, seeded.id);
  assert.equal(metrics.length, 0);
});

test("readAuditLogPrismaCutover uses Prisma primary when flag is on", async () => {
  resetFlags();
  process.env.AUDIT_LOG_PRISMA_READ_ENABLED = "1";
  delete process.env.AUDIT_LOG_PRISMA_SHADOW_READ_ENABLED;

  const seeded = seedAuditLog();
  setAuditLogPrismaClientForTests(
    makeMockPrisma(async () => toPrismaRow(seeded)) as unknown as Parameters<typeof setAuditLogPrismaClientForTests>[0],
  );
  const metrics: ReadAuditLogPrismaCutoverMetric[] = [];
  const result = await readAuditLogPrismaCutover(
    { id: seeded.id, workspaceId: seeded.workspaceId },
    (metric) => metrics.push(metric),
  );
  assert.ok(result);
  assert.equal(result!.id, seeded.id);
  assert.equal(metrics.length, 1);
  assert.equal(metrics[0]!.source, "primary");
  assert.equal(metrics[0]!.mismatch, 0);
});

test("readAuditLogPrismaCutover falls back to sync when Prisma primary throws", async () => {
  resetFlags();
  process.env.AUDIT_LOG_PRISMA_READ_ENABLED = "1";
  delete process.env.AUDIT_LOG_PRISMA_SHADOW_READ_ENABLED;

  const seeded = seedAuditLog();
  setAuditLogPrismaClientForTests(
    makeMockPrisma(async () => {
      throw new Error("prisma unreachable");
    }) as unknown as Parameters<typeof setAuditLogPrismaClientForTests>[0],
  );
  const metrics: ReadAuditLogPrismaCutoverMetric[] = [];
  const result = await readAuditLogPrismaCutover(
    { id: seeded.id, workspaceId: seeded.workspaceId },
    (metric) => metrics.push(metric),
  );
  assert.ok(result);
  assert.equal(result!.id, seeded.id);
  assert.equal(metrics.length, 1);
  assert.equal(metrics[0]!.source, "fallback");
  assert.equal(metrics[0]!.mismatch, 0);
  assert.ok(metrics[0]!.error?.includes("prisma unreachable"));
});

test("readAuditLogPrismaCutover detects mismatch under shadow flag", async () => {
  resetFlags();
  process.env.AUDIT_LOG_PRISMA_READ_ENABLED = "1";
  process.env.AUDIT_LOG_PRISMA_SHADOW_READ_ENABLED = "1";

  const seeded = seedAuditLog();
  // Primary returns a record with a different title to force mismatch.
  const drifted = { ...seeded, title: "drifted title" };
  setAuditLogPrismaClientForTests(
    makeMockPrisma(async () => toPrismaRow(drifted)) as unknown as Parameters<typeof setAuditLogPrismaClientForTests>[0],
  );
  const metrics: ReadAuditLogPrismaCutoverMetric[] = [];
  const result = await readAuditLogPrismaCutover(
    { id: seeded.id, workspaceId: seeded.workspaceId },
    (metric) => metrics.push(metric),
  );
  // The runner returns the primary result; the mismatch metric is observed.
  assert.ok(result);
  assert.equal(result!.title, "drifted title");
  assert.ok(metrics.some((m) => m.mismatch === 1));
});
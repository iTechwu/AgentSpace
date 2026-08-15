// Unit tests for the audit-log Prisma write cutover runner.
//
// Validates the buildDomainWriteCutover semantics: primary success returns
// primary result; an ambiguous primary failure is surfaced without a second
// non-idempotent insert.

import assert from "node:assert/strict";
import test from "node:test";
import { readAuditLogSync } from "../audit-log.ts";
import {
  createAuditLogPrisma,
  createAuditLogPrismaCutover,
  type CreateAuditLogPrismaCutoverMetric,
} from "./audit-log-prisma-write.ts";

const ORIGINAL_WRITE_FLAG = process.env.AUDIT_LOG_PRISMA_WRITE_ENABLED;

function resetFlags(): void {
  delete process.env.AUDIT_LOG_PRISMA_WRITE_ENABLED;
}

test.before(() => {
  resetFlags();
});

test.after(() => {
  if (ORIGINAL_WRITE_FLAG === undefined) delete process.env.AUDIT_LOG_PRISMA_WRITE_ENABLED;
  else process.env.AUDIT_LOG_PRISMA_WRITE_ENABLED = ORIGINAL_WRITE_FLAG;
});

interface MockAuditLogRow {
  id: string;
  workspaceId: string;
  title: string;
  note: string;
  code: string | null;
  source: string;
  sourceIndex: number;
  dataJson: unknown;
  createdAt: Date;
}

interface MockPrismaClient {
  auditLog: {
    upsert: (args: {
      where: { id: string };
      create: Omit<MockAuditLogRow, "createdAt"> & { createdAt: Date };
      update: Record<string, never>;
    }) => Promise<MockAuditLogRow>;
  };
}

function makeMockPrisma(
  behavior: (args: {
    where: { id: string };
    create: Omit<MockAuditLogRow, "createdAt"> & { createdAt: Date };
    update: Record<string, never>;
  }) => Promise<MockAuditLogRow>,
): MockPrismaClient {
  return { auditLog: { upsert: behavior } };
}

test("createAuditLogPrismaCutover uses sync fallback when flag is disabled", async () => {
  resetFlags();
  const metrics: CreateAuditLogPrismaCutoverMetric[] = [];
  const record = await createAuditLogPrismaCutover(
    {
      workspaceId: "default",
      title: "write cutover flag-off",
      note: "should use sync",
      source: "runtime_lifecycle",
      data: { flag: "off" },
    },
    (metric) => metrics.push(metric),
  );
  assert.equal(record.title, "write cutover flag-off");
  // Verify the row landed in the DB via the sync path (independent read).
  const fromDb = readAuditLogSync(record.id, "default");
  assert.ok(fromDb);
  assert.equal(fromDb!.title, record.title);
  assert.equal(metrics.length, 0);
});

test("createAuditLogPrismaCutover uses Prisma primary when flag is on", async () => {
  resetFlags();
  process.env.AUDIT_LOG_PRISMA_WRITE_ENABLED = "1";

  const metrics: CreateAuditLogPrismaCutoverMetric[] = [];
  // Inject the mock by patching the cached client via setter (the read
  // path's setAuditLogPrismaClientForTests is reused by the write module
  // because both share the same Prisma cache).
  const { setAuditLogPrismaClientForTests } = await import("./audit-log-prisma.ts");
  const mock = makeMockPrisma(async (args) => ({
    id: args.create.id,
    workspaceId: args.create.workspaceId,
    title: args.create.title,
    note: args.create.note,
    code: args.create.code,
    source: args.create.source,
    sourceIndex: args.create.sourceIndex,
    dataJson: args.create.dataJson,
    createdAt: args.create.createdAt,
  }));
  setAuditLogPrismaClientForTests(mock as unknown as Parameters<typeof setAuditLogPrismaClientForTests>[0]);
  try {
    const record = await createAuditLogPrismaCutover(
      {
        workspaceId: "default",
        title: "write cutover flag-on",
        note: "should use prisma",
        source: "runtime_lifecycle",
        data: { flag: "on" },
      },
      (metric) => metrics.push(metric),
    );
    assert.equal(record.title, "write cutover flag-on");
    assert.equal(metrics.length, 1);
    assert.equal(metrics[0]!.source, "primary");
    assert.equal(metrics[0]!.fallbackInvoked, 0);
    // Prisma write did not touch the actual DB; the sync read returns null.
    const fromDb = readAuditLogSync(record.id, "default");
    assert.equal(fromDb, null);
  } finally {
    setAuditLogPrismaClientForTests(null);
  }
});

test("createAuditLogPrismaCutover returns a committed primary result when metrics fail", async () => {
  resetFlags();
  process.env.AUDIT_LOG_PRISMA_WRITE_ENABLED = "1";
  let primaryCalls = 0;
  const { setAuditLogPrismaClientForTests } = await import("./audit-log-prisma.ts");
  setAuditLogPrismaClientForTests(
    makeMockPrisma(async (args) => {
      primaryCalls += 1;
      return {
        ...args.create,
        createdAt: args.create.createdAt,
      };
    }) as unknown as Parameters<typeof setAuditLogPrismaClientForTests>[0],
  );
  try {
    const record = await createAuditLogPrismaCutover(
      {
        workspaceId: "default",
        title: "metric failure must not retry",
        note: "primary already committed",
      },
      () => {
        throw new Error("metrics unavailable");
      },
    );

    assert.equal(record.title, "metric failure must not retry");
    assert.equal(primaryCalls, 1);
  } finally {
    setAuditLogPrismaClientForTests(null);
  }
});

test("createAuditLogPrismaCutover does not duplicate a write when Prisma primary throws", async () => {
  resetFlags();
  process.env.AUDIT_LOG_PRISMA_WRITE_ENABLED = "1";

  const { setAuditLogPrismaClientForTests } = await import("./audit-log-prisma.ts");
  setAuditLogPrismaClientForTests(
    makeMockPrisma(async () => {
      throw new Error("prisma write unreachable");
    }) as unknown as Parameters<typeof setAuditLogPrismaClientForTests>[0],
  );
  try {
    const metrics: CreateAuditLogPrismaCutoverMetric[] = [];
    await assert.rejects(
      createAuditLogPrismaCutover({
        workspaceId: "default",
        title: "write cutover fail closed",
        note: "must not fall back to sync",
        source: "runtime_lifecycle",
        data: { path: "fail-closed" },
      }, (metric) => metrics.push(metric)),
      /prisma write unreachable/,
    );
    assert.equal(metrics.length, 1);
    assert.equal(metrics[0]!.source, "primary");
    assert.equal(metrics[0]!.fallbackInvoked, 0);
    assert.ok(metrics[0]!.error?.includes("prisma write unreachable"));
  } finally {
    setAuditLogPrismaClientForTests(null);
  }
});

test("createAuditLogPrismaCutover preserves the primary error when metrics also fail", async () => {
  resetFlags();
  process.env.AUDIT_LOG_PRISMA_WRITE_ENABLED = "1";
  const { setAuditLogPrismaClientForTests } = await import("./audit-log-prisma.ts");
  setAuditLogPrismaClientForTests(
    makeMockPrisma(async () => {
      throw new Error("primary write failed");
    }) as unknown as Parameters<typeof setAuditLogPrismaClientForTests>[0],
  );
  try {
    await assert.rejects(
      createAuditLogPrismaCutover(
        { title: "preserve primary failure", note: "metrics fail too" },
        () => {
          throw new Error("metrics unavailable");
        },
      ),
      /primary write failed/,
    );
  } finally {
    setAuditLogPrismaClientForTests(null);
  }
});

test("createAuditLogPrisma returns a record with the expected shape", async () => {
  // Direct async test against the same mock client: validates create args
  // contract without going through the cutover.
  const { setAuditLogPrismaClientForTests } = await import("./audit-log-prisma.ts");
  setAuditLogPrismaClientForTests(
    makeMockPrisma(async (args) => ({
      id: args.create.id,
      workspaceId: args.create.workspaceId,
      title: args.create.title,
      note: args.create.note,
      code: args.create.code,
      source: args.create.source,
      sourceIndex: args.create.sourceIndex,
      dataJson: args.create.dataJson,
      createdAt: args.create.createdAt,
    })) as unknown as Parameters<typeof setAuditLogPrismaClientForTests>[0],
  );
  try {
    const record = await createAuditLogPrisma({
      workspaceId: "default",
      title: "direct prisma create",
      note: "n/a",
      source: "platform_admin",
      data: { hello: "world" },
    });
    assert.equal(record.title, "direct prisma create");
    assert.equal(record.source, "platform_admin");
    assert.equal(typeof record.id, "string");
    assert.ok(record.id.startsWith("audit-"));
    assert.equal(typeof record.createdAt, "string");
    assert.ok(record.createdAt.includes("T"));
  } finally {
    setAuditLogPrismaClientForTests(null);
  }
});

test("createAuditLogPrisma reuses a stable row for the same idempotency key", async () => {
  let stored: MockAuditLogRow | undefined;
  let upsertCalls = 0;
  const { setAuditLogPrismaClientForTests } = await import("./audit-log-prisma.ts");
  setAuditLogPrismaClientForTests(
    makeMockPrisma(async (args) => {
      upsertCalls += 1;
      stored ??= { ...args.create };
      return stored;
    }) as unknown as Parameters<typeof setAuditLogPrismaClientForTests>[0],
  );
  try {
    const input = {
      workspaceId: "default",
      idempotencyKey: "runtime-provision:request-42:completed",
      title: "Runtime provisioned",
      note: "The operation completed.",
      code: "runtime.provisioned",
      data: { runtimeId: "runtime-42" },
    };
    const first = await createAuditLogPrisma(input);
    const retried = await createAuditLogPrisma(input);

    assert.equal(retried.id, first.id);
    assert.equal(retried.createdAt, first.createdAt);
    assert.equal(upsertCalls, 2);
  } finally {
    setAuditLogPrismaClientForTests(null);
  }
});

test("createAuditLogPrisma rejects reused idempotency keys with different content", async () => {
  let stored: MockAuditLogRow | undefined;
  const { setAuditLogPrismaClientForTests } = await import("./audit-log-prisma.ts");
  setAuditLogPrismaClientForTests(
    makeMockPrisma(async (args) => {
      stored ??= { ...args.create };
      return stored;
    }) as unknown as Parameters<typeof setAuditLogPrismaClientForTests>[0],
  );
  try {
    await createAuditLogPrisma({
      idempotencyKey: "shared-key",
      title: "First event",
      note: "Original payload",
    });
    await assert.rejects(
      createAuditLogPrisma({
        idempotencyKey: "shared-key",
        title: "Different event",
        note: "Changed payload",
      }),
      /audit_log.idempotency_conflict/,
    );
  } finally {
    setAuditLogPrismaClientForTests(null);
  }
});

test("sync fallback also deduplicates by idempotency key", async () => {
  resetFlags();
  const input = {
    workspaceId: "default",
    idempotencyKey: `sync-retry-${Date.now()}`,
    title: "Sync retry",
    note: "One immutable audit row",
    data: { operationId: "op-sync-retry" },
  };

  const first = await createAuditLogPrismaCutover(input);
  const retried = await createAuditLogPrismaCutover(input);

  assert.equal(retried.id, first.id);
  assert.equal(retried.createdAt, first.createdAt);
});

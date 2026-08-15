// Unit tests for the document-agent-access Prisma write cutover runner.
//
// 覆盖 grant upsert 语义（4 列唯一约束 + DO UPDATE 列集）、revoke COALESCE
// raw 语义、fail-closed、flag-off sync 路径。

import assert from "node:assert/strict";
import test from "node:test";
import {
  setDocumentAgentAccessPrismaClientForTests,
  disconnectDocumentAgentAccessPrismaForTests,
} from "./document-agent-access-prisma.ts";
import {
  grantDocumentAgentAccessPrisma,
  grantDocumentAgentAccessPrismaCutover,
  revokeDocumentAgentAccessPrismaCutover,
  type DocumentAgentAccessWritePrismaCutoverMetric,
} from "./document-agent-access-prisma-write.ts";

const ORIGINAL_WRITE_FLAG = process.env.DOCUMENT_AGENT_ACCESS_PRISMA_WRITE_ENABLED;

function resetFlags(): void {
  delete process.env.DOCUMENT_AGENT_ACCESS_PRISMA_WRITE_ENABLED;
}

test.before(() => {
  resetFlags();
});

test.after(async () => {
  setDocumentAgentAccessPrismaClientForTests(null);
  await disconnectDocumentAgentAccessPrismaForTests();
  if (ORIGINAL_WRITE_FLAG === undefined) delete process.env.DOCUMENT_AGENT_ACCESS_PRISMA_WRITE_ENABLED;
  else process.env.DOCUMENT_AGENT_ACCESS_PRISMA_WRITE_ENABLED = ORIGINAL_WRITE_FLAG;
});

interface MockAccessRow {
  id: string;
  workspaceId: string;
  documentId: string;
  subjectType: string;
  subjectId: string;
  role: string;
  scope: string;
  grantedByUserId: string;
  createdAt: Date;
  updatedAt: Date;
  revokedAt: Date | null;
}

interface MockBehavior {
  upsert?: (args: Record<string, unknown>) => Promise<unknown>;
  findFirst?: (args: Record<string, unknown>) => Promise<MockAccessRow | null>;
  executeRaw?: (strings: TemplateStringsArray, ...values: unknown[]) => Promise<number>;
  queryRaw?: (strings: TemplateStringsArray, ...values: unknown[]) => Promise<unknown[]>;
}

function makeRow(overrides: Partial<MockAccessRow> = {}): MockAccessRow {
  return {
    id: "document-agent-access-mock",
    workspaceId: "default",
    documentId: "doc-mock",
    subjectType: "agent",
    subjectId: "agent-mock",
    role: "viewer",
    scope: "document",
    grantedByUserId: "user-mock",
    createdAt: new Date(),
    updatedAt: new Date(),
    revokedAt: null,
    ...overrides,
  };
}

function makeMockPrisma(behavior: MockBehavior): unknown {
  return {
    documentAgentAccess: {
      upsert: behavior.upsert ?? (async () => {
        throw new Error("unexpected upsert call");
      }),
      findFirst: behavior.findFirst ?? (async () => null),
    },
    $executeRaw: behavior.executeRaw ?? (async () => 1),
    $queryRaw: behavior.queryRaw ?? (async () => [{}]),
  };
}

const GRANT_INPUT = {
  workspaceId: "default",
  documentId: "doc-mock",
  subjectId: "agent-mock",
  role: "editor" as const,
  grantedByUserId: "user-mock",
};

test("grantDocumentAgentAccessPrismaCutover uses sync fallback when flag is disabled", async () => {
  resetFlags();
  const metrics: DocumentAgentAccessWritePrismaCutoverMetric[] = [];
  // sync 路径做 user 存在性检查；user-mock 不存在 → 报错文案即证明走了 sync。
  await assert.rejects(
    grantDocumentAgentAccessPrismaCutover(GRANT_INPUT, (metric) => metrics.push(metric)),
    /User "user-mock" does not exist/,
  );
  assert.equal(metrics.length, 0);
});

test("grantDocumentAgentAccessPrismaCutover uses Prisma primary when flag is on", async () => {
  resetFlags();
  process.env.DOCUMENT_AGENT_ACCESS_PRISMA_WRITE_ENABLED = "1";

  const upserts: Array<Record<string, unknown>> = [];
  setDocumentAgentAccessPrismaClientForTests(
    makeMockPrisma({
      upsert: async (args) => {
        upserts.push(args as Record<string, unknown>);
        return makeRow();
      },
      findFirst: async () => makeRow({ role: "editor" }),
    }) as Parameters<typeof setDocumentAgentAccessPrismaClientForTests>[0],
  );
  const metrics: DocumentAgentAccessWritePrismaCutoverMetric[] = [];
  const record = await grantDocumentAgentAccessPrismaCutover(
    GRANT_INPUT,
    (metric) => metrics.push(metric),
  );
  assert.equal(record.role, "editor");
  assert.equal(upserts.length, 1);
  // DO UPDATE 列集：role / grantedByUserId / updatedAt / revokedAt=NULL。
  const update = upserts[0]!.update as Record<string, unknown>;
  assert.equal(update.role, "editor");
  assert.equal(update.grantedByUserId, "user-mock");
  assert.equal(update.revokedAt, null);
  assert.equal(metrics.length, 1);
  assert.equal(metrics[0]!.source, "primary");
  assert.equal(metrics[0]!.fallbackInvoked, 0);
});

test("grantDocumentAgentAccessPrisma upserts against the 4-column unique key", async () => {
  const upserts: Array<Record<string, unknown>> = [];
  setDocumentAgentAccessPrismaClientForTests(
    makeMockPrisma({
      upsert: async (args) => {
        upserts.push(args as Record<string, unknown>);
        return makeRow();
      },
      findFirst: async () => makeRow(),
    }) as Parameters<typeof setDocumentAgentAccessPrismaClientForTests>[0],
  );
  await grantDocumentAgentAccessPrisma(GRANT_INPUT);
  const where = (upserts[0]!.where as Record<string, unknown>)
    .workspaceId_documentId_subjectType_subjectId as Record<string, string>;
  assert.deepEqual(where, {
    workspaceId: "default",
    documentId: "doc-mock",
    subjectType: "agent",
    subjectId: "agent-mock",
  });
});

test("grantDocumentAgentAccessPrisma validates role and missing workspace/user like sync", async () => {
  await assert.rejects(
    grantDocumentAgentAccessPrisma({ ...GRANT_INPUT, role: "owner" as "editor" }),
    /role must be viewer, editor, or forwarder/,
  );
  setDocumentAgentAccessPrismaClientForTests(
    makeMockPrisma({
      queryRaw: async () => [],
    }) as Parameters<typeof setDocumentAgentAccessPrismaClientForTests>[0],
  );
  await assert.rejects(
    grantDocumentAgentAccessPrisma(GRANT_INPUT),
    /Workspace "default" does not exist/,
  );
});

test("revokeDocumentAgentAccessPrismaCutover uses Prisma primary with COALESCE semantics", async () => {
  resetFlags();
  process.env.DOCUMENT_AGENT_ACCESS_PRISMA_WRITE_ENABLED = "1";

  const rawCalls: Array<{ sql: string; values: unknown[] }> = [];
  setDocumentAgentAccessPrismaClientForTests(
    makeMockPrisma({
      executeRaw: async (strings, ...values) => {
        rawCalls.push({ sql: strings.join("?"), values });
        return 1;
      },
      findFirst: async () => makeRow({ revokedAt: new Date() }),
    }) as Parameters<typeof setDocumentAgentAccessPrismaClientForTests>[0],
  );
  const metrics: DocumentAgentAccessWritePrismaCutoverMetric[] = [];
  const record = await revokeDocumentAgentAccessPrismaCutover(
    { workspaceId: "default", documentId: "doc-mock", subjectId: "agent-mock" },
    (metric) => metrics.push(metric),
  );
  assert.ok(record);
  assert.ok(record!.revokedAt);
  assert.match(rawCalls[0]!.sql, /COALESCE\(revoked_at/);
  assert.equal(metrics.length, 1);
  assert.equal(metrics[0]!.source, "primary");
});

test("revokeDocumentAgentAccessPrismaCutover returns null when no row matched", async () => {
  resetFlags();
  process.env.DOCUMENT_AGENT_ACCESS_PRISMA_WRITE_ENABLED = "1";

  setDocumentAgentAccessPrismaClientForTests(
    makeMockPrisma({
      executeRaw: async () => 0,
      findFirst: async () => null,
    }) as Parameters<typeof setDocumentAgentAccessPrismaClientForTests>[0],
  );
  const record = await revokeDocumentAgentAccessPrismaCutover(
    { workspaceId: "default", documentId: "doc-missing", subjectId: "agent-mock" },
  );
  assert.equal(record, null);
});

test("grantDocumentAgentAccessPrismaCutover propagates primary failures without fallback", async () => {
  resetFlags();
  process.env.DOCUMENT_AGENT_ACCESS_PRISMA_WRITE_ENABLED = "1";

  setDocumentAgentAccessPrismaClientForTests(
    makeMockPrisma({
      upsert: async () => {
        throw new Error("prisma grant unreachable");
      },
    }) as Parameters<typeof setDocumentAgentAccessPrismaClientForTests>[0],
  );
  const metrics: DocumentAgentAccessWritePrismaCutoverMetric[] = [];
  await assert.rejects(
    grantDocumentAgentAccessPrismaCutover(GRANT_INPUT, (metric) => metrics.push(metric)),
    /prisma grant unreachable/,
  );
  assert.equal(metrics.length, 1);
  assert.equal(metrics[0]!.source, "primary");
  assert.equal(metrics[0]!.fallbackInvoked, 0);
  assert.equal(metrics[0]!.error, "present");
});

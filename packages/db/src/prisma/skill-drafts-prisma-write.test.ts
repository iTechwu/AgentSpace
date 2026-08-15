// Unit tests for the skill-draft Prisma write cutover runner.

import assert from "node:assert/strict";
import test from "node:test";
import {
  deleteSkillDraftSync,
  readSkillDraftSync,
} from "../skill-drafts.ts";
import { setDofePrismaClientForTests, disconnectDofePrismaClient } from "./prisma-client.ts";
import {
  deleteSkillDraftPrismaCutover,
  upsertSkillDraftPrisma,
  upsertSkillDraftPrismaCutover,
  type SkillDraftWritePrismaCutoverMetric,
} from "./skill-drafts-prisma-write.ts";

const ORIGINAL_WRITE_FLAG = process.env.SKILL_DRAFTS_PRISMA_WRITE_ENABLED;

function resetFlags(): void {
  delete process.env.SKILL_DRAFTS_PRISMA_WRITE_ENABLED;
}

test.before(() => {
  resetFlags();
});

test.after(async () => {
  setDofePrismaClientForTests(null);
  await disconnectDofePrismaClient();
  if (ORIGINAL_WRITE_FLAG === undefined) delete process.env.SKILL_DRAFTS_PRISMA_WRITE_ENABLED;
  else process.env.SKILL_DRAFTS_PRISMA_WRITE_ENABLED = ORIGINAL_WRITE_FLAG;
});

interface MockSkillDraftRow {
  workspaceId: string;
  skillId: string;
  draftJson: string;
  updatedByUserId: string | null;
  updatedAt: Date;
}

interface MockPrismaClient {
  skillDraft: {
    upsert: (args: Record<string, unknown>) => Promise<MockSkillDraftRow>;
    deleteMany: (args: Record<string, unknown>) => Promise<{ count: number }>;
  };
}

function makeMockPrisma(
  upsert: (args: Record<string, unknown>) => Promise<MockSkillDraftRow>,
  deleteMany?: (args: Record<string, unknown>) => Promise<{ count: number }>,
): MockPrismaClient {
  return {
    skillDraft: {
      upsert,
      deleteMany:
        deleteMany ??
        (async () => {
          throw new Error("unexpected deleteMany call");
        }),
    },
  };
}

test("upsertSkillDraftPrismaCutover uses sync fallback when flag is disabled", async () => {
  resetFlags();
  // skill_draft 有 FK 到 skill 表：借用测试库已 seed 的 skill 行。
  const seeded = await readAnySeededSkill();
  assert.ok(seeded, "test DB must seed at least one skill row");
  const skillId = seeded!;
  const metrics: SkillDraftWritePrismaCutoverMetric[] = [];
  const record = await upsertSkillDraftPrismaCutover(
    { skillId, draftJson: "{\"name\":\"flag-off\"}", updatedByUserId: "user-mock" },
    (metric) => metrics.push(metric),
  );
  // sync 读回经 worker-thread JSON roundtrip 会重排空格，比较解析结果。
  assert.deepEqual(JSON.parse(record.draftJson), { name: "flag-off" });
  // Verify the row landed in the DB via the sync path (independent read).
  const fromDb = readSkillDraftSync(skillId);
  assert.ok(fromDb);
  assert.equal(fromDb!.updatedByUserId, "user-mock");
  assert.equal(metrics.length, 0);
  deleteSkillDraftSync(skillId);
});

async function readAnySeededSkill(): Promise<string | undefined> {
  const { Client } = await import("pg");
  const url =
    process.env.DOFE_AGENT_TEST_DATABASE_URL_OVERRIDE ||
    process.env.DOFE_AGENT_TEST_DATABASE_URL ||
    process.env.SELF_HOSTED_DATABASE_URL ||
    process.env.DATABASE_URL;
  if (!url) return undefined;
  const client = new Client({ connectionString: url });
  try {
    await client.connect();
    const result = await client.query<{ id: string }>(
      "SELECT id FROM skill ORDER BY created_at LIMIT 1",
    );
    return result.rows[0]?.id;
  } catch {
    return undefined;
  } finally {
    await client.end().catch(() => undefined);
  }
}

test("upsertSkillDraftPrismaCutover uses Prisma primary when flag is on", async () => {
  resetFlags();
  process.env.SKILL_DRAFTS_PRISMA_WRITE_ENABLED = "1";

  const upserts: Array<Record<string, unknown>> = [];
  setDofePrismaClientForTests(
    makeMockPrisma(async (args) => {
      upserts.push(args);
      return {
        workspaceId: "default",
        skillId: "skill-mock",
        draftJson: args.create.draftJson as string,
        updatedByUserId: (args.create.updatedByUserId as string | null) ?? null,
        updatedAt: new Date(),
      };
    }) as unknown as Parameters<typeof setDofePrismaClientForTests>[0],
  );
  const metrics: SkillDraftWritePrismaCutoverMetric[] = [];
  const record = await upsertSkillDraftPrismaCutover(
    { skillId: "skill-mock", draftJson: "{}", updatedByUserId: "  " },
    (metric) => metrics.push(metric),
  );
  assert.equal(record.skillId, "skill-mock");
  assert.equal(upserts.length, 1);
  // trim 后为空 → NULL（与 sync 一致）。
  const update = upserts[0]!.update as Record<string, unknown>;
  assert.equal(update.updatedByUserId, null);
  const where = (upserts[0]!.where as Record<string, unknown>)
    .workspaceId_skillId as Record<string, string>;
  assert.deepEqual(where, { workspaceId: "default", skillId: "skill-mock" });
  assert.equal(metrics.length, 1);
  assert.equal(metrics[0]!.source, "primary");
  assert.equal(metrics[0]!.fallbackInvoked, 0);
});

test("upsertSkillDraftPrisma keeps a stable row across repeat upserts", async () => {
  let stored: MockSkillDraftRow | undefined;
  let calls = 0;
  setDofePrismaClientForTests(
    makeMockPrisma(async (args) => {
      calls += 1;
      stored ??= {
        workspaceId: "default",
        skillId: args.create.skillId as string,
        draftJson: args.create.draftJson as string,
        updatedByUserId: null,
        updatedAt: new Date(),
      };
      return stored;
    }) as unknown as Parameters<typeof setDofePrismaClientForTests>[0],
  );
  const first = await upsertSkillDraftPrisma({ skillId: "skill-stable", draftJson: "v1" });
  const second = await upsertSkillDraftPrisma({ skillId: "skill-stable", draftJson: "v2" });
  assert.equal(second.skillId, first.skillId);
  assert.equal(calls, 2);
});

test("deleteSkillDraftPrismaCutover returns the deleteMany result", async () => {
  resetFlags();
  process.env.SKILL_DRAFTS_PRISMA_WRITE_ENABLED = "1";

  const deletes: Array<Record<string, unknown>> = [];
  setDofePrismaClientForTests(
    makeMockPrisma(
      async () => {
        throw new Error("unexpected upsert call");
      },
      async (args) => {
        deletes.push(args);
        return { count: 1 };
      },
    ) as unknown as Parameters<typeof setDofePrismaClientForTests>[0],
  );
  const metrics: SkillDraftWritePrismaCutoverMetric[] = [];
  const removed = await deleteSkillDraftPrismaCutover(
    { skillId: "skill-mock" },
    (metric) => metrics.push(metric),
  );
  assert.equal(removed, true);
  assert.deepEqual(deletes[0]!.where, { workspaceId: "default", skillId: "skill-mock" });
  assert.equal(metrics.length, 1);
  assert.equal(metrics[0]!.source, "primary");
});

test("upsertSkillDraftPrismaCutover propagates primary failures without fallback", async () => {
  resetFlags();
  process.env.SKILL_DRAFTS_PRISMA_WRITE_ENABLED = "1";

  setDofePrismaClientForTests(
    makeMockPrisma(async () => {
      throw new Error("prisma skill draft unreachable");
    }) as unknown as Parameters<typeof setDofePrismaClientForTests>[0],
  );
  const metrics: SkillDraftWritePrismaCutoverMetric[] = [];
  await assert.rejects(
    upsertSkillDraftPrismaCutover(
      { skillId: "skill-any", draftJson: "{}" },
      (metric) => metrics.push(metric),
    ),
    /prisma skill draft unreachable/,
  );
  assert.equal(metrics.length, 1);
  assert.equal(metrics[0]!.source, "primary");
  assert.equal(metrics[0]!.fallbackInvoked, 0);
  assert.equal(metrics[0]!.error, "present");
});

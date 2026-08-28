// Unit tests for the workspace-skill Prisma Client cutover runner
// (Phase 2 18 域).

import assert from "node:assert/strict";
import test from "node:test";
import type { WorkspaceSkill, WorkspaceSkillFile } from "@dofe-agent/domain/workspace";
import {
  setDofePrismaClientForTests,
  disconnectDofePrismaClient,
} from "./prisma-client.ts";
import {
  listStoredWorkspaceSkillsPrismaCutover,
  type ListStoredWorkspaceSkillsPrismaCutoverMetric,
} from "./workspace-skills-prisma-cutover.ts";

const ORIGINAL_ASYNC = process.env.WORKSPACE_SKILLS_PRISMA_READ_ENABLED;
const ORIGINAL_SHADOW = process.env.WORKSPACE_SKILLS_PRISMA_SHADOW_READ_ENABLED;

function resetFlags(): void {
  delete process.env.WORKSPACE_SKILLS_PRISMA_READ_ENABLED;
  delete process.env.WORKSPACE_SKILLS_PRISMA_SHADOW_READ_ENABLED;
}

test.before(() => {
  resetFlags();
});

test.after(async () => {
  setDofePrismaClientForTests(null);
  await disconnectDofePrismaClient();
  if (ORIGINAL_ASYNC === undefined) delete process.env.WORKSPACE_SKILLS_PRISMA_READ_ENABLED;
  else process.env.WORKSPACE_SKILLS_PRISMA_READ_ENABLED = ORIGINAL_ASYNC;
  if (ORIGINAL_SHADOW === undefined) delete process.env.WORKSPACE_SKILLS_PRISMA_SHADOW_READ_ENABLED;
  else process.env.WORKSPACE_SKILLS_PRISMA_SHADOW_READ_ENABLED = ORIGINAL_SHADOW;
});

interface MockPrismaSkill {
  id: string;
  workspaceId: string;
  name: string;
  description: string;
  sourceType: string | null;
  sourceUrl: string | null;
  configJson: string | null;
  createdAt: Date;
  updatedAt: Date;
}

interface MockPrismaSkillFile {
  id: string;
  skillId: string;
  path: string;
  content: string;
  createdAt: Date;
  updatedAt: Date;
}

interface MockPrismaClient {
  skill: {
    findMany: (args: unknown) => Promise<MockPrismaSkill[]>;
  };
  skillFile: {
    findMany: (args: unknown) => Promise<MockPrismaSkillFile[]>;
  };
}

function makeMockPrisma(
  skills: MockPrismaSkill[],
  files: MockPrismaSkillFile[] = [],
): MockPrismaClient {
  return {
    skill: { findMany: async () => skills },
    skillFile: { findMany: async () => files },
  };
}

function toPrismaSkillRow(record: WorkspaceSkill): MockPrismaSkill {
  return {
    id: record.id,
    workspaceId: record.workspaceId ?? "default",
    name: record.name,
    description: record.description,
    sourceType: record.sourceType ?? null,
    sourceUrl: record.sourceUrl ?? null,
    configJson: record.configJson ?? null,
    createdAt: new Date(record.createdAt),
    updatedAt: new Date(record.updatedAt),
  };
}

function toPrismaFileRow(skillId: string, file: WorkspaceSkillFile): MockPrismaSkillFile {
  return {
    id: file.id,
    skillId,
    path: file.path,
    content: file.content,
    createdAt: new Date(file.createdAt),
    updatedAt: new Date(file.updatedAt),
  };
}

test("listStoredWorkspaceSkillsPrismaCutover returns sync result when flag is disabled", async () => {
  resetFlags();
  const metrics: ListStoredWorkspaceSkillsPrismaCutoverMetric[] = [];
  const result = await listStoredWorkspaceSkillsPrismaCutover(
    "default",
    (metric) => metrics.push(metric),
  );
  assert.ok(Array.isArray(result));
  assert.equal(metrics.length, 0);
});

test("listStoredWorkspaceSkillsPrismaCutover uses Prisma primary when flag is on", async () => {
  resetFlags();
  process.env.WORKSPACE_SKILLS_PRISMA_READ_ENABLED = "1";
  delete process.env.WORKSPACE_SKILLS_PRISMA_SHADOW_READ_ENABLED;

  const mockedFile: WorkspaceSkillFile = {
    id: "sf-mock",
    path: "SKILL.md",
    content: "# mock",
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
  const mockedSkill: WorkspaceSkill = {
    id: "ws-prisma-mock",
    name: "MockSkill",
    description: "Mock skill",
    files: [mockedFile],
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
  setDofePrismaClientForTests(
    makeMockPrisma(
      [toPrismaSkillRow(mockedSkill)],
      [toPrismaFileRow(mockedSkill.id, mockedFile)],
    ) as unknown as Parameters<typeof setDofePrismaClientForTests>[0],
  );
  const metrics: ListStoredWorkspaceSkillsPrismaCutoverMetric[] = [];
  const result = await listStoredWorkspaceSkillsPrismaCutover(
    "default",
    (metric) => metrics.push(metric),
  );
  assert.equal(result.length, 1);
  assert.equal(result[0]!.id, "ws-prisma-mock");
  assert.equal(result[0]!.files.length, 1);
  assert.equal(result[0]!.files[0]!.id, "sf-mock");
  assert.equal(metrics.length, 1);
  assert.equal(metrics[0]!.source, "primary");
});

test("listStoredWorkspaceSkillsPrismaCutover falls back to sync when Prisma primary throws", async () => {
  resetFlags();
  process.env.WORKSPACE_SKILLS_PRISMA_READ_ENABLED = "1";
  delete process.env.WORKSPACE_SKILLS_PRISMA_SHADOW_READ_ENABLED;

  setDofePrismaClientForTests(
    {
      skill: { findMany: async () => { throw new Error("prisma workspace skills unreachable"); } },
      skillFile: { findMany: async () => [] },
    } as unknown as Parameters<typeof setDofePrismaClientForTests>[0],
  );
  const metrics: ListStoredWorkspaceSkillsPrismaCutoverMetric[] = [];
  const result = await listStoredWorkspaceSkillsPrismaCutover(
    "default",
    (metric) => metrics.push(metric),
  );
  assert.ok(Array.isArray(result));
  assert.equal(metrics.length, 1);
  assert.equal(metrics[0]!.source, "fallback");
  assert.equal(metrics[0]!.error, "present");
});
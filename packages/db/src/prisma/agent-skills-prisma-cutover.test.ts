// Unit tests for the agent-skill Prisma Client cutover runner (Phase 2 7 域).

import assert from "node:assert/strict";
import test from "node:test";
import type { StoredAgentSkillRecord } from "../types.ts";
import {
  setDofePrismaClientForTests,
  disconnectDofePrismaClient,
} from "./prisma-client.ts";
import {
  listAgentSkillAssignmentsPrismaCutover,
  type ListAgentSkillsPrismaCutoverMetric,
} from "./agent-skills-prisma-cutover.ts";
import { isAgentSkillsPrismaShadowReadEnabled } from "./agent-skills-prisma.ts";

const ORIGINAL_ASYNC = process.env.AGENT_SKILLS_PRISMA_READ_ENABLED;
const ORIGINAL_SHADOW = process.env.AGENT_SKILLS_PRISMA_SHADOW_READ_ENABLED;

function resetFlags(): void {
  delete process.env.AGENT_SKILLS_PRISMA_READ_ENABLED;
  delete process.env.AGENT_SKILLS_PRISMA_SHADOW_READ_ENABLED;
}

test.before(() => {
  resetFlags();
});

test.after(async () => {
  setDofePrismaClientForTests(null);
  await disconnectDofePrismaClient();
  if (ORIGINAL_ASYNC === undefined) delete process.env.AGENT_SKILLS_PRISMA_READ_ENABLED;
  else process.env.AGENT_SKILLS_PRISMA_READ_ENABLED = ORIGINAL_ASYNC;
  if (ORIGINAL_SHADOW === undefined) delete process.env.AGENT_SKILLS_PRISMA_SHADOW_READ_ENABLED;
  else process.env.AGENT_SKILLS_PRISMA_SHADOW_READ_ENABLED = ORIGINAL_SHADOW;
});

interface MockPrismaAgentSkill {
  workspaceId: string;
  agentId: string;
  employeeId: string;
  employeeName: string;
  skillId: string;
  skillArtifactDigest: string | null;
  rolloutPin: string | null;
  createdAt: Date;
}

interface MockPrismaClient {
  $queryRaw: (query: unknown) => Promise<MockPrismaAgentSkill[]>;
}

function makeMockPrisma(
  behavior: (args: unknown) => Promise<MockPrismaAgentSkill[]>,
): MockPrismaClient {
  return { $queryRaw: behavior };
}

function toPrismaRow(record: StoredAgentSkillRecord): MockPrismaAgentSkill {
  return {
    workspaceId: record.workspaceId,
    agentId: record.agentId,
    employeeId: record.employeeId,
    employeeName: record.employeeName,
    skillId: record.skillId,
    skillArtifactDigest: record.skillArtifactDigest ?? null,
    rolloutPin: record.rolloutPin ?? null,
    createdAt: new Date(record.createdAt),
  };
}

test("listAgentSkillAssignmentsPrismaCutover returns sync result when flag is disabled", async () => {
  resetFlags();
  const metrics: ListAgentSkillsPrismaCutoverMetric[] = [];
  const result = await listAgentSkillAssignmentsPrismaCutover(
    "default",
    (metric) => metrics.push(metric),
  );
  assert.ok(Array.isArray(result));
  assert.equal(metrics.length, 0);
});

test("listAgentSkillAssignmentsPrismaCutover uses Prisma primary when flag is on", async () => {
  resetFlags();
  process.env.AGENT_SKILLS_PRISMA_READ_ENABLED = "1";
  delete process.env.AGENT_SKILLS_PRISMA_SHADOW_READ_ENABLED;

  const mockedRow: StoredAgentSkillRecord = {
    workspaceId: "default",
    agentId: "emp-prisma-mock",
    employeeId: "emp-prisma-mock",
    employeeName: "MockEmp",
    skillId: "skill-prisma-mock",
    createdAt: new Date().toISOString(),
  };
  const alphabeticallyFirst: StoredAgentSkillRecord = {
    ...mockedRow,
    agentId: "emp-alpha",
    employeeId: "emp-alpha",
    employeeName: "alpha",
    skillId: "skill-alpha",
  };
  setDofePrismaClientForTests(
    makeMockPrisma(async () => [toPrismaRow(alphabeticallyFirst), toPrismaRow(mockedRow)]) as unknown as Parameters<typeof setDofePrismaClientForTests>[0],
  );
  const metrics: ListAgentSkillsPrismaCutoverMetric[] = [];
  const result = await listAgentSkillAssignmentsPrismaCutover(
    "default",
    (metric) => metrics.push(metric),
  );
  assert.equal(result.length, 2);
  assert.deepEqual(result.map((row) => row.skillId), ["skill-alpha", "skill-prisma-mock"]);
  assert.equal(metrics.length, 1);
  assert.equal(metrics[0]!.source, "primary");
});

test("listAgentSkillAssignmentsPrismaCutover falls back to sync when Prisma primary throws", async () => {
  resetFlags();
  process.env.AGENT_SKILLS_PRISMA_READ_ENABLED = "1";
  delete process.env.AGENT_SKILLS_PRISMA_SHADOW_READ_ENABLED;

  setDofePrismaClientForTests(
    makeMockPrisma(async () => {
      throw new Error("prisma agent skills unreachable");
    }) as unknown as Parameters<typeof setDofePrismaClientForTests>[0],
  );
  const metrics: ListAgentSkillsPrismaCutoverMetric[] = [];
  const result = await listAgentSkillAssignmentsPrismaCutover(
    "default",
    (metric) => metrics.push(metric),
  );
  assert.ok(Array.isArray(result));
  assert.equal(metrics.length, 1);
  assert.equal(metrics[0]!.source, "fallback");
  assert.equal(metrics[0]!.error, "present");
});

test("agent Skill Prisma shadow flag uses the documented environment name", async () => {
  resetFlags();
  process.env.AGENT_SKILLS_PRISMA_READ_ENABLED = "1";
  process.env.AGENT_SKILLS_PRISMA_SHADOW_READ_ENABLED = "1";
  setDofePrismaClientForTests(
    makeMockPrisma(async () => []) as unknown as Parameters<typeof setDofePrismaClientForTests>[0],
  );
  const metrics: ListAgentSkillsPrismaCutoverMetric[] = [];

  assert.equal(isAgentSkillsPrismaShadowReadEnabled(), true);
  await listAgentSkillAssignmentsPrismaCutover("default", (metric) => metrics.push(metric));
  assert.equal(metrics.length, 1);
});

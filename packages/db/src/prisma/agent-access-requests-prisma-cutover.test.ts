// Unit tests for the agent-access-request Prisma Client cutover runner
// (Phase 2 11 域).

import assert from "node:assert/strict";
import test from "node:test";
import type { AgentAccessRequestRecord } from "../types.ts";
import {
  setDofePrismaClientForTests,
  disconnectDofePrismaClient,
} from "./prisma-client.ts";
import {
  listAgentAccessRequestsPrismaCutover,
  type ListAgentAccessRequestsPrismaCutoverMetric,
} from "./agent-access-requests-prisma-cutover.ts";

const ORIGINAL_ASYNC = process.env.AGENT_ACCESS_REQUESTS_PRISMA_READ_ENABLED;
const ORIGINAL_SHADOW = process.env.AGENT_ACCESS_REQUESTS_PRISMA_SHADOW_READ_ENABLED;

function resetFlags(): void {
  delete process.env.AGENT_ACCESS_REQUESTS_PRISMA_READ_ENABLED;
  delete process.env.AGENT_ACCESS_REQUESTS_PRISMA_SHADOW_READ_ENABLED;
}

test.before(() => {
  resetFlags();
});

test.after(async () => {
  setDofePrismaClientForTests(null);
  await disconnectDofePrismaClient();
  if (ORIGINAL_ASYNC === undefined) delete process.env.AGENT_ACCESS_REQUESTS_PRISMA_READ_ENABLED;
  else process.env.AGENT_ACCESS_REQUESTS_PRISMA_READ_ENABLED = ORIGINAL_ASYNC;
  if (ORIGINAL_SHADOW === undefined) delete process.env.AGENT_ACCESS_REQUESTS_PRISMA_SHADOW_READ_ENABLED;
  else process.env.AGENT_ACCESS_REQUESTS_PRISMA_SHADOW_READ_ENABLED = ORIGINAL_SHADOW;
});

interface MockPrismaAccessRequest {
  id: string;
  workspaceId: string;
  sourceAgentName: string;
  requesterUserId: string;
  requestType: string;
  targetChannelName: string | null;
  status: string;
  reason: string;
  resolverUserId: string | null;
  resolvedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
  forkInvitationId: string | null;
  auditDataJson: unknown;
}

interface MockPrismaClient {
  agentAccessRequest: {
    findMany: (args: unknown) => Promise<MockPrismaAccessRequest[]>;
  };
}

function makeMockPrisma(
  behavior: (args: unknown) => Promise<MockPrismaAccessRequest[]>,
): MockPrismaClient {
  return { agentAccessRequest: { findMany: behavior } };
}

function toPrismaRow(record: AgentAccessRequestRecord): MockPrismaAccessRequest {
  return {
    id: record.id,
    workspaceId: record.workspaceId,
    sourceAgentName: record.sourceAgentName,
    requesterUserId: record.requesterUserId,
    requestType: record.requestType,
    targetChannelName: record.targetChannelName ?? null,
    status: record.status,
    reason: record.reason,
    resolverUserId: record.resolverUserId ?? null,
    resolvedAt: record.resolvedAt ? new Date(record.resolvedAt) : null,
    createdAt: new Date(record.createdAt),
    updatedAt: new Date(record.updatedAt),
    forkInvitationId: record.forkInvitationId ?? null,
    auditDataJson: record.auditDataJson,
  };
}

test("listAgentAccessRequestsPrismaCutover returns sync result when flag is disabled", async () => {
  resetFlags();
  const metrics: ListAgentAccessRequestsPrismaCutoverMetric[] = [];
  const result = await listAgentAccessRequestsPrismaCutover(
    { workspaceId: "default" },
    (metric) => metrics.push(metric),
  );
  assert.ok(Array.isArray(result));
  assert.equal(metrics.length, 0);
});

test("listAgentAccessRequestsPrismaCutover uses Prisma primary when flag is on", async () => {
  resetFlags();
  process.env.AGENT_ACCESS_REQUESTS_PRISMA_READ_ENABLED = "1";
  delete process.env.AGENT_ACCESS_REQUESTS_PRISMA_SHADOW_READ_ENABLED;

  const mockedRow: AgentAccessRequestRecord = {
    id: "aar-prisma-mock",
    workspaceId: "default",
    sourceAgentName: "SourceAgent",
    requesterUserId: "user-mock",
    requestType: "channel_use",
    status: "pending",
    reason: "Mock reason",
    auditDataJson: "{}",
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
  setDofePrismaClientForTests(
    makeMockPrisma(async () => [toPrismaRow(mockedRow)]) as unknown as Parameters<typeof setDofePrismaClientForTests>[0],
  );
  const metrics: ListAgentAccessRequestsPrismaCutoverMetric[] = [];
  const result = await listAgentAccessRequestsPrismaCutover(
    { workspaceId: "default" },
    (metric) => metrics.push(metric),
  );
  assert.equal(result.length, 1);
  assert.equal(result[0]!.id, "aar-prisma-mock");
  assert.equal(metrics.length, 1);
  assert.equal(metrics[0]!.source, "primary");
});

test("listAgentAccessRequestsPrismaCutover falls back to sync when Prisma primary throws", async () => {
  resetFlags();
  process.env.AGENT_ACCESS_REQUESTS_PRISMA_READ_ENABLED = "1";
  delete process.env.AGENT_ACCESS_REQUESTS_PRISMA_SHADOW_READ_ENABLED;

  setDofePrismaClientForTests(
    makeMockPrisma(async () => {
      throw new Error("prisma agent access requests unreachable");
    }) as unknown as Parameters<typeof setDofePrismaClientForTests>[0],
  );
  const metrics: ListAgentAccessRequestsPrismaCutoverMetric[] = [];
  const result = await listAgentAccessRequestsPrismaCutover(
    { workspaceId: "default" },
    (metric) => metrics.push(metric),
  );
  assert.ok(Array.isArray(result));
  assert.equal(metrics.length, 1);
  assert.equal(metrics[0]!.source, "fallback");
  assert.equal(metrics[0]!.error, "present");
});
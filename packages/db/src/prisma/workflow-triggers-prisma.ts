// workflow-trigger Phase 2 真 Prisma Client primary：与前 19 域
// 同款双 runner 模式，pg 原型仅作迁移期 fallback。
// 复用 prisma-client.ts 共享单例。

import { Prisma, type PrismaClient } from "@prisma/client";
import { randomLikeId } from "../database.ts";
import {
  disconnectDofePrismaClient,
  getDofePrismaClient,
  setDofePrismaClientForTests,
} from "./prisma-client.ts";
import type { WorkflowTriggerRecord } from "../types.ts";
import { retryPrismaTransaction } from "./transaction-retry.ts";

const VALID_TYPES = new Set(["manual", "schedule", "event"]);
const VALID_MISFIRE_POLICIES = new Set(["skip", "fire_once"]);

interface PrismaWorkflowTrigger {
  id: string;
  workspaceId: string;
  workflowId: string;
  type: string;
  configJson: unknown;
  timezone: string | null;
  status: string;
  nextFireAt: Date | null;
  lastFireAt: Date | null;
  misfirePolicy: string;
  dedupeWindowSeconds: number;
  leaseOwner: string | null;
  leaseExpiresAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface ListWorkflowTriggersPrismaInput {
  workflowId: string;
  workspaceId: string;
}

export interface ClaimWorkflowTriggersPrismaInput {
  workerId: string;
  now: string;
  limit: number;
  leaseSeconds: number;
  workspaceId?: string;
}

export async function listWorkflowTriggersForWorkflowPrisma(
  input: ListWorkflowTriggersPrismaInput,
  client?: PrismaClient,
): Promise<WorkflowTriggerRecord[]> {
  const prisma = client ?? getDofePrismaClient();
  const rows = await prisma.workflowTrigger.findMany({
    where: { workflowId: input.workflowId, workspaceId: input.workspaceId },
    orderBy: [{ createdAt: "asc" }, { id: "asc" }],
  });
  return rows
    .map((row) => mapPrismaRow(row as unknown as PrismaWorkflowTrigger))
    .filter((r): r is WorkflowTriggerRecord => r !== null);
}

export function isWorkflowTriggersPrismaReadEnabled(): boolean {
  return process.env.WORKFLOW_TRIGGERS_PRISMA_READ_ENABLED === "1";
}

export function isWorkflowTriggersPrismaShadowReadEnabled(): boolean {
  return process.env.WORKFLOW_TRIGGERS_PRISMA_SHADOW_READ_ENABLED === "1";
}

export function isWorkflowTriggersPrismaWriteEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.WORKFLOW_TRIGGERS_PRISMA_WRITE_ENABLED === "1";
}

/** Claims due triggers with the same compare-and-swap lease predicate as legacy SQL. */
export async function claimDueWorkflowTriggersPrisma(
  input: ClaimWorkflowTriggersPrismaInput,
  client?: PrismaClient,
): Promise<WorkflowTriggerRecord[]> {
  const prisma = client ?? getDofePrismaClient();
  const now = new Date(input.now);
  const leaseExpiresAt = new Date(now.getTime() + Math.max(1, input.leaseSeconds) * 1_000);
  const limit = Math.min(Math.max(Math.trunc(input.limit), 1), 100);
  return prisma.$transaction(async (tx) => {
    const candidates = await tx.workflowTrigger.findMany({
      where: {
        status: "active",
        nextFireAt: { lte: now },
        ...(input.workspaceId ? { workspaceId: input.workspaceId } : {}),
        OR: [{ leaseExpiresAt: null }, { leaseExpiresAt: { lt: now } }],
      },
      orderBy: [{ nextFireAt: "asc" }, { id: "asc" }],
      take: limit,
    });
    const claimed: WorkflowTriggerRecord[] = [];
    for (const candidate of candidates) {
      const definition = await tx.workflowDefinition.findFirst({
        where: { id: candidate.workflowId, workspaceId: candidate.workspaceId, status: "published" },
        select: { id: true },
      });
      if (!definition) continue;
      const updated = await tx.workflowTrigger.updateMany({
        where: {
          id: candidate.id,
          workspaceId: candidate.workspaceId,
          status: "active",
          nextFireAt: { lte: now },
          OR: [{ leaseExpiresAt: null }, { leaseExpiresAt: { lt: now } }],
        },
        data: { leaseOwner: input.workerId, leaseExpiresAt, updatedAt: now },
      });
      if (updated.count !== 1) continue;
      const row = await tx.workflowTrigger.findUnique({ where: { id: candidate.id } });
      if (row) {
        const mapped = mapPrismaRow(row as unknown as PrismaWorkflowTrigger);
        if (mapped) claimed.push(mapped);
      }
    }
    return claimed;
  });
}

export async function advanceWorkflowTriggerPrisma(input: {
  id: string;
  workspaceId: string;
  workerId: string;
  nextFireAt?: string | null;
  lastFireAt?: string | null;
  status?: string;
  now: string;
}, client?: PrismaClient): Promise<WorkflowTriggerRecord | null> {
  const prisma = client ?? getDofePrismaClient();
  const result = await prisma.workflowTrigger.updateMany({
    where: { id: input.id, workspaceId: input.workspaceId, leaseOwner: input.workerId },
    data: {
      nextFireAt: input.nextFireAt ? new Date(input.nextFireAt) : null,
      lastFireAt: input.lastFireAt ? new Date(input.lastFireAt) : undefined,
      status: input.status,
      leaseOwner: null,
      leaseExpiresAt: null,
      updatedAt: new Date(input.now),
    },
  });
  if (result.count !== 1) return null;
  const row = await prisma.workflowTrigger.findUnique({ where: { id: input.id } });
  return row ? mapPrismaRow(row as unknown as PrismaWorkflowTrigger) : null;
}

export interface AdvanceWorkflowTriggerWithOutcomePrismaInput {
  id: string;
  workspaceId: string;
  workflowId: string;
  workerId: string;
  nextFireAt?: string | null;
  lastFireAt?: string | null;
  status?: string;
  now: string;
  misfirePolicy: string;
  outcome: {
    code: string;
    reasonCode: string;
    scheduledAt?: string;
  };
}

/** Release a trigger lease and append its scheduler outcome in one transaction. */
export async function advanceWorkflowTriggerWithOutcomePrisma(
  input: AdvanceWorkflowTriggerWithOutcomePrismaInput,
  client?: PrismaClient,
): Promise<WorkflowTriggerRecord | null> {
  const prisma = client ?? getDofePrismaClient();
  const now = new Date(input.now);
  return retryPrismaTransaction(() => prisma.$transaction(async (tx) => {
    const result = await tx.workflowTrigger.updateMany({
      where: { id: input.id, workspaceId: input.workspaceId, leaseOwner: input.workerId },
      data: {
        nextFireAt: input.nextFireAt ? new Date(input.nextFireAt) : null,
        lastFireAt: input.lastFireAt ? new Date(input.lastFireAt) : undefined,
        status: input.status,
        leaseOwner: null,
        leaseExpiresAt: null,
        updatedAt: now,
      },
    });
    if (result.count !== 1) return null;
    await tx.auditLog.create({
      data: {
        id: `audit-${randomLikeId()}`,
        workspaceId: input.workspaceId,
        title: "Workflow trigger outcome",
        note: input.outcome.reasonCode,
        code: input.outcome.code,
        dataJson: {
          workflowId: input.workflowId,
          triggerId: input.id,
          scheduledAt: input.outcome.scheduledAt ?? input.lastFireAt ?? null,
          policy: input.misfirePolicy,
          reasonCode: input.outcome.reasonCode,
          occurredAt: input.now,
        },
        createdAt: now,
      },
    });
    const row = await tx.workflowTrigger.findUnique({ where: { id: input.id } });
    return row ? mapPrismaRow(row as unknown as PrismaWorkflowTrigger) : null;
  }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable }));
}

export { setDofePrismaClientForTests as setWorkflowTriggersPrismaClientForTests };

export async function disconnectWorkflowTriggersPrismaForTests(): Promise<void> {
  await disconnectDofePrismaClient();
}

function mapPrismaRow(row: PrismaWorkflowTrigger): WorkflowTriggerRecord | null {
  if (!VALID_TYPES.has(row.type)) return null;
  if (!VALID_MISFIRE_POLICIES.has(row.misfirePolicy)) return null;
  const record: WorkflowTriggerRecord = {
    id: row.id,
    workspaceId: row.workspaceId,
    workflowId: row.workflowId,
    type: row.type as WorkflowTriggerRecord["type"],
    configJson: typeof row.configJson === "string" ? row.configJson : JSON.stringify(row.configJson),
    status: row.status,
    misfirePolicy: row.misfirePolicy as WorkflowTriggerRecord["misfirePolicy"],
    dedupeWindowSeconds: Number(row.dedupeWindowSeconds),
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
  if (row.timezone !== null) record.timezone = row.timezone;
  if (row.nextFireAt) record.nextFireAt = row.nextFireAt.toISOString();
  if (row.lastFireAt) record.lastFireAt = row.lastFireAt.toISOString();
  if (row.leaseOwner !== null) record.leaseOwner = row.leaseOwner;
  if (row.leaseExpiresAt) record.leaseExpiresAt = row.leaseExpiresAt.toISOString();
  return record;
}

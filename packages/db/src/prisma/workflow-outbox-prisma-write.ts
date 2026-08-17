import type { Prisma, PrismaClient } from "@prisma/client";
import type { WorkflowOutboxRecord } from "../types.ts";
import { randomLikeId } from "../database.ts";
import { getDofePrismaClient } from "./prisma-client.ts";

export interface CreateWorkflowOutboxPrismaInput {
  id?: string;
  workspaceId: string;
  aggregateType: string;
  aggregateId: string;
  eventType: string;
  payloadJson: string | Record<string, unknown>;
  availableAt?: string;
  now?: string;
}

export async function enqueueWorkflowOutboxPrisma(
  input: CreateWorkflowOutboxPrismaInput,
  client?: PrismaClient,
): Promise<WorkflowOutboxRecord> {
  const prisma = client ?? getDofePrismaClient();
  const now = input.now ?? new Date().toISOString();
  const id = input.id?.trim() || `workflow-outbox-${randomLikeId()}`;
  const row = await prisma.workflowOutbox.upsert({
    where: { id },
    create: {
      id,
      workspaceId: required(input.workspaceId, "workspaceId"),
      aggregateType: required(input.aggregateType, "aggregateType"),
      aggregateId: required(input.aggregateId, "aggregateId"),
      eventType: required(input.eventType, "eventType"),
      payloadJson: parseJson(input.payloadJson),
      status: "pending",
      attempts: 0,
      availableAt: new Date(input.availableAt ?? now),
      createdAt: new Date(now),
    },
    update: {},
  });
  return mapWorkflowOutboxRow(row);
}

export async function claimWorkflowOutboxBatchPrisma(input: {
  workerId: string;
  now: string;
  limit: number;
  leaseSeconds: number;
  workspaceId?: string;
  eventType?: string;
}, client?: PrismaClient): Promise<WorkflowOutboxRecord[]> {
  const prisma = client ?? getDofePrismaClient();
  const limit = Math.min(Math.max(Math.trunc(input.limit), 1), 100);
  const now = new Date(input.now);
  const leaseUntil = new Date(now.getTime() + Math.max(1, input.leaseSeconds) * 1_000);
  return prisma.$transaction(async (tx) => {
    const candidates = await tx.workflowOutbox.findMany({
      where: {
        status: "pending",
        availableAt: { lte: now },
        ...(input.workspaceId ? { workspaceId: input.workspaceId } : {}),
        ...(input.eventType ? { eventType: input.eventType } : {}),
        OR: [{ lockedAt: null }, { lockedAt: { lt: now } }],
      },
      orderBy: [{ availableAt: "asc" }, { createdAt: "asc" }],
      take: limit,
    });
    const claimed: WorkflowOutboxRecord[] = [];
    for (const candidate of candidates) {
      const updated = await tx.workflowOutbox.updateMany({
        where: {
          id: candidate.id,
          workspaceId: candidate.workspaceId,
          status: "pending",
          OR: [{ lockedAt: null }, { lockedAt: { lt: now } }],
        },
        data: { lockedAt: leaseUntil, lockedBy: input.workerId, attempts: { increment: 1 } },
      });
      if (updated.count === 1) {
        const row = await tx.workflowOutbox.findUnique({ where: { id: candidate.id } });
        if (row) claimed.push(mapWorkflowOutboxRow(row));
      }
    }
    return claimed;
  });
}

export async function listPendingWorkflowOutboxPrisma(input: {
  now: string;
  limit: number;
  workspaceId?: string;
  eventType?: string;
}, client?: PrismaClient): Promise<WorkflowOutboxRecord[]> {
  const prisma = client ?? getDofePrismaClient();
  const rows = await prisma.workflowOutbox.findMany({
    where: {
      status: "pending",
      availableAt: { lte: new Date(input.now) },
      ...(input.workspaceId ? { workspaceId: input.workspaceId } : {}),
      ...(input.eventType ? { eventType: input.eventType } : {}),
      OR: [{ lockedAt: null }, { lockedAt: { lt: new Date(input.now) } }],
    },
    orderBy: [{ availableAt: "asc" }, { createdAt: "asc" }],
    take: Math.min(Math.max(Math.trunc(input.limit), 1), 100),
  });
  return rows.map((row) => mapWorkflowOutboxRow(row));
}

export async function markWorkflowOutboxFailedPrisma(input: {
  id: string;
  workerId: string;
  workspaceId: string;
  error: string;
  nextAvailableAt: string;
  maxAttempts: number;
  now?: string;
}, client?: PrismaClient): Promise<void> {
  const prisma = client ?? getDofePrismaClient();
  const current = await prisma.workflowOutbox.findFirst({
    where: { id: input.id, workspaceId: input.workspaceId, status: "pending", lockedBy: input.workerId },
    select: { attempts: true },
  });
  if (!current) throw new Error("workflow_outbox_lease_conflict");
  const nextAttempts = current.attempts + 1;
  const result = await prisma.workflowOutbox.updateMany({
    where: { id: input.id, workspaceId: input.workspaceId, status: "pending", lockedBy: input.workerId },
    data: {
      status: nextAttempts >= input.maxAttempts ? "dead_letter" : "pending",
      lastError: input.error,
      availableAt: new Date(input.nextAvailableAt),
      lockedAt: null,
      lockedBy: null,
      attempts: nextAttempts,
    },
  });
  if (result.count !== 1) throw new Error("workflow_outbox_lease_conflict");
}

export async function markWorkflowOutboxPublishedPrisma(input: {
  id: string;
  workerId: string;
  workspaceId: string;
  now?: string;
}, client?: PrismaClient): Promise<void> {
  const prisma = client ?? getDofePrismaClient();
  const result = await prisma.workflowOutbox.updateMany({
    where: { id: input.id, workspaceId: input.workspaceId, status: "pending", lockedBy: input.workerId },
    data: { status: "published", publishedAt: new Date(input.now ?? new Date().toISOString()), lockedAt: null, lockedBy: null },
  });
  if (result.count !== 1) throw new Error("workflow_outbox_lease_conflict");
}

export function isWorkflowOutboxPrismaWriteEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.WORKFLOW_OUTBOX_PRISMA_WRITE_ENABLED === "1";
}

function mapWorkflowOutboxRow(row: Record<string, unknown>): WorkflowOutboxRecord {
  const record: WorkflowOutboxRecord = {
    id: String(row.id),
    workspaceId: String(row.workspaceId),
    aggregateType: String(row.aggregateType),
    aggregateId: String(row.aggregateId),
    eventType: String(row.eventType),
    payloadJson: typeof row.payloadJson === "string" ? row.payloadJson : JSON.stringify(row.payloadJson ?? {}),
    status: String(row.status) as WorkflowOutboxRecord["status"],
    attempts: Number(row.attempts ?? 0),
    availableAt: toIso(row.availableAt),
    createdAt: toIso(row.createdAt),
  };
  const optionalFields = [["lockedAt", "lockedAt"], ["lockedBy", "lockedBy"], ["lastError", "lastError"], ["publishedAt", "publishedAt"]] as const;
  for (const [field, key] of optionalFields) {
    const value = row[key];
    if (value !== null && value !== undefined) record[field] = field.endsWith("At") ? toIso(value) : String(value);
  }
  return record;
}

function parseJson(value: string | Record<string, unknown>): Prisma.InputJsonValue {
  if (typeof value !== "string") return value as Prisma.InputJsonValue;
  try {
    const parsed = JSON.parse(value) as unknown;
    return parsed && typeof parsed === "object" ? parsed as Prisma.InputJsonValue : {};
  } catch {
    throw new Error("workflow_outbox.payload_json_invalid");
  }
}

function required(value: string, name: string): string {
  const normalized = value.trim();
  if (!normalized) throw new Error(`${name} is required.`);
  return normalized;
}

function toIso(value: unknown): string {
  return value instanceof Date ? value.toISOString() : new Date(String(value)).toISOString();
}

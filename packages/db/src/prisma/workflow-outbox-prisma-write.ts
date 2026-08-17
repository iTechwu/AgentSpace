import { Prisma, type PrismaClient } from "@prisma/client";
import { createHash } from "node:crypto";
import type { WorkflowOutboxRecord } from "../types.ts";
import { randomLikeId } from "../database.ts";
import { getDofePrismaClient } from "./prisma-client.ts";
import { retryPrismaTransaction } from "./transaction-retry.ts";

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
  const now = new Date(input.now ?? new Date().toISOString());
  await prisma.$transaction(async (tx) => {
    const current = await tx.workflowOutbox.findFirst({
      where: {
        id: input.id,
        workspaceId: input.workspaceId,
        status: "pending",
        availableAt: { lte: now },
        OR: [
          { lockedBy: input.workerId },
          { lockedAt: null },
          { lockedAt: { lt: now } },
        ],
      },
      select: { attempts: true, lockedBy: true },
    });
    if (!current) throw new Error("workflow_outbox_lease_conflict");
    const claimed = current.lockedBy === input.workerId
      ? current
      : await claimWorkflowOutboxForFailureInTransaction(input, now, tx);
    const result = await tx.workflowOutbox.updateMany({
      where: { id: input.id, workspaceId: input.workspaceId, status: "pending", lockedBy: input.workerId },
      data: {
        status: claimed.attempts >= input.maxAttempts ? "dead_letter" : "pending",
        lastError: input.error,
        availableAt: new Date(input.nextAvailableAt),
        lockedAt: null,
        lockedBy: null,
      },
    });
    if (result.count !== 1) throw new Error("workflow_outbox_lease_conflict");
  });
}

/** Lock run then node and acknowledge only while the observed skip condition still holds. */
export async function acknowledgeInactiveWorkflowNodeOutboxPrisma(input: {
  id: string;
  workerId: string;
  workspaceId: string;
  runId: string;
  nodeRunId: string;
  reason: "run_blocked" | "node_not_ready";
  now: string;
}, client?: PrismaClient): Promise<boolean> {
  const prisma = client ?? getDofePrismaClient();
  const now = new Date(input.now);
  return prisma.$transaction(async (tx) => {
    const runs = await tx.$queryRaw<Array<{ status: string }>>(
      Prisma.sql`SELECT status FROM workflow_run WHERE id = ${input.runId} AND workspace_id = ${input.workspaceId} FOR UPDATE`,
    );
    if (runs.length !== 1) throw new Error("workflow_run_not_found");
    const nodes = await tx.$queryRaw<Array<{ status: string }>>(
      Prisma.sql`SELECT status FROM workflow_node_run WHERE id = ${input.nodeRunId} AND workspace_id = ${input.workspaceId} FOR UPDATE`,
    );
    if (nodes.length !== 1) throw new Error("workflow_node_run_not_found");
    const shouldAcknowledge = input.reason === "run_blocked"
      ? isWorkflowRunDispatchBlocked(runs[0]!.status)
      : nodes[0]!.status !== "ready";
    if (!shouldAcknowledge) return false;
    const claimed = await tx.workflowOutbox.updateMany({
      where: {
        id: input.id,
        workspaceId: input.workspaceId,
        status: "pending",
        availableAt: { lte: now },
        OR: [{ lockedAt: null }, { lockedAt: { lt: now } }],
      },
      data: { lockedAt: new Date(now.getTime() + 60_000), lockedBy: input.workerId, attempts: { increment: 1 } },
    });
    if (claimed.count !== 1) throw new Error("workflow_outbox_lease_conflict");
    const published = await tx.workflowOutbox.updateMany({
      where: { id: input.id, workspaceId: input.workspaceId, status: "pending", lockedBy: input.workerId },
      data: { status: "published", publishedAt: now, lockedAt: null, lockedBy: null },
    });
    if (published.count !== 1) throw new Error("workflow_outbox_lease_conflict");
    return true;
  });
}

/** Atomically replace a run-ready event with deterministic node-ready events. */
export async function fanOutWorkflowRunOutboxPrisma(input: {
  id: string;
  workerId: string;
  workspaceId: string;
  runId: string;
  now: string;
}, client?: PrismaClient): Promise<{ nodeRunIds: string[] }> {
  const prisma = client ?? getDofePrismaClient();
  const now = new Date(input.now);
  return retryPrismaTransaction(() => prisma.$transaction(async (tx) => {
    const claimed = await tx.workflowOutbox.updateMany({
      where: {
        id: input.id,
        workspaceId: input.workspaceId,
        status: "pending",
        availableAt: { lte: now },
        OR: [{ lockedAt: null }, { lockedAt: { lt: now } }],
      },
      data: { lockedAt: new Date(now.getTime() + 60_000), lockedBy: input.workerId, attempts: { increment: 1 } },
    });
    if (claimed.count !== 1) throw new Error("workflow_outbox_lease_conflict");
    const runs = await tx.$queryRaw<Array<{ id: string }>>(
      Prisma.sql`SELECT id FROM workflow_run WHERE id = ${input.runId} AND workspace_id = ${input.workspaceId} FOR UPDATE`,
    );
    if (runs.length !== 1) throw new Error("workflow_run_not_found");
    const nodes = await tx.workflowNodeRun.findMany({
      where: { workspaceId: input.workspaceId, runId: input.runId, status: "ready" },
      orderBy: { id: "asc" },
      select: { id: true },
    });
    for (const node of nodes) {
      const id = workflowRunFanOutboxId(input.id, node.id);
      await tx.workflowOutbox.upsert({
        where: { id },
        create: {
          id,
          workspaceId: input.workspaceId,
          aggregateType: "workflow_node_run",
          aggregateId: node.id,
          eventType: "workflow.node.ready",
          payloadJson: { nodeRunId: node.id },
          status: "pending",
          attempts: 0,
          availableAt: now,
          createdAt: now,
        },
        update: {},
      });
    }
    const published = await tx.workflowOutbox.updateMany({
      where: { id: input.id, workspaceId: input.workspaceId, status: "pending", lockedBy: input.workerId },
      data: { status: "published", publishedAt: now, lockedAt: null, lockedBy: null },
    });
    if (published.count !== 1) throw new Error("workflow_outbox_lease_conflict");
    return { nodeRunIds: nodes.map((node) => node.id) };
  }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable }));
}

async function claimWorkflowOutboxForFailureInTransaction(
  input: { id: string; workerId: string; workspaceId: string },
  now: Date,
  tx: Prisma.TransactionClient,
): Promise<{ attempts: number }> {
  const claimed = await tx.workflowOutbox.updateMany({
    where: {
      id: input.id,
      workspaceId: input.workspaceId,
      status: "pending",
      availableAt: { lte: now },
      OR: [{ lockedAt: null }, { lockedAt: { lt: now } }],
    },
    data: { lockedAt: new Date(now.getTime() + 60_000), lockedBy: input.workerId, attempts: { increment: 1 } },
  });
  if (claimed.count !== 1) throw new Error("workflow_outbox_lease_conflict");
  const row = await tx.workflowOutbox.findFirst({
    where: { id: input.id, workspaceId: input.workspaceId, status: "pending", lockedBy: input.workerId },
    select: { attempts: true },
  });
  if (!row) throw new Error("workflow_outbox_lease_conflict");
  return row;
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

function isWorkflowRunDispatchBlocked(status: string): boolean {
  return ["paused", "cancelled", "failed", "succeeded", "partially_succeeded"].includes(status);
}

function workflowRunFanOutboxId(parentOutboxId: string, nodeRunId: string): string {
  const digest = createHash("sha256").update(`${parentOutboxId}\0${nodeRunId}`).digest("hex").slice(0, 32);
  return `workflow-outbox-fanout-${digest}`;
}

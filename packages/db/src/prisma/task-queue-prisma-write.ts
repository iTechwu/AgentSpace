import type { PrismaClient } from "@prisma/client";
import type { QueuedTaskRecord } from "../types.ts";
import { getDofePrismaClient } from "./prisma-client.ts";

export interface CreateTaskQueuePrismaInput {
  id: string;
  workspaceId: string;
  agentId: string;
  employeeId?: string;
  employeeName?: string;
  runtimeId: string;
  runtimeCredentialId?: string;
  routerSessionId?: string;
  issueId?: string;
  triggerType?: string;
  priority?: number;
  status?: QueuedTaskRecord["status"];
  inputJson: string | Record<string, unknown>;
  requestedByUserId?: string;
  requestedByDisplayName?: string;
  queuedAt?: string;
  createdAt?: string;
  updatedAt?: string;
}

/**
 * Prisma primary for the queue-row portion of task enqueue. The workflow
 * dispatcher must use this only inside the future Prisma transaction that also
 * claims the node and records router events; the legacy sync path remains the
 * atomic fallback until that transaction is migrated as one unit.
 */
export async function createAgentTaskQueuePrisma(
  input: CreateTaskQueuePrismaInput,
  client?: PrismaClient,
): Promise<QueuedTaskRecord> {
  const prisma = client ?? getDofePrismaClient();
  const now = new Date().toISOString();
  const row = await prisma.agentTaskQueue.upsert({
    where: { id: required(input.id, "id") },
    create: {
      id: required(input.id, "id"),
      workspaceId: required(input.workspaceId, "workspaceId"),
      agentId: required(input.agentId, "agentId"),
      employeeId: input.employeeId ?? null,
      employeeName: input.employeeName ?? null,
      runtimeId: required(input.runtimeId, "runtimeId"),
      runtimeCredentialId: input.runtimeCredentialId ?? null,
      routerSessionId: input.routerSessionId ?? null,
      issueId: input.issueId ?? null,
      triggerType: input.triggerType ?? "manual",
      priority: input.priority ?? 0,
      status: input.status ?? "queued",
      inputJson: parseJson(input.inputJson),
      requestedByUserId: input.requestedByUserId ?? null,
      requestedByDisplayName: input.requestedByDisplayName ?? null,
      queuedAt: new Date(input.queuedAt ?? now),
      createdAt: new Date(input.createdAt ?? now),
      updatedAt: new Date(input.updatedAt ?? now),
    },
    update: {},
  });
  return mapTaskQueueRow(row);
}

export function isTaskQueuePrismaWriteEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.TASK_QUEUE_PRISMA_WRITE_ENABLED === "1";
}

function mapTaskQueueRow(row: Record<string, unknown>): QueuedTaskRecord {
  const record: QueuedTaskRecord = {
    id: String(row.id),
    workspaceId: String(row.workspaceId),
    employeeId: String(row.employeeId ?? row.agentId),
    employeeName: String(row.employeeName ?? row.agentId),
    agentId: String(row.agentId),
    runtimeId: String(row.runtimeId),
    triggerType: String(row.triggerType) as QueuedTaskRecord["triggerType"],
    priority: Number(row.priority ?? 0),
    status: String(row.status) as QueuedTaskRecord["status"],
    inputJson: stringifyJson(row.inputJson),
    queuedAt: toIso(row.queuedAt),
    createdAt: toIso(row.createdAt),
    updatedAt: toIso(row.updatedAt),
  };
  for (const [field, key] of [
    ["runtimeCredentialId", "runtimeCredentialId"],
    ["routerSessionId", "routerSessionId"],
    ["issueId", "issueId"],
    ["requestedByUserId", "requestedByUserId"],
    ["requestedByDisplayName", "requestedByDisplayName"],
  ] as const) {
    const value = row[key];
    if (typeof value === "string") record[field] = value;
  }
  return record;
}

function parseJson(value: string | Record<string, unknown>): object {
  if (typeof value !== "string") return value;
  try {
    const parsed = JSON.parse(value) as unknown;
    return parsed && typeof parsed === "object" ? parsed as object : {};
  } catch {
    throw new Error("task_queue.input_json_invalid");
  }
}

function stringifyJson(value: unknown): string {
  return typeof value === "string" ? value : JSON.stringify(value ?? {});
}

function required(value: string, name: string): string {
  const normalized = value.trim();
  if (!normalized) throw new Error(`${name} is required.`);
  return normalized;
}

function toIso(value: unknown): string {
  return value instanceof Date ? value.toISOString() : new Date(String(value)).toISOString();
}


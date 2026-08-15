// workflow-trigger Phase 2 真 Prisma Client primary：与前 19 域
// 同款双 runner 模式，pg 原型仅作迁移期 fallback。
// 复用 prisma-client.ts 共享单例。

import type { PrismaClient } from "@prisma/client";
import {
  disconnectDofePrismaClient,
  getDofePrismaClient,
  setDofePrismaClientForTests,
} from "./prisma-client.ts";
import type { WorkflowTriggerRecord } from "../types.ts";

const VALID_TYPES = new Set(["manual", "schedule", "event"]);
const VALID_MISFIRE_POLICIES = new Set(["skip", "fire_once"]);

interface PrismaWorkflowTrigger {
  id: string;
  workspaceId: string;
  workflowId: string;
  type: string;
  configJson: string;
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
    configJson: row.configJson,
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

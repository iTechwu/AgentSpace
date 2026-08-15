// workflow-run Phase 2 真 Prisma Client primary：与前 18 域同款。
// 复用 prisma-client.ts 共享单例。
//
// 注意：Prisma 7 默认把 BigInt 暴露给 JS runtime；WorkflowRunRecord.currentSequence
// 字段在 source DB 是 BIGINT，pg driver 返回 bigint 原始类型。这里 mapPrismaRow
// 通过 Number() 降级为 number 形态（与 sync listWorkflowRunsSync 行为一致：sync
// 路径下 worker_thread 通过 JSON.parse 同样降为 number）。

import type { PrismaClient } from "@prisma/client";
import {
  disconnectDofePrismaClient,
  getDofePrismaClient,
  setDofePrismaClientForTests,
} from "./prisma-client.ts";
import type { WorkflowRunRecord } from "../types.ts";

interface PrismaWorkflowRun {
  id: string;
  workspaceId: string;
  workflowId: string;
  versionId: string;
  rootTaskId: string | null;
  triggerId: string | null;
  triggerType: string;
  triggerKey: string;
  inputJson: string;
  status: string;
  currentSequence: bigint | number;
  budgetJson: string;
  startedAt: Date | null;
  finishedAt: Date | null;
  createdBy: string;
  createdAt: Date;
  updatedAt: Date;
}

export interface ListWorkflowRunsPrismaInput {
  workspaceId: string;
  limit?: number;
  offset?: number;
}

export async function listWorkflowRunsPrisma(
  input: ListWorkflowRunsPrismaInput,
  client?: PrismaClient,
): Promise<WorkflowRunRecord[]> {
  const prisma = client ?? getDofePrismaClient();
  const limit = Math.max(1, Math.min(input.limit ?? 100, 500));
  const offset = Math.max(0, Math.trunc(input.offset ?? 0));
  const rows = await prisma.workflowRun.findMany({
    where: { workspaceId: input.workspaceId },
    orderBy: [{ createdAt: "desc" }, { id: "desc" }],
    take: limit,
    skip: offset,
  });
  return rows.map((row) => mapPrismaRow(row as unknown as PrismaWorkflowRun));
}

export function isWorkflowRunsPrismaReadEnabled(): boolean {
  return process.env.WORKFLOW_RUNS_PRISMA_READ_ENABLED === "1";
}

export function isWorkflowRunsPrismaShadowReadEnabled(): boolean {
  return process.env.WORKFLOW_RUNS_PRISMA_SHADOW_READ_ENABLED === "1";
}

export { setDofePrismaClientForTests as setWorkflowRunsPrismaClientForTests };

export async function disconnectWorkflowRunsPrismaForTests(): Promise<void> {
  await disconnectDofePrismaClient();
}

function mapPrismaRow(row: PrismaWorkflowRun): WorkflowRunRecord {
  const record: WorkflowRunRecord = {
    id: row.id,
    workspaceId: row.workspaceId,
    workflowId: row.workflowId,
    versionId: row.versionId,
    triggerType: row.triggerType,
    triggerKey: row.triggerKey,
    inputJson: row.inputJson,
    status: row.status,
    currentSequence: Number(row.currentSequence),
    budgetJson: row.budgetJson,
    createdBy: row.createdBy,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
  if (row.rootTaskId !== null) record.rootTaskId = row.rootTaskId;
  if (row.triggerId !== null) record.triggerId = row.triggerId;
  if (row.startedAt) record.startedAt = row.startedAt.toISOString();
  if (row.finishedAt) record.finishedAt = row.finishedAt.toISOString();
  return record;
}
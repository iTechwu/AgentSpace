// workflow-node-run Phase 2 真 Prisma Client primary：与前 20 域
// 同款双 runner 模式，pg 原型仅作迁移期 fallback。
// 复用 prisma-client.ts 共享单例。

import type { PrismaClient } from "@prisma/client";
import {
  disconnectDofePrismaClient,
  getDofePrismaClient,
  setDofePrismaClientForTests,
} from "./prisma-client.ts";
import type { WorkflowNodeRunRecord } from "../types.ts";

interface PrismaWorkflowNodeRun {
  id: string;
  workspaceId: string;
  runId: string;
  nodeId: string;
  nodeType: string;
  employeeId: string | null;
  employeeNameSnapshot: string | null;
  status: string;
  attemptCount: number;
  maxAttempts: number;
  availableAt: Date | null;
  taskQueueId: string | null;
  approvalId: string | null;
  approvalDeadline: Date | null;
  approvalScanAfter: Date | null;
  inputJson: string;
  outputJson: string | null;
  artifactManifestJson: string | null;
  errorCode: string | null;
  errorMessage: string | null;
  startedAt: Date | null;
  finishedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface ListWorkflowNodeRunsPrismaInput {
  workspaceId: string;
  runId: string;
}

export async function listWorkflowNodeRunsPrisma(
  input: ListWorkflowNodeRunsPrismaInput,
  client?: PrismaClient,
): Promise<WorkflowNodeRunRecord[]> {
  const prisma = client ?? getDofePrismaClient();
  const rows = await prisma.workflowNodeRun.findMany({
    where: { workspaceId: input.workspaceId, runId: input.runId },
    orderBy: [{ createdAt: "asc" }, { id: "asc" }],
  });
  return rows.map((row) => mapPrismaRow(row as unknown as PrismaWorkflowNodeRun));
}

export function isWorkflowNodeRunsPrismaReadEnabled(): boolean {
  return process.env.WORKFLOW_NODE_RUNS_PRISMA_READ_ENABLED === "1";
}

export function isWorkflowNodeRunsPrismaShadowReadEnabled(): boolean {
  return process.env.WORKFLOW_NODE_RUNS_PRISMA_SHADOW_READ_ENABLED === "1";
}

export { setDofePrismaClientForTests as setWorkflowNodeRunsPrismaClientForTests };

export async function disconnectWorkflowNodeRunsPrismaForTests(): Promise<void> {
  await disconnectDofePrismaClient();
}

function mapPrismaRow(row: PrismaWorkflowNodeRun): WorkflowNodeRunRecord {
  const record: WorkflowNodeRunRecord = {
    id: row.id,
    workspaceId: row.workspaceId,
    runId: row.runId,
    nodeId: row.nodeId,
    nodeType: row.nodeType,
    status: row.status,
    attemptCount: Number(row.attemptCount),
    maxAttempts: Number(row.maxAttempts),
    inputJson: row.inputJson,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
  if (row.employeeId !== null) record.employeeId = row.employeeId;
  if (row.employeeNameSnapshot !== null) {
    record.employeeNameSnapshot = row.employeeNameSnapshot;
  }
  if (row.availableAt) record.availableAt = row.availableAt.toISOString();
  if (row.taskQueueId !== null) record.taskQueueId = row.taskQueueId;
  if (row.approvalId !== null) record.approvalId = row.approvalId;
  if (row.approvalDeadline) record.approvalDeadline = row.approvalDeadline.toISOString();
  if (row.approvalScanAfter) record.approvalScanAfter = row.approvalScanAfter.toISOString();
  if (row.outputJson !== null) record.outputJson = row.outputJson;
  if (row.artifactManifestJson !== null) {
    record.artifactManifestJson = row.artifactManifestJson;
  }
  if (row.errorCode !== null) record.errorCode = row.errorCode;
  if (row.errorMessage !== null) record.errorMessage = row.errorMessage;
  if (row.startedAt) record.startedAt = row.startedAt.toISOString();
  if (row.finishedAt) record.finishedAt = row.finishedAt.toISOString();
  return record;
}

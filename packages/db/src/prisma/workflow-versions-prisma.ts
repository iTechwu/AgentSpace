// workflow-version Phase 2 真 Prisma Client primary：与前 21 域
// 同款双 runner 模式，pg 原型仅作迁移期 fallback。
// 复用 prisma-client.ts 共享单例。

import type { PrismaClient } from "@prisma/client";
import {
  disconnectDofePrismaClient,
  getDofePrismaClient,
  setDofePrismaClientForTests,
} from "./prisma-client.ts";
import type { WorkflowVersionRecord } from "../types.ts";

interface PrismaWorkflowVersion {
  id: string;
  workspaceId: string;
  workflowId: string;
  versionNumber: number;
  schemaVersion: number;
  graphJson: string;
  inputSchemaJson: string;
  outputSchemaJson: string;
  governanceJson: string;
  contentHash: string;
  publishedBy: string;
  publishedAt: Date;
  createdAt: Date;
}

export interface ListWorkflowVersionsPrismaInput {
  workflowId: string;
  workspaceId: string;
}

export async function listWorkflowVersionsPrisma(
  input: ListWorkflowVersionsPrismaInput,
  client?: PrismaClient,
): Promise<WorkflowVersionRecord[]> {
  const prisma = client ?? getDofePrismaClient();
  const rows = await prisma.workflowVersion.findMany({
    where: { workflowId: input.workflowId, workspaceId: input.workspaceId },
    orderBy: { versionNumber: "desc" },
  });
  return rows.map((row) => mapPrismaRow(row as unknown as PrismaWorkflowVersion));
}

export function isWorkflowVersionsPrismaReadEnabled(): boolean {
  return process.env.WORKFLOW_VERSIONS_PRISMA_READ_ENABLED === "1";
}

export function isWorkflowVersionsPrismaShadowReadEnabled(): boolean {
  return process.env.WORKFLOW_VERSIONS_PRISMA_SHADOW_READ_ENABLED === "1";
}

export { setDofePrismaClientForTests as setWorkflowVersionsPrismaClientForTests };

export async function disconnectWorkflowVersionsPrismaForTests(): Promise<void> {
  await disconnectDofePrismaClient();
}

function mapPrismaRow(row: PrismaWorkflowVersion): WorkflowVersionRecord {
  return {
    id: row.id,
    workspaceId: row.workspaceId,
    workflowId: row.workflowId,
    versionNumber: Number(row.versionNumber),
    schemaVersion: Number(row.schemaVersion),
    graphJson: row.graphJson,
    inputSchemaJson: row.inputSchemaJson,
    outputSchemaJson: row.outputSchemaJson,
    governanceJson: row.governanceJson,
    contentHash: row.contentHash,
    publishedBy: row.publishedBy,
    publishedAt: row.publishedAt.toISOString(),
    createdAt: row.createdAt.toISOString(),
  };
}

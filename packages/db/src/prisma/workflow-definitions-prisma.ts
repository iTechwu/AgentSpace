// workflow-definition Phase 2 真 Prisma Client primary：与前 13 域同款。
// 复用 prisma-client.ts 共享单例。

import type { PrismaClient } from "@prisma/client";
import {
  disconnectDofePrismaClient,
  getDofePrismaClient,
  setDofePrismaClientForTests,
} from "./prisma-client.ts";
import type { WorkflowDefinitionRecord } from "../types.ts";

interface PrismaWorkflowDefinition {
  id: string;
  workspaceId: string;
  name: string;
  description: string | null;
  ownerUserId: string;
  channelName: string | null;
  status: string;
  draftGraphJson: string;
  draftVersion: number;
  activeVersionId: string | null;
  legacySourceType: string | null;
  legacySourceId: string | null;
  createdBy: string;
  createdAt: Date;
  updatedAt: Date;
  archivedAt: Date | null;
}

const VALID_STATUSES = new Set(["draft", "published", "paused", "archived"]);

export async function listWorkflowDefinitionsPrisma(
  workspaceId: string,
  client?: PrismaClient,
): Promise<WorkflowDefinitionRecord[]> {
  const prisma = client ?? getDofePrismaClient();
  const rows = await prisma.workflowDefinition.findMany({
    where: { workspaceId },
    orderBy: [{ updatedAt: "desc" }, { id: "asc" }],
  });
  return rows.map((row) => mapPrismaRow(row as unknown as PrismaWorkflowDefinition));
}

export function isWorkflowDefinitionsPrismaReadEnabled(): boolean {
  return process.env.WORKFLOW_DEFINITIONS_PRISMA_READ_ENABLED === "1";
}

export function isWorkflowDefinitionsPrismaShadowReadEnabled(): boolean {
  return process.env.WORKFLOW_DEFINITIONS_PRISMA_SHADOW_READ_ENABLED === "1";
}

export { setDofePrismaClientForTests as setWorkflowDefinitionsPrismaClientForTests };

export async function disconnectWorkflowDefinitionsPrismaForTests(): Promise<void> {
  await disconnectDofePrismaClient();
}

function mapPrismaRow(
  row: PrismaWorkflowDefinition,
): WorkflowDefinitionRecord {
  if (!VALID_STATUSES.has(row.status)) {
    return {
      id: row.id,
      workspaceId: row.workspaceId,
      name: row.name,
      ownerUserId: row.ownerUserId,
      status: "draft",
      draftGraphJson: row.draftGraphJson,
      draftVersion: row.draftVersion,
      createdBy: row.createdBy,
      createdAt: row.createdAt.toISOString(),
      updatedAt: row.updatedAt.toISOString(),
    };
  }
  const record: WorkflowDefinitionRecord = {
    id: row.id,
    workspaceId: row.workspaceId,
    name: row.name,
    ownerUserId: row.ownerUserId,
    status: row.status as WorkflowDefinitionRecord["status"],
    draftGraphJson: row.draftGraphJson,
    draftVersion: row.draftVersion,
    createdBy: row.createdBy,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
  if (row.description !== null) record.description = row.description;
  if (row.channelName !== null) record.channelName = row.channelName;
  if (row.activeVersionId !== null) record.activeVersionId = row.activeVersionId;
  if (row.legacySourceType !== null) record.legacySourceType = row.legacySourceType;
  if (row.legacySourceId !== null) record.legacySourceId = row.legacySourceId;
  if (row.archivedAt) record.archivedAt = row.archivedAt.toISOString();
  return record;
}
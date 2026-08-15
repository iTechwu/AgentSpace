// knowledge-proposals Phase 2 真 Prisma Client primary：
// listKnowledgeProposalsPrisma 通过 prisma.knowledgeProposal.findMany 查询；
// 复用 prisma-client.ts 共享单例。

import type { PrismaClient } from "@prisma/client";
import {
  disconnectDofePrismaClient,
  getDofePrismaClient,
  setDofePrismaClientForTests,
} from "./prisma-client.ts";
import type {
  ListKnowledgeProposalsOptions,
  KnowledgeProposalRecord,
} from "../knowledge-proposals.ts";

const VALID_OPERATIONS = new Set(["create", "update", "append", "archive", "assign"]);
const VALID_STATUSES = new Set([
  "pending",
  "approved",
  "rejected",
  "superseded",
  "committed",
]);
const VALID_MODES = new Set(["all_agents", "selected_agents"]);

interface PrismaKnowledgeProposal {
  id: string;
  workspaceId: string;
  sourceTaskQueueId: string;
  sourceChannelName: string | null;
  sourceAgentName: string;
  operation: string;
  status: string;
  title: string;
  contentMarkdown: string;
  summary: string | null;
  reason: string | null;
  tagsJson: unknown;
  parentId: string | null;
  assignmentMode: string;
  assignedEmployeeNamesJson: unknown;
  targetKnowledgePageId: string | null;
  baseUpdatedAt: Date | null;
  createdKnowledgePageId: string | null;
  approvalId: string | null;
  decidedByUserId: string | null;
  decidedAt: Date | null;
  reviewerComment: string | null;
  createdAt: Date;
  updatedAt: Date;
}

export async function listKnowledgeProposalsPrisma(
  workspaceId: string,
  options?: ListKnowledgeProposalsOptions,
  client?: PrismaClient,
): Promise<KnowledgeProposalRecord[]> {
  const prisma = client ?? getDofePrismaClient();
  const where: Record<string, unknown> = { workspaceId };
  if (options?.statuses?.length) {
    where.status = { in: options.statuses };
  }
  if (options?.sourceAgentName) {
    where.sourceAgentName = options.sourceAgentName;
  }
  if (options?.approvalId) {
    where.approvalId = options.approvalId;
  }
  const rows = await prisma.knowledgeProposal.findMany({
    where,
    orderBy: [{ createdAt: "desc" }, { id: "desc" }],
  });
  return rows
    .map((row) => mapPrismaRow(row as unknown as PrismaKnowledgeProposal))
    .filter((r): r is KnowledgeProposalRecord => r !== null);
}

export function isKnowledgeProposalsPrismaReadEnabled(): boolean {
  return process.env.KNOWLEDGE_PROPOSALS_PRISMA_READ_ENABLED === "1";
}

export function isKnowledgeProposalsPrismaShadowReadEnabled(): boolean {
  return process.env.KNOWLEDGE_PROPOSALS_PRISMA_SHADOW_READ_ENABLED === "1";
}

export { setDofePrismaClientForTests as setKnowledgeProposalsPrismaClientForTests };

export async function disconnectKnowledgeProposalsPrismaForTests(): Promise<void> {
  await disconnectDofePrismaClient();
}

function mapPrismaRow(row: PrismaKnowledgeProposal): KnowledgeProposalRecord | null {
  if (!VALID_OPERATIONS.has(row.operation)) return null;
  if (!VALID_STATUSES.has(row.status)) return null;
  if (!VALID_MODES.has(row.assignmentMode)) return null;
  const record: KnowledgeProposalRecord = {
    id: row.id,
    workspaceId: row.workspaceId,
    sourceTaskQueueId: row.sourceTaskQueueId,
    sourceAgentName: row.sourceAgentName,
    operation: row.operation as KnowledgeProposalRecord["operation"],
    status: row.status as KnowledgeProposalRecord["status"],
    title: row.title,
    contentMarkdown: row.contentMarkdown,
    tags: normalizeStringArray(row.tagsJson),
    assignedEmployeeNames: normalizeStringArray(row.assignedEmployeeNamesJson),
    assignmentMode: row.assignmentMode as KnowledgeProposalRecord["assignmentMode"],
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
  if (row.sourceChannelName !== null) record.sourceChannelName = row.sourceChannelName;
  if (row.summary !== null) record.summary = row.summary;
  if (row.reason !== null) record.reason = row.reason;
  if (row.parentId !== null) record.parentId = row.parentId;
  if (row.targetKnowledgePageId !== null) record.targetKnowledgePageId = row.targetKnowledgePageId;
  if (row.baseUpdatedAt) record.baseUpdatedAt = row.baseUpdatedAt.toISOString();
  if (row.createdKnowledgePageId !== null) record.createdKnowledgePageId = row.createdKnowledgePageId;
  if (row.approvalId !== null) record.approvalId = row.approvalId;
  if (row.decidedByUserId !== null) record.decidedByUserId = row.decidedByUserId;
  if (row.decidedAt) record.decidedAt = row.decidedAt.toISOString();
  if (row.reviewerComment !== null) record.reviewerComment = row.reviewerComment;
  return record;
}

function normalizeStringArray(value: unknown): string[] {
  if (Array.isArray(value)) return value.filter((v): v is string => typeof v === "string");
  return [];
}

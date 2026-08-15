// document-permission-request Phase 2 真 Prisma Client primary：与前 9 域
// 同款双 runner 模式，pg 原型仅作迁移期 fallback。
// 复用 prisma-client.ts 共享单例。

import type { PrismaClient } from "@prisma/client";
import {
  disconnectDofePrismaClient,
  getDofePrismaClient,
  setDofePrismaClientForTests,
} from "./prisma-client.ts";
import type {
  DocumentPermissionRequestRecord,
} from "../types.ts";

const VALID_PROVIDERS = new Set(["notion", "microsoft_365"]);
const VALID_STATUSES = new Set(["pending", "approved", "rejected", "cancelled"]);

interface PrismaPermissionRequest {
  id: string;
  workspaceId: string;
  documentId: string | null;
  externalProvider: string | null;
  externalFileId: string | null;
  externalUrl: string | null;
  requestedRole: string;
  requestedByAgentName: string;
  requestedForChannelName: string | null;
  triggeredByUserId: string | null;
  reason: string;
  status: string;
  decidedByUserId: string | null;
  decisionNote: string | null;
  sourceTaskId: string | null;
  createdAt: Date;
  decidedAt: Date | null;
}

export interface ListDocumentPermissionRequestsPrismaInput {
  workspaceId?: string;
  status?: DocumentPermissionRequestRecord["status"];
  requestedByAgentName?: string;
  documentId?: string;
}

export async function listDocumentPermissionRequestsPrisma(
  input: ListDocumentPermissionRequestsPrismaInput = {},
  client?: PrismaClient,
): Promise<DocumentPermissionRequestRecord[]> {
  const prisma = client ?? getDofePrismaClient();
  const where: Record<string, unknown> = {
    workspaceId: input.workspaceId ?? "default",
  };
  if (input.status) where.status = input.status;
  if (input.requestedByAgentName?.trim()) {
    where.requestedByAgentName = input.requestedByAgentName.trim();
  }
  if (input.documentId?.trim()) where.documentId = input.documentId.trim();
  const rows = await prisma.documentPermissionRequest.findMany({
    where,
    orderBy: [{ createdAt: "desc" }, { id: "asc" }],
  });
  return rows
    .map((row) => mapPrismaRow(row as unknown as PrismaPermissionRequest))
    .filter((r): r is DocumentPermissionRequestRecord => r !== null);
}

export function isDocumentPermissionRequestsPrismaReadEnabled(): boolean {
  return process.env.DOCUMENT_PERMISSION_REQUESTS_PRISMA_READ_ENABLED === "1";
}

export function isDocumentPermissionRequestsPrismaShadowReadEnabled(): boolean {
  return process.env.DOCUMENT_PERMISSION_REQUESTS_PRISMA_SHADOW_READ_ENABLED === "1";
}

export { setDofePrismaClientForTests as setDocumentPermissionRequestsPrismaClientForTests };

export async function disconnectDocumentPermissionRequestsPrismaForTests(): Promise<void> {
  await disconnectDofePrismaClient();
}

function mapPrismaRow(
  row: PrismaPermissionRequest,
): DocumentPermissionRequestRecord | null {
  if (row.externalProvider !== null && !VALID_PROVIDERS.has(row.externalProvider)) return null;
  if (!VALID_STATUSES.has(row.status)) return null;
  const record: DocumentPermissionRequestRecord = {
    id: row.id,
    workspaceId: row.workspaceId,
    requestedRole: row.requestedRole as DocumentPermissionRequestRecord["requestedRole"],
    requestedByAgentName: row.requestedByAgentName,
    reason: row.reason,
    status: row.status as DocumentPermissionRequestRecord["status"],
    createdAt: row.createdAt.toISOString(),
  };
  if (row.documentId !== null) record.documentId = row.documentId;
  if (row.externalProvider !== null) {
    record.externalProvider = row.externalProvider as DocumentPermissionRequestRecord["externalProvider"];
  }
  if (row.externalFileId !== null) record.externalFileId = row.externalFileId;
  if (row.externalUrl !== null) record.externalUrl = row.externalUrl;
  if (row.requestedForChannelName !== null) record.requestedForChannelName = row.requestedForChannelName;
  if (row.triggeredByUserId !== null) record.triggeredByUserId = row.triggeredByUserId;
  if (row.decidedByUserId !== null) record.decidedByUserId = row.decidedByUserId;
  if (row.decisionNote !== null) record.decisionNote = row.decisionNote;
  if (row.sourceTaskId !== null) record.sourceTaskId = row.sourceTaskId;
  if (row.decidedAt) record.decidedAt = row.decidedAt.toISOString();
  return record;
}
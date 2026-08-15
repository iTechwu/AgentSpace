// document-agent-access Phase 2 真 Prisma Client primary：
// listDocumentAgentAccessPrisma 通过 prisma.documentAgentAccess.findMany 查询；
// 复用 prisma-client.ts 共享单例。

import type { PrismaClient } from "@prisma/client";
import {
  disconnectDofePrismaClient,
  getDofePrismaClient,
  setDofePrismaClientForTests,
} from "./prisma-client.ts";
import type { DocumentAgentAccessRecord } from "../types.ts";

const VALID_SUBJECT_TYPES = new Set(["agent"]);
const VALID_ROLES = new Set(["viewer", "editor", "forwarder"]);

interface PrismaDocumentAgentAccess {
  id: string;
  workspaceId: string;
  documentId: string;
  subjectType: string;
  subjectId: string;
  role: string;
  scope: string;
  grantedByUserId: string;
  createdAt: Date;
  updatedAt: Date;
  revokedAt: Date | null;
}

export interface ListDocumentAgentAccessPrismaInput {
  workspaceId?: string;
  documentId?: string;
  subjectId?: string;
  includeRevoked?: boolean;
}

export async function listDocumentAgentAccessPrisma(
  input: ListDocumentAgentAccessPrismaInput = {},
  client?: PrismaClient,
): Promise<DocumentAgentAccessRecord[]> {
  const prisma = client ?? getDofePrismaClient();
  const where: Record<string, unknown> = {
    workspaceId: input.workspaceId ?? "default",
  };
  if (input.documentId?.trim()) where.documentId = input.documentId.trim();
  if (input.subjectId?.trim()) {
    where.subjectType = "agent";
    where.subjectId = input.subjectId.trim();
  }
  if (!input.includeRevoked) where.revokedAt = null;
  const rows = await prisma.documentAgentAccess.findMany({
    where,
    orderBy: [{ updatedAt: "desc" }, { createdAt: "desc" }, { id: "asc" }],
  });
  return rows
    .map((row) => mapPrismaRow(row as unknown as PrismaDocumentAgentAccess))
    .filter((r): r is DocumentAgentAccessRecord => r !== null);
}

export function isDocumentAgentAccessPrismaReadEnabled(): boolean {
  return process.env.DOCUMENT_AGENT_ACCESS_PRISMA_READ_ENABLED === "1";
}

export function isDocumentAgentAccessPrismaShadowReadEnabled(): boolean {
  return process.env.DOCUMENT_AGENT_ACCESS_PRISMA_SHADOW_READ_ENABLED === "1";
}

export { setDofePrismaClientForTests as setDocumentAgentAccessPrismaClientForTests };

export async function disconnectDocumentAgentAccessPrismaForTests(): Promise<void> {
  await disconnectDofePrismaClient();
}

function mapPrismaRow(row: PrismaDocumentAgentAccess): DocumentAgentAccessRecord | null {
  if (!VALID_SUBJECT_TYPES.has(row.subjectType)) return null;
  if (!VALID_ROLES.has(row.role)) return null;
  if (row.scope !== "document") return null;
  const record: DocumentAgentAccessRecord = {
    id: row.id,
    workspaceId: row.workspaceId,
    documentId: row.documentId,
    subjectType: row.subjectType as DocumentAgentAccessRecord["subjectType"],
    subjectId: row.subjectId,
    role: row.role as DocumentAgentAccessRecord["role"],
    scope: row.scope,
    grantedByUserId: row.grantedByUserId,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
  if (row.revokedAt) record.revokedAt = row.revokedAt.toISOString();
  return record;
}

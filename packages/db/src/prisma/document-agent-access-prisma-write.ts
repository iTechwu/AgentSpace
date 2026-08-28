// document-agent-access Phase 2 真 Prisma Client write path：
// grantDocumentAgentAccessPrisma 复刻 sync 的 ON CONFLICT
// (workspace_id, document_id, subject_type, subject_id) DO UPDATE 语义
// （唯一约束真实存在，Prisma upsert 可表达）；revoke 用 $executeRaw 保真
// revoked_at = COALESCE(revoked_at, ?)（保留首次撤销时间戳）。
// 双 cutover 走 buildDomainWriteCutover：primary 抛错 fail closed 不重写。

import type { PrismaClient } from "@prisma/client";
import { randomLikeId } from "../database.ts";
import {
  grantDocumentAgentAccessSync,
  revokeDocumentAgentAccessSync,
} from "../document-agent-access.ts";
import type {
  DocumentAgentAccessRecord,
  DocumentAgentAccessRole,
} from "../types.ts";
import {
  buildDomainWriteCutover,
  type DomainWriteCutoverMetric,
} from "./cutover-runner.ts";
import { createPrismaCutoverMetricSink } from "./cutover-observability.ts";
// Reuse the shared PrismaClient singleton + setter so mock injection covers
// read and write without duplicating the cache plumbing.
import { getDofePrismaClient } from "./prisma-client.ts";
import {
  disconnectDocumentAgentAccessPrismaForTests,
  setDocumentAgentAccessPrismaClientForTests,
} from "./document-agent-access-prisma.ts";

export function isDocumentAgentAccessPrismaWriteEnabled(): boolean {
  return process.env.DOCUMENT_AGENT_ACCESS_PRISMA_WRITE_ENABLED === "1";
}

// Re-export so callers (tests / shutdown paths) only import this module.
export { disconnectDocumentAgentAccessPrismaForTests, setDocumentAgentAccessPrismaClientForTests };

export interface GrantDocumentAgentAccessInput {
  workspaceId?: string;
  documentId: string;
  subjectId: string;
  role: DocumentAgentAccessRole;
  grantedByUserId: string;
}

export interface RevokeDocumentAgentAccessInput {
  workspaceId?: string;
  documentId: string;
  subjectId: string;
}

/**
 * Direct Prisma upsert grant. Returns the persisted row read back from the
 * primary. Mirrors grantDocumentAgentAccessSync（含 workspace/user 存在性
 * 前置检查，报错文案与 sync 一致）。
 */
export async function grantDocumentAgentAccessPrisma(
  input: GrantDocumentAgentAccessInput,
  client?: PrismaClient,
): Promise<DocumentAgentAccessRecord> {
  const prisma = client ?? getDofePrismaClient();
  const workspaceId = input.workspaceId ?? "default";
  const documentId = requireTrimmed(input.documentId, "documentId");
  const subjectId = requireTrimmed(input.subjectId, "subjectId");
  const grantedByUserId = requireTrimmed(input.grantedByUserId, "grantedByUserId");
  assertAgentAssignableRole(input.role);
  await ensureWorkspaceExists(prisma, workspaceId);
  await ensureUserExists(prisma, grantedByUserId);

  const now = new Date();
  await prisma.documentAgentAccess.upsert({
    where: {
      workspaceId_documentId_subjectType_subjectId: {
        workspaceId,
        documentId,
        subjectType: "agent",
        subjectId,
      },
    },
    create: {
      id: `document-agent-access-${randomLikeId()}`,
      workspaceId,
      documentId,
      subjectType: "agent",
      subjectId,
      role: input.role,
      scope: "document",
      grantedByUserId,
      createdAt: now,
      updatedAt: now,
      revokedAt: null,
    },
    update: {
      role: input.role,
      grantedByUserId,
      updatedAt: now,
      revokedAt: null,
    },
  });

  const row = await prisma.documentAgentAccess.findFirst({
    where: { workspaceId, documentId, subjectType: "agent", subjectId },
  });
  if (!row) {
    throw new Error("Document agent access grant could not be read after write.");
  }
  return mapRowToRecord(row);
}

/**
 * Direct Prisma revoke. Returns the updated row (including revoked) or null
 * when no active grant matched. Mirrors revokeDocumentAgentAccessSync。
 */
export async function revokeDocumentAgentAccessPrisma(
  input: RevokeDocumentAgentAccessInput,
  client?: PrismaClient,
): Promise<DocumentAgentAccessRecord | null> {
  const prisma = client ?? getDofePrismaClient();
  const workspaceId = input.workspaceId ?? "default";
  const documentId = requireTrimmed(input.documentId, "documentId");
  const subjectId = requireTrimmed(input.subjectId, "subjectId");

  const now = new Date();
  await prisma.$executeRaw`UPDATE document_agent_access
     SET revoked_at = COALESCE(revoked_at, ${now}),
         updated_at = ${now}
     WHERE workspace_id = ${workspaceId}
       AND document_id = ${documentId}
       AND subject_type = 'agent'
       AND subject_id = ${subjectId}`;

  const row = await prisma.documentAgentAccess.findFirst({
    where: { workspaceId, documentId, subjectType: "agent", subjectId },
  });
  return row ? mapRowToRecord(row) : null;
}

export type DocumentAgentAccessWritePrismaCutoverMetric = DomainWriteCutoverMetric;
export type DocumentAgentAccessWritePrismaCutoverMetricSink = (
  metric: DocumentAgentAccessWritePrismaCutoverMetric,
) => void;

const grantDocumentAgentAccessPrismaCutoverImpl = buildDomainWriteCutover<
  GrantDocumentAgentAccessInput,
  DocumentAgentAccessRecord,
  DocumentAgentAccessWritePrismaCutoverMetric
>({
  isEnabled: isDocumentAgentAccessPrismaWriteEnabled,
  runPrimary: async (input) => grantDocumentAgentAccessPrisma(input),
  runFallback: (input) => grantDocumentAgentAccessSync(input),
  emitMetric: createPrismaCutoverMetricSink({
    domain: "document_agent_access",
    operation: "grant",
  }),
});

const revokeDocumentAgentAccessPrismaCutoverImpl = buildDomainWriteCutover<
  RevokeDocumentAgentAccessInput,
  DocumentAgentAccessRecord | null,
  DocumentAgentAccessWritePrismaCutoverMetric
>({
  isEnabled: isDocumentAgentAccessPrismaWriteEnabled,
  runPrimary: async (input) => revokeDocumentAgentAccessPrisma(input),
  runFallback: (input) => revokeDocumentAgentAccessSync(input),
  emitMetric: createPrismaCutoverMetricSink({
    domain: "document_agent_access",
    operation: "revoke",
  }),
});

/**
 * Write cutover for document-agent-access grant.
 */
export function grantDocumentAgentAccessPrismaCutover(
  input: GrantDocumentAgentAccessInput,
  metricSink?: DocumentAgentAccessWritePrismaCutoverMetricSink,
): Promise<DocumentAgentAccessRecord> {
  return grantDocumentAgentAccessPrismaCutoverImpl(input, metricSink);
}

/**
 * Write cutover for document-agent-access revoke.
 */
export function revokeDocumentAgentAccessPrismaCutover(
  input: RevokeDocumentAgentAccessInput,
  metricSink?: DocumentAgentAccessWritePrismaCutoverMetricSink,
): Promise<DocumentAgentAccessRecord | null> {
  return revokeDocumentAgentAccessPrismaCutoverImpl(input, metricSink);
}

interface PrismaAccessRow {
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

function mapRowToRecord(row: PrismaAccessRow): DocumentAgentAccessRecord {
  const record: DocumentAgentAccessRecord = {
    id: row.id,
    workspaceId: row.workspaceId,
    documentId: row.documentId,
    subjectType: row.subjectType as DocumentAgentAccessRecord["subjectType"],
    subjectId: row.subjectId,
    role: row.role as DocumentAgentAccessRole,
    scope: row.scope as DocumentAgentAccessRecord["scope"],
    grantedByUserId: row.grantedByUserId,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
  if (row.revokedAt) record.revokedAt = row.revokedAt.toISOString();
  return record;
}

async function ensureWorkspaceExists(prisma: PrismaClient, workspaceId: string): Promise<void> {
  const rows = await prisma.$queryRaw`SELECT 1 FROM workspace WHERE id = ${workspaceId} LIMIT 1`;
  if (!Array.isArray(rows) || rows.length === 0) {
    throw new Error(`Workspace "${workspaceId}" does not exist.`);
  }
}

async function ensureUserExists(prisma: PrismaClient, userId: string): Promise<void> {
  const rows = await prisma.$queryRaw`SELECT 1 FROM users WHERE id = ${userId} LIMIT 1`;
  if (!Array.isArray(rows) || rows.length === 0) {
    throw new Error(`User "${userId}" does not exist.`);
  }
}

function assertAgentAssignableRole(role: string): asserts role is DocumentAgentAccessRole {
  if (role !== "viewer" && role !== "editor" && role !== "forwarder") {
    throw new Error("role must be viewer, editor, or forwarder.");
  }
}

function requireTrimmed(value: string, label: string): string {
  const trimmed = value.trim();
  if (!trimmed) {
    throw new Error(`${label} is required.`);
  }
  return trimmed;
}

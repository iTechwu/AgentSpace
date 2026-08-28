// document-agent-access read cutover runner（真 Prisma Client primary）：
// Phase 2 第九域生产路径。pg 原型同款 runner 见 document-agent-access-cutover.ts
// （@deprecated）。

import { listDocumentAgentAccessSync } from "../document-agent-access.ts";
import type { DocumentAgentAccessRecord } from "../types.ts";
import { buildDomainCutover } from "./cutover-runner.ts";
import { createPrismaCutoverMetricSink } from "./cutover-observability.ts";
import type { ReadCutoverMetric } from "./read-cutover.ts";
import {
  isDocumentAgentAccessPrismaReadEnabled,
  isDocumentAgentAccessPrismaShadowReadEnabled,
  listDocumentAgentAccessPrisma,
  type ListDocumentAgentAccessPrismaInput,
} from "./document-agent-access-prisma.ts";

export type ListDocumentAgentAccessPrismaCutoverMetric = ReadCutoverMetric;
export type ListDocumentAgentAccessPrismaCutoverMetricSink = (
  metric: ListDocumentAgentAccessPrismaCutoverMetric,
) => void;

const listDocumentAgentAccessPrismaCutoverImpl = buildDomainCutover<
  ListDocumentAgentAccessPrismaInput,
  DocumentAgentAccessRecord[],
  ListDocumentAgentAccessPrismaCutoverMetric
>({
  isEnabled: isDocumentAgentAccessPrismaReadEnabled,
  isShadowEnabled: isDocumentAgentAccessPrismaShadowReadEnabled,
  runPrimary: async (input) => listDocumentAgentAccessPrisma(input),
  runFallback: (input) => listDocumentAgentAccessSync(input),
  compare: (primary, fallback) => recordsEqual(primary, fallback),
  emitMetric: createPrismaCutoverMetricSink({ domain: "document_agent_access", operation: "list" }),
});

export function listDocumentAgentAccessPrismaCutover(
  input: ListDocumentAgentAccessPrismaInput = {},
  metricSink?: ListDocumentAgentAccessPrismaCutoverMetricSink,
): Promise<DocumentAgentAccessRecord[]> {
  return listDocumentAgentAccessPrismaCutoverImpl(input, metricSink);
}

export function recordsEqual(
  primary: DocumentAgentAccessRecord[],
  fallback: DocumentAgentAccessRecord[],
): boolean {
  if (primary.length !== fallback.length) return false;
  for (let i = 0; i < primary.length; i += 1) {
    if (!recordEqual(primary[i]!, fallback[i]!)) return false;
  }
  return true;
}

function recordEqual(
  primary: DocumentAgentAccessRecord,
  fallback: DocumentAgentAccessRecord,
): boolean {
  return (
    primary.id === fallback.id &&
    primary.workspaceId === fallback.workspaceId &&
    primary.documentId === fallback.documentId &&
    primary.subjectType === fallback.subjectType &&
    primary.subjectId === fallback.subjectId &&
    primary.role === fallback.role &&
    primary.scope === fallback.scope &&
    primary.grantedByUserId === fallback.grantedByUserId &&
    primary.createdAt === fallback.createdAt &&
    primary.updatedAt === fallback.updatedAt &&
    primary.revokedAt === fallback.revokedAt
  );
}

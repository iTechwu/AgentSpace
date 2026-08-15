// @deprecated — Phase 2 pg 原型 cutover，保留作 Prisma 接入迁移期 fallback。
// 生产路径走 document-agent-access-prisma-cutover.ts。
//
// document-agent-access read cutover runner：把 sync `listDocumentAgentAccessSync`
// 与 async primary `listDocumentAgentAccessAsync` 接到通用 cutover-runner。

import { listDocumentAgentAccessSync } from "../document-agent-access.ts";
import type { DocumentAgentAccessRecord } from "../types.ts";
import {
  isDocumentAgentAccessAsyncReadEnabled,
  isDocumentAgentAccessShadowReadEnabled,
  listDocumentAgentAccessAsync,
} from "./document-agent-access-async.ts";
import { buildDomainCutover } from "./cutover-runner.ts";
import type { ReadCutoverMetric } from "./read-cutover.ts";

export type ListDocumentAgentAccessCutoverMetric = ReadCutoverMetric;
export type ListDocumentAgentAccessCutoverMetricSink = (
  metric: ListDocumentAgentAccessCutoverMetric,
) => void;

export interface ListDocumentAgentAccessInput {
  workspaceId?: string;
  documentId?: string;
  subjectId?: string;
  includeRevoked?: boolean;
}

/**
 * @deprecated Use {@link listDocumentAgentAccessPrismaCutover} instead.
 * Kept as Prisma 接入迁移期 fallback + 影子对比驱动。
 */
export function listDocumentAgentAccessCutover(
  input: ListDocumentAgentAccessInput = {},
  metricSink?: ListDocumentAgentAccessCutoverMetricSink,
): Promise<DocumentAgentAccessRecord[]> {
  return buildDomainCutover<
    ListDocumentAgentAccessInput,
    DocumentAgentAccessRecord[],
    ListDocumentAgentAccessCutoverMetric
  >({
    isEnabled: isDocumentAgentAccessAsyncReadEnabled,
    isShadowEnabled: isDocumentAgentAccessShadowReadEnabled,
    runPrimary: async (i) => listDocumentAgentAccessAsync(i),
    runFallback: (i) => listDocumentAgentAccessSync(i),
    compare: (primary, fallback) => recordsEqual(primary, fallback),
  })(input, metricSink);
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
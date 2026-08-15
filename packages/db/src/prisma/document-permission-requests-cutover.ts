// @deprecated — Phase 2 pg 原型 cutover，保留作 Prisma 接入迁移期 fallback。
// 生产路径走 document-permission-requests-prisma-cutover.ts。

import { listDocumentPermissionRequestsSync } from "../document-agent-access.ts";
import type { DocumentPermissionRequestRecord } from "../types.ts";
import {
  isDocumentPermissionRequestsAsyncReadEnabled,
  isDocumentPermissionRequestsShadowReadEnabled,
  listDocumentPermissionRequestsAsync,
} from "./document-permission-requests-async.ts";
import { buildDomainCutover } from "./cutover-runner.ts";
import type { ReadCutoverMetric } from "./read-cutover.ts";

export type ListDocumentPermissionRequestsCutoverMetric = ReadCutoverMetric;
export type ListDocumentPermissionRequestsCutoverMetricSink = (
  metric: ListDocumentPermissionRequestsCutoverMetric,
) => void;

export interface ListDocumentPermissionRequestsInput {
  workspaceId?: string;
  status?: DocumentPermissionRequestRecord["status"];
  requestedByAgentName?: string;
  documentId?: string;
}

/**
 * @deprecated Use {@link listDocumentPermissionRequestsPrismaCutover} instead.
 * Kept as Prisma 接入迁移期 fallback + 影子对比驱动。
 */
export function listDocumentPermissionRequestsCutover(
  input: ListDocumentPermissionRequestsInput = {},
  metricSink?: ListDocumentPermissionRequestsCutoverMetricSink,
): Promise<DocumentPermissionRequestRecord[]> {
  return buildDomainCutover<
    ListDocumentPermissionRequestsInput,
    DocumentPermissionRequestRecord[],
    ListDocumentPermissionRequestsCutoverMetric
  >({
    isEnabled: isDocumentPermissionRequestsAsyncReadEnabled,
    isShadowEnabled: isDocumentPermissionRequestsShadowReadEnabled,
    runPrimary: async (i) => listDocumentPermissionRequestsAsync(i),
    runFallback: (i) => listDocumentPermissionRequestsSync(i),
    compare: (primary, fallback) => recordsEqual(primary, fallback),
  })(input, metricSink);
}

export function recordsEqual(
  primary: DocumentPermissionRequestRecord[],
  fallback: DocumentPermissionRequestRecord[],
): boolean {
  if (primary.length !== fallback.length) return false;
  for (let i = 0; i < primary.length; i += 1) {
    if (!recordEqual(primary[i]!, fallback[i]!)) return false;
  }
  return true;
}

function recordEqual(
  primary: DocumentPermissionRequestRecord,
  fallback: DocumentPermissionRequestRecord,
): boolean {
  return (
    primary.id === fallback.id &&
    primary.workspaceId === fallback.workspaceId &&
    primary.documentId === fallback.documentId &&
    primary.externalProvider === fallback.externalProvider &&
    primary.externalFileId === fallback.externalFileId &&
    primary.externalUrl === fallback.externalUrl &&
    primary.requestedRole === fallback.requestedRole &&
    primary.requestedByAgentName === fallback.requestedByAgentName &&
    primary.requestedForChannelName === fallback.requestedForChannelName &&
    primary.triggeredByUserId === fallback.triggeredByUserId &&
    primary.reason === fallback.reason &&
    primary.status === fallback.status &&
    primary.decidedByUserId === fallback.decidedByUserId &&
    primary.decisionNote === fallback.decisionNote &&
    primary.sourceTaskId === fallback.sourceTaskId &&
    primary.createdAt === fallback.createdAt &&
    primary.decidedAt === fallback.decidedAt
  );
}
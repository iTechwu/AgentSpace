// document-permission-request read cutover runner（真 Prisma Client primary）：
// Phase 2 第十域生产路径。pg 原型同款 runner 见
// document-permission-requests-cutover.ts（@deprecated）。

import { listDocumentPermissionRequestsSync } from "../document-agent-access.ts";
import type { DocumentPermissionRequestRecord } from "../types.ts";
import { buildDomainCutover } from "./cutover-runner.ts";
import { createPrismaCutoverMetricSink } from "./cutover-observability.ts";
import type { ReadCutoverMetric } from "./read-cutover.ts";
import {
  isDocumentPermissionRequestsPrismaReadEnabled,
  isDocumentPermissionRequestsPrismaShadowReadEnabled,
  listDocumentPermissionRequestsPrisma,
  type ListDocumentPermissionRequestsPrismaInput,
} from "./document-permission-requests-prisma.ts";

export type ListDocumentPermissionRequestsPrismaCutoverMetric = ReadCutoverMetric;
export type ListDocumentPermissionRequestsPrismaCutoverMetricSink = (
  metric: ListDocumentPermissionRequestsPrismaCutoverMetric,
) => void;

const listDocumentPermissionRequestsPrismaCutoverImpl = buildDomainCutover<
  ListDocumentPermissionRequestsPrismaInput,
  DocumentPermissionRequestRecord[],
  ListDocumentPermissionRequestsPrismaCutoverMetric
>({
  isEnabled: isDocumentPermissionRequestsPrismaReadEnabled,
  isShadowEnabled: isDocumentPermissionRequestsPrismaShadowReadEnabled,
  runPrimary: async (input) => listDocumentPermissionRequestsPrisma(input),
  runFallback: (input) => listDocumentPermissionRequestsSync(input),
  compare: (primary, fallback) => recordsEqual(primary, fallback),
  emitMetric: createPrismaCutoverMetricSink({
    domain: "document_permission_request",
    operation: "list",
  }),
});

export function listDocumentPermissionRequestsPrismaCutover(
  input: ListDocumentPermissionRequestsPrismaInput = {},
  metricSink?: ListDocumentPermissionRequestsPrismaCutoverMetricSink,
): Promise<DocumentPermissionRequestRecord[]> {
  return listDocumentPermissionRequestsPrismaCutoverImpl(input, metricSink);
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
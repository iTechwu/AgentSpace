// attachment read cutover runner（真 Prisma Client primary）：
// Phase 2 第十二域生产路径。pg 原型同款 runner 见 attachments-cutover.ts
// （@deprecated）。

import { listStoredAttachmentsSync } from "../attachments.ts";
import type { StoredAttachmentRecord } from "../attachments.ts";
import { buildDomainCutover } from "./cutover-runner.ts";
import { createPrismaCutoverMetricSink } from "./cutover-observability.ts";
import type { ReadCutoverMetric } from "./read-cutover.ts";
import { listStoredAttachmentsPrisma } from "./attachments-prisma.ts";

export type ListAttachmentsPrismaCutoverMetric = ReadCutoverMetric;
export type ListAttachmentsPrismaCutoverMetricSink = (
  metric: ListAttachmentsPrismaCutoverMetric,
) => void;

const listStoredAttachmentsPrismaCutoverImpl = buildDomainCutover<
  string,
  StoredAttachmentRecord[],
  ListAttachmentsPrismaCutoverMetric
>({
  isEnabled: () => process.env.ATTACHMENTS_PRISMA_READ_ENABLED === "1",
  isShadowEnabled: () => process.env.ATTACHMENTS_PRISMA_SHADOW_READ_ENABLED === "1",
  runPrimary: async (workspaceId) => listStoredAttachmentsPrisma(workspaceId),
  runFallback: (workspaceId) => listStoredAttachmentsSync(workspaceId),
  compare: (primary, fallback) => recordsEqual(primary, fallback),
  emitMetric: createPrismaCutoverMetricSink({
    domain: "attachment",
    operation: "list",
  }),
});

export function listStoredAttachmentsPrismaCutover(
  workspaceId: string = "default",
  metricSink?: ListAttachmentsPrismaCutoverMetricSink,
): Promise<StoredAttachmentRecord[]> {
  return listStoredAttachmentsPrismaCutoverImpl(workspaceId, metricSink);
}

export function recordsEqual(
  primary: StoredAttachmentRecord[],
  fallback: StoredAttachmentRecord[],
): boolean {
  if (primary.length !== fallback.length) return false;
  for (let i = 0; i < primary.length; i += 1) {
    if (!recordEqual(primary[i]!, fallback[i]!)) return false;
  }
  return true;
}

function recordEqual(
  primary: StoredAttachmentRecord,
  fallback: StoredAttachmentRecord,
): boolean {
  return (
    primary.id === fallback.id &&
    primary.workspaceId === fallback.workspaceId &&
    primary.messageId === fallback.messageId &&
    primary.channelName === fallback.channelName &&
    primary.speaker === fallback.speaker &&
    primary.role === fallback.role &&
    primary.fileName === fallback.fileName &&
    primary.mediaType === fallback.mediaType &&
    primary.sizeBytes === fallback.sizeBytes &&
    primary.kind === fallback.kind &&
    primary.storedPath === fallback.storedPath &&
    primary.storageProvider === fallback.storageProvider &&
    primary.storageBucket === fallback.storageBucket &&
    primary.storageRegion === fallback.storageRegion &&
    primary.storageEndpoint === fallback.storageEndpoint &&
    primary.storageKey === fallback.storageKey &&
    primary.storageUrl === fallback.storageUrl &&
    primary.sha256 === fallback.sha256 &&
    primary.sourceMessageIndex === fallback.sourceMessageIndex &&
    primary.sourceMessageTime === fallback.sourceMessageTime &&
    primary.sourceSummary === fallback.sourceSummary &&
    primary.deletedAt === fallback.deletedAt &&
    primary.deletedByUserId === fallback.deletedByUserId &&
    primary.deletedByDisplayName === fallback.deletedByDisplayName &&
    primary.createdAt === fallback.createdAt
  );
}
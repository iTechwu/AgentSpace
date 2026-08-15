// @deprecated — Phase 2 pg 原型 cutover，保留作 Prisma 接入迁移期 fallback。
// 生产路径走 attachments-prisma-cutover.ts。

import { listStoredAttachmentsSync } from "../attachments.ts";
import type { StoredAttachmentRecord } from "../attachments.ts";
import {
  isAttachmentsAsyncReadEnabled,
  isAttachmentsShadowReadEnabled,
  listStoredAttachmentsAsync,
} from "./attachments-async.ts";
import { buildDomainCutover } from "./cutover-runner.ts";
import type { ReadCutoverMetric } from "./read-cutover.ts";

export type ListAttachmentsCutoverMetric = ReadCutoverMetric;
export type ListAttachmentsCutoverMetricSink = (
  metric: ListAttachmentsCutoverMetric,
) => void;

/**
 * @deprecated Use {@link listStoredAttachmentsPrismaCutover} instead.
 * Kept as Prisma 接入迁移期 fallback + 影子对比驱动。
 */
export function listStoredAttachmentsCutover(
  workspaceId: string = "default",
  metricSink?: ListAttachmentsCutoverMetricSink,
): Promise<StoredAttachmentRecord[]> {
  return buildDomainCutover<
    string,
    StoredAttachmentRecord[],
    ListAttachmentsCutoverMetric
  >({
    isEnabled: isAttachmentsAsyncReadEnabled,
    isShadowEnabled: isAttachmentsShadowReadEnabled,
    runPrimary: async (id) => listStoredAttachmentsAsync(id),
    runFallback: (id) => listStoredAttachmentsSync(id),
    compare: (primary, fallback) => recordsEqual(primary, fallback),
  })(workspaceId, metricSink);
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
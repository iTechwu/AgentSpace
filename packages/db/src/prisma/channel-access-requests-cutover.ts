// @deprecated — Phase 2 pg 原型 cutover，保留作 Prisma 接入迁移期 fallback。
// 生产路径走 channel-access-requests-prisma-cutover.ts。

import { listChannelAccessRequestsSync } from "../channel-access.ts";
import type {
  ChannelAccessRequestStatus,
  StoredChannelAccessRequestRecord,
} from "../types.ts";
import {
  isChannelAccessRequestsAsyncReadEnabled,
  isChannelAccessRequestsShadowReadEnabled,
  listChannelAccessRequestsAsync,
} from "./channel-access-requests-async.ts";
import { buildDomainCutover } from "./cutover-runner.ts";
import type { ReadCutoverMetric } from "./read-cutover.ts";

export type ListChannelAccessRequestsCutoverMetric = ReadCutoverMetric;
export type ListChannelAccessRequestsCutoverMetricSink = (
  metric: ListChannelAccessRequestsCutoverMetric,
) => void;

export interface ListChannelAccessRequestsInput {
  workspaceId: string;
  options?: {
    channelName?: string;
    userId?: string;
    statuses?: ChannelAccessRequestStatus[];
  };
}

/**
 * @deprecated Use {@link listChannelAccessRequestsPrismaCutover} instead.
 * Kept as Prisma 接入迁移期 fallback + 影子对比驱动。
 */
export function listChannelAccessRequestsCutover(
  input: ListChannelAccessRequestsInput,
  metricSink?: ListChannelAccessRequestsCutoverMetricSink,
): Promise<StoredChannelAccessRequestRecord[]> {
  return buildDomainCutover<
    ListChannelAccessRequestsInput,
    StoredChannelAccessRequestRecord[],
    ListChannelAccessRequestsCutoverMetric
  >({
    isEnabled: isChannelAccessRequestsAsyncReadEnabled,
    isShadowEnabled: isChannelAccessRequestsShadowReadEnabled,
    runPrimary: async (i) => listChannelAccessRequestsAsync(i.workspaceId, i.options),
    runFallback: (i) => listChannelAccessRequestsSync(i.workspaceId, i.options),
    compare: (primary, fallback) => recordsEqual(primary, fallback),
  })(input, metricSink);
}

export function recordsEqual(
  primary: StoredChannelAccessRequestRecord[],
  fallback: StoredChannelAccessRequestRecord[],
): boolean {
  if (primary.length !== fallback.length) return false;
  for (let i = 0; i < primary.length; i += 1) {
    if (!recordEqual(primary[i]!, fallback[i]!)) return false;
  }
  return true;
}

function recordEqual(
  primary: StoredChannelAccessRequestRecord,
  fallback: StoredChannelAccessRequestRecord,
): boolean {
  return (
    primary.id === fallback.id &&
    primary.workspaceId === fallback.workspaceId &&
    primary.channelName === fallback.channelName &&
    primary.userId === fallback.userId &&
    primary.status === fallback.status &&
    primary.requestedAt === fallback.requestedAt &&
    primary.resolvedAt === fallback.resolvedAt &&
    primary.resolvedBy === fallback.resolvedBy &&
    primary.note === fallback.note
  );
}
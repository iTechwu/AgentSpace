// @deprecated — Phase 2 pg 原型 cutover，保留作 Prisma 接入迁移期 fallback。
// 生产路径走 channel-participants-prisma-cutover.ts。

import { listChannelParticipantsSync } from "../channel-access.ts";
import type { ChannelParticipantStatus, StoredChannelParticipantRecord } from "../types.ts";
import {
  isChannelParticipantsAsyncReadEnabled,
  isChannelParticipantsShadowReadEnabled,
  listChannelParticipantsAsync,
} from "./channel-participants-async.ts";
import { buildDomainCutover } from "./cutover-runner.ts";
import type { ReadCutoverMetric } from "./read-cutover.ts";

export type ListChannelParticipantsCutoverMetric = ReadCutoverMetric;
export type ListChannelParticipantsCutoverMetricSink = (
  metric: ListChannelParticipantsCutoverMetric,
) => void;

export interface ListChannelParticipantsInput {
  workspaceId: string;
  channelName: string;
  options?: { userId?: string; statuses?: ChannelParticipantStatus[] };
}

/**
 * @deprecated Use {@link listChannelParticipantsPrismaCutover} instead.
 * Kept as Prisma 接入迁移期 fallback + 影子对比驱动。
 */
export function listChannelParticipantsCutover(
  input: ListChannelParticipantsInput,
  metricSink?: ListChannelParticipantsCutoverMetricSink,
): Promise<StoredChannelParticipantRecord[]> {
  return buildDomainCutover<
    ListChannelParticipantsInput,
    StoredChannelParticipantRecord[],
    ListChannelParticipantsCutoverMetric
  >({
    isEnabled: isChannelParticipantsAsyncReadEnabled,
    isShadowEnabled: isChannelParticipantsShadowReadEnabled,
    runPrimary: async (i) => listChannelParticipantsAsync(i.workspaceId, i.channelName, i.options),
    runFallback: (i) => listChannelParticipantsSync(i.workspaceId, i.channelName, i.options),
    compare: (primary, fallback) => recordsEqual(primary, fallback),
  })(input, metricSink);
}

export function recordsEqual(
  primary: StoredChannelParticipantRecord[],
  fallback: StoredChannelParticipantRecord[],
): boolean {
  if (primary.length !== fallback.length) return false;
  for (let i = 0; i < primary.length; i += 1) {
    if (!recordEqual(primary[i]!, fallback[i]!)) return false;
  }
  return true;
}

function recordEqual(
  primary: StoredChannelParticipantRecord,
  fallback: StoredChannelParticipantRecord,
): boolean {
  return (
    primary.id === fallback.id &&
    primary.workspaceId === fallback.workspaceId &&
    primary.channelName === fallback.channelName &&
    primary.userId === fallback.userId &&
    primary.status === fallback.status &&
    primary.addedBy === fallback.addedBy &&
    primary.joinedAt === fallback.joinedAt &&
    primary.removedAt === fallback.removedAt &&
    primary.updatedAt === fallback.updatedAt
  );
}
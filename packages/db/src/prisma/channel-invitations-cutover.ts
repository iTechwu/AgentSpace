// @deprecated — Phase 2 pg 原型 cutover，保留作 Prisma 接入迁移期 fallback。
// 生产路径走 channel-invitations-prisma-cutover.ts。

import { listChannelInvitationsSync } from "../channel-access.ts";
import type {
  ChannelInvitationStatus,
  StoredChannelInvitationRecord,
} from "../types.ts";
import {
  isChannelInvitationsAsyncReadEnabled,
  isChannelInvitationsShadowReadEnabled,
  listChannelInvitationsAsync,
} from "./channel-invitations-async.ts";
import { buildDomainCutover } from "./cutover-runner.ts";
import type { ReadCutoverMetric } from "./read-cutover.ts";

export type ListChannelInvitationsCutoverMetric = ReadCutoverMetric;
export type ListChannelInvitationsCutoverMetricSink = (
  metric: ListChannelInvitationsCutoverMetric,
) => void;

export interface ListChannelInvitationsInput {
  workspaceId: string;
  options?: {
    channelName?: string;
    inviteeUserId?: string;
    inviteeEmail?: string;
    statuses?: ChannelInvitationStatus[];
  };
}

/**
 * @deprecated Use {@link listChannelInvitationsPrismaCutover} instead.
 * Kept as Prisma 接入迁移期 fallback + 影子对比驱动。
 */
export function listChannelInvitationsCutover(
  input: ListChannelInvitationsInput,
  metricSink?: ListChannelInvitationsCutoverMetricSink,
): Promise<StoredChannelInvitationRecord[]> {
  return buildDomainCutover<
    ListChannelInvitationsInput,
    StoredChannelInvitationRecord[],
    ListChannelInvitationsCutoverMetric
  >({
    isEnabled: isChannelInvitationsAsyncReadEnabled,
    isShadowEnabled: isChannelInvitationsShadowReadEnabled,
    runPrimary: async (i) => listChannelInvitationsAsync(i.workspaceId, i.options),
    runFallback: (i) => listChannelInvitationsSync(i.workspaceId, i.options),
    compare: (primary, fallback) => recordsEqual(primary, fallback),
  })(input, metricSink);
}

export function recordsEqual(
  primary: StoredChannelInvitationRecord[],
  fallback: StoredChannelInvitationRecord[],
): boolean {
  if (primary.length !== fallback.length) return false;
  for (let i = 0; i < primary.length; i += 1) {
    if (!recordEqual(primary[i]!, fallback[i]!)) return false;
  }
  return true;
}

function recordEqual(
  primary: StoredChannelInvitationRecord,
  fallback: StoredChannelInvitationRecord,
): boolean {
  return (
    primary.id === fallback.id &&
    primary.workspaceId === fallback.workspaceId &&
    primary.channelName === fallback.channelName &&
    primary.inviteeUserId === fallback.inviteeUserId &&
    primary.inviteeEmail === fallback.inviteeEmail &&
    primary.invitedBy === fallback.invitedBy &&
    primary.status === fallback.status &&
    primary.createdAt === fallback.createdAt &&
    primary.expiresAt === fallback.expiresAt &&
    primary.respondedAt === fallback.respondedAt &&
    primary.respondedBy === fallback.respondedBy
  );
}
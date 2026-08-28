// channel-invitation read cutover runner（真 Prisma Client primary）：
// Phase 2 第十七域生产路径。pg 原型同款 runner 见 channel-invitations-cutover.ts
// （@deprecated）。

import { listChannelInvitationsSync } from "../channel-access.ts";
import type { StoredChannelInvitationRecord } from "../types.ts";
import { buildDomainCutover } from "./cutover-runner.ts";
import { createPrismaCutoverMetricSink } from "./cutover-observability.ts";
import type { ReadCutoverMetric } from "./read-cutover.ts";
import {
  listChannelInvitationsPrisma,
  type ListChannelInvitationsPrismaInput,
} from "./channel-invitations-prisma.ts";

export type ListChannelInvitationsPrismaCutoverMetric = ReadCutoverMetric;
export type ListChannelInvitationsPrismaCutoverMetricSink = (
  metric: ListChannelInvitationsPrismaCutoverMetric,
) => void;

const listChannelInvitationsPrismaCutoverImpl = buildDomainCutover<
  ListChannelInvitationsPrismaInput,
  StoredChannelInvitationRecord[],
  ListChannelInvitationsPrismaCutoverMetric
>({
  isEnabled: () => process.env.CHANNEL_INVITATIONS_PRISMA_READ_ENABLED === "1",
  isShadowEnabled: () => process.env.CHANNEL_INVITATIONS_PRISMA_SHADOW_READ_ENABLED === "1",
  runPrimary: async (input) => listChannelInvitationsPrisma(input),
  runFallback: (input) => listChannelInvitationsSync(input.workspaceId, input.options),
  compare: (primary, fallback) => recordsEqual(primary, fallback),
  emitMetric: createPrismaCutoverMetricSink({
    domain: "channel_invitation",
    operation: "list",
  }),
});

export function listChannelInvitationsPrismaCutover(
  input: ListChannelInvitationsPrismaInput,
  metricSink?: ListChannelInvitationsPrismaCutoverMetricSink,
): Promise<StoredChannelInvitationRecord[]> {
  return listChannelInvitationsPrismaCutoverImpl(input, metricSink);
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
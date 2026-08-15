// channel-participant read cutover runner（真 Prisma Client primary）：
// Phase 2 第十五域生产路径。pg 原型同款 runner 见 channel-participants-cutover.ts
// （@deprecated）。

import { listChannelParticipantsSync } from "../channel-access.ts";
import type { StoredChannelParticipantRecord } from "../types.ts";
import { buildDomainCutover } from "./cutover-runner.ts";
import { createPrismaCutoverMetricSink } from "./cutover-observability.ts";
import type { ReadCutoverMetric } from "./read-cutover.ts";
import {
  listChannelParticipantsPrisma,
  type ListChannelParticipantsPrismaInput,
} from "./channel-participants-prisma.ts";

export type ListChannelParticipantsPrismaCutoverMetric = ReadCutoverMetric;
export type ListChannelParticipantsPrismaCutoverMetricSink = (
  metric: ListChannelParticipantsPrismaCutoverMetric,
) => void;

const listChannelParticipantsPrismaCutoverImpl = buildDomainCutover<
  ListChannelParticipantsPrismaInput,
  StoredChannelParticipantRecord[],
  ListChannelParticipantsPrismaCutoverMetric
>({
  isEnabled: () => process.env.CHANNEL_PARTICIPANTS_PRISMA_READ_ENABLED === "1",
  isShadowEnabled: () => process.env.CHANNEL_PARTICIPANTS_PRISMA_SHADOW_READ_ENABLED === "1",
  runPrimary: async (input) => listChannelParticipantsPrisma(input),
  runFallback: (input) => listChannelParticipantsSync(input.workspaceId, input.channelName, input.options),
  compare: (primary, fallback) => recordsEqual(primary, fallback),
  emitMetric: createPrismaCutoverMetricSink({
    domain: "channel_participant",
    operation: "list",
  }),
});

export function listChannelParticipantsPrismaCutover(
  input: ListChannelParticipantsPrismaInput,
  metricSink?: ListChannelParticipantsPrismaCutoverMetricSink,
): Promise<StoredChannelParticipantRecord[]> {
  return listChannelParticipantsPrismaCutoverImpl(input, metricSink);
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
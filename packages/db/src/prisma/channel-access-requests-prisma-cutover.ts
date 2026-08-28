// channel-access-request read cutover runner（真 Prisma Client primary）：
// Phase 2 第十六域生产路径。pg 原型同款 runner 见
// channel-access-requests-cutover.ts（@deprecated）。

import { listChannelAccessRequestsSync } from "../channel-access.ts";
import type { StoredChannelAccessRequestRecord } from "../types.ts";
import { buildDomainCutover } from "./cutover-runner.ts";
import { createPrismaCutoverMetricSink } from "./cutover-observability.ts";
import type { ReadCutoverMetric } from "./read-cutover.ts";
import {
  listChannelAccessRequestsPrisma,
  type ListChannelAccessRequestsPrismaInput,
} from "./channel-access-requests-prisma.ts";

export type ListChannelAccessRequestsPrismaCutoverMetric = ReadCutoverMetric;
export type ListChannelAccessRequestsPrismaCutoverMetricSink = (
  metric: ListChannelAccessRequestsPrismaCutoverMetric,
) => void;

const listChannelAccessRequestsPrismaCutoverImpl = buildDomainCutover<
  ListChannelAccessRequestsPrismaInput,
  StoredChannelAccessRequestRecord[],
  ListChannelAccessRequestsPrismaCutoverMetric
>({
  isEnabled: () => process.env.CHANNEL_ACCESS_REQUESTS_PRISMA_READ_ENABLED === "1",
  isShadowEnabled: () => process.env.CHANNEL_ACCESS_REQUESTS_PRISMA_SHADOW_READ_ENABLED === "1",
  runPrimary: async (input) => listChannelAccessRequestsPrisma(input),
  runFallback: (input) => listChannelAccessRequestsSync(input.workspaceId, input.options),
  compare: (primary, fallback) => recordsEqual(primary, fallback),
  emitMetric: createPrismaCutoverMetricSink({
    domain: "channel_access_request",
    operation: "list",
  }),
});

export function listChannelAccessRequestsPrismaCutover(
  input: ListChannelAccessRequestsPrismaInput,
  metricSink?: ListChannelAccessRequestsPrismaCutoverMetricSink,
): Promise<StoredChannelAccessRequestRecord[]> {
  return listChannelAccessRequestsPrismaCutoverImpl(input, metricSink);
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
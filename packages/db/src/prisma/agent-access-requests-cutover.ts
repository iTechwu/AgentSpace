// @deprecated — Phase 2 pg 原型 cutover，保留作 Prisma 接入迁移期 fallback。
// 生产路径走 agent-access-requests-prisma-cutover.ts。

import { listAgentAccessRequestsSync } from "../agent-access-requests.ts";
import type { AgentAccessRequestRecord } from "../types.ts";
import {
  isAgentAccessRequestsAsyncReadEnabled,
  isAgentAccessRequestsShadowReadEnabled,
  listAgentAccessRequestsAsync,
} from "./agent-access-requests-async.ts";
import { buildDomainCutover } from "./cutover-runner.ts";
import type { ReadCutoverMetric } from "./read-cutover.ts";

export type ListAgentAccessRequestsCutoverMetric = ReadCutoverMetric;
export type ListAgentAccessRequestsCutoverMetricSink = (
  metric: ListAgentAccessRequestsCutoverMetric,
) => void;

export interface ListAgentAccessRequestsInput {
  workspaceId: string;
  options?: {
    sourceAgentName?: string;
    requesterUserId?: string;
    requestType?: AgentAccessRequestRecord["requestType"];
    statuses?: AgentAccessRequestRecord["status"][];
  };
}

/**
 * @deprecated Use {@link listAgentAccessRequestsPrismaCutover} instead.
 * Kept as Prisma 接入迁移期 fallback + 影子对比驱动。
 */
export function listAgentAccessRequestsCutover(
  input: ListAgentAccessRequestsInput,
  metricSink?: ListAgentAccessRequestsCutoverMetricSink,
): Promise<AgentAccessRequestRecord[]> {
  return buildDomainCutover<
    ListAgentAccessRequestsInput,
    AgentAccessRequestRecord[],
    ListAgentAccessRequestsCutoverMetric
  >({
    isEnabled: isAgentAccessRequestsAsyncReadEnabled,
    isShadowEnabled: isAgentAccessRequestsShadowReadEnabled,
    runPrimary: async (i) => listAgentAccessRequestsAsync(i.workspaceId, i.options),
    runFallback: (i) => listAgentAccessRequestsSync(i.workspaceId, i.options),
    compare: (primary, fallback) => recordsEqual(primary, fallback),
  })(input, metricSink);
}

export function recordsEqual(
  primary: AgentAccessRequestRecord[],
  fallback: AgentAccessRequestRecord[],
): boolean {
  if (primary.length !== fallback.length) return false;
  for (let i = 0; i < primary.length; i += 1) {
    if (!recordEqual(primary[i]!, fallback[i]!)) return false;
  }
  return true;
}

function recordEqual(
  primary: AgentAccessRequestRecord,
  fallback: AgentAccessRequestRecord,
): boolean {
  const auditEqual = normalizeJsonEqual(primary.auditDataJson, fallback.auditDataJson);
  return (
    primary.id === fallback.id &&
    primary.workspaceId === fallback.workspaceId &&
    primary.sourceAgentName === fallback.sourceAgentName &&
    primary.requesterUserId === fallback.requesterUserId &&
    primary.requestType === fallback.requestType &&
    primary.targetChannelName === fallback.targetChannelName &&
    primary.status === fallback.status &&
    primary.reason === fallback.reason &&
    primary.resolverUserId === fallback.resolverUserId &&
    primary.resolvedAt === fallback.resolvedAt &&
    primary.createdAt === fallback.createdAt &&
    primary.updatedAt === fallback.updatedAt &&
    primary.forkInvitationId === fallback.forkInvitationId &&
    auditEqual
  );
}

function normalizeJsonEqual(a: string, b: string): boolean {
  try {
    return JSON.stringify(JSON.parse(a)) === JSON.stringify(JSON.parse(b));
  } catch {
    return a === b;
  }
}
// agent-access-request read cutover runner（真 Prisma Client primary）：
// Phase 2 第十一域生产路径。pg 原型同款 runner 见 agent-access-requests-cutover.ts
// （@deprecated）。

import { listAgentAccessRequestsSync } from "../agent-access-requests.ts";
import type { AgentAccessRequestRecord } from "../types.ts";
import { buildDomainCutover } from "./cutover-runner.ts";
import { createPrismaCutoverMetricSink } from "./cutover-observability.ts";
import type { ReadCutoverMetric } from "./read-cutover.ts";
import {
  isAgentAccessRequestsPrismaReadEnabled,
  isAgentAccessRequestsPrismaShadowReadEnabled,
  listAgentAccessRequestsPrisma,
  type ListAgentAccessRequestsPrismaInput,
} from "./agent-access-requests-prisma.ts";

export type ListAgentAccessRequestsPrismaCutoverMetric = ReadCutoverMetric;
export type ListAgentAccessRequestsPrismaCutoverMetricSink = (
  metric: ListAgentAccessRequestsPrismaCutoverMetric,
) => void;

const listAgentAccessRequestsPrismaCutoverImpl = buildDomainCutover<
  ListAgentAccessRequestsPrismaInput,
  AgentAccessRequestRecord[],
  ListAgentAccessRequestsPrismaCutoverMetric
>({
  isEnabled: isAgentAccessRequestsPrismaReadEnabled,
  isShadowEnabled: isAgentAccessRequestsPrismaShadowReadEnabled,
  runPrimary: async (input) => listAgentAccessRequestsPrisma(input),
  runFallback: (input) => listAgentAccessRequestsSync(input.workspaceId, input.options),
  compare: (primary, fallback) => recordsEqual(primary, fallback),
  emitMetric: createPrismaCutoverMetricSink({
    domain: "agent_access_request",
    operation: "list",
  }),
});

export function listAgentAccessRequestsPrismaCutover(
  input: ListAgentAccessRequestsPrismaInput,
  metricSink?: ListAgentAccessRequestsPrismaCutoverMetricSink,
): Promise<AgentAccessRequestRecord[]> {
  return listAgentAccessRequestsPrismaCutoverImpl(input, metricSink);
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
// knowledge-proposals read cutover runner（真 Prisma Client primary）：
// Phase 2 第八域生产路径。pg 原型同款 runner 见 knowledge-proposals-cutover.ts
// （@deprecated）。

import type {
  ListKnowledgeProposalsOptions,
  KnowledgeProposalRecord,
} from "../knowledge-proposals.ts";
import { buildDomainCutover } from "./cutover-runner.ts";
import { createPrismaCutoverMetricSink } from "./cutover-observability.ts";
import type { ReadCutoverMetric } from "./read-cutover.ts";
import {
  isKnowledgeProposalsPrismaReadEnabled,
  isKnowledgeProposalsPrismaShadowReadEnabled,
  listKnowledgeProposalsPrisma,
} from "./knowledge-proposals-prisma.ts";
import { listKnowledgeProposalsSync } from "../knowledge-proposals.ts";

export type ListKnowledgeProposalsPrismaCutoverMetric = ReadCutoverMetric;
export type ListKnowledgeProposalsPrismaCutoverMetricSink = (
  metric: ListKnowledgeProposalsPrismaCutoverMetric,
) => void;

const listKnowledgeProposalsPrismaCutoverImpl = buildDomainCutover<
  { workspaceId: string; options?: ListKnowledgeProposalsOptions },
  KnowledgeProposalRecord[],
  ListKnowledgeProposalsPrismaCutoverMetric
>({
  isEnabled: isKnowledgeProposalsPrismaReadEnabled,
  isShadowEnabled: isKnowledgeProposalsPrismaShadowReadEnabled,
  runPrimary: async (input) => listKnowledgeProposalsPrisma(input.workspaceId, input.options),
  runFallback: (input) => listKnowledgeProposalsSync(input.workspaceId, input.options),
  compare: (primary, fallback) => recordsEqual(primary, fallback),
  emitMetric: createPrismaCutoverMetricSink({ domain: "knowledge_proposals", operation: "list" }),
});

export function listKnowledgeProposalsPrismaCutover(
  workspaceId: string,
  options?: ListKnowledgeProposalsOptions,
  metricSink?: ListKnowledgeProposalsPrismaCutoverMetricSink,
): Promise<KnowledgeProposalRecord[]> {
  return listKnowledgeProposalsPrismaCutoverImpl(
    { workspaceId, options },
    metricSink,
  );
}

export function recordsEqual(
  primary: KnowledgeProposalRecord[],
  fallback: KnowledgeProposalRecord[],
): boolean {
  if (primary.length !== fallback.length) return false;
  for (let i = 0; i < primary.length; i += 1) {
    if (!recordEqual(primary[i]!, fallback[i]!)) return false;
  }
  return true;
}

function recordEqual(
  primary: KnowledgeProposalRecord,
  fallback: KnowledgeProposalRecord,
): boolean {
  const tagsEqual = arrayEqual(primary.tags, fallback.tags);
  const assignedEqual = arrayEqual(primary.assignedEmployeeNames, fallback.assignedEmployeeNames);
  return (
    primary.id === fallback.id &&
    primary.workspaceId === fallback.workspaceId &&
    primary.sourceTaskQueueId === fallback.sourceTaskQueueId &&
    primary.sourceChannelName === fallback.sourceChannelName &&
    primary.sourceAgentName === fallback.sourceAgentName &&
    primary.operation === fallback.operation &&
    primary.status === fallback.status &&
    primary.title === fallback.title &&
    primary.contentMarkdown === fallback.contentMarkdown &&
    primary.summary === fallback.summary &&
    primary.reason === fallback.reason &&
    tagsEqual &&
    primary.parentId === fallback.parentId &&
    primary.assignmentMode === fallback.assignmentMode &&
    assignedEqual &&
    primary.targetKnowledgePageId === fallback.targetKnowledgePageId &&
    primary.baseUpdatedAt === fallback.baseUpdatedAt &&
    primary.createdKnowledgePageId === fallback.createdKnowledgePageId &&
    primary.approvalId === fallback.approvalId &&
    primary.decidedByUserId === fallback.decidedByUserId &&
    primary.decidedAt === fallback.decidedAt &&
    primary.reviewerComment === fallback.reviewerComment &&
    primary.createdAt === fallback.createdAt &&
    primary.updatedAt === fallback.updatedAt
  );
}

function arrayEqual(a: readonly string[], b: readonly string[]): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i += 1) {
    if (a[i] !== b[i]) return false;
  }
  return true;
}

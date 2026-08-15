// @deprecated — Phase 2 pg 原型 cutover，保留作 Prisma 接入迁移期 fallback。
// 生产路径走 knowledge-proposals-prisma-cutover.ts。
//
// knowledge-proposals read cutover runner：把 sync `listKnowledgeProposalsSync`
// 与 async primary `listKnowledgeProposalsAsync` 接到通用 cutover-runner。

import { listKnowledgeProposalsSync } from "../knowledge-proposals.ts";
import type {
  ListKnowledgeProposalsOptions,
  KnowledgeProposalRecord,
} from "../knowledge-proposals.ts";
import {
  isKnowledgeProposalsAsyncReadEnabled,
  isKnowledgeProposalsShadowReadEnabled,
  listKnowledgeProposalsAsync,
} from "./knowledge-proposals-async.ts";
import { buildDomainCutover } from "./cutover-runner.ts";
import type { ReadCutoverMetric } from "./read-cutover.ts";

export type ListKnowledgeProposalsCutoverMetric = ReadCutoverMetric;
export type ListKnowledgeProposalsCutoverMetricSink = (
  metric: ListKnowledgeProposalsCutoverMetric,
) => void;

/**
 * @deprecated Use {@link listKnowledgeProposalsPrismaCutover} instead.
 * Kept as Prisma 接入迁移期 fallback + 影子对比驱动。
 */
export function listKnowledgeProposalsCutover(
  workspaceId: string,
  options?: ListKnowledgeProposalsOptions,
  metricSink?: ListKnowledgeProposalsCutoverMetricSink,
): Promise<KnowledgeProposalRecord[]> {
  return buildDomainCutover<
    { workspaceId: string; options?: ListKnowledgeProposalsOptions },
    KnowledgeProposalRecord[],
    ListKnowledgeProposalsCutoverMetric
  >({
    isEnabled: isKnowledgeProposalsAsyncReadEnabled,
    isShadowEnabled: isKnowledgeProposalsShadowReadEnabled,
    runPrimary: async (input) => listKnowledgeProposalsAsync(input.workspaceId, input.options),
    runFallback: (input) => listKnowledgeProposalsSync(input.workspaceId, input.options),
    compare: (primary, fallback) => recordsEqual(primary, fallback),
  })({ workspaceId, options }, metricSink);
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
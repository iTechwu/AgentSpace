// @deprecated — Phase 2 pg 原型 cutover，保留作 Prisma 接入迁移期 fallback。
// 生产路径走 workflow-runs-prisma-cutover.ts。

import { listWorkflowRunsSync } from "../workflows/runs.ts";
import type { WorkflowRunRecord } from "../types.ts";
import {
  isWorkflowRunsAsyncReadEnabled,
  isWorkflowRunsShadowReadEnabled,
  listWorkflowRunsAsync,
} from "./workflow-runs-async.ts";
import { buildDomainCutover } from "./cutover-runner.ts";
import type { ReadCutoverMetric } from "./read-cutover.ts";

export type ListWorkflowRunsCutoverMetric = ReadCutoverMetric;
export type ListWorkflowRunsCutoverMetricSink = (
  metric: ListWorkflowRunsCutoverMetric,
) => void;

export interface ListWorkflowRunsInput {
  workspaceId: string;
  limit?: number;
  offset?: number;
}

/**
 * @deprecated Use {@link listWorkflowRunsPrismaCutover} instead.
 * Kept as Prisma 接入迁移期 fallback + 影子对比驱动。
 */
export function listWorkflowRunsCutover(
  input: ListWorkflowRunsInput,
  metricSink?: ListWorkflowRunsCutoverMetricSink,
): Promise<WorkflowRunRecord[]> {
  return buildDomainCutover<
    ListWorkflowRunsInput,
    WorkflowRunRecord[],
    ListWorkflowRunsCutoverMetric
  >({
    isEnabled: isWorkflowRunsAsyncReadEnabled,
    isShadowEnabled: isWorkflowRunsShadowReadEnabled,
    runPrimary: async (i) => listWorkflowRunsAsync(i.workspaceId, i.limit, i.offset),
    runFallback: (i) => listWorkflowRunsSync(i.workspaceId, i.limit, i.offset),
    compare: (primary, fallback) => recordsEqual(primary, fallback),
  })(input, metricSink);
}

export function recordsEqual(
  primary: WorkflowRunRecord[],
  fallback: WorkflowRunRecord[],
): boolean {
  if (primary.length !== fallback.length) return false;
  for (let i = 0; i < primary.length; i += 1) {
    if (!recordEqual(primary[i]!, fallback[i]!)) return false;
  }
  return true;
}

function recordEqual(
  primary: WorkflowRunRecord,
  fallback: WorkflowRunRecord,
): boolean {
  return (
    primary.id === fallback.id &&
    primary.workspaceId === fallback.workspaceId &&
    primary.workflowId === fallback.workflowId &&
    primary.versionId === fallback.versionId &&
    primary.rootTaskId === fallback.rootTaskId &&
    primary.triggerId === fallback.triggerId &&
    primary.triggerType === fallback.triggerType &&
    primary.triggerKey === fallback.triggerKey &&
    primary.inputJson === fallback.inputJson &&
    primary.status === fallback.status &&
    primary.currentSequence === fallback.currentSequence &&
    primary.budgetJson === fallback.budgetJson &&
    primary.startedAt === fallback.startedAt &&
    primary.finishedAt === fallback.finishedAt &&
    primary.createdBy === fallback.createdBy &&
    primary.createdAt === fallback.createdAt &&
    primary.updatedAt === fallback.updatedAt
  );
}
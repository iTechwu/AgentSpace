// @deprecated — Phase 2 pg 原型 cutover，保留作 Prisma 接入迁移期 fallback。
// 生产路径走 workflow-node-runs-prisma-cutover.ts。

import { listWorkflowNodeRunsSync } from "../workflows/runs.ts";
import type { WorkflowNodeRunRecord } from "../types.ts";
import {
  isWorkflowNodeRunsAsyncReadEnabled,
  isWorkflowNodeRunsShadowReadEnabled,
  listWorkflowNodeRunsAsync,
} from "./workflow-node-runs-async.ts";
import { buildDomainCutover } from "./cutover-runner.ts";
import type { ReadCutoverMetric } from "./read-cutover.ts";

export type ListWorkflowNodeRunsCutoverMetric = ReadCutoverMetric;
export type ListWorkflowNodeRunsCutoverMetricSink = (
  metric: ListWorkflowNodeRunsCutoverMetric,
) => void;

export interface ListWorkflowNodeRunsInput {
  workspaceId: string;
  runId: string;
}

/**
 * @deprecated Use {@link listWorkflowNodeRunsPrismaCutover} instead.
 * Kept as Prisma 接入迁移期 fallback + 影子对比驱动。
 */
export function listWorkflowNodeRunsCutover(
  input: ListWorkflowNodeRunsInput,
  metricSink?: ListWorkflowNodeRunsCutoverMetricSink,
): Promise<WorkflowNodeRunRecord[]> {
  return buildDomainCutover<
    ListWorkflowNodeRunsInput,
    WorkflowNodeRunRecord[],
    ListWorkflowNodeRunsCutoverMetric
  >({
    isEnabled: isWorkflowNodeRunsAsyncReadEnabled,
    isShadowEnabled: isWorkflowNodeRunsShadowReadEnabled,
    runPrimary: async (i) => listWorkflowNodeRunsAsync(i.workspaceId, i.runId),
    runFallback: (i) => listWorkflowNodeRunsSync(i.workspaceId, i.runId),
    compare: (primary, fallback) => recordsEqual(primary, fallback),
  })(input, metricSink);
}

export function recordsEqual(
  primary: WorkflowNodeRunRecord[],
  fallback: WorkflowNodeRunRecord[],
): boolean {
  if (primary.length !== fallback.length) return false;
  for (let i = 0; i < primary.length; i += 1) {
    if (!recordEqual(primary[i]!, fallback[i]!)) return false;
  }
  return true;
}

function recordEqual(
  primary: WorkflowNodeRunRecord,
  fallback: WorkflowNodeRunRecord,
): boolean {
  return (
    primary.id === fallback.id &&
    primary.workspaceId === fallback.workspaceId &&
    primary.runId === fallback.runId &&
    primary.nodeId === fallback.nodeId &&
    primary.nodeType === fallback.nodeType &&
    primary.employeeId === fallback.employeeId &&
    primary.employeeNameSnapshot === fallback.employeeNameSnapshot &&
    primary.status === fallback.status &&
    primary.attemptCount === fallback.attemptCount &&
    primary.maxAttempts === fallback.maxAttempts &&
    primary.availableAt === fallback.availableAt &&
    primary.taskQueueId === fallback.taskQueueId &&
    primary.approvalId === fallback.approvalId &&
    primary.approvalDeadline === fallback.approvalDeadline &&
    primary.approvalScanAfter === fallback.approvalScanAfter &&
    primary.inputJson === fallback.inputJson &&
    primary.outputJson === fallback.outputJson &&
    primary.artifactManifestJson === fallback.artifactManifestJson &&
    primary.errorCode === fallback.errorCode &&
    primary.errorMessage === fallback.errorMessage &&
    primary.startedAt === fallback.startedAt &&
    primary.finishedAt === fallback.finishedAt &&
    primary.createdAt === fallback.createdAt &&
    primary.updatedAt === fallback.updatedAt
  );
}

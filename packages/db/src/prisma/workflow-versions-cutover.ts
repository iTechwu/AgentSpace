// @deprecated — Phase 2 pg 原型 cutover，保留作 Prisma 接入迁移期 fallback。
// 生产路径走 workflow-versions-prisma-cutover.ts。

import { listWorkflowVersionsSync } from "../workflows/definitions.ts";
import type { WorkflowVersionRecord } from "../types.ts";
import {
  isWorkflowVersionsAsyncReadEnabled,
  isWorkflowVersionsShadowReadEnabled,
  listWorkflowVersionsAsync,
} from "./workflow-versions-async.ts";
import { buildDomainCutover } from "./cutover-runner.ts";
import type { ReadCutoverMetric } from "./read-cutover.ts";

export type ListWorkflowVersionsCutoverMetric = ReadCutoverMetric;
export type ListWorkflowVersionsCutoverMetricSink = (
  metric: ListWorkflowVersionsCutoverMetric,
) => void;

export interface ListWorkflowVersionsInput {
  workflowId: string;
  workspaceId: string;
}

/**
 * @deprecated Use {@link listWorkflowVersionsPrismaCutover} instead.
 * Kept as Prisma 接入迁移期 fallback + 影子对比驱动。
 */
export function listWorkflowVersionsCutover(
  input: ListWorkflowVersionsInput,
  metricSink?: ListWorkflowVersionsCutoverMetricSink,
): Promise<WorkflowVersionRecord[]> {
  return buildDomainCutover<
    ListWorkflowVersionsInput,
    WorkflowVersionRecord[],
    ListWorkflowVersionsCutoverMetric
  >({
    isEnabled: isWorkflowVersionsAsyncReadEnabled,
    isShadowEnabled: isWorkflowVersionsShadowReadEnabled,
    runPrimary: async (i) => listWorkflowVersionsAsync(i.workflowId, i.workspaceId),
    runFallback: (i) => listWorkflowVersionsSync(i.workflowId, i.workspaceId),
    compare: (primary, fallback) => recordsEqual(primary, fallback),
  })(input, metricSink);
}

export function recordsEqual(
  primary: WorkflowVersionRecord[],
  fallback: WorkflowVersionRecord[],
): boolean {
  if (primary.length !== fallback.length) return false;
  for (let i = 0; i < primary.length; i += 1) {
    if (!recordEqual(primary[i]!, fallback[i]!)) return false;
  }
  return true;
}

function recordEqual(
  primary: WorkflowVersionRecord,
  fallback: WorkflowVersionRecord,
): boolean {
  return (
    primary.id === fallback.id &&
    primary.workspaceId === fallback.workspaceId &&
    primary.workflowId === fallback.workflowId &&
    primary.versionNumber === fallback.versionNumber &&
    primary.schemaVersion === fallback.schemaVersion &&
    primary.graphJson === fallback.graphJson &&
    primary.inputSchemaJson === fallback.inputSchemaJson &&
    primary.outputSchemaJson === fallback.outputSchemaJson &&
    primary.governanceJson === fallback.governanceJson &&
    primary.contentHash === fallback.contentHash &&
    primary.publishedBy === fallback.publishedBy &&
    primary.publishedAt === fallback.publishedAt &&
    primary.createdAt === fallback.createdAt
  );
}

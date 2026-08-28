// @deprecated — Phase 2 pg 原型 cutover，保留作 Prisma 接入迁移期 fallback。
// 生产路径走 workflow-definitions-prisma-cutover.ts。

import { listWorkflowDefinitionsSync } from "../workflows/definitions.ts";
import type { WorkflowDefinitionRecord } from "../types.ts";
import {
  isWorkflowDefinitionsAsyncReadEnabled,
  isWorkflowDefinitionsShadowReadEnabled,
  listWorkflowDefinitionsAsync,
} from "./workflow-definitions-async.ts";
import { buildDomainCutover } from "./cutover-runner.ts";
import type { ReadCutoverMetric } from "./read-cutover.ts";

export type ListWorkflowDefinitionsCutoverMetric = ReadCutoverMetric;
export type ListWorkflowDefinitionsCutoverMetricSink = (
  metric: ListWorkflowDefinitionsCutoverMetric,
) => void;

/**
 * @deprecated Use {@link listWorkflowDefinitionsPrismaCutover} instead.
 * Kept as Prisma 接入迁移期 fallback + 影子对比驱动。
 */
export function listWorkflowDefinitionsCutover(
  workspaceId: string,
  metricSink?: ListWorkflowDefinitionsCutoverMetricSink,
): Promise<WorkflowDefinitionRecord[]> {
  return buildDomainCutover<
    string,
    WorkflowDefinitionRecord[],
    ListWorkflowDefinitionsCutoverMetric
  >({
    isEnabled: isWorkflowDefinitionsAsyncReadEnabled,
    isShadowEnabled: isWorkflowDefinitionsShadowReadEnabled,
    runPrimary: async (id) => listWorkflowDefinitionsAsync(id),
    runFallback: (id) => listWorkflowDefinitionsSync(id),
    compare: (primary, fallback) => recordsEqual(primary, fallback),
  })(workspaceId, metricSink);
}

export function recordsEqual(
  primary: WorkflowDefinitionRecord[],
  fallback: WorkflowDefinitionRecord[],
): boolean {
  if (primary.length !== fallback.length) return false;
  for (let i = 0; i < primary.length; i += 1) {
    if (!recordEqual(primary[i]!, fallback[i]!)) return false;
  }
  return true;
}

function recordEqual(
  primary: WorkflowDefinitionRecord,
  fallback: WorkflowDefinitionRecord,
): boolean {
  return (
    primary.id === fallback.id &&
    primary.workspaceId === fallback.workspaceId &&
    primary.name === fallback.name &&
    primary.description === fallback.description &&
    primary.ownerUserId === fallback.ownerUserId &&
    primary.channelName === fallback.channelName &&
    primary.status === fallback.status &&
    primary.draftGraphJson === fallback.draftGraphJson &&
    primary.draftVersion === fallback.draftVersion &&
    primary.activeVersionId === fallback.activeVersionId &&
    primary.legacySourceType === fallback.legacySourceType &&
    primary.legacySourceId === fallback.legacySourceId &&
    primary.createdBy === fallback.createdBy &&
    primary.createdAt === fallback.createdAt &&
    primary.updatedAt === fallback.updatedAt &&
    primary.archivedAt === fallback.archivedAt
  );
}
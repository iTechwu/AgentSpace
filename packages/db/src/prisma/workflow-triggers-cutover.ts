// @deprecated — Phase 2 pg 原型 cutover，保留作 Prisma 接入迁移期 fallback。
// 生产路径走 workflow-triggers-prisma-cutover.ts。

import { listWorkflowTriggersForWorkflowSync } from "../workflows/definitions.ts";
import type { WorkflowTriggerRecord } from "../types.ts";
import {
  isWorkflowTriggersAsyncReadEnabled,
  isWorkflowTriggersShadowReadEnabled,
  listWorkflowTriggersForWorkflowAsync,
} from "./workflow-triggers-async.ts";
import { buildDomainCutover } from "./cutover-runner.ts";
import type { ReadCutoverMetric } from "./read-cutover.ts";

export type ListWorkflowTriggersCutoverMetric = ReadCutoverMetric;
export type ListWorkflowTriggersCutoverMetricSink = (
  metric: ListWorkflowTriggersCutoverMetric,
) => void;

export interface ListWorkflowTriggersInput {
  workflowId: string;
  workspaceId: string;
}

/**
 * @deprecated Use {@link listWorkflowTriggersPrismaCutover} instead.
 * Kept as Prisma 接入迁移期 fallback + 影子对比驱动。
 */
export function listWorkflowTriggersCutover(
  input: ListWorkflowTriggersInput,
  metricSink?: ListWorkflowTriggersCutoverMetricSink,
): Promise<WorkflowTriggerRecord[]> {
  return buildDomainCutover<
    ListWorkflowTriggersInput,
    WorkflowTriggerRecord[],
    ListWorkflowTriggersCutoverMetric
  >({
    isEnabled: isWorkflowTriggersAsyncReadEnabled,
    isShadowEnabled: isWorkflowTriggersShadowReadEnabled,
    runPrimary: async (i) => listWorkflowTriggersForWorkflowAsync(i.workflowId, i.workspaceId),
    runFallback: (i) => listWorkflowTriggersForWorkflowSync(i.workflowId, i.workspaceId),
    compare: (primary, fallback) => recordsEqual(primary, fallback),
  })(input, metricSink);
}

export function recordsEqual(
  primary: WorkflowTriggerRecord[],
  fallback: WorkflowTriggerRecord[],
): boolean {
  if (primary.length !== fallback.length) return false;
  for (let i = 0; i < primary.length; i += 1) {
    if (!recordEqual(primary[i]!, fallback[i]!)) return false;
  }
  return true;
}

function recordEqual(
  primary: WorkflowTriggerRecord,
  fallback: WorkflowTriggerRecord,
): boolean {
  return (
    primary.id === fallback.id &&
    primary.workspaceId === fallback.workspaceId &&
    primary.workflowId === fallback.workflowId &&
    primary.type === fallback.type &&
    primary.configJson === fallback.configJson &&
    primary.timezone === fallback.timezone &&
    primary.status === fallback.status &&
    primary.nextFireAt === fallback.nextFireAt &&
    primary.lastFireAt === fallback.lastFireAt &&
    primary.misfirePolicy === fallback.misfirePolicy &&
    primary.dedupeWindowSeconds === fallback.dedupeWindowSeconds &&
    primary.leaseOwner === fallback.leaseOwner &&
    primary.leaseExpiresAt === fallback.leaseExpiresAt &&
    primary.createdAt === fallback.createdAt &&
    primary.updatedAt === fallback.updatedAt
  );
}

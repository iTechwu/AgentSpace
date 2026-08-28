// workflow-trigger read cutover runner（真 Prisma Client primary）：
// Phase 2 第二十域生产路径。pg 原型同款 runner 见 workflow-triggers-cutover.ts
// （@deprecated）。

import { listWorkflowTriggersForWorkflowSync } from "../workflows/definitions.ts";
import type { WorkflowTriggerRecord } from "../types.ts";
import { buildDomainCutover } from "./cutover-runner.ts";
import { createPrismaCutoverMetricSink } from "./cutover-observability.ts";
import type { ReadCutoverMetric } from "./read-cutover.ts";
import {
  listWorkflowTriggersForWorkflowPrisma,
  type ListWorkflowTriggersPrismaInput,
} from "./workflow-triggers-prisma.ts";

export type ListWorkflowTriggersPrismaCutoverMetric = ReadCutoverMetric;
export type ListWorkflowTriggersPrismaCutoverMetricSink = (
  metric: ListWorkflowTriggersPrismaCutoverMetric,
) => void;

const listWorkflowTriggersPrismaCutoverImpl = buildDomainCutover<
  ListWorkflowTriggersPrismaInput,
  WorkflowTriggerRecord[],
  ListWorkflowTriggersPrismaCutoverMetric
>({
  isEnabled: () => process.env.WORKFLOW_TRIGGERS_PRISMA_READ_ENABLED === "1",
  isShadowEnabled: () => process.env.WORKFLOW_TRIGGERS_PRISMA_SHADOW_READ_ENABLED === "1",
  runPrimary: async (input) => listWorkflowTriggersForWorkflowPrisma(input),
  runFallback: (input) =>
    listWorkflowTriggersForWorkflowSync(input.workflowId, input.workspaceId),
  compare: (primary, fallback) => recordsEqual(primary, fallback),
  emitMetric: createPrismaCutoverMetricSink({
    domain: "workflow_trigger",
    operation: "list",
  }),
});

export function listWorkflowTriggersPrismaCutover(
  input: ListWorkflowTriggersPrismaInput,
  metricSink?: ListWorkflowTriggersPrismaCutoverMetricSink,
): Promise<WorkflowTriggerRecord[]> {
  return listWorkflowTriggersPrismaCutoverImpl(input, metricSink);
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

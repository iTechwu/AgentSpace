// workflow-definition read cutover runner（真 Prisma Client primary）：
// Phase 2 第十四域生产路径。pg 原型同款 runner 见 workflow-definitions-cutover.ts
// （@deprecated）。

import { listWorkflowDefinitionsSync } from "../workflows/definitions.ts";
import type { WorkflowDefinitionRecord } from "../types.ts";
import { buildDomainCutover } from "./cutover-runner.ts";
import { createPrismaCutoverMetricSink } from "./cutover-observability.ts";
import type { ReadCutoverMetric } from "./read-cutover.ts";
import { listWorkflowDefinitionsPrisma } from "./workflow-definitions-prisma.ts";

export type ListWorkflowDefinitionsPrismaCutoverMetric = ReadCutoverMetric;
export type ListWorkflowDefinitionsPrismaCutoverMetricSink = (
  metric: ListWorkflowDefinitionsPrismaCutoverMetric,
) => void;

const listWorkflowDefinitionsPrismaCutoverImpl = buildDomainCutover<
  string,
  WorkflowDefinitionRecord[],
  ListWorkflowDefinitionsPrismaCutoverMetric
>({
  isEnabled: () => process.env.WORKFLOW_DEFINITIONS_PRISMA_READ_ENABLED === "1",
  isShadowEnabled: () => process.env.WORKFLOW_DEFINITIONS_PRISMA_SHADOW_READ_ENABLED === "1",
  runPrimary: async (workspaceId) => listWorkflowDefinitionsPrisma(workspaceId),
  runFallback: (workspaceId) => listWorkflowDefinitionsSync(workspaceId),
  compare: (primary, fallback) => recordsEqual(primary, fallback),
  emitMetric: createPrismaCutoverMetricSink({
    domain: "workflow_definition",
    operation: "list",
  }),
});

export function listWorkflowDefinitionsPrismaCutover(
  workspaceId: string,
  metricSink?: ListWorkflowDefinitionsPrismaCutoverMetricSink,
): Promise<WorkflowDefinitionRecord[]> {
  return listWorkflowDefinitionsPrismaCutoverImpl(workspaceId, metricSink);
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
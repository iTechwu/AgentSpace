// workflow-version read cutover runner（真 Prisma Client primary）：
// Phase 2 第二十二域生产路径。pg 原型同款 runner 见
// workflow-versions-cutover.ts（@deprecated）。

import { listWorkflowVersionsSync } from "../workflows/definitions.ts";
import type { WorkflowVersionRecord } from "../types.ts";
import { buildDomainCutover } from "./cutover-runner.ts";
import { createPrismaCutoverMetricSink } from "./cutover-observability.ts";
import type { ReadCutoverMetric } from "./read-cutover.ts";
import {
  listWorkflowVersionsPrisma,
  type ListWorkflowVersionsPrismaInput,
} from "./workflow-versions-prisma.ts";

export type ListWorkflowVersionsPrismaCutoverMetric = ReadCutoverMetric;
export type ListWorkflowVersionsPrismaCutoverMetricSink = (
  metric: ListWorkflowVersionsPrismaCutoverMetric,
) => void;

const listWorkflowVersionsPrismaCutoverImpl = buildDomainCutover<
  ListWorkflowVersionsPrismaInput,
  WorkflowVersionRecord[],
  ListWorkflowVersionsPrismaCutoverMetric
>({
  isEnabled: () => process.env.WORKFLOW_VERSIONS_PRISMA_READ_ENABLED === "1",
  isShadowEnabled: () => process.env.WORKFLOW_VERSIONS_PRISMA_SHADOW_READ_ENABLED === "1",
  runPrimary: async (input) => listWorkflowVersionsPrisma(input),
  runFallback: (input) =>
    listWorkflowVersionsSync(input.workflowId, input.workspaceId),
  compare: (primary, fallback) => recordsEqual(primary, fallback),
  emitMetric: createPrismaCutoverMetricSink({
    domain: "workflow_version",
    operation: "list",
  }),
});

export function listWorkflowVersionsPrismaCutover(
  input: ListWorkflowVersionsPrismaInput,
  metricSink?: ListWorkflowVersionsPrismaCutoverMetricSink,
): Promise<WorkflowVersionRecord[]> {
  return listWorkflowVersionsPrismaCutoverImpl(input, metricSink);
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

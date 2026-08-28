// workflow-run read cutover runner（真 Prisma Client primary）：
// Phase 2 第十九域生产路径。pg 原型同款 runner 见 workflow-runs-cutover.ts
// （@deprecated）。

import { listWorkflowRunsSync } from "../workflows/runs.ts";
import type { WorkflowRunRecord } from "../types.ts";
import { buildDomainCutover } from "./cutover-runner.ts";
import { createPrismaCutoverMetricSink } from "./cutover-observability.ts";
import type { ReadCutoverMetric } from "./read-cutover.ts";
import {
  listWorkflowRunsPrisma,
  type ListWorkflowRunsPrismaInput,
} from "./workflow-runs-prisma.ts";

export type ListWorkflowRunsPrismaCutoverMetric = ReadCutoverMetric;
export type ListWorkflowRunsPrismaCutoverMetricSink = (
  metric: ListWorkflowRunsPrismaCutoverMetric,
) => void;

const listWorkflowRunsPrismaCutoverImpl = buildDomainCutover<
  ListWorkflowRunsPrismaInput,
  WorkflowRunRecord[],
  ListWorkflowRunsPrismaCutoverMetric
>({
  isEnabled: () => process.env.WORKFLOW_RUNS_PRISMA_READ_ENABLED === "1",
  isShadowEnabled: () => process.env.WORKFLOW_RUNS_PRISMA_SHADOW_READ_ENABLED === "1",
  runPrimary: async (input) => listWorkflowRunsPrisma(input),
  runFallback: (input) => listWorkflowRunsSync(input.workspaceId, input.limit, input.offset),
  compare: (primary, fallback) => recordsEqual(primary, fallback),
  emitMetric: createPrismaCutoverMetricSink({
    domain: "workflow_run",
    operation: "list",
  }),
});

export function listWorkflowRunsPrismaCutover(
  input: ListWorkflowRunsPrismaInput,
  metricSink?: ListWorkflowRunsPrismaCutoverMetricSink,
): Promise<WorkflowRunRecord[]> {
  return listWorkflowRunsPrismaCutoverImpl(input, metricSink);
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
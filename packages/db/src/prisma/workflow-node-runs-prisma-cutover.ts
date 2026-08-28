// workflow-node-run read cutover runner（真 Prisma Client primary）：
// Phase 2 第二十一域生产路径。pg 原型同款 runner 见
// workflow-node-runs-cutover.ts（@deprecated）。

import { listWorkflowNodeRunsSync } from "../workflows/runs.ts";
import type { WorkflowNodeRunRecord } from "../types.ts";
import { buildDomainCutover } from "./cutover-runner.ts";
import { createPrismaCutoverMetricSink } from "./cutover-observability.ts";
import type { ReadCutoverMetric } from "./read-cutover.ts";
import {
  listWorkflowNodeRunsPrisma,
  type ListWorkflowNodeRunsPrismaInput,
} from "./workflow-node-runs-prisma.ts";

export type ListWorkflowNodeRunsPrismaCutoverMetric = ReadCutoverMetric;
export type ListWorkflowNodeRunsPrismaCutoverMetricSink = (
  metric: ListWorkflowNodeRunsPrismaCutoverMetric,
) => void;

const listWorkflowNodeRunsPrismaCutoverImpl = buildDomainCutover<
  ListWorkflowNodeRunsPrismaInput,
  WorkflowNodeRunRecord[],
  ListWorkflowNodeRunsPrismaCutoverMetric
>({
  isEnabled: () => process.env.WORKFLOW_NODE_RUNS_PRISMA_READ_ENABLED === "1",
  isShadowEnabled: () => process.env.WORKFLOW_NODE_RUNS_PRISMA_SHADOW_READ_ENABLED === "1",
  runPrimary: async (input) => listWorkflowNodeRunsPrisma(input),
  runFallback: (input) => listWorkflowNodeRunsSync(input.workspaceId, input.runId),
  compare: (primary, fallback) => recordsEqual(primary, fallback),
  emitMetric: createPrismaCutoverMetricSink({
    domain: "workflow_node_run",
    operation: "list",
  }),
});

export function listWorkflowNodeRunsPrismaCutover(
  input: ListWorkflowNodeRunsPrismaInput,
  metricSink?: ListWorkflowNodeRunsPrismaCutoverMetricSink,
): Promise<WorkflowNodeRunRecord[]> {
  return listWorkflowNodeRunsPrismaCutoverImpl(input, metricSink);
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

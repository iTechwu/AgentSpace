import { isWorkflowNodeType, type WorkflowNodeRunStatus, type WorkflowNodeType, type WorkflowRunStatus } from "@dofe-agent/domain";

const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const STATUSES = new Set<WorkflowRunStatus | WorkflowNodeRunStatus>([
  "created", "queued", "running", "waiting_approval", "paused", "succeeded",
  "partially_succeeded", "failed", "cancelled", "pending", "ready", "retry_wait", "skipped",
]);

export const WORKFLOW_METRICS = Object.freeze({
  triggerLagSeconds: { name: "workflow_trigger_lag_seconds", kind: "histogram", unit: "seconds" },
  runDurationSeconds: { name: "workflow_run_duration_seconds", kind: "histogram", unit: "seconds" },
  nodeFailuresTotal: { name: "workflow_node_failures_total", kind: "counter", unit: "failures" },
  joinWaitSeconds: { name: "workflow_join_wait_seconds", kind: "histogram", unit: "seconds" },
  manualInterventionTotal: { name: "workflow_manual_intervention_total", kind: "counter", unit: "interventions" },
} as const);

export interface WorkflowMetricLabelInput {
  workspaceId: string;
  workflowId: string;
  nodeType: WorkflowNodeType;
  status: WorkflowRunStatus | WorkflowNodeRunStatus;
}

export function buildWorkflowMetricLabels(input: WorkflowMetricLabelInput): Record<string, string> {
  return {
    workspaceId: safeIdentifier(input.workspaceId),
    workflowId: safeIdentifier(input.workflowId),
    nodeType: isWorkflowNodeType(input.nodeType) ? input.nodeType : "unknown",
    status: STATUSES.has(input.status) ? input.status : "unknown",
  };
}

export interface WorkflowLogInput {
  eventCode: string;
  workspaceId: string;
  workflowId: string;
  runId?: string;
  nodeRunId?: string;
  status?: WorkflowRunStatus | WorkflowNodeRunStatus;
  count?: number;
  durationMs?: number;
}

export function buildWorkflowLogRecord(input: WorkflowLogInput): Record<string, string | number> {
  const record: Record<string, string | number> = {
    eventCode: safeIdentifier(input.eventCode),
    workspaceId: safeIdentifier(input.workspaceId),
    workflowId: safeIdentifier(input.workflowId),
  };
  if (input.runId) record.runId = safeIdentifier(input.runId);
  if (input.nodeRunId) record.nodeRunId = safeIdentifier(input.nodeRunId);
  if (input.status) record.status = STATUSES.has(input.status) ? input.status : "unknown";
  if (input.count !== undefined) record.count = safeNonNegativeNumber(input.count);
  if (input.durationMs !== undefined) record.durationMs = safeNonNegativeNumber(input.durationMs);
  return record;
}

function safeIdentifier(value: string): string {
  return SAFE_ID.test(value) ? value : "unknown";
}

function safeNonNegativeNumber(value: number): number {
  return Number.isFinite(value) && value >= 0 ? value : 0;
}

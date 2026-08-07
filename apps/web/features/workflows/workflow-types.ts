import type {
  WorkflowDefinitionStatus,
  WorkflowGraphDefinition,
  WorkflowRunStatus,
} from "@dofe-agent/domain";

export interface WorkflowListItem {
  id: string;
  name: string;
  status: WorkflowDefinitionStatus;
  ownerLabel: string;
  triggerLabelCode: "manual" | "schedule" | "event" | "none";
  nextFireAt?: string;
  lastTriggerOutcome?: {
    code: "workflow.trigger.misfire_skipped" | "workflow.trigger.misfire_fire_once" | "workflow.trigger.invalid" | "workflow.trigger.materialization_failed";
    createdAt: string;
  };
  latestRun?: {
    id: string;
    status: WorkflowRunStatus;
    finishedAt?: string;
  };
  topology: {
    employeeNodeCount: number;
    parallelGroupCount: number;
    hasApproval: boolean;
  };
  sourceKind?: "workflow" | "legacy";
  migrationStatus?: "migrated" | "needs_migration";
  legacySourceId?: string;
}

export interface WorkflowCenterPageData {
  workflows: WorkflowListItem[];
  totals: {
    all: number;
    published: number;
    paused: number;
    blocked: number;
  };
}

export type WorkflowBuilderEntry = "automations" | "calendar" | "task-board";

export interface WorkflowBuilderEmployee {
  id: string;
  name: string;
  status: string;
}

export interface WorkflowBuilderInitialValue {
  id: string;
  name: string;
  description: string;
  status: WorkflowDefinitionStatus;
  graph: WorkflowGraphDefinition;
  draftVersion: number;
  publishedVersionNumber?: number;
  trigger: {
    type: "manual" | "schedule" | "event" | "none";
    config: Record<string, unknown>;
    timezone?: string;
    misfirePolicy: "skip" | "fire_once";
  };
  governance: {
    maxConcurrency: number;
    budgetUsd?: number;
  };
  channelName?: string;
}

export interface WorkflowBuilderPageData {
  employees: WorkflowBuilderEmployee[];
  channels: string[];
  members: Array<{ userId: string; displayName: string }>;
  ownerLabel: string;
  workflow?: WorkflowBuilderInitialValue;
}

export interface WorkflowRunEventItem {
  id: string;
  sequence: number;
  type: string;
  nodeRunId?: string;
  severity: string;
  createdAt: string;
}

export interface WorkflowNodeRunItem {
  id: string;
  nodeId: string;
  nodeType: string;
  employeeName: string;
  status: string;
  attemptCount: number;
  maxAttempts: number;
  artifactCount: number;
  costUsd?: number;
  errorCode?: string;
  startedAt?: string;
  finishedAt?: string;
  // 审批等待详情（UIUX:82）：审批 id（用于跳转审批中心）、风险等级、审批人姓名、来源。
  approvalId?: string;
  approvalRisk?: "low" | "medium" | "high";
  approvalReviewerLabel?: string;
  approvalSource?: string;
}

export interface WorkflowRunPageData {
  id: string;
  workflowId: string;
  workflowName: string;
  status: string;
  triggerType: string;
  currentSequence: number;
  canControl: boolean;
  canRunManually?: boolean;
  startedAt?: string;
  finishedAt?: string;
  createdAt: string;
  nodes: WorkflowNodeRunItem[];
  events: WorkflowRunEventItem[];
}

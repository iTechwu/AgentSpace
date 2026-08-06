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
  triggerLabelCode: string;
  nextFireAt?: string;
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
  trigger: {
    type: "manual" | "schedule" | "event";
    config: Record<string, unknown>;
    timezone?: string;
  };
  governance: {
    maxConcurrency: number;
    failurePolicy: "stop" | "continue";
  };
}

export interface WorkflowBuilderPageData {
  employees: WorkflowBuilderEmployee[];
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
}

export interface WorkflowRunPageData {
  id: string;
  workflowId: string;
  workflowName: string;
  status: string;
  triggerType: string;
  currentSequence: number;
  startedAt?: string;
  finishedAt?: string;
  createdAt: string;
  nodes: WorkflowNodeRunItem[];
  events: WorkflowRunEventItem[];
}

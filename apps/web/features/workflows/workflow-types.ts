import type {
  WorkflowDefinitionStatus,
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

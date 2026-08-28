// 计费 / Token 用量 / 预算（3.2-4 自 types.ts 按域拆分；types.ts 保留为 re-export barrel）。
import {
  type EnqueueTaskInput,
} from "./tasks.ts";

export interface ModelPricingRecord {
  modelId: string;
  displayName: string;
  inputPer1M: number;
  outputPer1M: number;
  currency: string;
  updatedAt: string;
}

export type TokenUsageBillingStatus = "estimated" | "pending_reconciliation" | "reconciled" | "unallocated" | "voided";

export interface TokenUsageRecord {
  id: string;
  workspaceId: string;
  taskQueueId?: string;
  agentId: string;
  modelId: string;
  providerAccountId?: string;
  runtimeCredentialId?: string;
  routerSessionId?: string;
  gatewayUsageId?: string;
  protocol?: string;
  inputTokens: number;
  outputTokens: number;
  cacheTokens: number;
  costUsd: number;
  billingStatus?: TokenUsageBillingStatus;
  gatewayRequestId?: string;
  delegationId?: string;
  employeeId?: string;
  runtimeId?: string;
  jobId?: string;
  pipelineStage?: string;
  sourceInvocationId?: string;
  modelInvocationId?: string;
  actualCostUsd?: number;
  currency?: string;
  reconciledAt?: string;
  requestStartedAt?: string;
  requestEndedAt?: string;
  sourceUpdatedAt?: string;
  channelName?: string;
  createdAt: string;
}

export type BudgetScope = "workspace" | "agent" | "channel";
export type BudgetPeriod = "monthly" | "total";
export type BudgetAction = "pause" | "approve" | "warn";

export interface BudgetRecord {
  id: string;
  workspaceId: string;
  scope: BudgetScope;
  scopeId: string;
  limitUsd: number;
  period: BudgetPeriod;
  action: BudgetAction;
  warningThreshold: number;
  enabled: boolean;
  createdBy: string;
  createdAt: string;
  updatedAt: string;
}

export function priorityToNumber(priority: EnqueueTaskInput["priority"]): number {
  if (priority === "high") {
    return 3;
  }
  if (priority === "medium") {
    return 2;
  }
  return 1;
}

/* ------------------------------------------------------------------ */
/* Employee data durability (EAD-001 .. EAD-005)                      */
/* ------------------------------------------------------------------ */

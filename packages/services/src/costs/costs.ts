import {
  DEFAULT_WORKSPACE_ID,
  listTokenUsageSync,
  getAgentCostSummarySync,
  getWorkspaceCostSummarySync,
  getWorkspaceBillingSummarySync,
  listModelPricingSync,
  getMonthStartIso,
  getRuntimeCostSummarySync,
  listRuntimeCostSummariesSync,
  getRuntimeCredentialCostSummarySync,
  listRuntimeCredentialCostSummariesSync,
  getSessionCostSummarySync,
  listSessionCostSummariesSync,
  listWorkspaceRuntimeDisplayNamesSync,
} from "@dofe-agent/db";
import type { ActiveEmployee } from "@dofe-agent/domain/workspace";
import { readWorkspaceStateSync } from "../shared/state-io.ts";

export interface AgentCostProfile {
  agentId: string;
  displayName: string;
  modelId: string;
  providerAccountId?: string;
  totalInputTokens: number;
  totalOutputTokens: number;
  totalCostUsd: number;
  taskCount: number;
  avgCostPerTask: number;
}

export interface CostDashboardData {
  agents: AgentCostProfile[];
  runtimes: RuntimeCostProfile[];
  runtimeCredentials: RuntimeCredentialCostProfile[];
  sessions: SessionCostProfile[];
  totalCostUsd: number;
  totalTasks: number;
  totalInputTokens: number;
  totalOutputTokens: number;
  estimatedCostUsd: number;
  reconciledCostUsd: number;
  unallocatedCostUsd: number;
  totalActualCostUsd: number;
  lastReconciledAt?: string;
  models: Array<{ modelId: string; displayName: string; inputPer1M: number; outputPer1M: number }>;
  recentUsage: Array<{
    id: string;
    agentId: string;
    modelId: string;
    providerAccountId?: string;
    inputTokens: number;
    outputTokens: number;
    costUsd: number;
    actualCostUsd?: number;
    billingStatus: string;
    channelName?: string;
    createdAt: string;
  }>;
}

export function getCostDashboardDataSync(
  period: "monthly" | "total" = "monthly",
  workspaceId = DEFAULT_WORKSPACE_ID,
): CostDashboardData {
  const since = period === "monthly" ? getMonthStartIso() : undefined;
  const state = readWorkspaceStateSync(workspaceId);
  const employeeIndex = new Map<string, string>(
    state.activeEmployees.map((e: ActiveEmployee) => [e.name, e.remarkName?.trim() ?? e.name]),
  );

  const summaries = getWorkspaceCostSummarySync(since, workspaceId);
  const models = listModelPricingSync();
  const recentUsage = listTokenUsageSync({ since, workspaceId }).slice(0, 50);
  const billing = getWorkspaceBillingSummarySync(since, workspaceId);
  const runtimes = listRuntimeCostProfilesSync(period, workspaceId);
  const runtimeCredentials = listRuntimeCredentialCostProfilesSync(period, workspaceId);
  const sessions = listSessionCostProfilesSync(period, workspaceId);

  const agents: AgentCostProfile[] = summaries.map((s: (typeof summaries)[number]) => ({
    agentId: s.agentId,
    displayName: employeeIndex.get(s.agentId) ?? s.agentId,
    modelId: s.modelId,
    providerAccountId: s.providerAccountId,
    totalInputTokens: s.totalInputTokens,
    totalOutputTokens: s.totalOutputTokens,
    totalCostUsd: s.totalCostUsd,
    taskCount: s.taskCount,
    avgCostPerTask: s.taskCount > 0 ? s.totalCostUsd / s.taskCount : 0,
  }));

  return {
    agents,
    runtimes,
    runtimeCredentials,
    sessions,
    totalCostUsd: agents.reduce((sum, a) => sum + a.totalCostUsd, 0),
    totalTasks: agents.reduce((sum, a) => sum + a.taskCount, 0),
    totalInputTokens: agents.reduce((sum, a) => sum + a.totalInputTokens, 0),
    totalOutputTokens: agents.reduce((sum, a) => sum + a.totalOutputTokens, 0),
    estimatedCostUsd: billing.estimatedCostUsd,
    reconciledCostUsd: billing.reconciledCostUsd,
    unallocatedCostUsd: billing.unallocatedCostUsd,
    totalActualCostUsd: billing.totalActualCostUsd,
    lastReconciledAt: billing.lastReconciledAt,
    models: models.map((m: (typeof models)[number]) => ({
      modelId: m.modelId,
      displayName: m.displayName,
      inputPer1M: m.inputPer1M,
      outputPer1M: m.outputPer1M,
    })),
    recentUsage: recentUsage.map((u: (typeof recentUsage)[number]) => ({
      id: u.id,
      agentId: u.agentId,
      modelId: u.modelId,
      providerAccountId: u.providerAccountId,
      inputTokens: u.inputTokens,
      outputTokens: u.outputTokens,
      costUsd: u.costUsd,
      actualCostUsd: u.actualCostUsd,
      billingStatus: u.billingStatus ?? "estimated",
      channelName: u.channelName,
      createdAt: u.createdAt,
    })),
  };
}

export function getAgentCostProfileSync(
  agentId: string,
  period: "monthly" | "total" = "monthly",
  workspaceId = DEFAULT_WORKSPACE_ID,
): {
  totalInputTokens: number;
  totalOutputTokens: number;
  totalCostUsd: number;
  taskCount: number;
  avgCostPerTask: number;
} {
  const since = period === "monthly" ? getMonthStartIso() : undefined;
  const summary = getAgentCostSummarySync(agentId, since, workspaceId);
  return {
    ...summary,
    avgCostPerTask: summary.taskCount > 0 ? summary.totalCostUsd / summary.taskCount : 0,
  };
}

export interface RuntimeCostProfile {
  runtimeId: string;
  displayName?: string;
  totalInputTokens: number;
  totalOutputTokens: number;
  totalCostUsd: number;
  totalActualCostUsd: number;
  taskCount: number;
  avgCostPerTask: number;
}

export function getRuntimeCostProfileSync(
  runtimeId: string,
  period: "monthly" | "total" = "monthly",
  workspaceId = DEFAULT_WORKSPACE_ID,
): RuntimeCostProfile {
  const since = period === "monthly" ? getMonthStartIso() : undefined;
  const summary = getRuntimeCostSummarySync(runtimeId, since, workspaceId);
  return {
    runtimeId,
    totalInputTokens: summary.totalInputTokens,
    totalOutputTokens: summary.totalOutputTokens,
    totalCostUsd: summary.totalCostUsd,
    totalActualCostUsd: summary.totalActualCostUsd,
    taskCount: summary.taskCount,
    avgCostPerTask: summary.taskCount > 0 ? summary.totalCostUsd / summary.taskCount : 0,
  };
}

export function listRuntimeCostProfilesSync(
  period: "monthly" | "total" = "monthly",
  workspaceId = DEFAULT_WORKSPACE_ID,
): RuntimeCostProfile[] {
  const since = period === "monthly" ? getMonthStartIso() : undefined;
  const summaries = listRuntimeCostSummariesSync(since, workspaceId);
  const displayNames = new Map(
    listWorkspaceRuntimeDisplayNamesSync(workspaceId).map((r) => [r.runtimeId, r.displayName.trim()]),
  );
  return summaries.map((s) => ({
    runtimeId: s.runtimeId,
    displayName: displayNames.get(s.runtimeId) || undefined,
    totalInputTokens: s.totalInputTokens,
    totalOutputTokens: s.totalOutputTokens,
    totalCostUsd: s.totalCostUsd,
    totalActualCostUsd: s.totalActualCostUsd,
    taskCount: s.taskCount,
    avgCostPerTask: s.taskCount > 0 ? s.totalCostUsd / s.taskCount : 0,
  }));
}

export interface RuntimeCredentialCostProfile {
  runtimeCredentialId: string;
  totalInputTokens: number;
  totalOutputTokens: number;
  totalCostUsd: number;
  totalActualCostUsd: number;
  taskCount: number;
  avgCostPerTask: number;
}

export function getRuntimeCredentialCostProfileSync(
  runtimeCredentialId: string,
  period: "monthly" | "total" = "monthly",
  workspaceId = DEFAULT_WORKSPACE_ID,
): RuntimeCredentialCostProfile {
  const since = period === "monthly" ? getMonthStartIso() : undefined;
  const summary = getRuntimeCredentialCostSummarySync(runtimeCredentialId, since, workspaceId);
  return {
    runtimeCredentialId,
    totalInputTokens: summary.totalInputTokens,
    totalOutputTokens: summary.totalOutputTokens,
    totalCostUsd: summary.totalCostUsd,
    totalActualCostUsd: summary.totalActualCostUsd,
    taskCount: summary.taskCount,
    avgCostPerTask: summary.taskCount > 0 ? summary.totalCostUsd / summary.taskCount : 0,
  };
}

export function listRuntimeCredentialCostProfilesSync(
  period: "monthly" | "total" = "monthly",
  workspaceId = DEFAULT_WORKSPACE_ID,
): RuntimeCredentialCostProfile[] {
  const since = period === "monthly" ? getMonthStartIso() : undefined;
  return listRuntimeCredentialCostSummariesSync(since, workspaceId).map((s) => ({
    runtimeCredentialId: s.runtimeCredentialId,
    totalInputTokens: s.totalInputTokens,
    totalOutputTokens: s.totalOutputTokens,
    totalCostUsd: s.totalCostUsd,
    totalActualCostUsd: s.totalActualCostUsd,
    taskCount: s.taskCount,
    avgCostPerTask: s.taskCount > 0 ? s.totalCostUsd / s.taskCount : 0,
  }));
}

export interface SessionCostProfile {
  routerSessionId: string;
  totalInputTokens: number;
  totalOutputTokens: number;
  totalCostUsd: number;
  totalActualCostUsd: number;
  taskCount: number;
  avgCostPerTask: number;
}

export function getSessionCostProfileSync(
  routerSessionId: string,
  period: "monthly" | "total" = "monthly",
  workspaceId = DEFAULT_WORKSPACE_ID,
): SessionCostProfile {
  const since = period === "monthly" ? getMonthStartIso() : undefined;
  const summary = getSessionCostSummarySync(routerSessionId, since, workspaceId);
  return {
    routerSessionId,
    totalInputTokens: summary.totalInputTokens,
    totalOutputTokens: summary.totalOutputTokens,
    totalCostUsd: summary.totalCostUsd,
    totalActualCostUsd: summary.totalActualCostUsd,
    taskCount: summary.taskCount,
    avgCostPerTask: summary.taskCount > 0 ? summary.totalCostUsd / summary.taskCount : 0,
  };
}

export function listSessionCostProfilesSync(
  period: "monthly" | "total" = "monthly",
  workspaceId = DEFAULT_WORKSPACE_ID,
): SessionCostProfile[] {
  const since = period === "monthly" ? getMonthStartIso() : undefined;
  return listSessionCostSummariesSync(since, workspaceId).map((s) => ({
    routerSessionId: s.routerSessionId,
    totalInputTokens: s.totalInputTokens,
    totalOutputTokens: s.totalOutputTokens,
    totalCostUsd: s.totalCostUsd,
    totalActualCostUsd: s.totalActualCostUsd,
    taskCount: s.taskCount,
    avgCostPerTask: s.taskCount > 0 ? s.totalCostUsd / s.taskCount : 0,
  }));
}

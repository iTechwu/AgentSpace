import {
  DEFAULT_WORKSPACE_ID,
  listTokenUsageSync,
  getAgentCostSummarySync,
  getWorkspaceCostSummarySync,
  listModelPricingSync,
  getMonthStartIso,
} from "@dofe-agent/db";
import type { ActiveEmployee } from "@dofe-agent/domain/workspace";
import { readWorkspaceStateSync } from "../shared/state-io.ts";

export interface AgentCostProfile {
  agentId: string;
  displayName: string;
  modelId: string;
  totalInputTokens: number;
  totalOutputTokens: number;
  totalCostUsd: number;
  taskCount: number;
  avgCostPerTask: number;
}

export interface CostDashboardData {
  agents: AgentCostProfile[];
  totalCostUsd: number;
  totalTasks: number;
  totalInputTokens: number;
  totalOutputTokens: number;
  models: Array<{ modelId: string; displayName: string; inputPer1M: number; outputPer1M: number }>;
  recentUsage: Array<{
    id: string;
    agentId: string;
    modelId: string;
    inputTokens: number;
    outputTokens: number;
    costUsd: number;
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

  const agents: AgentCostProfile[] = summaries.map((s: (typeof summaries)[number]) => ({
    agentId: s.agentId,
    displayName: employeeIndex.get(s.agentId) ?? s.agentId,
    modelId: s.modelId,
    totalInputTokens: s.totalInputTokens,
    totalOutputTokens: s.totalOutputTokens,
    totalCostUsd: s.totalCostUsd,
    taskCount: s.taskCount,
    avgCostPerTask: s.taskCount > 0 ? s.totalCostUsd / s.taskCount : 0,
  }));

  return {
    agents,
    totalCostUsd: agents.reduce((sum, a) => sum + a.totalCostUsd, 0),
    totalTasks: agents.reduce((sum, a) => sum + a.taskCount, 0),
    totalInputTokens: agents.reduce((sum, a) => sum + a.totalInputTokens, 0),
    totalOutputTokens: agents.reduce((sum, a) => sum + a.totalOutputTokens, 0),
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
      inputTokens: u.inputTokens,
      outputTokens: u.outputTokens,
      costUsd: u.costUsd,
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

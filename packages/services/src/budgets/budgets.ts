import {
  DEFAULT_WORKSPACE_ID,
  listBudgetsSync,
  readBudgetSync,
  upsertBudgetSync,
  toggleBudgetSync,
  deleteBudgetSync,
  getSpentUsdSync,
  getMonthStartIso,
} from "@dofe-agent/db";
import type { BudgetAction, BudgetPeriod, BudgetRecord, BudgetScope } from "@dofe-agent/db";

export type BudgetCheckResult =
  | { status: "ok" }
  | { status: "warning"; budget: BudgetRecord; spentUsd: number; percentUsed: number }
  | { status: "exceeded"; budget: BudgetRecord; spentUsd: number; percentUsed: number; action: BudgetAction };

export function checkBudgetSync(scope: BudgetScope, scopeId: string, workspaceId = DEFAULT_WORKSPACE_ID): BudgetCheckResult {
  const budget = readBudgetSync(scope, scopeId, workspaceId);
  if (!budget || !budget.enabled) {
    return { status: "ok" };
  }

  const since = budget.period === "monthly" ? getMonthStartIso() : undefined;
  const spentUsd = getSpentUsdSync(scope, scopeId, since, workspaceId);
  const percentUsed = budget.limitUsd > 0 ? spentUsd / budget.limitUsd : 0;

  if (spentUsd >= budget.limitUsd) {
    return { status: "exceeded", budget, spentUsd, percentUsed, action: budget.action };
  }

  if (percentUsed >= budget.warningThreshold) {
    return { status: "warning", budget, spentUsd, percentUsed };
  }

  return { status: "ok" };
}

export function checkAllBudgetsForAgentSync(agentId: string, channelName?: string, workspaceId = DEFAULT_WORKSPACE_ID): BudgetCheckResult {
  const workspaceCheck = checkBudgetSync("workspace", workspaceId, workspaceId);
  if (workspaceCheck.status === "exceeded") return workspaceCheck;

  const agentCheck = checkBudgetSync("agent", agentId, workspaceId);
  if (agentCheck.status === "exceeded") return agentCheck;

  if (channelName) {
    const channelCheck = checkBudgetSync("channel", channelName, workspaceId);
    if (channelCheck.status === "exceeded") return channelCheck;
  }

  if (workspaceCheck.status === "warning") return workspaceCheck;
  if (agentCheck.status === "warning") return agentCheck;

  if (channelName) {
    const channelCheck = checkBudgetSync("channel", channelName, workspaceId);
    if (channelCheck.status === "warning") return channelCheck;
  }

  return { status: "ok" };
}

export interface BudgetWithSpent extends BudgetRecord {
  spentUsd: number;
  percentUsed: number;
}

export function listBudgetsWithSpentSync(workspaceId = DEFAULT_WORKSPACE_ID): BudgetWithSpent[] {
  const budgets = listBudgetsSync(workspaceId);
  return budgets.map((budget) => {
    const since = budget.period === "monthly" ? getMonthStartIso() : undefined;
    const spentUsd = getSpentUsdSync(budget.scope, budget.scopeId, since, workspaceId);
    return {
      ...budget,
      spentUsd,
      percentUsed: budget.limitUsd > 0 ? spentUsd / budget.limitUsd : 0,
    };
  });
}

export {
  upsertBudgetSync,
  toggleBudgetSync,
  deleteBudgetSync,
};

export type { BudgetScope, BudgetPeriod, BudgetAction, BudgetRecord };

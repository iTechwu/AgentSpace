// dashboard 成本与预算页（从 features/dashboard/data.ts 拆出，3.4/3.6 巨型文件项）。

import { DEFAULT_WORKSPACE_ID } from "@dofe-agent/db";
import type { BudgetAction, BudgetPeriod, BudgetScope } from "@dofe-agent/db";
import type { CostDashboardData } from "@dofe-agent/services/finance";
import { getAuthoritativeCostDashboardDataCached, getCostDashboardDataCached, listBudgetsWithSpentCached, readWorkspaceStateCached } from "./cached.ts";

export type CostPageData = CostDashboardData;
export function getCostPageData(
  period: "monthly" | "total" = "monthly",
  workspaceId = DEFAULT_WORKSPACE_ID,
): CostPageData {
  return getCostDashboardDataCached(period, workspaceId);
}
export async function getCostPageDataAsync(
  period: "monthly" | "total" = "monthly",
  workspaceId = DEFAULT_WORKSPACE_ID,
): Promise<CostPageData> {
  return getAuthoritativeCostDashboardDataCached(period, workspaceId);
}

// ── Budgets ──
export interface BudgetPageItem {
  id: string;
  scope: BudgetScope;
  scopeId: string;
  limitUsd: number;
  period: BudgetPeriod;
  action: BudgetAction;
  warningThreshold: number;
  enabled: boolean;
  spentUsd: number;
  percentUsed: number;
}
export interface BudgetPageData {
  budgets: BudgetPageItem[];
  agents: Array<{ id: string; name: string }>;
  channels: Array<{ name: string }>;
}
export function getBudgetPageData(workspaceId = DEFAULT_WORKSPACE_ID): BudgetPageData {
  const state = readWorkspaceStateCached(workspaceId);
  const budgets = listBudgetsWithSpentCached(workspaceId);

  return {
    budgets: budgets.map((b) => ({
      id: b.id,
      scope: b.scope,
      scopeId: b.scopeId,
      limitUsd: b.limitUsd,
      period: b.period,
      action: b.action,
      warningThreshold: b.warningThreshold,
      enabled: b.enabled,
      spentUsd: b.spentUsd,
      percentUsed: b.percentUsed,
    })),
    agents: state.activeEmployees.map((e) => ({
      id: e.name,
      name: e.remarkName?.trim() || e.name,
    })),
    channels: state.channels.map((ch) => ({ name: ch.name })),
  };
}

// ── Knowledge ──

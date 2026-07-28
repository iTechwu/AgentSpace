import { DEFAULT_WORKSPACE_ID, getDatabase } from "./database.ts";
import type { TokenUsageBillingStatus } from "./types.ts";

export interface BillingCurrencySummary {
  currency: string;
  pendingReconciliationCost: number;
  reconciledCost: number;
  unallocatedCost: number;
  totalActualCost: number;
}

export function getWorkspaceBillingSummarySync(since?: string, workspaceId = DEFAULT_WORKSPACE_ID): {
  estimatedCostUsd: number;
  pendingReconciliationCostUsd: number;
  reconciledCostUsd: number;
  unallocatedCostUsd: number;
  totalActualCostUsd: number;
  lastReconciledAt?: string;
  billingByCurrency: BillingCurrencySummary[];
} {
  const params: string[] = [workspaceId];
  let dateFilter = "WHERE workspace_id = ?";
  if (since) {
    dateFilter += " AND created_at >= ?";
    params.push(since);
  }

  const rows = getDatabase().prepare(
    `SELECT billing_status,
            CASE
              WHEN billing_status = 'estimated' OR actual_cost_usd IS NULL THEN 'USD'
              ELSE COALESCE(NULLIF(UPPER(currency), ''), 'UNKNOWN')
            END AS billing_currency,
            COALESCE(SUM(actual_cost_usd), 0) AS total_actual,
            COALESCE(SUM(cost_usd), 0) AS total_estimated,
            COALESCE(SUM(CASE WHEN actual_cost_usd IS NOT NULL THEN actual_cost_usd ELSE cost_usd END), 0) AS total_effective,
            MAX(reconciled_at) AS last_reconciled
     FROM token_usage ${dateFilter}
     GROUP BY billing_status,
              CASE
                WHEN billing_status = 'estimated' OR actual_cost_usd IS NULL THEN 'USD'
                ELSE COALESCE(NULLIF(UPPER(currency), ''), 'UNKNOWN')
              END`,
  ).all(...params) as Array<{
    billing_status: string | null;
    billing_currency: string;
    total_actual: number;
    total_estimated: number;
    total_effective: number;
    last_reconciled: string | null;
  }>;

  let estimatedCostUsd = 0;
  let pendingReconciliationCostUsd = 0;
  let reconciledCostUsd = 0;
  let unallocatedCostUsd = 0;
  let totalActualCostUsd = 0;
  let lastReconciledAt: string | undefined;
  const byCurrency = new Map<string, BillingCurrencySummary>();

  for (const row of rows) {
    const status = normalizeBillingStatus(row.billing_status);
    const currency = row.billing_currency;
    const summary = byCurrency.get(currency) ?? {
      currency,
      pendingReconciliationCost: 0,
      reconciledCost: 0,
      unallocatedCost: 0,
      totalActualCost: 0,
    };
    if (status === "estimated") {
      if (currency === "USD") estimatedCostUsd += row.total_estimated;
    } else if (status === "pending_reconciliation") {
      summary.pendingReconciliationCost += row.total_effective;
      if (currency === "USD") pendingReconciliationCostUsd += row.total_effective;
    } else if (status === "reconciled") {
      summary.reconciledCost += row.total_actual;
      summary.totalActualCost += row.total_actual;
      if (currency === "USD") {
        reconciledCostUsd += row.total_actual;
        totalActualCostUsd += row.total_actual;
      }
    } else {
      summary.unallocatedCost += row.total_actual;
      summary.totalActualCost += row.total_actual;
      if (currency === "USD") {
        unallocatedCostUsd += row.total_actual;
        totalActualCostUsd += row.total_actual;
      }
    }
    byCurrency.set(currency, summary);
    if (row.last_reconciled && (!lastReconciledAt || row.last_reconciled > lastReconciledAt)) {
      lastReconciledAt = row.last_reconciled;
    }
  }

  return {
    estimatedCostUsd,
    pendingReconciliationCostUsd,
    reconciledCostUsd,
    unallocatedCostUsd,
    totalActualCostUsd,
    lastReconciledAt,
    billingByCurrency: [...byCurrency.values()].sort((a, b) => a.currency.localeCompare(b.currency)),
  };
}

function normalizeBillingStatus(value: string | null): TokenUsageBillingStatus {
  if (value === "pending_reconciliation" || value === "reconciled" || value === "unallocated") return value;
  return "estimated";
}

"use client";

import { useEffect, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { getTeamBillingBalanceAction, upsertBudgetAction, toggleBudgetAction, deleteBudgetAction, reconcileWorkspaceUsageAction, type TeamBillingBalanceResult } from "@/features/costs/actions";
import type { CostPageData, BudgetPageData, BudgetPageItem } from "@/features/dashboard/data";
import { refreshWorkspaceModule } from "@/features/dashboard/workspace-module-refresh";
import type { BudgetAction, BudgetPeriod, BudgetScope } from "@dofe-agent/db";
import { useLanguage } from "@/features/i18n/language-provider";
import { formatCompactTimestamp } from "@/shared/lib/time-format";

type ActiveTab = "costs" | "budgets";

export function CostsPageClient({
  costs,
  budgets,
  onDataChanged,
}: {
  costs: CostPageData;
  budgets: BudgetPageData;
  onDataChanged?: () => void;
}) {
  const { tx } = useLanguage();
  const router = useRouter();
  const [tab, setTab] = useState<ActiveTab>("costs");
  const [showAddBudget, setShowAddBudget] = useState(false);
  const [isCompactLayout, setIsCompactLayout] = useState(false);
  const [isPending, startTransition] = useTransition();
  const [teamBalance, setTeamBalance] = useState<TeamBillingBalanceResult | null>(null);

  useEffect(() => {
    let active = true;
    void getTeamBillingBalanceAction().then((balance) => {
      if (active) setTeamBalance(balance);
    }).catch(() => {
      if (active) setTeamBalance({ errorCode: "upstream_unavailable" });
    });
    return () => { active = false; };
  }, []);

  useEffect(() => {
    if (typeof window === "undefined" || typeof window.matchMedia !== "function") {
      return;
    }

    const mediaQuery = window.matchMedia("(max-width: 860px)");
    const handleChange = (event?: MediaQueryListEvent): void => {
      setIsCompactLayout(event ? event.matches : mediaQuery.matches);
    };

    handleChange();

    if (typeof mediaQuery.addEventListener === "function") {
      mediaQuery.addEventListener("change", handleChange);
      return () => mediaQuery.removeEventListener("change", handleChange);
    }

    mediaQuery.addListener(handleChange);
    return () => mediaQuery.removeListener(handleChange);
  }, []);

  return (
    <section className={`costs-shell${isCompactLayout ? " costs-shell--compact" : ""}`}>
      <div className="costs-toolbar">
        <h2>{tx("成本与预算", "Costs & Budget")}</h2>
        <div className="costs-tab-bar">
          <button
            className={`costs-tab${tab === "costs" ? " costs-tab--active" : ""}`}
            onClick={() => setTab("costs")}
            type="button"
          >
            {tx("成本总览", "Cost Overview")}
          </button>
          <button
            className={`costs-tab${tab === "budgets" ? " costs-tab--active" : ""}`}
            onClick={() => setTab("budgets")}
            type="button"
          >
            {tx("预算管理", "Budgets")}
          </button>
        </div>
      </div>

      {tab === "costs" ? (
        <CostOverview compact={isCompactLayout} data={costs} teamBalance={teamBalance} tx={tx} />
      ) : (
        <BudgetManager
          budgets={budgets}
          tx={tx}
          isPending={isPending}
          showAddBudget={showAddBudget}
          onShowAddBudget={setShowAddBudget}
          onSave={(input) => {
            startTransition(async () => {
              await upsertBudgetAction(input);
              setShowAddBudget(false);
              refreshWorkspaceModule(onDataChanged, router);
            });
          }}
          onToggle={(id, enabled) => {
            startTransition(async () => {
              await toggleBudgetAction(id, enabled);
              refreshWorkspaceModule(onDataChanged, router);
            });
          }}
          onDelete={(id) => {
            startTransition(async () => {
              await deleteBudgetAction(id);
              refreshWorkspaceModule(onDataChanged, router);
            });
          }}
        />
      )}
    </section>
  );
}

function CostOverview({
  compact,
  data,
  teamBalance,
  tx,
}: {
  compact: boolean;
  data: CostPageData;
  teamBalance: TeamBillingBalanceResult | null;
  tx: (zh: string, en: string) => string;
}) {
  const router = useRouter();
  const [isPending, startTransition] = useTransition();
  const [lastResult, setLastResult] = useState<{ reconciledCount: number; unallocatedCount: number } | null>(null);
  const averagePerTask = data.totalTasks > 0 ? data.totalCostUsd / data.totalTasks : 0;
  const availableTeamBalance = teamBalance && !("errorCode" in teamBalance) ? teamBalance : null;

  function handleReconcile(): void {
    startTransition(async () => {
      try {
        const result = await reconcileWorkspaceUsageAction();
        setLastResult({ reconciledCount: result.reconciledCount, unallocatedCount: result.unallocatedCount });
        router.refresh();
      } catch (err) {
        setLastResult({ reconciledCount: -1, unallocatedCount: -1 });
        console.error("Reconciliation failed", err);
      }
    });
  }

  return (
    <div className="costs-overview">
      <div className="costs-insight-band" role="list">
        <article className="costs-insight-card" role="listitem">
          <span>{tx("每任务均价", "Avg per task")}</span>
          <strong>{data.totalInputTokens + data.totalOutputTokens > 0 && data.totalCostUsd === 0
            ? tx("尚未计价", "Pricing pending")
            : formatBillingAmount(averagePerTask, data.reportCurrency ?? "CNY")}</strong>
        </article>
        <article className="costs-insight-card" role="listitem">
          <span>{tx("模型数", "Models")}</span>
          <strong>{data.modelCount ?? new Set(data.agents.map((agent) => agent.modelId)).size}</strong>
        </article>
        <article className="costs-insight-card" role="listitem">
          <span>{tx("Token 用量", "Token usage")}</span>
          <strong>{formatTokens(data.totalInputTokens + data.totalOutputTokens)}</strong>
        </article>
      </div>

      {data.billingReportState && data.billingReportState !== "authoritative" ? (
        <div className="costs-empty" role="status">
          {tx(
            "models 权威账单暂不可用；当前仅展示本地任务关联，不显示本地推算金额。",
            "The authoritative models billing report is unavailable. Local task attribution remains visible, but locally calculated money is hidden.",
          )}
        </div>
      ) : null}

      <div className="costs-summary-cards">
        <div className="costs-summary-card">
          <span className="costs-summary-card__label">{tx("团队实际余额", "Team balance")}</span>
          <span className="costs-summary-card__value">{availableTeamBalance ? `${availableTeamBalance.balance} ${availableTeamBalance.currency}` : tx("暂不可用", "Unavailable")}</span>
          {availableTeamBalance ? (
            <span className="costs-summary-card__label">{tx("可用", "Available")}: {availableTeamBalance.availableBalance} {availableTeamBalance.currency}</span>
          ) : teamBalance && "errorCode" in teamBalance ? (
            <span className="costs-summary-card__label">{formatBalanceError(teamBalance.errorCode, tx)}</span>
          ) : null}
        </div>
        <div className="costs-summary-card">
          <span className="costs-summary-card__label">{tx("应计费用", "Accrued charge")}</span>
          <span className="costs-summary-card__value">{formatCurrencyBreakdown(data, "estimatedCost")}</span>
        </div>
        <div className="costs-summary-card">
          <span className="costs-summary-card__label">{tx("待结算", "Pending settlement")}</span>
          <span className="costs-summary-card__value">{formatCurrencyBreakdown(data, "pendingReconciliationCost")}</span>
        </div>
        <div className="costs-summary-card">
          <span className="costs-summary-card__label">{tx("已结算", "Settled")}</span>
          <span className="costs-summary-card__value">{formatCurrencyBreakdown(data, "reconciledCost")}</span>
        </div>
        <div className="costs-summary-card">
          <span className="costs-summary-card__label">{tx("需对账", "Needs reconciliation")}</span>
          <span className="costs-summary-card__value">{formatCurrencyBreakdown(data, "unallocatedCost")}</span>
        </div>
        <div className="costs-summary-card">
          <span className="costs-summary-card__label">{tx("实际扣费", "Actual Charged")}</span>
          <span className="costs-summary-card__value">{formatCurrencyBreakdown(data, "totalActualCost")}</span>
        </div>
      </div>

      <div className="costs-reconcile-bar">
        <button
          className="costs-reconcile-btn"
          type="button"
          disabled={isPending}
          onClick={handleReconcile}
        >
          {isPending ? tx("同步中...", "Syncing...") : tx("同步用量明细", "Sync usage details")}
        </button>
        {data.lastReconciledAt ? (
          <span className="costs-reconcile-meta">
            {tx("上次对账:", "Last reconciled:")} {formatCompactTimestamp(data.lastReconciledAt, { emptyFallback: data.lastReconciledAt })}
          </span>
        ) : null}
        {lastResult ? (
          <span className="costs-reconcile-meta">
            {lastResult.reconciledCount === -1
              ? tx("对账失败", "Reconciliation failed")
              : tx(`已同步 ${lastResult.reconciledCount} 条，未归属 ${lastResult.unallocatedCount} 条`, `Synced ${lastResult.reconciledCount}, unattributed ${lastResult.unallocatedCount}`)}
          </span>
        ) : null}
      </div>

      <h3>{tx("AI员工 费用明细", "AI employee Cost Breakdown")}</h3>
      {data.agents.length > 0 ? (
        compact ? (
          <div className="costs-agent-cards">
            {data.agents.map((agent) => (
              <article className="costs-agent-card" key={`${agent.agentId}-${agent.modelId}-${agent.providerAccountId ?? agent.runtimeCredentialId ?? "legacy"}`}>
                <div className="costs-agent-card__header">
                  <strong>{agent.displayName}</strong>
                  <span className="costs-agent-model">{agent.modelId}</span>
                </div>
                <div className="costs-agent-card__stats">
                  <span>{tx("任务数", "Tasks")}: {agent.taskCount}</span>
                  <span>{tx("计费来源", "Billing source")}: {formatBillingSource(agent, tx)}</span>
                  <span>{tx("输入", "Input")}: {formatTokens(agent.totalInputTokens)}</span>
                  <span>{tx("输出", "Output")}: {formatTokens(agent.totalOutputTokens)}</span>
                  <span>{tx("总费用", "Cost")}: {formatBillingAmount(agent.totalCostUsd, agent.currency ?? data.reportCurrency ?? "CNY")}</span>
                  <span>{tx("均价", "Avg")}: {formatBillingAmount(agent.avgCostPerTask, agent.currency ?? data.reportCurrency ?? "CNY")}</span>
                </div>
              </article>
            ))}
          </div>
        ) : (
          <div className="costs-agent-table">
            <div className="costs-agent-row costs-agent-row--header">
              <span>AI员工</span>
              <span>{tx("模型", "Model")}</span>
              <span>{tx("计费来源", "Billing source")}</span>
              <span>{tx("任务数", "Tasks")}</span>
              <span>{tx("输入", "Input")}</span>
              <span>{tx("输出", "Output")}</span>
              <span>{tx("总费用", "Cost")}</span>
              <span>{tx("均价", "Avg")}</span>
            </div>
            {data.agents.map((agent) => (
              <div className="costs-agent-row" key={`${agent.agentId}-${agent.modelId}-${agent.providerAccountId ?? agent.runtimeCredentialId ?? "legacy"}`}>
                <span className="costs-agent-name">{agent.displayName}</span>
                <span className="costs-agent-model">{agent.modelId}</span>
                <span>{formatBillingSource(agent, tx)}</span>
                <span>{agent.taskCount}</span>
                <span>{formatTokens(agent.totalInputTokens)}</span>
                <span>{formatTokens(agent.totalOutputTokens)}</span>
                <span>{formatBillingAmount(agent.totalCostUsd, agent.currency ?? data.reportCurrency ?? "CNY")}</span>
                <span>{formatBillingAmount(agent.avgCostPerTask, agent.currency ?? data.reportCurrency ?? "CNY")}</span>
              </div>
            ))}
          </div>
        )
      ) : (
        <div className="costs-empty">{tx("暂无用量数据", "No usage data yet")}</div>
      )}

      <CostDimensionTable
        title={tx("Runtime 费用明细", "Runtime Cost Breakdown")}
        rows={data.runtimes.map((runtime) => ({
          id: runtime.runtimeId,
          label: runtime.displayName ?? runtime.runtimeId,
          taskCount: runtime.taskCount,
          totalInputTokens: runtime.totalInputTokens,
          totalOutputTokens: runtime.totalOutputTokens,
          totalCostUsd: runtime.totalCostUsd,
          totalActualCostUsd: runtime.totalActualCostUsd,
          avgCostPerTask: runtime.avgCostPerTask,
          currency: runtime.currency,
        }))}
        compact={compact}
        emptyMessage={tx(
          "暂无受管 Runtime 用量；受管 Runtime 经路由产生用量后，此处按 Runtime 拆分。",
          "No managed runtime usage yet. This breaks down by runtime once managed runtimes produce routed usage.",
        )}
        tx={tx}
      />

      <CostDimensionTable
        title={tx("Runtime Key 费用明细", "Runtime Key Cost Breakdown")}
        rows={data.runtimeCredentials.map((credential) => ({
          id: credential.runtimeCredentialId,
          label: credential.runtimeCredentialId,
          taskCount: credential.taskCount,
          totalInputTokens: credential.totalInputTokens,
          totalOutputTokens: credential.totalOutputTokens,
          totalCostUsd: credential.totalCostUsd,
          totalActualCostUsd: credential.totalActualCostUsd,
          avgCostPerTask: credential.avgCostPerTask,
          currency: credential.currency,
        }))}
        compact={compact}
        emptyMessage={tx(
          "暂无 Runtime Key 用量；对账后此处按 Runtime Key 拆分实际扣费。",
          "No runtime key usage yet. This breaks down by runtime key after reconciliation.",
        )}
        tx={tx}
      />

      <CostDimensionTable
        title={tx("会话费用明细", "Session Cost Breakdown")}
        rows={data.sessions.map((session) => ({
          id: session.routerSessionId,
          label: session.routerSessionId,
          taskCount: session.taskCount,
          totalInputTokens: session.totalInputTokens,
          totalOutputTokens: session.totalOutputTokens,
          totalCostUsd: session.totalCostUsd,
          totalActualCostUsd: session.totalActualCostUsd,
          avgCostPerTask: session.avgCostPerTask,
          currency: session.currency,
        }))}
        compact={compact}
        emptyMessage={tx(
          "暂无会话用量；会话产生用量后此处按会话拆分。",
          "No session usage yet. This breaks down by session once sessions produce usage.",
        )}
        tx={tx}
      />

      {data.recentUsage.length > 0 ? (
        <>
          <h3>{tx("最近用量", "Recent Usage")}</h3>
          {compact ? (
            <div className="costs-recent-cards">
              {data.recentUsage.slice(0, 20).map((usage) => (
                <article className="costs-recent-card" key={usage.id}>
                  <div className="costs-recent-card__header">
                    <strong>{formatUsageOwner(usage, tx)}</strong>
                    <span className="costs-recent-model">{usage.modelId}</span>
                    <BillingStatusBadge status={usage.billingStatus} tx={tx} />
                  </div>
                  <div className="costs-recent-card__stats">
                    <span>{formatUsageTokens(usage)}</span>
                    <span>{formatUsageCost(usage, tx)}</span>
                  </div>
                  <div className="costs-recent-time">
                    {tx("更新时间", "Updated")}: {formatCompactTimestamp(usage.sourceUpdatedAt ?? usage.reconciledAt ?? usage.createdAt, { emptyFallback: usage.createdAt })}
                  </div>
                </article>
              ))}
            </div>
          ) : (
            <div className="costs-recent-list">
              {data.recentUsage.slice(0, 20).map((usage) => (
                <div className="costs-recent-item" key={usage.id}>
                  <span className="costs-recent-agent">{formatUsageOwner(usage, tx)}</span>
                  <span className="costs-recent-model">{usage.modelId}</span>
                  <span>{formatUsageTokens(usage)}</span>
                  <span>{formatUsageCost(usage, tx)}</span>
                  <BillingStatusBadge status={usage.billingStatus} tx={tx} />
                  <span className="costs-recent-time">
                    {tx("更新时间", "Updated")}: {formatCompactTimestamp(usage.sourceUpdatedAt ?? usage.reconciledAt ?? usage.createdAt, { emptyFallback: usage.createdAt })}
                  </span>
                </div>
              ))}
            </div>
          )}
        </>
      ) : null}
    </div>
  );
}

function formatCurrencyBreakdown(
  data: CostPageData,
  field: "estimatedCost" | "pendingReconciliationCost" | "reconciledCost" | "unallocatedCost" | "totalActualCost",
): string {
  const values = data.billingByCurrency
    .filter((entry) => entry[field] !== 0)
    .map((entry) => formatBillingAmount(entry[field], entry.currency));
  return values.length > 0 ? values.join(" + ") : formatCny(0);
}

function CostDimensionTable({
  title,
  rows,
  compact,
  emptyMessage,
  tx,
}: {
  title: string;
  rows: Array<{
    id: string;
    label: string;
    taskCount: number;
    totalInputTokens: number;
    totalOutputTokens: number;
    totalCostUsd: number;
    totalActualCostUsd: number;
    avgCostPerTask: number;
    currency?: string;
  }>;
  compact: boolean;
  emptyMessage?: string;
  tx: (zh: string, en: string) => string;
}) {
  return (
    <>
      <h3>{title}</h3>
      {rows.length === 0 ? (
        <div className="costs-empty">{emptyMessage ?? tx("暂无用量数据", "No usage data yet")}</div>
      ) : compact ? (
        <div className="costs-agent-cards">
          {rows.map((row) => (
            <article className="costs-agent-card" key={`${row.id}-${row.currency ?? "CNY"}`}>
              <div className="costs-agent-card__header">
                <strong>{row.label}</strong>
              </div>
              <div className="costs-agent-card__stats">
                <span>{tx("任务数", "Tasks")}: {row.taskCount}</span>
                <span>{tx("输入", "Input")}: {formatTokens(row.totalInputTokens)}</span>
                <span>{tx("输出", "Output")}: {formatTokens(row.totalOutputTokens)}</span>
                <span>{tx("总费用", "Cost")}: {formatBillingAmount(row.totalCostUsd, row.currency ?? "CNY")}{row.totalActualCostUsd > 0 ? ` → ${formatBillingAmount(row.totalActualCostUsd, row.currency ?? "CNY")}` : ""}</span>
                <span>{tx("均价", "Avg")}: {formatBillingAmount(row.avgCostPerTask, row.currency ?? "CNY")}</span>
              </div>
            </article>
          ))}
        </div>
      ) : (
        <div className="costs-agent-table">
          <div className="costs-agent-row costs-agent-row--header">
            <span>{tx("名称", "Name")}</span>
            <span>{tx("任务数", "Tasks")}</span>
            <span>{tx("输入", "Input")}</span>
            <span>{tx("输出", "Output")}</span>
            <span>{tx("总费用", "Cost")}</span>
            <span>{tx("均价", "Avg")}</span>
          </div>
          {rows.map((row) => (
            <div className="costs-agent-row" key={`${row.id}-${row.currency ?? "CNY"}`}>
              <span className="costs-agent-name" title={row.id}>{row.label}</span>
              <span>{row.taskCount}</span>
              <span>{formatTokens(row.totalInputTokens)}</span>
              <span>{formatTokens(row.totalOutputTokens)}</span>
              <span>{formatBillingAmount(row.totalCostUsd, row.currency ?? "CNY")}{row.totalActualCostUsd > 0 ? ` → ${formatBillingAmount(row.totalActualCostUsd, row.currency ?? "CNY")}` : ""}</span>
              <span>{formatBillingAmount(row.avgCostPerTask, row.currency ?? "CNY")}</span>
            </div>
          ))}
        </div>
      )}
    </>
  );
}

function BillingStatusBadge({
  status,
  tx,
}: {
  status: string;
  tx: (zh: string, en: string) => string;
}) {
  const label = status === "reconciled"
    ? tx("已同步", "Synced")
    : status === "unallocated"
      ? tx("未归属", "Unattributed")
      : status === "pending_reconciliation"
        ? tx("等待账单", "Awaiting charge")
        : tx("等待账单", "Awaiting charge");
  const className = `costs-status costs-status--${status}`;
  return <span className={className}>{label}</span>;
}

function formatUsageTokens(usage: CostPageData["recentUsage"][number]): string {
  const cache = usage.cacheTokens > 0 ? ` / ${formatTokens(usage.cacheTokens)} cache` : "";
  return `${formatTokens(usage.inputTokens)} / ${formatTokens(usage.outputTokens)}${cache}`;
}

function formatUsageCost(
  usage: CostPageData["recentUsage"][number],
  tx: (zh: string, en: string) => string,
): string {
  return usage.actualCostUsd == null
    ? tx("等待 models 账单", "Awaiting models charge")
    : formatBillingAmount(usage.actualCostUsd, usage.currency);
}

function formatUsageOwner(
  usage: CostPageData["recentUsage"][number],
  tx: (zh: string, en: string) => string,
): string {
  if (usage.billingStatus === "unallocated" || usage.agentId === "unknown" || usage.agentId === "__unattributed__") {
    return tx("未归属用量", "Unattributed usage");
  }
  return usage.agentId;
}

function formatBillingSource(
  agent: CostPageData["agents"][number],
  tx: (zh: string, en: string) => string,
): string {
  if (agent.providerAccountId) return agent.providerAccountId;
  if (agent.runtimeCredentialId) return tx("models 托管凭据", "Managed models credential");
  return tx("历史记录", "Historical record");
}

function formatBalanceError(
  code: Extract<TeamBillingBalanceResult, { errorCode: string }>["errorCode"],
  tx: (zh: string, en: string) => string,
): string {
  if (code === "remote_mode_required") return tx("仅服务器模式提供 models 余额", "Models balance is available in remote mode only");
  if (code === "models_not_configured") return tx("models 服务尚未配置", "Models billing is not configured");
  if (code === "tenant_scope_missing") return tx("工作区尚未绑定 models 租户", "Workspace is not linked to a models tenant");
  return tx("models 账单服务不可用", "Models billing service unavailable");
}

function BudgetManager({
  budgets,
  tx,
  isPending,
  showAddBudget,
  onShowAddBudget,
  onSave,
  onToggle,
  onDelete,
}: {
  budgets: BudgetPageData;
  tx: (zh: string, en: string) => string;
  isPending: boolean;
  showAddBudget: boolean;
  onShowAddBudget: (show: boolean) => void;
  onSave: (input: { scope: BudgetScope; scopeId: string; limitUsd: number; period: BudgetPeriod; action: BudgetAction; warningThreshold: number }) => void;
  onToggle: (id: string, enabled: boolean) => void;
  onDelete: (id: string) => void;
}) {
  const [scope, setScope] = useState<BudgetScope>("workspace");
  const [scopeId, setScopeId] = useState("global");
  const [limitUsd, setLimitUsd] = useState("50");
  const [period, setPeriod] = useState<BudgetPeriod>("monthly");
  const [action, setAction] = useState<BudgetAction>("warn");
  const [threshold, setThreshold] = useState("0.8");

  return (
    <div className="budget-manager">
      <div className="budget-toolbar">
        <button
          className="budget-add-btn"
          onClick={() => onShowAddBudget(!showAddBudget)}
          type="button"
        >
          {showAddBudget ? tx("取消", "Cancel") : tx("+ 添加预算", "+ Add Budget")}
        </button>
      </div>

      {showAddBudget ? (
        <div className="budget-form">
          <div className="budget-form__row">
            <label>{tx("范围", "Scope")}</label>
            <select value={scope} onChange={(e) => {
              const newScope = e.target.value as BudgetScope;
              setScope(newScope);
              setScopeId(newScope === "workspace" ? "global" : "");
            }}>
              <option value="workspace">{tx("全局", "Workspace")}</option>
              <option value="agent">AI员工</option>
              <option value="channel">{tx("群组", "Group")}</option>
            </select>
          </div>

          {scope === "agent" ? (
            <div className="budget-form__row">
              <label>AI员工</label>
              <select value={scopeId} onChange={(e) => setScopeId(e.target.value)}>
                <option value="">{tx("选择 AI员工", "Select AI employee")}</option>
                {budgets.agents.map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}
              </select>
            </div>
          ) : null}

          {scope === "channel" ? (
            <div className="budget-form__row">
              <label>{tx("群组", "Group")}</label>
              <select value={scopeId} onChange={(e) => setScopeId(e.target.value)}>
                <option value="">{tx("选择群组", "Select Group")}</option>
                {budgets.channels.map((ch) => <option key={ch.name} value={ch.name}>{ch.name}</option>)}
              </select>
            </div>
          ) : null}

          <div className="budget-form__row">
            <label>{tx("预算上限 (CNY)", "Limit (CNY)")}</label>
            <input type="number" step="0.01" min="0" value={limitUsd} onChange={(e) => setLimitUsd(e.target.value)} />
          </div>

          <div className="budget-form__row">
            <label>{tx("周期", "Period")}</label>
            <select value={period} onChange={(e) => setPeriod(e.target.value as BudgetPeriod)}>
              <option value="monthly">{tx("每月", "Monthly")}</option>
              <option value="total">{tx("累计", "Total")}</option>
            </select>
          </div>

          <div className="budget-form__row">
            <label>{tx("超预算动作", "Over-budget Action")}</label>
            <select value={action} onChange={(e) => setAction(e.target.value as BudgetAction)}>
              <option value="warn">{tx("仅告警", "Warn Only")}</option>
              <option value="pause">{tx("暂停任务", "Pause Task")}</option>
              <option value="approve">{tx("需要审批", "Require Approval")}</option>
            </select>
          </div>

          <div className="budget-form__row">
            <label>{tx("预警阈值", "Warning Threshold")}</label>
            <input type="number" step="0.05" min="0" max="1" value={threshold} onChange={(e) => setThreshold(e.target.value)} />
          </div>

          <button
            className="budget-save-btn"
            disabled={isPending || !scopeId}
            onClick={() => onSave({
              scope,
              scopeId,
              limitUsd: parseFloat(limitUsd) || 0,
              period,
              action,
              warningThreshold: parseFloat(threshold) || 0.8,
            })}
            type="button"
          >
            {isPending ? tx("保存中...", "Saving...") : tx("保存", "Save")}
          </button>
        </div>
      ) : null}

      <div className="budget-list">
        {budgets.budgets.length > 0 ? (
          budgets.budgets.map((b) => (
            <BudgetCard key={b.id} budget={b} tx={tx} onToggle={onToggle} onDelete={onDelete} />
          ))
        ) : (
          <div className="costs-empty">{tx("暂无预算设置", "No budgets configured")}</div>
        )}
      </div>
    </div>
  );
}

function BudgetCard({
  budget,
  tx,
  onToggle,
  onDelete,
}: {
  budget: BudgetPageItem;
  tx: (zh: string, en: string) => string;
  onToggle: (id: string, enabled: boolean) => void;
  onDelete: (id: string) => void;
}) {
  const pct = Math.round(budget.percentUsed * 100);
  const barColor = pct >= 100 ? "var(--color-danger)" : pct >= 80 ? "var(--color-warning)" : "var(--color-accent)";
  const scopeLabel = budget.scope === "workspace"
    ? tx("全局", "Workspace")
    : budget.scope === "agent"
      ? `AI员工: ${budget.scopeId}`
      : `#${budget.scopeId}`;

  return (
    <div className={`budget-card${!budget.enabled ? " budget-card--disabled" : ""}`}>
      <div className="budget-card__header">
        <strong>{scopeLabel}</strong>
        <span className="budget-card__period">
          {budget.period === "monthly" ? tx("每月", "Monthly") : tx("累计", "Total")}
        </span>
      </div>
      <div className="budget-card__bar-container">
        <div
          className="budget-card__bar"
          style={{ width: `${Math.min(pct, 100)}%`, backgroundColor: barColor }}
        />
      </div>
      <div className="budget-card__stats">
        <span>{formatCny(budget.spentUsd)} / {formatCny(budget.limitUsd, 2)}</span>
        <span>{pct}%</span>
      </div>
      <div className="budget-card__meta">
        <span>{tx("超支:", "Action:")} {translateAction(budget.action, tx)}</span>
        <span>{tx("预警:", "Warn:")} {Math.round(budget.warningThreshold * 100)}%</span>
      </div>
      <div className="budget-card__actions">
        <button
          className="budget-card__toggle"
          onClick={() => onToggle(budget.id, !budget.enabled)}
          type="button"
        >
          {budget.enabled ? tx("禁用", "Disable") : tx("启用", "Enable")}
        </button>
        <button
          className="budget-card__delete"
          onClick={() => onDelete(budget.id)}
          type="button"
        >
          {tx("删除", "Delete")}
        </button>
      </div>
    </div>
  );
}

function translateAction(action: BudgetAction, tx: (zh: string, en: string) => string): string {
  if (action === "pause") return tx("暂停", "Pause");
  if (action === "approve") return tx("审批", "Approve");
  return tx("告警", "Warn");
}

function formatTokens(value: number): string {
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(1)}M`;
  if (value >= 1_000) return `${(value / 1_000).toFixed(1)}K`;
  return String(value);
}

function formatCny(value: number, fractionDigits = 4): string {
  return `¥${value.toFixed(fractionDigits)}`;
}

function formatBillingAmount(value: number, currency?: string): string {
  const normalized = currency?.trim().toUpperCase();
  return normalized && normalized !== "CNY"
    ? `${value.toFixed(4)} ${normalized}`
    : formatCny(value);
}

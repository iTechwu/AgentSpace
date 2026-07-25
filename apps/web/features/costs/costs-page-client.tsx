"use client";

import { useEffect, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { upsertBudgetAction, toggleBudgetAction, deleteBudgetAction } from "@/features/costs/actions";
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
        <CostOverview compact={isCompactLayout} data={costs} tx={tx} />
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
  tx,
}: {
  compact: boolean;
  data: CostPageData;
  tx: (zh: string, en: string) => string;
}) {
  const averagePerTask = data.totalTasks > 0 ? data.totalCostUsd / data.totalTasks : 0;
  return (
    <div className="costs-overview">
      <div className="costs-insight-band" role="list">
        <article className="costs-insight-card" role="listitem">
          <span>{tx("每任务均价", "Avg per task")}</span>
          <strong>${averagePerTask.toFixed(4)}</strong>
        </article>
        <article className="costs-insight-card" role="listitem">
          <span>{tx("模型数", "Models")}</span>
          <strong>{new Set(data.agents.map((agent) => agent.modelId)).size}</strong>
        </article>
        <article className="costs-insight-card" role="listitem">
          <span>{tx("最近记录", "Recent entries")}</span>
          <strong>{data.recentUsage.length}</strong>
        </article>
      </div>

      <div className="costs-summary-cards">
        <div className="costs-summary-card">
          <span className="costs-summary-card__label">{tx("总费用", "Total Cost")}</span>
          <span className="costs-summary-card__value">${data.totalCostUsd.toFixed(4)}</span>
        </div>
        <div className="costs-summary-card">
          <span className="costs-summary-card__label">{tx("总任务数", "Total Tasks")}</span>
          <span className="costs-summary-card__value">{data.totalTasks}</span>
        </div>
        <div className="costs-summary-card">
          <span className="costs-summary-card__label">{tx("输入 Tokens", "Input Tokens")}</span>
          <span className="costs-summary-card__value">{formatTokens(data.totalInputTokens)}</span>
        </div>
        <div className="costs-summary-card">
          <span className="costs-summary-card__label">{tx("输出 Tokens", "Output Tokens")}</span>
          <span className="costs-summary-card__value">{formatTokens(data.totalOutputTokens)}</span>
        </div>
      </div>

      <h3>{tx("Agent 费用明细", "Agent Cost Breakdown")}</h3>
      {data.agents.length > 0 ? (
        compact ? (
          <div className="costs-agent-cards">
            {data.agents.map((agent) => (
              <article className="costs-agent-card" key={`${agent.agentId}-${agent.modelId}`}>
                <div className="costs-agent-card__header">
                  <strong>{agent.displayName}</strong>
                  <span className="costs-agent-model">{agent.modelId}</span>
                </div>
                <div className="costs-agent-card__stats">
                  <span>{tx("任务数", "Tasks")}: {agent.taskCount}</span>
                  <span>{tx("输入", "Input")}: {formatTokens(agent.totalInputTokens)}</span>
                  <span>{tx("输出", "Output")}: {formatTokens(agent.totalOutputTokens)}</span>
                  <span>{tx("总费用", "Cost")}: ${agent.totalCostUsd.toFixed(4)}</span>
                  <span>{tx("均价", "Avg")}: ${agent.avgCostPerTask.toFixed(4)}</span>
                </div>
              </article>
            ))}
          </div>
        ) : (
          <div className="costs-agent-table">
            <div className="costs-agent-row costs-agent-row--header">
              <span>Agent</span>
              <span>{tx("模型", "Model")}</span>
              <span>{tx("任务数", "Tasks")}</span>
              <span>{tx("输入", "Input")}</span>
              <span>{tx("输出", "Output")}</span>
              <span>{tx("总费用", "Cost")}</span>
              <span>{tx("均价", "Avg")}</span>
            </div>
            {data.agents.map((agent) => (
              <div className="costs-agent-row" key={`${agent.agentId}-${agent.modelId}`}>
                <span className="costs-agent-name">{agent.displayName}</span>
                <span className="costs-agent-model">{agent.modelId}</span>
                <span>{agent.taskCount}</span>
                <span>{formatTokens(agent.totalInputTokens)}</span>
                <span>{formatTokens(agent.totalOutputTokens)}</span>
                <span>${agent.totalCostUsd.toFixed(4)}</span>
                <span>${agent.avgCostPerTask.toFixed(4)}</span>
              </div>
            ))}
          </div>
        )
      ) : (
        <div className="costs-empty">{tx("暂无用量数据", "No usage data yet")}</div>
      )}

      {data.recentUsage.length > 0 ? (
        <>
          <h3>{tx("最近用量", "Recent Usage")}</h3>
          {compact ? (
            <div className="costs-recent-cards">
              {data.recentUsage.slice(0, 20).map((usage) => (
                <article className="costs-recent-card" key={usage.id}>
                  <div className="costs-recent-card__header">
                    <strong>{usage.agentId}</strong>
                    <span className="costs-recent-model">{usage.modelId}</span>
                  </div>
                  <div className="costs-recent-card__stats">
                    <span>{formatTokens(usage.inputTokens)} / {formatTokens(usage.outputTokens)}</span>
                    <span>${usage.costUsd.toFixed(4)}</span>
                  </div>
                  <div className="costs-recent-time">{formatCompactTimestamp(usage.createdAt, { emptyFallback: usage.createdAt })}</div>
                </article>
              ))}
            </div>
          ) : (
            <div className="costs-recent-list">
              {data.recentUsage.slice(0, 20).map((usage) => (
                <div className="costs-recent-item" key={usage.id}>
                  <span className="costs-recent-agent">{usage.agentId}</span>
                  <span className="costs-recent-model">{usage.modelId}</span>
                  <span>{formatTokens(usage.inputTokens)} / {formatTokens(usage.outputTokens)}</span>
                  <span>${usage.costUsd.toFixed(4)}</span>
                  <span className="costs-recent-time">{formatCompactTimestamp(usage.createdAt, { emptyFallback: usage.createdAt })}</span>
                </div>
              ))}
            </div>
          )}
        </>
      ) : null}
    </div>
  );
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
              <option value="agent">Agent</option>
              <option value="channel">{tx("群组", "Group")}</option>
            </select>
          </div>

          {scope === "agent" ? (
            <div className="budget-form__row">
              <label>Agent</label>
              <select value={scopeId} onChange={(e) => setScopeId(e.target.value)}>
                <option value="">{tx("选择 Agent", "Select Agent")}</option>
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
            <label>{tx("预算上限 (USD)", "Limit (USD)")}</label>
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
      ? `Agent: ${budget.scopeId}`
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
        <span>${budget.spentUsd.toFixed(4)} / ${budget.limitUsd.toFixed(2)}</span>
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

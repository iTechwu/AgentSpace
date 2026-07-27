"use client";

import { useEffect, useState } from "react";
import type { PerformanceDashboardData } from "@dofe-agent/services";
import { useLanguage } from "@/features/i18n/language-provider";

export function PerformancePageClient({ data }: { data: PerformanceDashboardData }) {
  const { tx } = useLanguage();
  const [isCompactLayout, setIsCompactLayout] = useState(false);

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
    <div className={`performance-page${isCompactLayout ? " performance-page--compact" : ""}`}>
      <h1 className="performance-page__title">{tx("AI员工 绩效看板", "AI Employee Performance")}</h1>

      <div className="performance-summary">
        <SummaryCard
          label={tx("总任务", "Total Tasks")}
          value={String(data.totalTasks)}
        />
        <SummaryCard
          label={tx("完成率", "Completion Rate")}
          value={formatPercent(data.overallCompletionRate)}
          tone={data.overallCompletionRate >= 0.8 ? "positive" : data.overallCompletionRate >= 0.5 ? "warning" : "danger"}
        />
        <SummaryCard
          label={tx("错误率", "Error Rate")}
          value={formatPercent(data.overallErrorRate)}
          tone={data.overallErrorRate <= 0.1 ? "positive" : data.overallErrorRate <= 0.3 ? "warning" : "danger"}
        />
        <SummaryCard
          label={tx("平均响应时间", "Avg Response Time")}
          value={formatDuration(data.overallAvgResponseTimeMs)}
        />
      </div>

      {data.agents.length > 0 ? (
        isCompactLayout ? (
          <div className="performance-card-list">
            {data.agents.map((agent) => (
              <article className="performance-card" key={agent.agentId}>
                <div className="performance-card__header">
                  <div className="performance-agent-cell">
                    <strong>{agent.displayName}</strong>
                    {agent.displayName !== agent.agentId ? (
                      <span className="performance-agent-cell__id">{agent.agentId}</span>
                    ) : null}
                  </div>
                  <div className="performance-card__badges">
                    <PercentBadge value={agent.completionRate} mode="completion" />
                    <PercentBadge value={agent.errorRate} mode="error" />
                  </div>
                </div>
                <div className="performance-card__stats">
                  <span>{tx("总任务", "Tasks")}: {agent.totalTasks}</span>
                  <span>{tx("完成", "Done")}: {agent.completedTasks}</span>
                  <span>{tx("失败", "Failed")}: {agent.failedTasks}</span>
                  <span>{tx("平均响应", "Avg Time")}: {formatDuration(agent.avgResponseTimeMs)}</span>
                  <span>
                    {tx("满意度", "Satisfaction")}:{" "}
                    {agent.satisfactionRate !== null
                      ? `${formatPercent(agent.satisfactionRate)} (${agent.approvalCount}✓ / ${agent.rejectionCount}✗)`
                      : "—"}
                  </span>
                </div>
              </article>
            ))}
          </div>
        ) : (
          <div className="performance-table-wrapper">
            <table className="performance-table">
              <thead>
                <tr>
                  <th>{tx("AI员工", "AI employee")}</th>
                  <th className="performance-table__num">{tx("总任务", "Tasks")}</th>
                  <th className="performance-table__num">{tx("完成", "Done")}</th>
                  <th className="performance-table__num">{tx("失败", "Failed")}</th>
                  <th className="performance-table__num">{tx("完成率", "Rate")}</th>
                  <th className="performance-table__num">{tx("错误率", "Errors")}</th>
                  <th className="performance-table__num">{tx("平均响应", "Avg Time")}</th>
                  <th className="performance-table__num">{tx("满意度", "Satisfaction")}</th>
                </tr>
              </thead>
              <tbody>
                {data.agents.map((agent) => (
                  <tr key={agent.agentId}>
                    <td>
                      <div className="performance-agent-cell">
                        <strong>{agent.displayName}</strong>
                        {agent.displayName !== agent.agentId ? (
                          <span className="performance-agent-cell__id">{agent.agentId}</span>
                        ) : null}
                      </div>
                    </td>
                    <td className="performance-table__num">{agent.totalTasks}</td>
                    <td className="performance-table__num">{agent.completedTasks}</td>
                    <td className="performance-table__num">{agent.failedTasks}</td>
                    <td className="performance-table__num">
                      <PercentBadge value={agent.completionRate} mode="completion" />
                    </td>
                    <td className="performance-table__num">
                      <PercentBadge value={agent.errorRate} mode="error" />
                    </td>
                    <td className="performance-table__num">
                      {formatDuration(agent.avgResponseTimeMs)}
                    </td>
                    <td className="performance-table__num">
                      {agent.satisfactionRate !== null ? (
                        <span>
                          {formatPercent(agent.satisfactionRate)}
                          <span className="performance-sat-detail">
                            {" "}({agent.approvalCount}✓ / {agent.rejectionCount}✗)
                          </span>
                        </span>
                      ) : (
                        <span className="performance-muted">—</span>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )
      ) : (
        <div className="performance-empty">
          {tx("还没有任务执行记录。", "No task executions yet.")}
        </div>
      )}
    </div>
  );
}

function SummaryCard({
  label,
  value,
  tone,
}: {
  label: string;
  value: string;
  tone?: "positive" | "warning" | "danger";
}) {
  return (
    <div className="performance-summary-card">
      <div className="performance-summary-card__label">{label}</div>
      <div className={`performance-summary-card__value${tone ? ` performance-summary-card__value--${tone}` : ""}`}>
        {value}
      </div>
    </div>
  );
}

function PercentBadge({ value, mode }: { value: number; mode: "completion" | "error" }) {
  const tone =
    mode === "completion"
      ? value >= 0.8 ? "positive" : value >= 0.5 ? "warning" : "danger"
      : value <= 0.1 ? "positive" : value <= 0.3 ? "warning" : "danger";

  return (
    <span className={`performance-badge performance-badge--${tone}`}>
      {formatPercent(value)}
    </span>
  );
}

function formatPercent(value: number): string {
  return `${Math.round(value * 100)}%`;
}

function formatDuration(ms: number | null): string {
  if (ms === null) {
    return "—";
  }

  if (ms < 1000) {
    return `${Math.round(ms)}ms`;
  }

  const seconds = ms / 1000;
  if (seconds < 60) {
    return `${seconds.toFixed(1)}s`;
  }

  const minutes = seconds / 60;
  if (minutes < 60) {
    return `${minutes.toFixed(1)}m`;
  }

  const hours = minutes / 60;
  return `${hours.toFixed(1)}h`;
}

"use client";

import { useState, useTransition } from "react";
import type { TaskEstimationResult } from "@dofe-agent/services";
import { estimateTaskAction } from "./actions";
import { useLanguage } from "@/features/i18n/language-provider";

export function EstimationCard({
  channels,
}: {
  channels: Array<{ name: string }>;
  agents: Array<{ id: string; name: string }>;
}) {
  const { tx } = useLanguage();
  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [channelName, setChannelName] = useState(channels[0]?.name ?? "");
  const [result, setResult] = useState<TaskEstimationResult | null>(null);
  const [isPending, startTransition] = useTransition();

  function handleEstimate(): void {
    if (!title.trim()) return;
    startTransition(async () => {
      const estimation = await estimateTaskAction({
        taskTitle: title.trim(),
        taskDescription: description.trim() || undefined,
        channelName: channelName || undefined,
      });
      setResult(estimation);
    });
  }

  return (
    <div className="estimation-card">
      <h3 className="estimation-card__title">{tx("任务预估报价", "Task Estimation")}</h3>

      <div className="estimation-card__form">
        <input
          className="estimation-card__input"
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          placeholder={tx("任务标题", "Task title")}
        />
        <textarea
          className="estimation-card__textarea"
          value={description}
          onChange={(e) => setDescription(e.target.value)}
          placeholder={tx("任务描述（可选）", "Task description (optional)")}
          rows={2}
        />
        <div className="estimation-card__row">
          <select
            className="estimation-card__select"
            value={channelName}
            onChange={(e) => setChannelName(e.target.value)}
          >
            <option value="">{tx("不限群组", "Any group")}</option>
            {channels.map((ch) => (
              <option key={ch.name} value={ch.name}>
                {ch.name}
              </option>
            ))}
          </select>
          <button
            className="estimation-card__btn estimation-card__btn--primary"
            disabled={isPending || !title.trim()}
            onClick={handleEstimate}
            type="button"
          >
            {isPending ? tx("预估中…", "Estimating…") : tx("预估报价", "Estimate")}
          </button>
        </div>
      </div>

      {result ? (
        <div className="estimation-card__result">
          <div className="estimation-card__result-header">
            <strong>{result.taskTitle}</strong>
            {result.channelName ? <span>{result.channelName}</span> : null}
          </div>

          {result.agents.length > 0 ? (
            <table className="estimation-table">
              <thead>
                <tr>
                  <th>{tx("AI员工", "AI employee")}</th>
                  <th className="estimation-table__num">{tx("预估费用", "Est. Cost")}</th>
                  <th className="estimation-table__num">{tx("完成率", "Rate")}</th>
                  <th className="estimation-table__num">{tx("信心", "Conf.")}</th>
                  <th className="estimation-table__num">{tx("建议预算", "Budget")}</th>
                  <th>{tx("建议", "Note")}</th>
                </tr>
              </thead>
              <tbody>
                {result.agents.map((agent) => (
                  <tr key={agent.agentId} className={agent.recommended ? "estimation-table__row--recommended" : ""}>
                    <td>
                      <div className="estimation-agent-cell">
                        <strong>{agent.displayName}</strong>
                        {agent.displayName !== agent.agentId ? (
                          <span className="estimation-agent-cell__id">{agent.agentId}</span>
                        ) : null}
                      </div>
                    </td>
                    <td className="estimation-table__num">¥{agent.estimatedCostUsd.toFixed(4)}</td>
                    <td className="estimation-table__num">{Math.round(agent.avgCompletionRate * 100)}%</td>
                    <td className="estimation-table__num">
                      <ConfidenceBadge confidence={agent.confidence} basedOn={agent.basedOnTaskCount} />
                    </td>
                    <td className="estimation-table__num">¥{agent.recommendedBudgetUsd.toFixed(4)}</td>
                    <td>{agent.recommended ? tx("推荐", "Recommended") : ""}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          ) : (
            <p className="estimation-card__empty">{tx("没有候选 AI员工。", "No candidate AI employees.")}</p>
          )}
        </div>
      ) : null}
    </div>
  );
}

function ConfidenceBadge({ confidence, basedOn }: { confidence: "high" | "medium" | "low"; basedOn: number }) {
  const { tx } = useLanguage();
  const label =
    confidence === "high"
      ? tx("高", "High")
      : confidence === "medium"
        ? tx("中", "Med")
        : tx("低", "Low");
  const detail = basedOn > 0 ? ` (${basedOn})` : "";

  return (
    <span className={`estimation-confidence estimation-confidence--${confidence}`}>
      {label}{detail}
    </span>
  );
}

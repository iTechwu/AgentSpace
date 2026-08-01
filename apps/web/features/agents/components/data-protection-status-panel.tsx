"use client";

import { useEffect, useState } from "react";
import { useLanguage } from "@/features/i18n/language-provider";
import { readWorkspaceAgentDataProtectionAction, type AgentDataProtectionSummary } from "../actions";

interface DataProtectionStatusPanelProps {
  readonly employeeName: string;
}

/**
 * Read-only "数据保护" summary for the agent detail resume (P4). Surfaces the
 * employee's persistent-workspace head revision, published artifacts, and the
 * runtime-binding generation/status from the durability control plane.
 */
export function DataProtectionStatusPanel({ employeeName }: DataProtectionStatusPanelProps) {
  const { tx } = useLanguage();
  const [summary, setSummary] = useState<AgentDataProtectionSummary | null>(null);
  const [error, setError] = useState("");

  useEffect(() => {
    let cancelled = false;
    void readWorkspaceAgentDataProtectionAction(employeeName)
      .then((value) => {
        if (!cancelled) {
          setSummary(value);
        }
      })
      .catch((cause: unknown) => {
        if (!cancelled) {
          setError(cause instanceof Error ? cause.message : String(cause));
        }
      });
    return () => {
      cancelled = true;
    };
  }, [employeeName]);

  if (error) {
    return (
      <section className="panel data-protection-panel" aria-label={tx("数据保护", "Data protection")}>
        <div className="panel-header">
          <h3>{tx("数据保护", "Data protection")}</h3>
        </div>
        <p className="data-protection-panel__error">{error}</p>
      </section>
    );
  }

  const revisionId = summary?.headRevisionId;
  const artifactCount = summary?.recentArtifactCount ?? 0;
  const bindingStatus = summary?.bindingStatus;
  const bindingGeneration = summary?.bindingGeneration;

  return (
    <section className="panel data-protection-panel" aria-label={tx("数据保护", "Data protection")}>
      <div className="panel-header">
        <h3>{tx("数据保护", "Data protection")}</h3>
        <small>{summary ? tx("持久化事实来源", "Durable source of truth") : "…"}</small>
      </div>
      <dl className="data-protection-panel__grid">
        <div>
          <dt>{tx("工作空间版本", "Workspace revision")}</dt>
          <dd>
            {revisionId
              ? `${revisionId.slice(-8)}${summary?.headRevisionDigest ? ` · ${summary.headRevisionDigest.slice(0, 12)}…` : ""}`
              : tx("无已提交版本", "No committed revision")}
          </dd>
        </div>
        <div>
          <dt>{tx("最近快照", "Last snapshot")}</dt>
          <dd>{summary?.lastSnapshotAt ? new Date(summary.lastSnapshotAt).toLocaleString() : tx("—", "—")}</dd>
        </div>
        <div>
          <dt>{tx("存储健康", "Storage health")}</dt>
          <dd>{summary?.storageHealth ?? "unknown"}</dd>
        </div>
        <div>
          <dt>{tx("正式产物", "Published artifacts")}</dt>
          <dd>{String(artifactCount)}</dd>
        </div>
        <div>
          <dt>{tx("绑定代次", "Binding generation")}</dt>
          <dd>{bindingGeneration !== null && bindingGeneration !== undefined ? String(bindingGeneration) : tx("—", "—")}</dd>
        </div>
        <div>
          <dt>{tx("运行时状态", "Runtime status")}</dt>
          <dd>{bindingStatus ?? tx("未绑定", "Unbound")}</dd>
        </div>
      </dl>
    </section>
  );
}

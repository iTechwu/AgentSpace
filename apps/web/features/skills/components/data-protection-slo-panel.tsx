"use client";

import { useCallback, useEffect, useState } from "react";
import { useLanguage } from "@/features/i18n/language-provider";
import { AppIcon } from "@/shared/ui/app-icon";
import { readDataProtectionSloDashboardAction, type DataProtectionSloView } from "@/features/skills/slo-actions";

function formatAge(seconds: number): string {
  if (seconds <= 0) return "—";
  if (seconds >= 3600) return `${Math.round(seconds / 3600)}h`;
  return `${Math.round(seconds / 60)}m`;
}

function formatBytes(bytes: number): string {
  if (bytes >= 1024 ** 3) return `${(bytes / 1024 ** 3).toFixed(2)} GiB`;
  if (bytes >= 1024 ** 2) return `${(bytes / 1024 ** 2).toFixed(1)} MiB`;
  if (bytes >= 1024) return `${(bytes / 1024).toFixed(1)} KiB`;
  return `${bytes} B`;
}

/** 数据保护 SLO 看板（P1-6）：紧凑指标网格 + 关键告警。 */
export function DataProtectionSloPanel() {
  const { tx } = useLanguage();
  const [view, setView] = useState<DataProtectionSloView>();
  const [loading, setLoading] = useState(true);

  const reload = useCallback(() => {
    setLoading(true);
    void readDataProtectionSloDashboardAction()
      .then(setView)
      .catch(() => setView(undefined))
      .finally(() => setLoading(false));
  }, []);

  useEffect(() => {
    reload();
  }, [reload]);

  if (loading) {
    return <p className="form-field__hint">{tx("正在加载 SLO…", "Loading SLO…")}</p>;
  }
  if (!view) {
    return null;
  }
  const { metrics } = view;
  const headAgeOk = metrics.workspaceHeadAgeSeconds <= view.sloTargets.headAgeSeconds;
  const rtoOk = metrics.runtimeRecoveryDurationSeconds <= view.sloTargets.recoveryRtoSeconds;

  const stats: Array<{ label: string; value: string; ok?: boolean }> = [
    { label: tx("Workspace head age", "Workspace head age"), value: formatAge(metrics.workspaceHeadAgeSeconds), ok: headAgeOk },
    { label: tx("恢复时长 RTO", "Recovery duration (RTO)"), value: metrics.runtimeRecoveryDurationSeconds > 0 ? `${metrics.runtimeRecoveryDurationSeconds}s` : "—", ok: rtoOk },
    { label: tx("Digest 校验失败", "Digest verification failures"), value: String(metrics.skillArtifactVerificationFailures), ok: metrics.skillArtifactVerificationFailures === 0 },
    { label: tx("绑定代际冲突", "Binding generation conflicts"), value: String(metrics.runtimeBindingGenerationConflicts), ok: metrics.runtimeBindingGenerationConflicts === 0 },
    { label: tx("提交对账积压", "Commit reconciliation backlog"), value: String(metrics.taskCommitReconciliationBacklog), ok: metrics.taskCommitReconciliationBacklog === 0 },
    { label: tx("数据容量", "Data capacity"), value: formatBytes(metrics.employeeDataUsageBytes) },
    { label: tx("超配额员工", "Quota exceeded employees"), value: String(metrics.retentionQuotaExceededEmployees), ok: metrics.retentionQuotaExceededEmployees === 0 },
    { label: tx("活跃 legal hold", "Active legal holds"), value: String(metrics.activeLegalHolds) },
  ];

  return (
    <section className="data-protection-slo">
      <header className="data-protection-slo__header">
        <AppIcon name="approvals" />
        <h3>{tx("数据保护 SLO 看板", "Data protection SLO dashboard")}</h3>
        <button aria-label={tx("刷新", "Refresh")} className="action-button action-button--compact action-button--icon" onClick={reload} type="button"><AppIcon name="refresh" /></button>
      </header>
      <div className="data-protection-slo__grid">
        {stats.map((stat) => (
          <div className="data-protection-slo__stat" key={stat.label}>
            <span>{stat.label}</span>
            <strong className={stat.ok === false ? "data-protection-slo__stat--bad" : ""}>{stat.value}</strong>
          </div>
        ))}
      </div>
      {view.alerts.length > 0 ? (
        <ul className="data-protection-slo__alerts">
          {view.alerts.map((alert, index) => (
            <li className={`data-protection-slo__alert data-protection-slo__alert--${alert.severity}`} key={`${alert.code}:${alert.employeeName ?? "workspace"}:${index}`}>
              <code>{alert.code}</code>
              <span>{alert.message}</span>
            </li>
          ))}
        </ul>
      ) : (
        <p className="data-protection-slo__ok">{tx("当前无告警", "No active alerts")}</p>
      )}
      <p className="data-protection-slo__meta">
        {tx("检查时间", "Checked at")}: {new Date(view.checkedAt).toLocaleString()}
      </p>
    </section>
  );
}

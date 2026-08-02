"use client";

import { useEffect, useState } from "react";
import { useLanguage } from "@/features/i18n/language-provider";
import { useAutoRefresh } from "@/shared/lib/use-auto-refresh";
import {
  approveEmployeeRecoveryAction,
  readWorkspaceAgentDataProtectionAction,
  rejectEmployeeRecoveryAction,
  triggerEmployeeBackupRestoreDrillAction,
  triggerEmployeeRecoveryAction,
  type AgentDataProtectionSummary,
} from "../actions";

interface DataProtectionStatusPanelProps {
  readonly employeeName: string;
}

const RECOVERY_PHASE_STEPS = [
  "allocate",
  "mount_workspace",
  "install_skills",
  "resolve_secrets",
  "health_check",
  "activate",
] as const;

/**
 * "数据保护" summary for the agent detail resume (P4). Surfaces the employee's
 * persistent-workspace head revision, published artifacts, runtime-binding
 * generation/status, health alerts, recent recovery operations (with live phase
 * progress + approval), and recent drill runs.
 */
export function DataProtectionStatusPanel({ employeeName }: DataProtectionStatusPanelProps) {
  const { tx } = useLanguage();
  const [summary, setSummary] = useState<AgentDataProtectionSummary | null>(null);
  const [error, setError] = useState("");
  const [runningDrill, setRunningDrill] = useState(false);
  const [drillMessage, setDrillMessage] = useState("");
  const [runningRecovery, setRunningRecovery] = useState(false);
  const [recoveryMessage, setRecoveryMessage] = useState("");

  const loadSummary = () => {
    void readWorkspaceAgentDataProtectionAction(employeeName)
      .then((value) => setSummary(value))
      .catch((cause: unknown) => setError(cause instanceof Error ? cause.message : String(cause)));
  };

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

  // Poll while a recovery is in flight so the phase stepper advances without a
  // manual refresh.
  useAutoRefresh(Boolean(summary?.activeRecoveryOperation), 4000, loadSummary);

  const runDrill = async () => {
    setRunningDrill(true);
    setDrillMessage("");
    try {
      const result = await triggerEmployeeBackupRestoreDrillAction(employeeName);
      if (result.toast) {
        setDrillMessage(tx(result.toast.zh, result.toast.en));
      } else if (result.data) {
        setDrillMessage(
          result.data.status === "completed"
            ? tx("演练已通过", "Drill passed")
            : tx("演练失败", "Drill failed"),
        );
      }
      loadSummary();
    } catch (cause: unknown) {
      setDrillMessage(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setRunningDrill(false);
    }
  };

  const runRecovery = async () => {
    setRunningRecovery(true);
    setRecoveryMessage("");
    try {
      const result = await triggerEmployeeRecoveryAction(employeeName, { requireApproval: true });
      if (result.toast) {
        setRecoveryMessage(tx(result.toast.zh, result.toast.en));
      }
      loadSummary();
    } catch (cause: unknown) {
      setRecoveryMessage(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setRunningRecovery(false);
    }
  };

  const decideRecovery = async (operationId: string, approve: boolean) => {
    setRecoveryMessage("");
    try {
      const result = approve
        ? await approveEmployeeRecoveryAction(employeeName, operationId)
        : await rejectEmployeeRecoveryAction(employeeName, operationId);
      if (result.toast) {
        setRecoveryMessage(tx(result.toast.zh, result.toast.en));
      }
      loadSummary();
    } catch (cause: unknown) {
      setRecoveryMessage(cause instanceof Error ? cause.message : String(cause));
    }
  };

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
  const alerts = summary?.alerts ?? [];
  const recoveryOps = summary?.recentRecoveryOperations ?? [];
  const drillRuns = summary?.recentDrillRuns ?? [];

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

      <div className="data-protection-panel__section">
        <h4>{tx("健康告警", "Health alerts")}</h4>
        {alerts.length === 0 ? (
          <p className="data-protection-panel__ok">{tx("当前无针对该员工的告警。", "No alerts for this employee.")}</p>
        ) : (
          <ul className="data-protection-panel__alert-list">
            {alerts.map((alert) => (
              <li key={alert.code} className={`data-protection-panel__alert data-protection-panel__alert--${alert.severity}`}>
                <strong>{alert.code}</strong>
                <span>{alert.message}</span>
                {alert.value !== undefined && <small>{alert.metric}: {alert.value}</small>}
              </li>
            ))}
          </ul>
        )}
      </div>

      <div className="data-protection-panel__section">
        <div className="data-protection-panel__section-header">
          <h4>{tx("恢复进度", "Recovery progress")}</h4>
          <button
            type="button"
            className="button button--small"
            onClick={runRecovery}
            disabled={runningRecovery || Boolean(summary?.activeRecoveryOperation)}
          >
            {runningRecovery ? tx("启动中…", "Starting…") : tx("启动恢复", "Start recovery")}
          </button>
        </div>
        {recoveryMessage && <p className="data-protection-panel__drill-message">{recoveryMessage}</p>}
        {!summary?.activeRecoveryOperation ? (
          <p className="data-protection-panel__empty">{tx("无进行中的恢复。", "No recovery in progress.")}</p>
        ) : (() => {
          const activeOp = summary.activeRecoveryOperation!;
          const currentIndex = RECOVERY_PHASE_STEPS.indexOf(
            activeOp.phase as (typeof RECOVERY_PHASE_STEPS)[number],
          );
          return (
            <>
              <ol className="data-protection-panel__phase-steps">
                {RECOVERY_PHASE_STEPS.map((phase, index) => (
                  <li
                    key={phase}
                    className={[
                      "data-protection-panel__phase",
                      index < currentIndex ? "data-protection-panel__phase--done" : "",
                      index === currentIndex ? "data-protection-panel__phase--current" : "",
                    ].join(" ")}
                  >
                    <span>{tx(phase, phase)}</span>
                  </li>
                ))}
              </ol>
              {activeOp.approvalState === "pending" && (
                <div className="data-protection-panel__approval">
                  <button type="button" className="button button--small" onClick={() => decideRecovery(activeOp.id, true)}>
                    {tx("批准", "Approve")}
                  </button>
                  <button type="button" className="button button--small button--danger" onClick={() => decideRecovery(activeOp.id, false)}>
                    {tx("拒绝", "Reject")}
                  </button>
                </div>
              )}
              {activeOp.errorMessage && <small className="data-protection-panel__error">{activeOp.errorMessage}</small>}
            </>
          );
        })()}
      </div>

      <div className="data-protection-panel__section">
        <h4>{tx("最近恢复操作", "Recent recovery operations")}</h4>
        {recoveryOps.length === 0 ? (
          <p className="data-protection-panel__empty">{tx("无恢复操作。", "No recovery operations.")}</p>
        ) : (
          <ul className="data-protection-panel__op-list">
            {recoveryOps.map((op) => (
              <li key={op.id} className={`data-protection-panel__op data-protection-panel__op--${op.phase}`}>
                <span>{op.phase}</span>
                <span>{new Date(op.createdAt).toLocaleString()}</span>
                {op.errorMessage && <small>{op.errorMessage}</small>}
              </li>
            ))}
          </ul>
        )}
      </div>

      <div className="data-protection-panel__section">
        <div className="data-protection-panel__section-header">
          <h4>{tx("备份/恢复演练", "Backup/restore drills")}</h4>
          <button
            type="button"
            className="button button--small"
            onClick={runDrill}
            disabled={runningDrill || !summary}
          >
            {runningDrill ? tx("运行中…", "Running…") : tx("运行演练", "Run drill")}
          </button>
        </div>
        {drillMessage && <p className="data-protection-panel__drill-message">{drillMessage}</p>}
        {drillRuns.length === 0 ? (
          <p className="data-protection-panel__empty">{tx("暂无演练记录。", "No drill runs yet.")}</p>
        ) : (
          <ul className="data-protection-panel__drill-list">
            {drillRuns.map((run) => (
              <li key={run.id} className={`data-protection-panel__drill data-protection-panel__drill--${run.status}`}>
                <span>{run.trigger}</span>
                <span>{run.status}</span>
                <span>{new Date(run.startedAt).toLocaleString()}</span>
                <small>
                  {run.successCount}/{run.sampleCount} {tx("通过", "passed")}
                </small>
              </li>
            ))}
          </ul>
        )}
      </div>
    </section>
  );
}

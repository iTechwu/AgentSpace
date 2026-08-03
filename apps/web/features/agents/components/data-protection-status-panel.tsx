"use client";

import { useEffect, useState } from "react";
import { useLanguage } from "@/features/i18n/language-provider";
import { useAutoRefresh } from "@/shared/lib/use-auto-refresh";
import type { EmployeeDataLegalHoldRecord, EmployeeDataLegalHoldResourceType } from "@dofe-agent/db";
import {
  approveEmployeeRecoveryAction,
  createEmployeeDataLegalHoldAction,
  listEmployeeDataLegalHoldsAction,
  readWorkspaceAgentDataProtectionAction,
  rejectEmployeeRecoveryAction,
  releaseEmployeeDataLegalHoldAction,
  retryEmployeeRecoveryAction,
  restoreEmployeeWorkspaceRevisionAction,
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
  const [restoringRevisionId, setRestoringRevisionId] = useState("");
  const [legalHolds, setLegalHolds] = useState<EmployeeDataLegalHoldRecord[]>([]);
  const [loadingHolds, setLoadingHolds] = useState(false);
  const [holdMessage, setHoldMessage] = useState("");
  const [newHoldResourceType, setNewHoldResourceType] = useState<EmployeeDataLegalHoldResourceType>("employee_workspace");
  const [newHoldResourceId, setNewHoldResourceId] = useState("");
  const [newHoldReason, setNewHoldReason] = useState("");
  const [newHoldExpiresAt, setNewHoldExpiresAt] = useState("");
  const [releasingHoldId, setReleasingHoldId] = useState("");

  const loadSummary = () => {
    void readWorkspaceAgentDataProtectionAction(employeeName)
      .then((value) => setSummary(value))
      .catch((cause: unknown) => setError(cause instanceof Error ? cause.message : String(cause)));
  };

  const loadHolds = () => {
    setLoadingHolds(true);
    void listEmployeeDataLegalHoldsAction(employeeName)
      .then((value) => setLegalHolds(value))
      .catch((cause: unknown) => setHoldMessage(cause instanceof Error ? cause.message : String(cause)))
      .finally(() => setLoadingHolds(false));
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
    loadHolds();
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

  const retryRecovery = async (operationId: string) => {
    setRecoveryMessage("");
    try {
      const result = await retryEmployeeRecoveryAction(employeeName, operationId);
      if (result.toast) {
        setRecoveryMessage(tx(result.toast.zh, result.toast.en));
      }
      loadSummary();
    } catch (cause: unknown) {
      setRecoveryMessage(cause instanceof Error ? cause.message : String(cause));
    }
  };

  const restoreRevision = async (targetRevisionId: string) => {
    const confirmationEmployeeName = window.prompt(
      tx(
        `输入员工名称“${employeeName}”以确认恢复到版本 ${targetRevisionId.slice(-8)}。当前版本会保留在历史中。`,
        `Enter employee name "${employeeName}" to restore revision ${targetRevisionId.slice(-8)}. The current revision remains in history.`,
      ),
    );
    if (confirmationEmployeeName === null) return;
    setRestoringRevisionId(targetRevisionId);
    setRecoveryMessage("");
    try {
      const result = await restoreEmployeeWorkspaceRevisionAction({
        employeeName,
        targetRevisionId,
        confirmationEmployeeName,
      });
      if (result.toast) {
        setRecoveryMessage(tx(result.toast.zh, result.toast.en));
      }
      loadSummary();
    } catch (cause: unknown) {
      setRecoveryMessage(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setRestoringRevisionId("");
    }
  };

  const createHold = async () => {
    setHoldMessage("");
    try {
      const result = await createEmployeeDataLegalHoldAction({
        employeeName,
        resourceType: newHoldResourceType,
        resourceId: newHoldResourceId,
        reason: newHoldReason,
        expiresAt: newHoldExpiresAt || undefined,
      });
      if (result.toast) {
        setHoldMessage(tx(result.toast.zh, result.toast.en));
      }
      setNewHoldResourceId("");
      setNewHoldReason("");
      setNewHoldExpiresAt("");
      loadHolds();
    } catch (cause: unknown) {
      setHoldMessage(cause instanceof Error ? cause.message : String(cause));
    }
  };

  const releaseHold = async (legalHoldId: string) => {
    const reason = window.prompt(
      tx("输入释放法律保全的原因。", "Enter the reason for releasing this legal hold."),
    );
    if (reason === null) return;
    if (!reason.trim()) {
      setHoldMessage(tx("释放原因不能为空。", "Release reason is required."));
      return;
    }
    setReleasingHoldId(legalHoldId);
    setHoldMessage("");
    try {
      const result = await releaseEmployeeDataLegalHoldAction({ legalHoldId, releaseReason: reason });
      if (result.toast) {
        setHoldMessage(tx(result.toast.zh, result.toast.en));
      }
      loadHolds();
    } catch (cause: unknown) {
      setHoldMessage(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setReleasingHoldId("");
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
  const workspaceRevisions = summary?.recentWorkspaceRevisions ?? [];

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
                  <p className="data-protection-panel__approval-count">
                    {tx(
                      `审批进度：${activeOp.approvalCount ?? 0}/${activeOp.requiredApprovals ?? 1}`,
                      `Approval progress: ${activeOp.approvalCount ?? 0}/${activeOp.requiredApprovals ?? 1}`,
                    )}
                  </p>
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
        <h4>{tx("法律保全", "Legal holds")}</h4>
        {holdMessage && <p className="data-protection-panel__drill-message">{holdMessage}</p>}
        <div className="data-protection-panel__hold-form">
          <select
            className="input input--small"
            value={newHoldResourceType}
            onChange={(e) => setNewHoldResourceType(e.target.value as EmployeeDataLegalHoldResourceType)}
          >
            <option value="employee_workspace">{tx("工作空间", "Workspace")}</option>
            <option value="artifact">{tx("产物", "Artifact")}</option>
            <option value="revision">{tx("版本", "Revision")}</option>
            <option value="content_blob">{tx("内容 blob", "Content blob")}</option>
          </select>
          <input
            type="text"
            className="input input--small"
            placeholder={tx("资源 ID", "Resource ID")}
            value={newHoldResourceId}
            onChange={(e) => setNewHoldResourceId(e.target.value)}
          />
          <input
            type="text"
            className="input input--small"
            placeholder={tx("原因", "Reason")}
            value={newHoldReason}
            onChange={(e) => setNewHoldReason(e.target.value)}
          />
          <input
            type="datetime-local"
            className="input input--small"
            value={newHoldExpiresAt}
            onChange={(e) => setNewHoldExpiresAt(e.target.value)}
          />
          <button
            type="button"
            className="button button--small"
            onClick={createHold}
            disabled={!newHoldResourceId.trim() || !newHoldReason.trim()}
          >
            {tx("创建保全", "Create hold")}
          </button>
        </div>
        {loadingHolds ? (
          <p className="data-protection-panel__empty">{tx("加载中…", "Loading…")}</p>
        ) : legalHolds.length === 0 ? (
          <p className="data-protection-panel__empty">{tx("暂无法律保全。", "No legal holds.")}</p>
        ) : (
          <ul className="data-protection-panel__op-list">
            {legalHolds.map((hold) => (
              <li key={hold.id} className={`data-protection-panel__op ${hold.releasedAt ? "data-protection-panel__op--released" : ""}`}>
                <span>{hold.resourceType}</span>
                <span title={hold.resourceId}>{hold.resourceId.slice(-12)}</span>
                <span>{hold.reason}</span>
                <small>{new Date(hold.createdAt).toLocaleString()}</small>
                {hold.expiresAt && <small>{tx("到期", "Expires")}: {new Date(hold.expiresAt).toLocaleString()}</small>}
                {hold.releasedAt ? (
                  <small>{tx("已释放", "Released")}</small>
                ) : (
                  <button
                    type="button"
                    className="button button--small button--danger"
                    onClick={() => releaseHold(hold.id)}
                    disabled={releasingHoldId === hold.id}
                  >
                    {releasingHoldId === hold.id ? tx("释放中…", "Releasing…") : tx("释放", "Release")}
                  </button>
                )}
              </li>
            ))}
          </ul>
        )}
      </div>

      <div className="data-protection-panel__section">
        <h4>{tx("工作空间版本历史", "Workspace revision history")}</h4>
        {workspaceRevisions.length === 0 ? (
          <p className="data-protection-panel__empty">{tx("暂无已提交版本。", "No committed revisions.")}</p>
        ) : (
          <ul className="data-protection-panel__op-list">
            {workspaceRevisions.map((revision) => {
              const isHead = revision.id === summary?.headRevisionId;
              return (
                <li key={revision.id} className="data-protection-panel__op">
                  <span>{revision.id.slice(-8)}</span>
                  <span>{new Date(revision.createdAt).toLocaleString()}</span>
                  <small>{revision.sourceKind}</small>
                  {isHead ? (
                    <small>{tx("当前版本", "Current")}</small>
                  ) : (
                    <button
                      type="button"
                      className="button button--small"
                      disabled={Boolean(restoringRevisionId) || Boolean(summary?.activeRecoveryOperation)}
                      onClick={() => restoreRevision(revision.id)}
                    >
                      {restoringRevisionId === revision.id
                        ? tx("恢复中…", "Restoring…")
                        : tx("恢复此版本", "Restore")}
                    </button>
                  )}
                </li>
              );
            })}
          </ul>
        )}
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
                {op.phase === "failed" && op.approvalState !== "rejected" && (
                  <button type="button" className="button button--small" onClick={() => retryRecovery(op.id)}>
                    {tx("重试", "Retry")}
                  </button>
                )}
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

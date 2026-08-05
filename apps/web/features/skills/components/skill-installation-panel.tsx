"use client";

import { useCallback, useEffect, useState } from "react";
import { useLanguage } from "@/features/i18n/language-provider";
import { runToastAction } from "@/shared/lib/toast-action";
import { useFeedbackToast } from "@/shared/ui/feedback-toast-provider";
import { AppIcon } from "@/shared/ui/app-icon";
import {
  createSkillUpgradeAction,
  downloadSkillInstallationDiagnosticsAction,
  listSkillInstallApprovalsAction,
  listSkillInstallationRowsForSkillAction,
  listSkillRunnerInvocationsAction,
  promoteSkillUpgradeAction,
  rollbackSkillInstallationAction,
  uninstallSkillInstallationAction,
  type SkillInstallApprovalAuditView,
  type SkillInstallationRowView,
  type SkillRunnerInvocationAuditView,
} from "@/features/skills/installation-actions";

interface SkillInstallationPanelProps {
  readonly skillId: string;
}

const INSTALLATION_STATUS_LABELS: Record<string, [string, string]> = {
  inspecting: ["检查中", "Inspecting"],
  approval_required: ["需批准", "Approval required"],
  preparing: ["准备中", "Preparing"],
  blocked: ["需配置", "Blocked"],
  ready: ["已就绪", "Ready"],
  degraded: ["已降级", "Degraded"],
  retired: ["已退役", "Retired"],
};

const COMPONENT_STATUS_LABELS: Record<string, [string, string]> = {
  pending: ["待处理", "Pending"],
  preparing: ["准备中", "Preparing"],
  ready: ["已就绪", "Ready"],
  blocked: ["已阻断", "Blocked"],
  failed: ["失败", "Failed"],
  degraded: ["已降级", "Degraded"],
};

/**
 * Skill 安装详情（Phase 5）：按 skill 展示各 Runtime 上的安装行，含组件状态、
 * operation 历史与回滚入口。任务只会加载 `ready` 的安装（readiness gate）。
 */
export function SkillInstallationPanel({ skillId }: SkillInstallationPanelProps) {
  const { tx } = useLanguage();
  const { pushToast } = useFeedbackToast();
  const [rows, setRows] = useState<SkillInstallationRowView[]>([]);
  const [approvals, setApprovals] = useState<SkillInstallApprovalAuditView[]>([]);
  const [invocations, setInvocations] = useState<SkillRunnerInvocationAuditView[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadFailed, setLoadFailed] = useState(false);
  const [pendingRollbackId, setPendingRollbackId] = useState<string>("");
  const [pendingPromoteId, setPendingPromoteId] = useState<string>("");
  const [pendingUpgradeId, setPendingUpgradeId] = useState<string>("");
  const [pendingUninstallId, setPendingUninstallId] = useState<string>("");
  const [downloadingDiagnostics, setDownloadingDiagnostics] = useState(false);

  const reload = useCallback(() => {
    setLoading(true);
    setLoadFailed(false);
    void Promise.all([
      listSkillInstallationRowsForSkillAction({ skillId }),
      listSkillInstallApprovalsAction(),
      listSkillRunnerInvocationsAction(),
    ]).then(([nextRows, nextApprovals, nextInvocations]) => {
      setRows(nextRows);
      setApprovals(nextApprovals.filter((approval) => approval.skillId === skillId));
      const installationIds = new Set(nextRows.map((row) => row.installationId));
      setInvocations(nextInvocations.filter((invocation) => invocation.installationId && installationIds.has(invocation.installationId)));
    }).catch(() => setLoadFailed(true)).finally(() => setLoading(false));
  }, [skillId]);

  useEffect(() => {
    reload();
  }, [reload]);

  const rollback = (installationId: string) => {
    setPendingRollbackId(installationId);
    void runToastAction({
      action: () => rollbackSkillInstallationAction({ installationId }),
      pushToast,
      tx,
      fallbackError: { zh: "回滚失败。", en: "Rollback failed." },
      onSuccess: () => {
        reload();
      },
    }).finally(() => {
      setPendingRollbackId("");
    });
  };

  const uninstall = (installationId: string) => {
    if (!window.confirm(tx("卸载该 Runtime 安装？现有任务快照不受影响，新任务将不再使用它。", "Uninstall this runtime installation? Existing task snapshots are unchanged; new tasks will no longer use it."))) return;
    setPendingUninstallId(installationId);
    void runToastAction({
      action: () => uninstallSkillInstallationAction({ installationId }),
      pushToast,
      tx,
      fallbackError: { zh: "卸载失败。", en: "Uninstall failed." },
      onSuccess: reload,
    }).finally(() => setPendingUninstallId(""));
  };

  const promote = (row: SkillInstallationRowView) => {
    if (!row.previousReadyArtifactDigest) return;
    if (!window.confirm(tx("发布该候选版本？新任务和现有员工分配将切换到此 revision。", "Promote this candidate? New tasks and current employee assignments will switch to this revision."))) return;
    setPendingPromoteId(row.installationId);
    void runToastAction({
      action: () => promoteSkillUpgradeAction({
        installationId: row.installationId,
        skillId,
        expectedPreviousDigest: row.previousReadyArtifactDigest!,
      }),
      pushToast,
      tx,
      fallbackError: { zh: "候选版本发布失败。", en: "Failed to promote candidate." },
      onSuccess: reload,
    }).finally(() => setPendingPromoteId(""));
  };

  const prepareUpgrade = (row: SkillInstallationRowView) => {
    if (!row.candidateArtifactDigest) return;
    const newRiskCount = row.candidateNewRiskItems?.length ?? 0;
    const riskLine = newRiskCount > 0
      ? tx(
          `\n\n包含 ${newRiskCount} 项新的高风险能力（${row.candidateNewRiskItems!.map((item) => item.key).join("、")}）。确定已了解其影响并逐项授权？`,
          `\n\nIt introduces ${newRiskCount} new high-risk capability item(s): ${row.candidateNewRiskItems!.map((item) => item.key).join(", ")}. Confirm you understand and authorize each?`,
        )
      : "";
    const message = row.candidateBreaking
      ? tx(
          `该候选包含 ${row.candidateChangeCount ?? 0} 项变更，其中有 breaking 变更。批准并在此 Runtime 准备升级？${riskLine}`,
          `This candidate has ${row.candidateChangeCount ?? 0} changes, including breaking changes. Approve and prepare it on this runtime?${riskLine}`,
        )
      : tx(
          `在此 Runtime 准备候选版本（${row.candidateChangeCount ?? 0} 项变更）？${riskLine}`,
          `Prepare the candidate on this runtime (${row.candidateChangeCount ?? 0} changes)?${riskLine}`,
        );
    if (!window.confirm(message)) return;
    setPendingUpgradeId(row.installationId);
    void runToastAction({
      action: () => createSkillUpgradeAction({
        skillId,
        runtimeId: row.runtimeId,
        previousInstallationId: row.installationId,
        candidateArtifactDigest: row.candidateArtifactDigest,
        approved: row.candidateBreaking === true,
        approvedRisks: newRiskCount > 0,
      }),
      pushToast,
      tx,
      fallbackError: { zh: "候选版本准备失败。", en: "Failed to prepare candidate." },
      onSuccess: reload,
    }).finally(() => setPendingUpgradeId(""));
  };

  const downloadDiagnostics = () => {
    setDownloadingDiagnostics(true);
    void runToastAction({
      action: () => downloadSkillInstallationDiagnosticsAction({ skillId }),
      pushToast,
      tx,
      fallbackError: { zh: "诊断包生成失败。", en: "Failed to generate diagnostics." },
      onSuccess: (data) => downloadBase64Json(data.fileName, data.contentBase64),
    }).finally(() => setDownloadingDiagnostics(false));
  };

  if (loading) {
    return <p className="form-field__hint">{tx("正在加载安装状态…", "Loading installation state…")}</p>;
  }

  if (loadFailed) {
    return (
      <div className="skill-installation-empty" role="alert">
        <span>{tx("安装状态加载失败。", "Failed to load installation state.")}</span>
        <button className="action-button action-button--compact" onClick={reload} type="button"><AppIcon name="refresh" />{tx("重试", "Retry")}</button>
      </div>
    );
  }

  if (rows.length === 0) {
    return (
      <div>
        <p className="form-field__hint" role="status">
          {tx("该 Skill 尚未安装到任何 Runtime。", "This skill is not installed on any runtime yet.")}
        </p>
        {approvals.length > 0 ? <SkillInstallApprovalsAudit approvals={approvals} tx={tx} /> : null}
        {invocations.length > 0 ? <SkillRunnerInvocationsAudit invocations={invocations} tx={tx} /> : null}
      </div>
    );
  }

  return (
    <div className="skill-installation-list">
      <div className="skill-installation-list__toolbar">
        <span>{tx(`${rows.length} 个安装版本`, `${rows.length} installation revisions`)}</span>
        <div className="skill-installation-card__actions">
          <button aria-label={tx("下载脱敏诊断包", "Download redacted diagnostics")} className="action-button action-button--compact action-button--icon" disabled={downloadingDiagnostics} onClick={downloadDiagnostics} title={tx("下载脱敏诊断包", "Download redacted diagnostics")} type="button"><AppIcon className={downloadingDiagnostics ? "spin" : undefined} name={downloadingDiagnostics ? "loader" : "download"} /></button>
          <button aria-label={tx("刷新安装状态", "Refresh installation state")} className="action-button action-button--compact action-button--icon" onClick={reload} title={tx("刷新", "Refresh")} type="button"><AppIcon name="refresh" /></button>
        </div>
      </div>
      {approvals.length > 0 ? <SkillInstallApprovalsAudit approvals={approvals} tx={tx} /> : null}
      {invocations.length > 0 ? <SkillRunnerInvocationsAudit invocations={invocations} tx={tx} /> : null}
      {rows.map((row) => {
        const [statusZh, statusEn] = INSTALLATION_STATUS_LABELS[row.status] ?? [row.status, row.status];
        return (
          <article className="skill-installation-card" key={row.installationId}>
            <header className="skill-installation-card__header">
              <div>
                <h4>
                  {tx(statusZh, statusEn)}
                  {row.active ? ` · ${tx("当前版本", "active")}` : ""}
                  <span className="skill-installation-card__meta">
                    {" · "}
                    {row.runtimeId.slice(0, 8)}
                    {" · "}
                    {tx("revision", "revision")} {row.revision}
                  </span>
                </h4>
                <p className="skill-installation-card__digest">
                  {tx("artifact", "artifact")} {row.artifactDigest.slice(0, 12)}…
                </p>
              </div>
              <div className="skill-installation-card__actions">
                {row.active && row.status === "ready" && row.candidateArtifactDigest ? (
                  <button className="modal-secondary-button" disabled={pendingUpgradeId === row.installationId} onClick={() => prepareUpgrade(row)} type="button">
                    <AppIcon name="arrowRight" />{pendingUpgradeId === row.installationId ? tx("准备中…", "Preparing…") : tx("准备升级", "Prepare upgrade")}
                  </button>
                ) : null}
                {row.status === "ready" && !row.active && row.previousReadyArtifactDigest ? (
                  <button className="modal-secondary-button" disabled={pendingPromoteId === row.installationId} onClick={() => promote(row)} type="button">
                    <AppIcon name="checkCircle" />{pendingPromoteId === row.installationId ? tx("发布中…", "Promoting…") : tx("发布", "Promote")}
                  </button>
                ) : null}
                {(row.status === "degraded" || row.status === "blocked") && row.previousReadyRevision ? (
                  <button className="modal-secondary-button" disabled={pendingRollbackId === row.installationId} onClick={() => rollback(row.installationId)} type="button">
                    <AppIcon name="reply" />{pendingRollbackId === row.installationId ? tx("回滚中…", "Rolling back…") : tx("回滚", "Roll back")}
                  </button>
                ) : null}
                <button aria-label={tx("卸载", "Uninstall")} className="modal-secondary-button skill-installation-card__uninstall" disabled={pendingUninstallId === row.installationId} onClick={() => uninstall(row.installationId)} title={tx("卸载", "Uninstall")} type="button">
                  {pendingUninstallId === row.installationId ? <AppIcon className="spin" name="loader" /> : <AppIcon name="trash" />}
                </button>
              </div>
            </header>

            <dl className="skill-installation-evidence">
              <div><dt>{tx("健康", "Health")}</dt><dd>{row.health}</dd></div>
              <div><dt>release lock</dt><dd><code>{row.releaseLockDigest ? `${row.releaseLockDigest.slice(0, 16)}…` : tx("缺失", "missing")}</code></dd></div>
              <div><dt>{tx("已准备 digest", "Prepared digest")}</dt><dd><code>{row.preparedDigest ? `${row.preparedDigest.slice(0, 16)}…` : tx("待验证", "pending")}</code></dd></div>
              {row.candidateArtifactDigest ? (
                <div><dt>{tx("候选", "Candidate")}</dt><dd><code>{row.candidateArtifactDigest.slice(0, 12)}…</code> · {row.candidateChangeCount ?? 0} {tx("项变更", "changes")}{row.candidateBreaking ? ` · ${tx("破坏性", "breaking")}` : ""}</dd></div>
              ) : null}
            </dl>

            <div className="skill-installation-card__body">
              <div className="skill-installation-card__section">
                <h5>{tx("组件", "Components")}</h5>
                {row.components.length === 0 ? (
                  <p className="form-field__hint">{tx("无组件", "No components")}</p>
                ) : (
                  <ul className="skill-installation-components">
                    {row.components.map((component) => {
                      const [zh, en] = COMPONENT_STATUS_LABELS[component.status] ?? [component.status, component.status];
                      return (
                        <li key={`${component.kind}:${component.key}`}>
                          <span className="skill-installation-component__kind">{component.kind}</span>
                          <span className="skill-installation-component__key">{component.key}</span>
                          <span className="skill-installation-component__status">{tx(zh, en)}</span>
                          {component.errorMessage ? <span className="skill-installation-component__error" title={component.errorMessage}>{component.errorCode ?? component.errorMessage}</span> : null}
                        </li>
                      );
                    })}
                  </ul>
                )}
              </div>

              <div className="skill-installation-card__section">
                <h5>{tx("最近操作", "Recent operations")}</h5>
                {row.operations.length === 0 ? (
                  <p className="form-field__hint">{tx("无操作记录", "No operations")}</p>
                ) : (
                  <ul className="skill-installation-operations">
                    {row.operations.map((operation) => (
                      <li key={operation.id}>
                        <span className="skill-installation-operation__type">{operation.operation}</span>
                        <span className="skill-installation-operation__status">{operation.status}</span>
                        <span className="skill-installation-operation__attempt">#{operation.claimGeneration}</span>
                        {operation.evidence ? (
                          <span className="skill-installation-operation__evidence">
                            {operation.evidence.cacheHit !== undefined ? (operation.evidence.cacheHit ? tx("缓存命中", "cache hit") : tx("现场准备", "materialized")) : null}
                            {operation.evidence.installedDependencyCount !== undefined ? ` · ${operation.evidence.installedDependencyCount} ${tx("项依赖", "dependencies")}` : ""}
                          </span>
                        ) : null}
                        {operation.errorMessage ? (
                          <span className="skill-installation-operation__error" title={operation.errorMessage}>
                            {operation.errorMessage}
                          </span>
                        ) : null}
                      </li>
                    ))}
                  </ul>
                )}
              </div>
            </div>
          </article>
        );
      })}
    </div>
  );
}

function downloadBase64Json(fileName: string, contentBase64: string): void {
  const binary = atob(contentBase64);
  const buffer = new ArrayBuffer(binary.length);
  const bytes = new Uint8Array(buffer);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  const url = URL.createObjectURL(new Blob([buffer], { type: "application/json" }));
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = fileName;
  anchor.click();
  URL.revokeObjectURL(url);
}

/** Skill Runner 调用审计入口：展示该 Skill 各安装上的 entrypoint 调用记录（P1-3）。 */
function SkillRunnerInvocationsAudit({
  invocations,
  tx,
}: {
  invocations: SkillRunnerInvocationAuditView[];
  tx: (zh: string, en: string) => string;
}) {
  return (
    <details className="skill-install-approvals-audit">
      <summary>
        {tx(`Runner 调用记录（${invocations.length}）`, `Runner invocation records (${invocations.length})`)}
      </summary>
      <ul>
        {invocations.map((invocation) => (
          <li key={invocation.id}>
            <div>
              <span className={`skill-install-approvals-audit__decision ${invocation.resultCode === 0 && !invocation.timedOut ? "" : "skill-install-approvals-audit__decision--fail"}`}>
                {invocation.resultCode === 0 && !invocation.timedOut ? tx("成功", "OK") : tx(`失败 ${invocation.resultCode}`, `exit ${invocation.resultCode}`)}
              </span>
              <code className="skill-install-approvals-audit__digest">{invocation.entrypointKey}</code>
              {invocation.timedOut ? <span className="skill-install-approvals-audit__consumed">{tx("超时", "timeout")}</span> : null}
            </div>
            <div>
              <span>{new Date(invocation.createdAt).toLocaleString()}</span>
              {invocation.durationMs !== undefined ? <span> · {invocation.durationMs}ms</span> : null}
              {invocation.safeSummary ? <span className="skill-install-approvals-audit__reason">{invocation.safeSummary}</span> : null}
            </div>
          </li>
        ))}
      </ul>
    </details>
  );
}

/** 审批审计入口：展示该 Skill 的首次安装逐项授权记录（P0-2）。 */
function SkillInstallApprovalsAudit({
  approvals,
  tx,
}: {
  approvals: SkillInstallApprovalAuditView[];
  tx: (zh: string, en: string) => string;
}) {
  return (
    <details className="skill-install-approvals-audit">
      <summary>
        {tx(`审批记录（${approvals.length}）`, `Approval records (${approvals.length})`)}
      </summary>
      <ul>
        {approvals.map((approval) => (
          <li key={approval.id}>
            <div>
              <span className="skill-install-approvals-audit__decision">{approval.decision}</span>
              <code className="skill-install-approvals-audit__digest">{approval.artifactDigest.slice(0, 12)}…</code>
              {approval.consumedAt ? <span className="skill-install-approvals-audit__consumed">{tx("已消费", "consumed")}</span> : null}
            </div>
            <div>
              <span>{new Date(approval.createdAt).toLocaleString()}</span>
              {approval.reason ? <span className="skill-install-approvals-audit__reason">{approval.reason}</span> : null}
            </div>
            <ul>
              {approval.riskItems.map((item, index) => (
                <li key={`${item.category}:${item.key}:${index}`}><code>{item.key}</code></li>
              ))}
            </ul>
          </li>
        ))}
      </ul>
    </details>
  );
}

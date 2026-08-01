"use client";

import { useCallback, useEffect, useState } from "react";
import { useLanguage } from "@/features/i18n/language-provider";
import { runToastAction } from "@/shared/lib/toast-action";
import { useFeedbackToast } from "@/shared/ui/feedback-toast-provider";
import {
  listSkillInstallationRowsForSkillAction,
  rollbackSkillInstallationAction,
  type SkillInstallationRowView,
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
  const [loading, setLoading] = useState(true);
  const [loadFailed, setLoadFailed] = useState(false);
  const [pendingRollbackId, setPendingRollbackId] = useState<string>("");

  const reload = useCallback(() => {
    setLoading(true);
    setLoadFailed(false);
    void listSkillInstallationRowsForSkillAction({ skillId })
      .then(setRows)
      .catch(() => setLoadFailed(true))
      .finally(() => setLoading(false));
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

  if (loading) {
    return <p className="form-field__hint">{tx("正在加载安装状态…", "Loading installation state…")}</p>;
  }

  if (loadFailed) {
    return (
      <p className="form-field__hint" role="status">
        {tx("安装状态加载失败。", "Failed to load installation state.")}
      </p>
    );
  }

  if (rows.length === 0) {
    return (
      <p className="form-field__hint" role="status">
        {tx("该 Skill 尚未安装到任何 Runtime。", "This skill is not installed on any runtime yet.")}
      </p>
    );
  }

  return (
    <div className="skill-installation-list">
      {rows.map((row) => {
        const [statusZh, statusEn] = INSTALLATION_STATUS_LABELS[row.status] ?? [row.status, row.status];
        return (
          <article className="skill-installation-card" key={row.installationId}>
            <header className="skill-installation-card__header">
              <div>
                <h4>
                  {tx(statusZh, statusEn)}
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
              {(row.status === "degraded" || row.status === "blocked") && row.previousReadyRevision ? (
                <button
                  className="modal-secondary-button"
                  disabled={pendingRollbackId === row.installationId}
                  onClick={() => rollback(row.installationId)}
                  type="button"
                >
                  {pendingRollbackId === row.installationId
                    ? tx("回滚中…", "Rolling back…")
                    : tx("回滚", "Roll back")}
                </button>
              ) : null}
            </header>

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

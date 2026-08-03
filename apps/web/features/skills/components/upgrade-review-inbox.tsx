"use client";

import { useCallback, useEffect, useState } from "react";
import { useLanguage } from "@/features/i18n/language-provider";
import { runToastAction } from "@/shared/lib/toast-action";
import { useFeedbackToast } from "@/shared/ui/feedback-toast-provider";
import { AppIcon } from "@/shared/ui/app-icon";
import {
  listUpgradeReviewCandidatesAction,
  reviewUpgradeCandidateAction,
  type UpgradeReviewCandidateView,
} from "@/features/skills/installation-actions";

const DIFF_CATEGORY_LABELS: Record<string, [string, string]> = {
  content: ["内容", "Content"],
  execution: ["执行", "Execution"],
  network_permissions: ["能力/网络", "Capabilities / network"],
  services: ["服务", "Services"],
  config: ["配置", "Config"],
};

/**
 * 升级审批收件箱（P1-3）：展示工作区内等待审批的升级候选，
 * 提供逐项 semantic diff 与高风险能力变更，可批准或驳回。
 */
export function UpgradeReviewInbox({ onActionDone }: { onActionDone?: () => void }) {
  const { tx } = useLanguage();
  const { pushToast } = useFeedbackToast();
  const [candidates, setCandidates] = useState<UpgradeReviewCandidateView[]>([]);
  const [loading, setLoading] = useState(true);
  const [pendingId, setPendingId] = useState("");
  const [reasons, setReasons] = useState<Record<string, string>>({});

  const reload = useCallback(() => {
    setLoading(true);
    void listUpgradeReviewCandidatesAction()
      .then(setCandidates)
      .catch(() => setCandidates([]))
      .finally(() => setLoading(false));
  }, []);

  useEffect(() => {
    reload();
  }, [reload]);

  if (loading) {
    return <p className="form-field__hint">{tx("正在加载升级候选…", "Loading upgrade candidates…")}</p>;
  }
  if (candidates.length === 0) {
    return null;
  }

  const review = (candidate: UpgradeReviewCandidateView, decision: "approved" | "rejected") => {
    const reason = reasons[candidate.previousInstallationId] ?? "";
    if (decision === "rejected" && !reason.trim()) {
      window.alert(tx("驳回前请填写理由。", "Please provide a reason before rejecting."));
      return;
    }
    if (decision === "approved" && candidate.breaking && !window.confirm(tx("该升级包含 breaking 变更，确定批准？", "This upgrade contains breaking changes. Approve it?"))) {
      return;
    }
    setPendingId(candidate.previousInstallationId);
    void runToastAction({
      action: () => reviewUpgradeCandidateAction({
        skillId: candidate.skillId,
        runtimeId: candidate.runtimeId,
        previousInstallationId: candidate.previousInstallationId,
        decision,
        reason,
      }),
      pushToast,
      tx,
      fallbackError: { zh: "审批处理失败。", en: "Failed to process the review." },
      onSuccess: () => {
        reload();
        onActionDone?.();
      },
    }).finally(() => setPendingId(""));
  };

  return (
    <section className="skill-upgrade-inbox">
      <header className="skill-upgrade-inbox__header">
        <AppIcon name="alertCircle" />
        <h3>{tx(`待审批升级（${candidates.length}）`, `Pending upgrade approvals (${candidates.length})`)}</h3>
        <button aria-label={tx("刷新", "Refresh")} className="action-button action-button--compact action-button--icon" onClick={reload} type="button"><AppIcon name="refresh" /></button>
      </header>
      <ul className="skill-upgrade-inbox__list">
        {candidates.map((candidate) => (
          <li className="skill-upgrade-inbox__card" key={`${candidate.previousInstallationId}:${candidate.candidateArtifactDigest}`}>
            <div className="skill-upgrade-inbox__summary">
              <strong>{candidate.skillName}</strong>
              <span className={candidate.breaking ? "skill-upgrade-inbox__breaking" : ""}>
                {tx(`${candidate.changeCount} 项变更`, `${candidate.changeCount} changes`)}
                {candidate.breaking ? ` · ${tx("breaking", "breaking")}` : ""}
              </span>
              <span className="skill-upgrade-inbox__runtime">{candidate.runtimeId.slice(0, 8)} · {tx("revision", "revision")} {candidate.previousRevision}</span>
            </div>

            <details className="skill-upgrade-inbox__diff">
              <summary>{tx("逐项 semantic diff", "Per-item semantic diff")}</summary>
              <ul>
                {candidate.diffCategories.map((category) => (
                  <li key={category.category}>
                    <span>{DIFF_CATEGORY_LABELS[category.category]?.[0] ?? category.category}</span>
                    {category.changes.length > 0 ? (
                      <ul>
                        {category.changes.map((change) => <li key={change}><code>{change}</code></li>)}
                      </ul>
                    ) : <em>{tx("无变化", "no changes")}</em>}
                  </li>
                ))}
              </ul>
              {candidate.newRiskItems.length > 0 ? (
                <div className="skill-upgrade-inbox__risks">
                  <span className="skill-install-risk-category">{tx("新增高风险能力", "New high-risk capabilities")}</span>
                  <ul>
                    {candidate.newRiskItems.map((item) => <li key={item.key}><code>{item.key}</code></li>)}
                  </ul>
                </div>
              ) : null}
            </details>

            <div className="skill-upgrade-inbox__actions">
              <input
                className="text-input"
                onChange={(event) => setReasons((current) => ({ ...current, [candidate.previousInstallationId]: event.target.value }))}
                placeholder={tx("审批/驳回理由…", "Approval / rejection reason…")}
                value={reasons[candidate.previousInstallationId] ?? ""}
              />
              <button className="modal-secondary-button" disabled={pendingId === candidate.previousInstallationId} onClick={() => review(candidate, "rejected")} type="button">
                <AppIcon name="close" />{tx("驳回", "Reject")}
              </button>
              <button className="primary-button" disabled={pendingId === candidate.previousInstallationId} onClick={() => review(candidate, "approved")} type="button">
                <AppIcon name="checkCircle" />{tx("批准", "Approve")}
              </button>
            </div>
          </li>
        ))}
      </ul>
    </section>
  );
}

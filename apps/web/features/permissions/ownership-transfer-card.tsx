"use client";

import { useState, useTransition } from "react";
import type { PermissionCatalogMember } from "@dofe-agent/services";
import { transferWorkspaceOwnershipAction } from "@/features/settings/actions";
import type { SettingsTx } from "@/features/settings/settings-types";
import { translateSettingsActionError } from "@/features/settings/settings-utils";

/**
 * Owner-only card to transfer workspace ownership. The change is written to the
 * IdP (sso.dofe.ai) via the server action so it survives SSO re-sync; the acting
 * Owner is demoted to Admin. Candidates are the workspace's non-owner members.
 */
export function OwnershipTransferCard({
  candidates,
  tx,
}: {
  candidates: PermissionCatalogMember[];
  tx: SettingsTx;
}) {
  const [targetUserId, setTargetUserId] = useState("");
  const [feedback, setFeedback] = useState<string | null>(null);
  const [isPending, startTransition] = useTransition();

  // The acting viewer is the Owner, so excluding owners also excludes self.
  const eligible = candidates.filter((candidate) => candidate.role !== "owner");

  function handleTransfer() {
    if (!targetUserId) {
      setFeedback(tx("请先选择一名成员。", "Select a member first."));
      return;
    }
    const confirmed = window.confirm(
      tx(
        "转移后你将变为 Admin，对方成为新的 Owner。该操作会同步到 SSO（不会因重新登录回滚）并记录审计。确定继续？",
        "You will become Admin and the selected member becomes the new Owner. This syncs to SSO (survives re-login) and is audited. Continue?",
      ),
    );
    if (!confirmed) return;

    setFeedback(null);
    startTransition(async () => {
      try {
        await transferWorkspaceOwnershipAction({ targetUserId });
        setFeedback(tx("所有权已转移。你已是 Admin。", "Ownership transferred. You are now Admin."));
        setTargetUserId("");
      } catch (error) {
        setFeedback(translateSettingsActionError(error, tx));
      }
    });
  }

  return (
    <div className="ownership-transfer-card panel-header">
      <div>
        <h3>{tx("所有权转移", "Ownership transfer")}</h3>
        <p className="settings-panel-note">
          {tx(
            "将工作区 Owner 转给另一名成员。转移会写入 SSO（不会因重新登录被回滚），你将降级为 Admin。",
            "Transfer workspace Owner to another member. The change is written to SSO (survives re-login); you become Admin.",
          )}
        </p>
        {eligible.length === 0 ? (
          <p className="settings-feedback">
            {tx("当前没有可转移的成员。", "No eligible members to transfer to.")}
          </p>
        ) : (
          <div className="ownership-transfer-controls">
            <label className="permissions-center-search">
              <span>{tx("新 Owner", "New owner")}</span>
              <select
                disabled={isPending}
                onChange={(event) => setTargetUserId(event.currentTarget.value)}
                value={targetUserId}
              >
                <option value="">{tx("选择成员…", "Select member…")}</option>
                {eligible.map((candidate) => (
                  <option key={candidate.userId} value={candidate.userId}>
                    {candidate.displayName} ({candidate.role})
                  </option>
                ))}
              </select>
            </label>
            <button
              className="btn btn--danger"
              disabled={isPending || !targetUserId}
              onClick={handleTransfer}
              type="button"
            >
              {isPending ? tx("转移中…", "Transferring…") : tx("转移所有权", "Transfer ownership")}
            </button>
          </div>
        )}
      </div>
      {feedback ? (
        <p aria-live="polite" className="settings-feedback" role="status">
          {feedback}
        </p>
      ) : null}
    </div>
  );
}

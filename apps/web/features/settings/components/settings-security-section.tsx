"use client";

import { type Dispatch, type SetStateAction, type TransitionStartFunction } from "react";
import { revokeOtherSessionsAction, revokeSessionAction } from "@/features/settings/actions";
import { SettingsSectionShell } from "@/features/settings/components/settings-chrome";
import type { SettingsSectionMeta } from "@/features/settings/settings-meta";
import type { SettingsSessionItem, SettingsTx } from "@/features/settings/settings-types";
import {
  describeSession,
  describeSessionFingerprint,
  formatSessionTimestamp,
  translateSettingsActionError,
} from "@/features/settings/settings-utils";
import { EmptyState } from "@/shared/ui/empty-state";

export function SettingsSecuritySection({
  currentSessionId,
  isPending,
  meta,
  refreshSettingsData,
  securityFeedback,
  sessionFilter,
  sessions,
  setSecurityFeedback,
  setSessionFilter,
  startTransition,
  tx,
}: {
  currentSessionId?: string;
  isPending: boolean;
  meta: SettingsSectionMeta;
  refreshSettingsData: () => void;
  securityFeedback: string | null;
  sessionFilter: "active" | "revoked" | "all";
  sessions: SettingsSessionItem[];
  setSecurityFeedback: Dispatch<SetStateAction<string | null>>;
  setSessionFilter: Dispatch<SetStateAction<"active" | "revoked" | "all">>;
  startTransition: TransitionStartFunction;
  tx: SettingsTx;
}) {
  const visibleSessions = sessions.filter((session) => {
    if (sessionFilter === "all") {
      return true;
    }
    if (sessionFilter === "revoked") {
      return Boolean(session.revokedAt);
    }

    return !session.revokedAt;
  });

  return (
    <SettingsSectionShell meta={meta}>
      <section className="page-panel">
        <div className="panel-header">
          <div>
            <h3>{tx("设备与登录会话", "Devices & Sessions")}</h3>
            <p className="settings-panel-note">
              {tx("查看当前设备、活跃会话和已撤销会话，把危险动作集中在这里处理。", "Review current, active, and revoked sessions, and keep sign-out actions isolated here.")}
            </p>
          </div>
        </div>

        <div className="settings-danger-callout">
          <div>
            <strong>{tx("危险动作", "Danger zone")}</strong>
            <p>{tx("如果你怀疑账号已在其他设备登录，可在这里一次性退出其他设备。", "If you suspect your account is signed in elsewhere, sign out the other devices from here.")}</p>
          </div>
          <button
            className="secondary-button"
            disabled={isPending || sessions.filter((session) => session.id !== currentSessionId && !session.revokedAt).length === 0}
            onClick={() => {
              startTransition(async () => {
                try {
                  const result = await revokeOtherSessionsAction();
                  const revokedCount = result?.revokedCount ?? 0;
                  setSecurityFeedback(
                    revokedCount > 0
                      ? tx(`已退出 ${revokedCount} 台其他设备。`, `Signed out ${revokedCount} other device(s).`)
                      : tx("没有可退出的其他设备。", "No other devices were signed in."),
                  );
                  refreshSettingsData();
                } catch (error) {
                  setSecurityFeedback(translateSettingsActionError(error, tx));
                }
              });
            }}
            type="button"
          >
            {tx("退出其他设备", "Sign Out Other Devices")}
          </button>
        </div>

        {securityFeedback ? <p aria-live="polite" className="settings-feedback" role="status">{securityFeedback}</p> : null}

        <div className="settings-filter-row">
          {[
            ["active", tx("活跃会话", "Active")],
            ["revoked", tx("已撤销", "Revoked")],
            ["all", tx("全部会话", "All sessions")],
          ].map(([value, label]) => (
            <button
              className={`filter-pill${sessionFilter === value ? " filter-pill--active" : ""}`}
              key={value}
              onClick={() => setSessionFilter(value as "active" | "revoked" | "all")}
              type="button"
            >
              {label}
            </button>
          ))}
        </div>

        <div className="settings-session-list">
          {visibleSessions.length > 0 ? (
            visibleSessions.map((session) => (
              <SessionCard
                currentSessionId={currentSessionId}
                isPending={isPending}
                key={session.id}
                refreshSettingsData={refreshSettingsData}
                session={session}
                setSecurityFeedback={setSecurityFeedback}
                startTransition={startTransition}
                tx={tx}
              />
            ))
          ) : (
            <EmptyState title={tx("当前筛选下暂无会话。", "No sessions match the current filter.")} />
          )}
        </div>
      </section>
    </SettingsSectionShell>
  );
}

function SessionCard({
  currentSessionId,
  isPending,
  refreshSettingsData,
  session,
  setSecurityFeedback,
  startTransition,
  tx,
}: {
  currentSessionId?: string;
  isPending: boolean;
  refreshSettingsData: () => void;
  session: SettingsSessionItem;
  setSecurityFeedback: Dispatch<SetStateAction<string | null>>;
  startTransition: TransitionStartFunction;
  tx: SettingsTx;
}) {
  const isCurrent = session.id === currentSessionId;
  const isRevoked = Boolean(session.revokedAt);
  const statusLabel = isCurrent
    ? tx("当前设备", "Current device")
    : isRevoked
      ? tx("已撤销", "Revoked")
      : tx("活跃", "Active");

  return (
    <article className="settings-session-card">
      <div className="settings-session-card__header">
        <div>
          <strong>{describeSession(session.userAgent, tx)}</strong>
          <p>{statusLabel}</p>
        </div>
        <button
          className="secondary-button"
          disabled={isPending || isCurrent || isRevoked}
          onClick={() => {
            startTransition(async () => {
              try {
                await revokeSessionAction(session.id);
                setSecurityFeedback(tx("会话已撤销。", "Session revoked."));
                refreshSettingsData();
              } catch (error) {
                setSecurityFeedback(translateSettingsActionError(error, tx));
              }
            });
          }}
          type="button"
        >
          {tx("撤销", "Revoke")}
        </button>
      </div>

      <div className="settings-session-card__meta">
        <span>{tx(`会话 ID ${describeSessionFingerprint(session.id)}`, `Session ID ${describeSessionFingerprint(session.id)}`)}</span>
        <span>{tx(`登录时间 ${formatSessionTimestamp(session.createdAt)}`, `Signed in ${formatSessionTimestamp(session.createdAt)}`)}</span>
        <span>{tx(`最近活动 ${formatSessionTimestamp(session.lastSeenAt)}`, `Last active ${formatSessionTimestamp(session.lastSeenAt)}`)}</span>
        <span>{tx(`过期时间 ${formatSessionTimestamp(session.expiresAt)}`, `Expires ${formatSessionTimestamp(session.expiresAt)}`)}</span>
        <span>{tx(`IP ${session.ipAddress ?? "unknown"}`, `IP ${session.ipAddress ?? "unknown"}`)}</span>
        {session.revokedAt ? (
          <span>{tx(`撤销时间 ${formatSessionTimestamp(session.revokedAt)}`, `Revoked ${formatSessionTimestamp(session.revokedAt)}`)}</span>
        ) : null}
      </div>
    </article>
  );
}

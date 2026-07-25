"use client";

import { formatDaemonProviderLabel } from "@dofe-agent/domain";
import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { pruneOldOfflineDaemonsAction } from "@/features/agents/actions";
import {
  createDaemonApiTokenAction,
  revokeDaemonApiTokenAction,
} from "@/features/settings/actions";
import { useLanguage } from "@/features/i18n/language-provider";
import { AppIcon } from "@/shared/ui/app-icon";
import { runToastAction } from "@/shared/lib/toast-action";
import { useFeedbackToast } from "@/shared/ui/feedback-toast-provider";
import type {
  DaemonSnapshotView,
  DaemonTokenView,
} from "@/features/dashboard/data";

interface DaemonManagementPanelProps {
  daemonSnapshots: DaemonSnapshotView[];
  daemonTokens: DaemonTokenView[];
  pending?: boolean;
  onDeleteRuntime?: (runtime: DaemonSnapshotView["runtimes"][number]) => void;
}

export function DaemonManagementPanel({
  daemonSnapshots,
  daemonTokens,
  pending = false,
  onDeleteRuntime,
}: DaemonManagementPanelProps) {
  const { tx } = useLanguage();
  const { pushToast } = useFeedbackToast();
  const router = useRouter();
  const [isPending, startTransition] = useTransition();
  const [createdToken, setCreatedToken] = useState<{
    id: string;
    label: string;
    token: string;
  } | null>(null);

  return (
    <>
      <div className="subsection">
        <div className="panel-header">
          <div>
            <h3>{tx("远程服务器状态", "Remote Server Status")}</h3>
          </div>
          <div className="panel-header__actions">
            <button
              className="action-button action-button--danger"
              disabled={isPending}
              onClick={() => {
                startTransition(async () => {
                  await runToastAction({
                    action: pruneOldOfflineDaemonsAction,
                    onSuccess: async () => {
                      router.refresh();
                    },
                    pushToast,
                    tx,
                    fallbackError: {
                      zh: "清理旧 daemon 失败。",
                      en: "Failed to clean old daemons.",
                    },
                  });
                });
              }}
              title={tx("删除 7 天以上没有心跳的离线 daemon", "Delete offline daemons without a heartbeat for more than 7 days")}
              type="button"
            >
              {isPending ? tx("清理中...", "Cleaning...") : tx("清理旧 daemon", "Clean old daemons")}
            </button>
          </div>
        </div>

        {daemonSnapshots.length > 0 ? (
          <div className="settings-daemon-list">
            {daemonSnapshots.map((daemon) => (
              <article className="settings-daemon-card" key={daemon.daemonKey}>
                <div className="settings-daemon-card__header">
                  <div>
                    <strong>{daemon.deviceName}</strong>
                    <p>{daemon.daemonKey}</p>
                  </div>
                  <span className={`status-chip status-chip--${daemon.status === "online" ? "positive" : "danger"}`}>
                    {daemon.status === "online" ? tx("在线", "Online") : tx("离线", "Offline")}
                  </span>
                </div>
                <p className="settings-daemon-card__meta">
                  {tx("最近心跳", "Last heartbeat")}: {daemon.lastHeartbeatAt ?? tx("暂无", "Unavailable")}
                </p>
                <p className="settings-daemon-card__meta">
                  {tx("运行模式", "Mode")}: {daemon.mode === "remote" ? tx("远程", "Remote") : tx("本地", "Local")}
                </p>
                {daemon.serverUrl ? (
                  <p className="settings-daemon-card__meta">
                    Server: {daemon.serverUrl}
                  </p>
                ) : null}
                {daemon.googleWorkspaceReadiness ? (
                  <div className="settings-daemon-readiness">
                    <p className="settings-daemon-card__meta">
                      Google Sheets readiness: {formatReadinessSummary(daemon.googleWorkspaceReadiness, tx)}
                    </p>
                    <div className="settings-daemon-readiness__items">
                      <span>{formatReadinessItem("dofe-agent output", daemon.googleWorkspaceReadiness.dofeAgentOutput, tx)}</span>
                      <span>{formatReadinessItem("gws", daemon.googleWorkspaceReadiness.gws, tx)}</span>
                      <span>{formatReadinessItem("bwrap", daemon.googleWorkspaceReadiness.bwrap, tx)}</span>
                      <span>executor: {daemon.googleWorkspaceReadiness.executor}</span>
                    </div>
                    {daemon.googleWorkspaceReadiness.latestOperationFailure ? (
                      <p className="settings-daemon-card__meta">
                        {tx("最近 Google Workspace 失败", "Latest Google Workspace failure")}: {daemon.googleWorkspaceReadiness.latestOperationFailure.errorCode ?? daemon.googleWorkspaceReadiness.latestOperationFailure.operationType}
                      </p>
                    ) : null}
                  </div>
                ) : null}
                <div className="settings-daemon-runtimes">
                  {daemon.runtimes.length > 0 ? (
                    daemon.runtimes.map((runtime) => (
                      <div className="settings-daemon-runtime" key={runtime.id}>
                        <div className="settings-daemon-runtime__main">
                          <strong>{runtime.name}</strong>
                          {runtime.displayName ? <span>{tx(`备注名：${runtime.displayName}`, `Remark: ${runtime.displayName}`)}</span> : null}
                          <span>{`${formatDaemonProviderLabel(runtime.provider)} · ${runtime.version || tx("未知版本", "Unknown version")}`}</span>
                          <span>{formatProviderHealth(runtime.providerHealth.providerUsable, tx)}</span>
                        </div>
                        <div className="settings-daemon-runtime__side">
                          <small>{runtime.lastHeartbeatAt ?? tx("暂无心跳", "No heartbeat")}</small>
                          {onDeleteRuntime ? (
                            <button
                              aria-label={tx(`删除执行引擎 ${runtime.name}`, `Delete execution engine ${runtime.name}`)}
                              className="settings-daemon-runtime__delete"
                              disabled={pending || isPending}
                              onClick={() => onDeleteRuntime(runtime)}
                              title={tx("删除执行引擎", "Delete execution engine")}
                              type="button"
                            >
                              <AppIcon name="trash" />
                            </button>
                          ) : null}
                        </div>
                      </div>
                    ))
                  ) : (
                    <p className="settings-daemon-card__meta">
                      {tx("这台服务器当前没有执行引擎。", "This server currently has no execution engines.")}
                    </p>
                  )}
                </div>
              </article>
            ))}
          </div>
        ) : (
          <p className="panel-note">{tx("当前还没有注册的远程服务器。", "There are no registered remote servers yet.")}</p>
        )}
      </div>

      <div className="subsection">
        <div className="panel-header">
          <div>
            <h3>{tx("服务器接入令牌", "Server Access Tokens")}</h3>
          </div>
        </div>

        <form
          className="settings-token-create"
          onSubmit={(event) => {
            event.preventDefault();
            const form = event.currentTarget;
            const formData = new FormData(event.currentTarget);
            const label = ((formData.get("label") as string | null) ?? "").trim();
            const createdBy = ((formData.get("createdBy") as string | null) ?? "").trim();
            if (!label || !createdBy) {
              return;
            }

            startTransition(async () => {
              await runToastAction({
                action: () => createDaemonApiTokenAction({ label, createdBy }),
                onSuccess: async (created) => {
                  setCreatedToken(created);
                  form.reset();
                },
                pushToast,
                tx,
                fallbackError: {
                  zh: "创建令牌失败。",
                  en: "Failed to create token.",
                },
              });
            });
          }}
        >
          <label className="form-field">
            <span>{tx("令牌标签", "Token Label")}</span>
            <input defaultValue="remote-daemon" name="label" type="text" />
          </label>
          <label className="form-field">
            <span>{tx("创建人", "Created By")}</span>
            <input defaultValue="techwu" name="createdBy" type="text" />
          </label>
          <button className="primary-button" disabled={isPending} type="submit">
            {isPending ? tx("创建中...", "Creating...") : tx("创建新令牌", "Create Token")}
          </button>
        </form>

        {createdToken ? (
          <div className="settings-token-secret">
            <strong>{tx("新令牌已创建", "New Token Created")}</strong>
            <p>{tx("这个值只会展示一次，请立即复制给远程服务器。", "This value is only shown once. Copy it now for the remote server.")}</p>
            <code>{createdToken.token}</code>
          </div>
        ) : null}

        {daemonTokens.length > 0 ? (
          <div className="settings-token-list">
            {daemonTokens.map((token) => (
              <article className="settings-token-card" key={token.id}>
                <div className="settings-token-card__header">
                  <div>
                    <strong>{token.label}</strong>
                    <p>{token.id}</p>
                  </div>
                  <span className={`status-chip status-chip--${token.status === "active" ? "positive" : "danger"}`}>
                    {token.status === "active" ? tx("有效", "Active") : tx("已吊销", "Revoked")}
                  </span>
                </div>
                <p className="settings-token-card__meta">
                  {tx("创建人", "Created by")}: {token.createdBy}
                </p>
                <p className="settings-token-card__meta">
                  {tx("最近使用", "Last used")}: {token.lastUsedAt ?? tx("从未使用", "Never used")}
                </p>
                {token.status === "active" ? (
                  <button
                    className="action-button action-button--danger"
                    disabled={isPending}
                    onClick={() => {
                      startTransition(async () => {
                        await runToastAction({
                          action: () => revokeDaemonApiTokenAction(token.id),
                          onSuccess: async () => {
                            if (createdToken?.id === token.id) {
                              setCreatedToken(null);
                            }
                          },
                          pushToast,
                          tx,
                          fallbackError: {
                            zh: "吊销令牌失败。",
                            en: "Failed to revoke token.",
                          },
                        });
                      });
                    }}
                    type="button"
                  >
                    {tx("吊销", "Revoke")}
                  </button>
                ) : null}
              </article>
            ))}
          </div>
        ) : (
          <p className="panel-note">{tx("当前还没有服务器接入令牌。", "There are no server access tokens yet.")}</p>
        )}
      </div>
    </>
  );
}

function formatProviderHealth(
  providerUsable: DaemonSnapshotView["runtimes"][number]["providerHealth"]["providerUsable"],
  tx: (zh: string, en: string) => string,
): string {
  if (providerUsable === "usable") {
    return tx("Provider 可用", "Provider usable");
  }
  if (providerUsable === "unusable") {
    return tx("Provider 不可用", "Provider unavailable");
  }
  return tx("Provider 未验证", "Provider unverified");
}

function formatReadinessSummary(
  readiness: NonNullable<DaemonSnapshotView["googleWorkspaceReadiness"]>,
  tx: (zh: string, en: string) => string,
): string {
  if (
    readiness.dofeAgentOutput.available &&
    readiness.gws.available &&
    readiness.bwrap.available
  ) {
    return tx("可用", "Ready");
  }
  return tx("需要处理", "Needs attention");
}

function formatReadinessItem(
  label: string,
  item: { available: boolean; error?: string },
  tx: (zh: string, en: string) => string,
): string {
  return `${label}: ${item.available ? tx("可用", "ok") : item.error ?? tx("不可用", "missing")}`;
}

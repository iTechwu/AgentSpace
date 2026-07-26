"use client";

import { formatDaemonProviderLabel } from "@dofe-agent/domain";
import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { approveRuntimeProvisionAction, createProviderAccountAction, pruneOldOfflineDaemonsAction, requestRuntimeProvisionAction } from "@/features/agents/actions";
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
  ProviderAccountView,
  RuntimeProvisionRequestView,
} from "@/features/dashboard/data";

interface DaemonManagementPanelProps {
  daemonSnapshots: DaemonSnapshotView[];
  daemonTokens: DaemonTokenView[];
  providerAccounts?: ProviderAccountView[];
  runtimeProvisionRequests?: RuntimeProvisionRequestView[];
  pending?: boolean;
  onDeleteRuntime?: (runtime: DaemonSnapshotView["runtimes"][number]) => void;
}

export function DaemonManagementPanel({
  daemonSnapshots,
  daemonTokens,
  providerAccounts = [],
  runtimeProvisionRequests = [],
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
        <div className="panel-header"><div><h3>{tx("Provider 账户", "Provider Accounts")}</h3></div></div>
        <form className="settings-token-create" onSubmit={(event) => {
          event.preventDefault();
          const form = event.currentTarget;
          const values = new FormData(form);
          startTransition(async () => {
            await runToastAction({
              action: () => createProviderAccountAction({
                provider: String(values.get("provider") ?? ""),
                name: String(values.get("name") ?? ""),
                billingAccountId: String(values.get("billingAccountId") ?? ""),
                secretRef: String(values.get("secretRef") ?? ""),
                configRef: String(values.get("configRef") ?? ""),
                allowedModels: String(values.get("allowedModels") ?? "").split(",").map((value) => value.trim()).filter(Boolean),
              }),
              onSuccess: async () => { form.reset(); router.refresh(); }, pushToast, tx,
              fallbackError: { zh: "创建 Provider 账户失败。", en: "Failed to create provider account." },
            });
          });
        }}>
          <label className="form-field"><span>Provider</span><select defaultValue="claude" name="provider"><option value="claude">Claude Code</option><option value="codex">Codex</option><option value="gemini">Gemini CLI</option><option value="antigravity">Antigravity CLI</option><option value="openclaw">OpenClaw</option><option value="opencode">OpenCode</option><option value="nanobot">NanoBot</option><option value="hermes">Hermes</option></select></label>
          <label className="form-field"><span>{tx("账户名称", "Account name")}</span><input name="name" required type="text" /></label>
          <label className="form-field"><span>{tx("账单账户标识", "Billing account ID")}</span><input name="billingAccountId" type="text" /></label>
          <label className="form-field"><span>{tx("密钥引用", "Secret reference")}</span><input name="secretRef" placeholder="vault://..." type="text" /></label>
          <label className="form-field"><span>{tx("配置引用", "Config reference")}</span><input name="configRef" placeholder="config://..." type="text" /></label>
          <label className="form-field"><span>{tx("允许模型", "Allowed models")}</span><input name="allowedModels" placeholder="model-a, model-b" type="text" /></label>
          <button className="primary-button" disabled={isPending} type="submit">{tx("创建账户", "Create account")}</button>
        </form>
        {providerAccounts.length > 0 ? <div className="settings-token-list">{providerAccounts.map((account) => <article className="settings-token-card" key={account.id}><strong>{account.name}</strong><p>{formatDaemonProviderLabel(account.provider)}</p><p>{account.billingAccountId ?? tx("未标记账单账户", "No billing account ID")}</p><p>{account.status}</p></article>)}</div> : <p className="panel-note">{tx("先创建账户，再供给 runtime。", "Create an account before provisioning a runtime.")}</p>}
      </div>

      <div className="subsection">
        <div className="panel-header"><div><h3>{tx("执行引擎供给", "Runtime Provisioning")}</h3></div></div>
        <form className="settings-token-create" onSubmit={(event) => {
          event.preventDefault();
          const form = event.currentTarget;
          const values = new FormData(form);
          const account = providerAccounts.find((item) => item.id === String(values.get("providerAccountId") ?? ""));
          if (!account) return;
          startTransition(async () => {
            await runToastAction({ action: () => requestRuntimeProvisionAction({ providerAccountId: account.id, provider: account.provider, runtimeName: String(values.get("runtimeName") ?? ""), targetServer: String(values.get("targetServer") ?? "") }), onSuccess: async () => { form.reset(); router.refresh(); }, pushToast, tx, fallbackError: { zh: "创建供给请求失败。", en: "Failed to create provisioning request." } });
          });
        }}>
          <label className="form-field"><span>{tx("Provider 账户", "Provider account")}</span><select name="providerAccountId" required><option value="">{tx("选择账户", "Select account")}</option>{providerAccounts.filter((account) => account.status === "active").map((account) => <option key={account.id} value={account.id}>{account.name} ({account.provider})</option>)}</select></label>
          <label className="form-field"><span>{tx("Runtime 名称", "Runtime name")}</span><input name="runtimeName" required type="text" /></label>
          <label className="form-field"><span>{tx("目标服务器", "Target server")}</span><input name="targetServer" required type="text" /></label>
          <button className="primary-button" disabled={isPending || providerAccounts.every((account) => account.status !== "active")} type="submit">{tx("提交供给请求", "Request runtime")}</button>
        </form>
        {runtimeProvisionRequests.length > 0 ? <div className="settings-token-list">{runtimeProvisionRequests.map((request) => <article className="settings-token-card" key={request.id}><strong>{request.runtimeName}</strong><p>{request.providerAccountName} · {request.targetServer}</p><p>{request.status}</p>{request.status === "approved" ? <p><code>DOFE_AGENT_PROVIDER_ACCOUNT_ID={request.providerAccountId}</code></p> : null}{request.status === "requested" ? <button className="primary-button" disabled={isPending} onClick={() => startTransition(async () => { await runToastAction({ action: () => approveRuntimeProvisionAction(request.id), onSuccess: async (result) => { setCreatedToken({ id: result.tokenId, label: `provision-${request.id}`, token: result.token }); router.refresh(); }, pushToast, tx, fallbackError: { zh: "批准供给请求失败。", en: "Failed to approve provisioning request." } }); })} type="button">{tx("批准并创建令牌", "Approve and create token")}</button> : null}</article>)}</div> : null}
      </div>

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

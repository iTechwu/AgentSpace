"use client";

import { useEffect, useState, useTransition } from "react";
import { useLanguage } from "@/features/i18n/language-provider";
import { translateSettingsActionError } from "@/features/settings/settings-utils";
import {
  checkFeishuIntegrationHealthAction,
  createFeishuAgentBotBindingAction,
  disableFeishuAgentBotBindingAction,
} from "./feishu-actions";
import { FeishuAgentBotCredentialRotation } from "./feishu-agent-bot-credential-rotation";
import { FeishuAgentBotPolicyEditor } from "./feishu-agent-bots-panel";
import type {
  FeishuAgentBotSetupReference,
  FeishuIntegrationSettingsItem,
} from "./feishu-types";

interface FeishuAgentBotAgentSettingsPanelProps {
  readonly agentId: string;
  readonly agentName: string;
  readonly canManage: boolean;
  readonly integration?: FeishuIntegrationSettingsItem;
  readonly onUpdated?: (integration: FeishuIntegrationSettingsItem) => void;
  readonly setupReference?: FeishuAgentBotSetupReference;
}

type HealthCheckFeedback = {
  readonly message: string;
  readonly tone: "success" | "error";
};

export function FeishuAgentBotAgentSettingsPanel({
  agentId,
  agentName,
  canManage,
  integration,
  onUpdated,
  setupReference,
}: FeishuAgentBotAgentSettingsPanelProps) {
  const { tx } = useLanguage();
  const [isPending, startTransition] = useTransition();
  const [currentIntegration, setCurrentIntegration] = useState(integration);
  const [feedback, setFeedback] = useState<string | null>(null);
  const [healthCheckFeedback, setHealthCheckFeedback] = useState<HealthCheckFeedback | null>(null);
  const [appId, setAppId] = useState("");
  const [appSecret, setAppSecret] = useState("");
  const [displayName, setDisplayName] = useState("");
  const [transportMode, setTransportMode] = useState<"websocket_worker" | "http_webhook">("websocket_worker");
  const [tenantKey, setTenantKey] = useState("");
  const [verificationToken, setVerificationToken] = useState("");
  const [encryptKey, setEncryptKey] = useState("");
  const [botAddedPolicy, setBotAddedPolicy] = useState<"auto_create_channel" | "pending_admin_review" | "disabled">("auto_create_channel");
  const [firstMessagePolicy, setFirstMessagePolicy] = useState<"auto_create_if_bot_mentioned" | "pending_admin_review" | "reply_with_setup_card" | "disabled">("auto_create_if_bot_mentioned");
  const [reviewStatusPolicy, setReviewStatusPolicy] = useState<"approved" | "pending_admin_review" | "needs_identity_binding">("approved");
  const [unboundUserMode, setUnboundUserMode] = useState<"ignore" | "reply_on_mention" | "reply_all" | "require_identity">("reply_on_mention");
  const [guestPermissionProfile, setGuestPermissionProfile] = useState<"none" | "channel_context_only" | "channel_readonly">("channel_context_only");

  useEffect(() => {
    setCurrentIntegration(integration);
    setFeedback(null);
    setHealthCheckFeedback(null);
  }, [integration?.id, agentId]);

  const requiresVerificationToken = transportMode === "http_webhook";
  const canCreate = canManage && appId.trim() && appSecret.trim() && (!requiresVerificationToken || verificationToken.trim());
  const disabled = isPending || !canManage;
  const healthTone = healthCheckFeedback?.tone ?? resolveHealthTone(currentIntegration?.lastHealthStatus);

  const handleCreated = (created: FeishuIntegrationSettingsItem) => {
    setCurrentIntegration(created);
    setAppId("");
    setAppSecret("");
    setVerificationToken("");
    setEncryptKey("");
    setFeedback(tx("AI员工 飞书 Bot 已绑定，工作区已启用。", "AI employee Feishu bot bound and workspace enabled."));
    onUpdated?.(created);
  };

  const handleUpdated = (updated: FeishuIntegrationSettingsItem) => {
    setCurrentIntegration(updated);
    onUpdated?.(updated);
  };

  return (
    <section className="form-panel form-panel--nested feishu-agent-settings-panel">
      <div className="panel-header">
        <div>
          <h3>{tx("Feishu Bot", "Feishu Bot")}</h3>
          <p className="settings-panel-note">
            {tx(
              `把 ${agentName} 绑定到自己的飞书 Bot，用户可在飞书群里直接 @这个 Bot。`,
              `Bind ${agentName} to its own Feishu bot so users can mention that bot directly in Feishu groups.`,
            )}
          </p>
        </div>
        {currentIntegration ? (
          <span className={`status-chip status-chip--${statusTone(currentIntegration.status)}`}>
            {formatIntegrationStatus(currentIntegration.status, tx)}
          </span>
        ) : (
          <span className="status-chip status-chip--neutral">{tx("未绑定", "Unbound")}</span>
        )}
      </div>

      {!currentIntegration && setupReference ? (
        <FeishuAgentBotOnboarding
          developerConsoleUrl={setupReference.developerConsoleUrl}
          setupSteps={setupReference.openPlatformSetupSteps}
          tx={tx}
        />
      ) : null}

      {currentIntegration ? (
        <div className="feishu-agent-settings-panel__bound">
          <div className="feishu-agent-settings-panel__summary">
            <div>
              <span>{tx("Bot", "Bot")}</span>
              <strong>{currentIntegration.displayName}</strong>
            </div>
            <div>
              <span>{tx("连接方式", "Transport")}</span>
              <strong>{formatTransportMode(currentIntegration.transportMode, tx)}</strong>
            </div>
            <div className={`feishu-agent-settings-panel__health${healthTone ? ` feishu-agent-settings-panel__health--${healthTone}` : ""}`}>
              <span>{tx("健康状态", "Health")}</span>
              <strong>{formatHealthStatus(currentIntegration.lastHealthStatus, tx)}</strong>
              <button
                className="action-button feishu-agent-settings-panel__health-check"
                disabled={disabled || currentIntegration.status !== "active"}
                onClick={() => {
                  startTransition(async () => {
                    try {
                      const updated = await checkFeishuIntegrationHealthAction(currentIntegration.id);
                      setHealthCheckFeedback(updated.lastHealthStatus === "healthy"
                        ? { tone: "success", message: tx("飞书 Bot 连接检查通过。", "Feishu bot health check passed.") }
                        : { tone: "error", message: tx("飞书 Bot 连接检查失败。", "Feishu bot health check failed.") });
                      handleUpdated(updated);
                    } catch (error) {
                      setHealthCheckFeedback({
                        tone: "error",
                        message: translateSettingsActionError(error, tx),
                      });
                    }
                  });
                }}
                type="button"
              >
                {isPending ? tx("检查中...", "Checking...") : tx("检查连接", "Check Connection")}
              </button>
              {healthCheckFeedback ? (
                <p aria-live="polite" className={`feishu-agent-settings-panel__health-feedback feishu-agent-settings-panel__health-feedback--${healthCheckFeedback.tone}`}>
                  {healthCheckFeedback.message}
                </p>
              ) : null}
            </div>
            <div>
              <span>{tx("已绑定群聊", "Bound groups")}</span>
              <strong>{currentIntegration.channelBindingCount}</strong>
            </div>
          </div>

          {currentIntegration.setupGuide ? (
            <details className="feishu-advanced-settings feishu-agent-settings-panel__commands">
              <summary>
                <span>{tx("健康检查与联调命令", "Health and Smoke Commands")}</span>
                <small>{tx("按这个 AI员工 的飞书 Bot 运行，不需要手查 integration id", "Run against this AI employee bot without looking up the integration id")}</small>
              </summary>
              <div className="feishu-agent-settings-panel__command-list">
                <FeishuAgentSettingsCommand
                  label={tx("健康检查", "Health check")}
                  value={currentIntegration.setupGuide.commands.healthCheck}
                />
                <FeishuAgentSettingsCommand
                  label={tx("Bot Readiness", "Bot readiness")}
                  value={currentIntegration.setupGuide.commands.botReadiness}
                />
                {currentIntegration.setupGuide.commands.bindSecondAgentBot ? (
                  <FeishuAgentSettingsCommand
                    label={tx("绑定第二个 AI员工 Bot", "Bind second AI employee bot")}
                    note={tx(
                      "先在 scripts/feishu/.env 填入第二个飞书 app 凭据，再运行此命令创建第二个 Bot 绑定；通过 Phase 6 前置检查前，最终 evidence --require all 会保持 blocked。",
                      "Fill the second Feishu app credentials in scripts/feishu/.env first, then run this command to create the second bot binding; final evidence --require all stays blocked until it is Phase 6-ready.",
                    )}
                    value={currentIntegration.setupGuide.commands.bindSecondAgentBot}
                  />
                ) : null}
                <FeishuAgentSettingsCommand
                  label={tx("Data-plane Readiness", "Data-plane readiness")}
                  value={currentIntegration.setupGuide.commands.dataPlaneReadiness}
                />
                <FeishuAgentSettingsCommand
                  label={tx("Worker Readiness", "Worker readiness")}
                  value={currentIntegration.setupGuide.commands.workerReadiness}
                />
                {currentIntegration.setupGuide.commands.autoProvisionPolicy ? (
                  <FeishuAgentSettingsCommand
                    label={tx("治理策略", "Governance policy")}
                    value={currentIntegration.setupGuide.commands.autoProvisionPolicy}
                  />
                ) : null}
                {currentIntegration.setupGuide.commands.agentChannelAccessDisable ? (
                  <FeishuAgentSettingsCommand
                    label={tx("禁用频道访问", "Disable channel access")}
                    value={currentIntegration.setupGuide.commands.agentChannelAccessDisable}
                  />
                ) : null}
                {currentIntegration.setupGuide.commands.agentChannelAccessRestore ? (
                  <FeishuAgentSettingsCommand
                    label={tx("恢复频道访问", "Restore channel access")}
                    value={currentIntegration.setupGuide.commands.agentChannelAccessRestore}
                  />
                ) : null}
                {currentIntegration.setupGuide.commands.channelBindings ? (
                  <FeishuAgentSettingsCommand
                    label={tx("群聊绑定", "Channel bindings")}
                    value={currentIntegration.setupGuide.commands.channelBindings}
                  />
                ) : null}
                <FeishuAgentSettingsCommand
                  label={tx("Smoke Env", "Smoke env")}
                  value={currentIntegration.setupGuide.commands.smokeEnv}
                />
                <FeishuAgentSettingsCommand
                  label={tx("检查 Smoke Env", "Check smoke env")}
                  value={currentIntegration.setupGuide.commands.checkEnv}
                />
                <FeishuAgentSettingsCommand
                  label={tx("Live Smoke", "Live smoke")}
                  value={currentIntegration.setupGuide.commands.strictLiveSmoke}
                />
                <FeishuAgentSettingsCommand
                  label={tx("验证 24 小时 OpenAPI 证据", "Verify 24h OpenAPI evidence")}
                  value={currentIntegration.setupGuide.commands.verifyOpenApiEvidence}
                />
                <FeishuAgentSettingsCommand
                  label={tx("验证 24 小时进群事件样本", "Verify 24h bot-added payload")}
                  note={tx(
                    "把一次真实机器人进群回调 JSON 保存在 runtime-output 后运行；输出只包含脱敏引用、哈希、字段来源和 24 小时有效时间。",
                    "Save one real bot-added callback JSON under runtime-output first; the output only includes redacted references, hashes, field sources, and a 24h freshness timestamp.",
                  )}
                  value={currentIntegration.setupGuide.commands.verifyBotAddedPayload}
                />
                <FeishuAgentSettingsCommand
                  label={tx("Smoke Plan", "Smoke plan")}
                  note={tx(
                    "默认输出可读 blockers 和下一步命令；需要机器可读结果时在命令末尾追加 --json。",
                    "Prints readable blockers and next commands by default; append --json for machine-readable output.",
                  )}
                  value={currentIntegration.setupGuide.commands.smokePlan}
                />
                <FeishuAgentSettingsCommand
                  label={tx("最终证据", "Final evidence")}
                  note={tx(
                    "默认输出可读 gate、artifact 和 remediation 摘要；需要完整 counters 时在命令末尾追加 --json。",
                    "Prints readable gate, artifact, and remediation summaries by default; append --json for full counters.",
                  )}
                  value={currentIntegration.setupGuide.commands.evidence}
                />
              </div>
              <FeishuAgentBotSetupReference
                callbackPath={currentIntegration.setupGuide.eventCallbackPath}
                credentialFields={currentIntegration.setupGuide.requiredCredentialFields}
                events={currentIntegration.setupGuide.requiredEvents}
                scopes={currentIntegration.setupGuide.requiredScopes}
                tx={tx}
              />
            </details>
          ) : null}

          <FeishuAgentBotPolicyEditor
            integration={currentIntegration}
            isPending={isPending || !canManage}
            key={currentIntegration.id}
            onUpdated={(updated) => {
              setFeedback(tx("AI员工 飞书 Bot 治理策略已更新。", "AI employee Feishu bot governance policy updated."));
              handleUpdated(updated);
            }}
            setFeedback={setFeedback}
            startTransition={startTransition}
            tx={tx}
          />

          <FeishuAgentBotCredentialRotation
            integration={currentIntegration}
            isPending={disabled}
            onUpdated={handleUpdated}
            setFeedback={setFeedback}
            startTransition={startTransition}
            tx={tx}
          />

          <div className="feishu-integration-form__actions">
            <button
              className="action-button action-button--danger"
              disabled={disabled || currentIntegration.status === "disabled"}
              onClick={() => {
                startTransition(async () => {
                  try {
                    const updated = await disableFeishuAgentBotBindingAction(currentIntegration.id);
                    setFeedback(tx("AI员工 飞书 Bot 已停用。", "AI employee Feishu bot disabled."));
                    handleUpdated(updated);
                  } catch (error) {
                    setFeedback(translateSettingsActionError(error, tx));
                  }
                });
              }}
              type="button"
            >
              {tx("停用", "Disable")}
            </button>
          </div>
        </div>
      ) : (
        <div className="feishu-integration-form feishu-agent-settings-panel__create">
          <label className="form-field">
            <span>{tx("App ID", "App ID")}</span>
            <input
              autoComplete="off"
              disabled={disabled}
              onChange={(event) => setAppId(event.currentTarget.value)}
              value={appId}
            />
          </label>

          <label className="form-field">
            <span>{tx("App Secret", "App Secret")}</span>
            <input
              autoComplete="new-password"
              disabled={disabled}
              onChange={(event) => setAppSecret(event.currentTarget.value)}
              type="password"
              value={appSecret}
            />
          </label>

          <details className="feishu-advanced-settings">
            <summary>
              <span>{tx("自定义高级功能", "Customize Advanced Options")}</span>
              <small>{tx("事件回调、Tenant Key、自动建群和未绑定用户策略", "Event callback, Tenant Key, auto-provisioning, and unbound user policy")}</small>
            </summary>
            <div className="feishu-advanced-settings__body">
              <label className="form-field">
                <span>{tx("名称", "Name")}</span>
                <input
                  disabled={disabled}
                  onChange={(event) => setDisplayName(event.currentTarget.value)}
                  placeholder={`${agentName} Feishu Bot`}
                  value={displayName}
                />
              </label>
              <label className="form-field">
                <span>{tx("连接方式", "Transport")}</span>
                <select
                  disabled={disabled}
                  onChange={(event) => setTransportMode(event.currentTarget.value as "websocket_worker" | "http_webhook")}
                  value={transportMode}
                >
                  <option value="websocket_worker">{tx("长连接", "WebSocket worker")}</option>
                  <option value="http_webhook">{tx("事件回调", "Event callback")}</option>
                </select>
              </label>
              <label className="form-field">
                <span>{tx("Tenant Key", "Tenant Key")}</span>
                <input
                  autoComplete="off"
                  disabled={disabled}
                  onChange={(event) => setTenantKey(event.currentTarget.value)}
                  value={tenantKey}
                />
              </label>
              <label className="form-field">
                <span>
                  {requiresVerificationToken
                    ? tx("Verification Token（事件回调必填）", "Verification Token (required for callbacks)")
                    : tx("Verification Token", "Verification Token")}
                </span>
                <input
                  autoComplete="new-password"
                  disabled={disabled}
                  onChange={(event) => setVerificationToken(event.currentTarget.value)}
                  type="password"
                  value={verificationToken}
                />
              </label>
              <label className="form-field">
                <span>{tx("Encrypt Key", "Encrypt Key")}</span>
                <input
                  autoComplete="new-password"
                  disabled={disabled}
                  onChange={(event) => setEncryptKey(event.currentTarget.value)}
                  type="password"
                  value={encryptKey}
                />
              </label>
              <label className="form-field">
                <span>{tx("机器人进群", "Bot Added")}</span>
                <select
                  disabled={disabled}
                  onChange={(event) => setBotAddedPolicy(event.currentTarget.value as "auto_create_channel" | "pending_admin_review" | "disabled")}
                  value={botAddedPolicy}
                >
                  <option value="auto_create_channel">{tx("自动创建 Channel", "Auto-create channel")}</option>
                  <option value="pending_admin_review">{tx("等待管理员审核", "Pending admin review")}</option>
                  <option value="disabled">{tx("关闭", "Disabled")}</option>
                </select>
              </label>
              <label className="form-field">
                <span>{tx("首次消息", "First Message")}</span>
                <select
                  disabled={disabled}
                  onChange={(event) => setFirstMessagePolicy(event.currentTarget.value as "auto_create_if_bot_mentioned" | "pending_admin_review" | "reply_with_setup_card" | "disabled")}
                  value={firstMessagePolicy}
                >
                  <option value="auto_create_if_bot_mentioned">{tx("@Bot 时自动创建", "Auto-create when mentioned")}</option>
                  <option value="pending_admin_review">{tx("等待管理员审核", "Pending admin review")}</option>
                  <option value="reply_with_setup_card">{tx("回复设置卡片", "Reply with setup card")}</option>
                  <option value="disabled">{tx("关闭", "Disabled")}</option>
                </select>
              </label>
              <label className="form-field">
                <span>{tx("建群审核状态", "Provision Review")}</span>
                <select
                  disabled={disabled}
                  onChange={(event) => setReviewStatusPolicy(event.currentTarget.value as "approved" | "pending_admin_review" | "needs_identity_binding")}
                  value={reviewStatusPolicy}
                >
                  <option value="approved">{tx("通过", "Approved")}</option>
                  <option value="pending_admin_review">{tx("等待管理员审核", "Pending admin review")}</option>
                  <option value="needs_identity_binding">{tx("需要身份绑定", "Needs identity binding")}</option>
                </select>
              </label>
              <label className="form-field">
                <span>{tx("未绑定用户", "Unbound Users")}</span>
                <select
                  disabled={disabled}
                  onChange={(event) => setUnboundUserMode(event.currentTarget.value as "ignore" | "reply_on_mention" | "reply_all" | "require_identity")}
                  value={unboundUserMode}
                >
                  <option value="reply_on_mention">{tx("@Bot 时回复", "Reply when mentioned")}</option>
                  <option value="reply_all">{tx("全部回复", "Reply all")}</option>
                  <option value="require_identity">{tx("要求绑定身份", "Require identity")}</option>
                  <option value="ignore">{tx("忽略", "Ignore")}</option>
                </select>
              </label>
              <label className="form-field">
                <span>{tx("访客权限", "Guest Permission")}</span>
                <select
                  disabled={disabled}
                  onChange={(event) => setGuestPermissionProfile(event.currentTarget.value as "none" | "channel_context_only" | "channel_readonly")}
                  value={guestPermissionProfile}
                >
                  <option value="channel_context_only">{tx("当前 Channel 上下文", "Current channel context")}</option>
                  <option value="channel_readonly">{tx("当前 Channel 只读", "Current channel readonly")}</option>
                  <option value="none">{tx("无", "None")}</option>
                </select>
              </label>
              {setupReference ? (
                <FeishuAgentBotSetupReference
                  callbackPath={setupReference.eventCallbackPath}
                  credentialFields={setupReference.requiredCredentialFields}
                  events={setupReference.requiredEvents}
                  scopes={setupReference.requiredScopes}
                  tx={tx}
                />
              ) : null}
            </div>
          </details>

          <div className="feishu-integration-form__actions">
            <button
              className="primary-button"
              disabled={!canCreate}
              onClick={() => {
                startTransition(async () => {
                  try {
                    const created = await createFeishuAgentBotBindingAction({
                      agentId,
                      displayName,
                      transportMode,
                      appId,
                      appSecret,
                      verificationToken,
                      encryptKey,
                      tenantKey,
                      channelAutoProvisioning: {
                        botAdded: botAddedPolicy,
                        firstMessage: firstMessagePolicy,
                        reviewStatus: reviewStatusPolicy,
                      },
                      externalGuestPolicy: {
                        unboundUserMode,
                        guestPermissionProfile,
                        requireIdentityFor: [
                          "writes",
                          "approvals",
                          "private_resources",
                          "runtime_sensitive_tools",
                        ],
                      },
                    });
                    handleCreated(created);
                  } catch (error) {
                    setFeedback(translateSettingsActionError(error, tx));
                  }
                });
              }}
              type="button"
            >
              {tx("绑定 Bot 并启用工作区", "Bind Bot and Enable Workspace")}
            </button>
          </div>
        </div>
      )}

      {!canManage ? (
        <p className="settings-panel-note">
          {tx("只有 workspace 管理员可以绑定或修改 AI员工 飞书 Bot。", "Only workspace admins can bind or modify AI employee Feishu bots.")}
        </p>
      ) : null}
      {feedback ? <p className="settings-panel-note">{feedback}</p> : null}
    </section>
  );
}

function FeishuAgentBotSetupReference({
  callbackPath,
  credentialFields,
  events,
  scopes,
  tx,
}: {
  callbackPath: string;
  credentialFields: readonly string[];
  events: readonly string[];
  scopes: readonly string[];
  tx: (zh: string, en: string) => string;
}) {
  return (
    <div className="feishu-setup-summary feishu-agent-settings-panel__setup-reference">
      <section>
        <strong>{tx("凭据字段", "Credential Fields")}</strong>
        <ul>
          {credentialFields.map((field) => (
            <li key={field}><code>{field}</code></li>
          ))}
        </ul>
      </section>
      <section>
        <strong>{tx("事件", "Events")}</strong>
        <ul>
          <li>
            <span>{tx("回调路径", "Callback Path")}</span>: <code>{callbackPath}</code>
          </li>
          {events.map((eventName) => (
            <li key={eventName}><code>{eventName}</code></li>
          ))}
        </ul>
      </section>
      <section>
        <strong>{tx("Docs / Sheets / Base 权限", "Docs / Sheets / Base Scopes")}</strong>
        <ul>
          {scopes.map((scope) => (
            <li key={scope}><code>{scope}</code></li>
          ))}
        </ul>
      </section>
    </div>
  );
}

function FeishuAgentBotOnboarding({
  developerConsoleUrl,
  setupSteps,
  tx,
}: {
  developerConsoleUrl: string;
  setupSteps: ReadonlyArray<{ id: string; required: string[] }>;
  tx: (zh: string, en: string) => string;
}) {
  return (
    <section className="feishu-agent-bot-onboarding" aria-label={tx("飞书 Bot 绑定准备", "Feishu Bot setup")}>
      <header className="feishu-agent-bot-onboarding__header">
        <div>
          <span>{tx("绑定前准备", "Before you bind")}</span>
          <h4>{tx("在飞书开放平台完成配置", "Complete setup in the Feishu developer console")}</h4>
          <p>{tx("完成以下六项后，填写 App ID 与 App Secret 即可绑定。", "Complete these six items, then bind with the App ID and App Secret.")}</p>
        </div>
        <a className="action-button feishu-agent-bot-onboarding__link" href={developerConsoleUrl} rel="noreferrer" target="_blank">
          {tx("打开飞书开放平台", "Open Feishu Developer Console")}
        </a>
      </header>

      <ol className="feishu-agent-bot-onboarding__steps">
        {setupSteps.map((step, index) => (
          <li key={step.id}>
            <span className="feishu-agent-bot-onboarding__step-number" aria-hidden="true">{index + 1}</span>
            <div>
              <strong>{formatFeishuSetupStep(step.id, tx)}</strong>
              <ul aria-label={tx("所需配置", "Required configuration")}>
                {step.required.map((requirement) => <li key={requirement}><code>{requirement}</code></li>)}
              </ul>
            </div>
          </li>
        ))}
      </ol>

      <aside className="feishu-agent-bot-onboarding__outcome">
        <span>{tx("绑定后", "After binding")}</span>
        <p>
          {tx(
            "将立即启用此 AI员工 的飞书工作区数据平面；机器人进群或被 @ 时会自动建立对应 Channel。",
            "This immediately enables the AI employee's Feishu workspace data plane and creates a Channel when the bot is added or mentioned.",
          )}
        </p>
      </aside>
    </section>
  );
}

function formatFeishuSetupStep(id: string, tx: (zh: string, en: string) => string): string {
  switch (id) {
    case "create_custom_app":
      return tx("创建企业自建应用", "Create a custom app");
    case "enable_bot":
      return tx("在应用能力中启用 Bot", "Enable the Bot capability");
    case "configure_event_subscription":
      return tx("订阅消息、进群和卡片事件", "Subscribe to message, bot-added, and card events");
    case "grant_bot_scopes":
      return tx("授予 Bot 和成员基础权限", "Grant Bot and member permissions");
    case "grant_data_plane_scopes":
      return tx("授予文档、表格和多维表格权限", "Grant Docs, Sheets, and Base permissions");
    case "release_or_install_app":
      return tx("发布或安装应用到当前租户", "Publish or install the app for this tenant");
    default:
      return id;
  }
}

function FeishuAgentSettingsCommand({
  label,
  note,
  value,
}: {
  label: string;
  note?: string;
  value: string;
}) {
  return (
    <div className="feishu-agent-settings-panel__command">
      <span>{label}</span>
      <code>{value}</code>
      {note ? <small>{note}</small> : null}
    </div>
  );
}

function statusTone(status: string): "positive" | "warning" | "danger" | "neutral" {
  if (status === "active") return "positive";
  if (status === "disabled") return "warning";
  if (status === "error") return "danger";
  return "neutral";
}

function formatIntegrationStatus(
  status: string,
  tx: (zh: string, en: string) => string,
): string {
  switch (status) {
    case "active":
      return tx("启用", "Active");
    case "disabled":
      return tx("停用", "Disabled");
    case "error":
      return tx("异常", "Error");
    default:
      return status;
  }
}

function formatTransportMode(
  transportMode: string,
  tx: (zh: string, en: string) => string,
): string {
  return transportMode === "websocket_worker"
    ? tx("长连接", "WebSocket worker")
    : tx("事件回调", "Event callback");
}

function formatHealthStatus(
  status: string | undefined,
  tx: (zh: string, en: string) => string,
): string {
  switch (status) {
    case "healthy":
      return tx("健康", "Healthy");
    case "degraded":
      return tx("需检查", "Degraded");
    case "error":
      return tx("异常", "Error");
    default:
      return tx("未检查", "Unchecked");
  }
}

function resolveHealthTone(status: string | undefined): "success" | "error" | "warning" | undefined {
  switch (status) {
    case "healthy":
      return "success";
    case "degraded":
      return "warning";
    case "error":
      return "error";
    default:
      return undefined;
  }
}

"use client";

import { type TransitionStartFunction, useEffect, useState } from "react";
import type { WorkspaceRole } from "@dofe-agent/db";
import { SettingsSectionShell } from "@/features/settings/components/settings-chrome";
import type { SettingsSectionMeta } from "@/features/settings/settings-meta";
import type { SettingsTx } from "@/features/settings/settings-types";
import { AppIcon, type AppIconName } from "@/shared/ui/app-icon";
import { FeishuAgentBotsPanel } from "./feishu-agent-bots-panel";
import { FeishuChannelBindingsPanel } from "./feishu-channel-bindings-panel";
import { FeishuCreateIntegrationDialog } from "./feishu-create-integration-dialog";
import { FeishuHealthPanel } from "./feishu-health-panel";
import { FeishuOperationRunsPanel } from "./feishu-operation-runs-panel";
import { FeishuResourceBindingsPanel } from "./feishu-resource-bindings-panel";
import { FeishuUserBindingsPanel } from "./feishu-user-bindings-panel";
import type {
  FeishuAvailableChannelItem,
  FeishuAvailableAgentItem,
  FeishuAvailableUserItem,
  FeishuIntegrationCreationGuide,
  FeishuIntegrationSettingsItem,
} from "./feishu-types";

interface FeishuStatCardItem {
  label: string;
  value: number;
  icon: AppIconName;
  tone: "accent" | "success" | "warning" | "danger";
}

export function SettingsIntegrationsSection({
  availableChannels,
  availableAgents,
  availableUsers,
  currentMembershipRole,
  currentUserId,
  feishuIntegrationCreationGuide,
  feishuIntegrations,
  isPending,
  meta,
  refreshSettingsData,
  startTransition,
  tx,
}: {
  availableChannels: FeishuAvailableChannelItem[];
  availableAgents: FeishuAvailableAgentItem[];
  availableUsers: FeishuAvailableUserItem[];
  currentMembershipRole: WorkspaceRole;
  currentUserId?: string;
  feishuIntegrationCreationGuide?: FeishuIntegrationCreationGuide;
  feishuIntegrations: FeishuIntegrationSettingsItem[];
  isPending: boolean;
  meta: SettingsSectionMeta;
  refreshSettingsData: () => void;
  startTransition: TransitionStartFunction;
  tx: SettingsTx;
}) {
  const [integrations, setIntegrations] = useState(feishuIntegrations);
  const [feedback, setFeedback] = useState<string | null>(null);

  useEffect(() => {
    setIntegrations(feishuIntegrations);
  }, [feishuIntegrations]);

  const totalChannelBindings = integrations.reduce((sum, integration) => sum + integration.channelBindingCount, 0);
  const totalResourceBindings = integrations.reduce((sum, integration) => sum + integration.resourceBindingCount, 0);
  const totalUserBindings = integrations.reduce((sum, integration) => sum + integration.userBindingCount, 0);
  const totalOperationRuns = integrations.reduce((sum, integration) => sum + integration.operationRunCount, 0);
  const totalOutboxFailures = integrations.reduce((sum, integration) => sum + integration.outboxFailureCount, 0);
  const canManageIntegrations = currentMembershipRole === "owner" || currentMembershipRole === "admin";

  function mergeIntegration(nextIntegration: FeishuIntegrationSettingsItem): void {
    setIntegrations((current) => [
      nextIntegration,
      ...current.filter((integration) => integration.id !== nextIntegration.id),
    ]);
    refreshSettingsData();
  }

  function removeIntegration(integrationId: string): void {
    setIntegrations((current) => current.filter((integration) => integration.id !== integrationId));
    refreshSettingsData();
  }

  const overviewStats: FeishuStatCardItem[] = canManageIntegrations
    ? [
      {
        label: tx("用户绑定", "User Bindings"),
        value: totalUserBindings,
        icon: "contacts",
        tone: "success",
      },
      {
        label: tx("会话映射", "Chat Mappings"),
        value: totalChannelBindings,
        icon: "messages",
        tone: "accent",
      },
      {
        label: tx("Docs / Sheets / Base", "Docs / Sheets / Base"),
        value: totalResourceBindings,
        icon: "tables",
        tone: "accent",
      },
      {
        label: tx("数据操作", "Data Operations"),
        value: totalOperationRuns,
        icon: "automations",
        tone: "accent",
      },
      {
        label: tx("出站失败", "Outbound Failures"),
        value: totalOutboxFailures,
        icon: "alertCircle",
        tone: "danger",
      },
    ]
    : [
      {
        label: tx("我的飞书绑定", "My Feishu Binding"),
        value: totalUserBindings,
        icon: "feishu",
        tone: "success",
      },
      {
        label: tx("可用集成", "Available Integrations"),
        value: integrations.filter((integration) => integration.status !== "disabled").length,
        icon: "market",
        tone: "accent",
      },
    ];

  return (
    <SettingsSectionShell meta={meta}>
      <div className="feishu-overview" aria-label={tx("飞书集成概览", "Feishu integration overview")}>
        {overviewStats.map((stat) => (
          <div
            className={`feishu-stat-card feishu-stat-card--${stat.tone}`}
            key={stat.label}
          >
            <span className="feishu-stat-card__icon" aria-hidden="true">
              <AppIcon name={stat.icon} />
            </span>
            <span className="feishu-stat-card__body">
              <strong className="feishu-stat-card__value">{stat.value}</strong>
              <span className="feishu-stat-card__label">{stat.label}</span>
            </span>
          </div>
        ))}
      </div>

      {feedback ? (
        <p aria-live="polite" className="feishu-feedback" role="status">{feedback}</p>
      ) : null}

      <div className="feishu-group">
        <div className="feishu-group__header">
          <h3>{tx("连接", "Connections")}</h3>
          <p>
            {tx("绑定 AI员工 飞书 Bot，或为共享数据面创建工作区级集成。", "Bind a Feishu bot to an AI employee, or create a workspace-level integration for the shared data plane.")}
          </p>
        </div>

        <FeishuAgentBotsPanel
          availableAgents={availableAgents}
          integrations={integrations}
          isPending={isPending}
          onUpdated={mergeIntegration}
          setFeedback={setFeedback}
          startTransition={startTransition}
          tx={tx}
        />

        {canManageIntegrations ? (
          <FeishuCreateIntegrationDialog
            creationGuide={feishuIntegrationCreationGuide}
            isPending={isPending}
            onCreated={mergeIntegration}
            setFeedback={setFeedback}
            startTransition={startTransition}
            tx={tx}
          />
        ) : null}

        {canManageIntegrations ? (
          <FeishuHealthPanel
            integrations={integrations}
            isPending={isPending}
            onDeleted={removeIntegration}
            onUpdated={mergeIntegration}
            setFeedback={setFeedback}
            startTransition={startTransition}
            tx={tx}
          />
        ) : null}
      </div>

      <div className="feishu-group">
        <div className="feishu-group__header">
          <h3>{tx("绑定与映射", "Bindings")}</h3>
          <p>
            {tx("把飞书用户、会话和文档映射到 agent.dofe 身份与资源。", "Map Feishu users, chats, and documents to agent.dofe identities and resources.")}
          </p>
        </div>

        <FeishuUserBindingsPanel
          availableUsers={availableUsers}
          currentMembershipRole={currentMembershipRole}
          currentUserId={currentUserId}
          integrations={integrations}
          isPending={isPending}
          onUpdated={mergeIntegration}
          setFeedback={setFeedback}
          startTransition={startTransition}
          tx={tx}
        />

        {canManageIntegrations ? (
          <>
            <FeishuChannelBindingsPanel
              availableChannels={availableChannels}
              integrations={integrations}
              isPending={isPending}
              onUpdated={mergeIntegration}
              setFeedback={setFeedback}
              startTransition={startTransition}
              tx={tx}
            />

            <FeishuResourceBindingsPanel
              availableChannels={availableChannels}
              integrations={integrations}
              isPending={isPending}
              onUpdated={mergeIntegration}
              setFeedback={setFeedback}
              startTransition={startTransition}
              tx={tx}
            />
          </>
        ) : null}
      </div>

      {canManageIntegrations ? (
        <div className="feishu-group">
          <div className="feishu-group__header">
            <h3>{tx("运行记录", "Activity")}</h3>
            <p>
              {tx("Docs、Sheets、Base 读写操作的策略决策、状态与错误。", "Policy decisions, status, and errors for Docs, Sheets, and Base operations.")}
            </p>
          </div>
          <FeishuOperationRunsPanel integrations={integrations} tx={tx} />
        </div>
      ) : null}
    </SettingsSectionShell>
  );
}

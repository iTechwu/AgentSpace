// 飞书域视图构建：按频道聚合飞书集成绑定摘要（bot 连接 + 资源绑定）。
// 会读飞书集成设置（listFeishuIntegrationSettingsItems，含 viewer 鉴权）。
import type {
  WorkspaceRole,
} from "@dofe-agent/db";
import type {
  ChannelFeishuSummaryRecord,
} from "../data-types";
import {
  listFeishuIntegrationSettingsItems,
} from "@/features/integrations/feishu/feishu-settings-data";

export function buildFeishuChannelSummaryByChannelName(input: {
  workspaceId: string;
  canView: boolean;
  viewer?: {
    role: WorkspaceRole;
    userId: string;
  };
}): Map<string, ChannelFeishuSummaryRecord> {
  if (!input.canView) {
    return new Map();
  }

  const summaries = new Map<string, ChannelFeishuSummaryRecord>();
  const connectedBotKeys = new Set<string>();
  const resourceKeys = new Set<string>();
  const integrations = listFeishuIntegrationSettingsItems({
    workspaceId: input.workspaceId,
    viewer: input.viewer,
  });

  const ensureSummary = (channelName: string): ChannelFeishuSummaryRecord => {
    const current = summaries.get(channelName);
    if (current) {
      return current;
    }
    const next: ChannelFeishuSummaryRecord = {
      bindingCount: 0,
      connectedAgentBots: [],
      resourceBindings: [],
    };
    summaries.set(channelName, next);
    return next;
  };

  for (const integration of integrations) {
    for (const binding of integration.channelBindings) {
      if (binding.status === "archived") {
        continue;
      }
      const summary = ensureSummary(binding.channelName);
      summary.bindingCount += 1;
      if (!summary.externalChatReference || binding.status === "active") {
        summary.externalChatReference = binding.externalChatReference;
        summary.externalChatName = binding.externalChatName;
        summary.externalChatType = binding.externalChatType;
        summary.provisionSource = binding.provisionSource;
        summary.reviewStatus = binding.reviewStatus;
      }
      if (integration.agentId && binding.status === "active") {
        const key = `${binding.channelName}:${integration.id}:${integration.agentId}`;
        if (!connectedBotKeys.has(key)) {
          connectedBotKeys.add(key);
          summary.connectedAgentBots.push({
            integrationId: integration.id,
            displayName: integration.displayName,
            agentId: integration.agentId,
            status: integration.status,
            unboundUserMode: integration.externalGuestPolicy?.unboundUserMode,
            guestPermissionProfile: integration.externalGuestPolicy?.guestPermissionProfile,
          });
        }
      }
    }

    for (const resourceBinding of integration.resourceBindings) {
      if (!resourceBinding.channelName || resourceBinding.status === "archived") {
        continue;
      }
      const key = `${resourceBinding.channelName}:${integration.id}:${resourceBinding.id}`;
      if (resourceKeys.has(key)) {
        continue;
      }
      resourceKeys.add(key);
      const summary = ensureSummary(resourceBinding.channelName);
      summary.resourceBindings.push({
        id: resourceBinding.id,
        integrationId: integration.id,
        integrationDisplayName: integration.displayName,
        providerResourceType: resourceBinding.providerResourceType,
        displayName: resourceBinding.displayName,
        canWrite: resourceBinding.canWrite,
        guestReadable: resourceBinding.guestReadable,
        status: resourceBinding.status,
      });
    }
  }

  return summaries;
}

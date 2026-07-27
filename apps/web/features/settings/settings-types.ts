import type {
  FeishuAvailableAgentItem,
  FeishuAvailableChannelItem,
  FeishuAvailableUserItem,
  FeishuIntegrationCreationGuide,
  FeishuIntegrationSettingsItem,
} from "@/features/integrations/feishu/feishu-types";
import type { PermissionCenterData } from "@dofe-agent/services";

export type SettingsTx = (zh: string, en: string) => string;
export type SettingsPermissionCenterData = PermissionCenterData;

export interface SettingsSessionItem {
  id: string;
  createdAt: string;
  expiresAt: string;
  lastSeenAt: string;
  ipAddress?: string;
  userAgent?: string;
  revokedAt?: string;
}

export type SettingsFeishuIntegrationItem = FeishuIntegrationSettingsItem;
export type SettingsFeishuIntegrationCreationGuide = FeishuIntegrationCreationGuide;
export type SettingsFeishuAvailableAgentItem = FeishuAvailableAgentItem;
export type SettingsFeishuAvailableChannelItem = FeishuAvailableChannelItem;
export type SettingsFeishuAvailableUserItem = FeishuAvailableUserItem;

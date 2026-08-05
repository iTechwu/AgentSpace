import {
  listSessionsForUserSync,
  readAuthIdentityForUserSync,
  type WorkspaceRole,
} from "@dofe-agent/db";
import { getWorkspacePermissionCenterSync, resolveAgentRuntimeMode } from "@dofe-agent/services";
import { loadSsoWorkspaceDirectory } from "@/features/auth/sso-directory";
import { readPublicAppUrl } from "@/features/auth/public-app-url";
import {
  buildFeishuIntegrationCreationGuide,
  canManageFeishuIntegrations,
  listFeishuAvailableAgents,
  listFeishuAvailableChannels,
  listFeishuAvailableUsers,
  listFeishuIntegrationSettingsItems,
} from "@/features/integrations/feishu/feishu-settings-data";
import {
  canAccessSettingsSection,
  DEFAULT_SETTINGS_SECTION,
  isSettingsDetailSectionId,
  type SettingsDetailSectionId,
  type SettingsSectionId,
} from "@/features/settings/settings-sections";
import type {
  SettingsFeishuAvailableAgentItem,
  SettingsFeishuAvailableChannelItem,
  SettingsFeishuAvailableUserItem,
  SettingsFeishuIntegrationCreationGuide,
  SettingsFeishuIntegrationItem,
  SettingsPermissionCenterData,
  SettingsSessionItem,
} from "@/features/settings/settings-types";

export interface SettingsPageData {
  isSsoManagedWorkspace: boolean;
  currentMembershipRole: WorkspaceRole;
  currentSessionId?: string;
  currentUserDisplayName: string;
  currentUserId: string;
  currentWorkspaceSlug: string;
  canCreateDaemonTokens: boolean;
  initialSection: SettingsSectionId;
  feishuAvailableAgents: SettingsFeishuAvailableAgentItem[];
  feishuAvailableChannels: SettingsFeishuAvailableChannelItem[];
  feishuAvailableUsers: SettingsFeishuAvailableUserItem[];
  feishuIntegrationCreationGuide?: SettingsFeishuIntegrationCreationGuide;
  feishuIntegrations: SettingsFeishuIntegrationItem[];
  permissions?: SettingsPermissionCenterData;
  sessions: SettingsSessionItem[];
}

export function resolveSettingsLoaderSection(
  settingsPath?: readonly string[],
): SettingsDetailSectionId | undefined {
  if (!settingsPath || settingsPath.length === 0 || settingsPath.length > 1) {
    return undefined;
  }

  const [section] = settingsPath;
  return section && isSettingsDetailSectionId(section) ? section : undefined;
}

export async function loadSettingsPageData(input: {
  currentSessionId?: string;
  currentUser: {
    displayName: string;
    email?: string;
    id: string;
  };
  currentWorkspace: {
    id: string;
    name: string;
    slug: string;
  };
  role: WorkspaceRole;
  section?: SettingsSectionId;
}): Promise<SettingsPageData> {
  const requestedSection = input.section ?? DEFAULT_SETTINGS_SECTION;
  const workspaceId = input.currentWorkspace.id;
  const requiresCurrentWorkspaceRole = requestedSection === "permissions" || requestedSection === "integrations";
  const ssoDirectory = requiresCurrentWorkspaceRole
    ? await loadCurrentSsoWorkspaceDirectory({
      currentUserId: input.currentUser.id,
      workspaceId,
    })
    : {
      role: input.role,
      workspaceName: input.currentWorkspace.name,
    };
  if (!canAccessSettingsSection(ssoDirectory.role, requestedSection)) {
    throw new SettingsSectionForbiddenError(requestedSection);
  }

  const shouldLoadIntegrations = requestedSection === "integrations";
  const shouldLoadPermissions = requestedSection === "permissions";
  const shouldLoadSessions = requestedSection === "security";
  const canManageIntegrations = canManageFeishuIntegrations(ssoDirectory.role);
  const feishuAvailableUsers = shouldLoadIntegrations
    ? listFeishuAvailableUsers({ workspaceId })
      .filter((user) => canManageIntegrations || user.userId === input.currentUser.id)
    : [];

  return {
    isSsoManagedWorkspace: true,
    currentMembershipRole: ssoDirectory.role,
    currentSessionId: input.currentSessionId,
    currentUserDisplayName: input.currentUser.displayName,
    currentUserId: input.currentUser.id,
    currentWorkspaceSlug: input.currentWorkspace.slug,
    canCreateDaemonTokens: resolveAgentRuntimeMode() !== "remote",
    initialSection: requestedSection,
    feishuAvailableChannels: shouldLoadIntegrations && canManageIntegrations
      ? listFeishuAvailableChannels({ workspaceId })
      : [],
    feishuAvailableAgents: shouldLoadIntegrations && canManageIntegrations
      ? listFeishuAvailableAgents({ workspaceId })
      : [],
    feishuAvailableUsers,
    feishuIntegrationCreationGuide: shouldLoadIntegrations && canManageIntegrations
      ? buildFeishuIntegrationCreationGuide({ workspaceId, appUrl: readPublicAppUrl() })
      : undefined,
    feishuIntegrations: shouldLoadIntegrations
      ? listFeishuIntegrationSettingsItems({
        workspaceId,
        appUrl: readPublicAppUrl(),
        viewer: { role: ssoDirectory.role, userId: input.currentUser.id },
      })
      : [],
    permissions: shouldLoadPermissions
      ? getWorkspacePermissionCenterSync({
        workspaceId,
        actor: {
          userId: input.currentUser.id,
          displayName: input.currentUser.displayName,
          role: ssoDirectory.role,
        },
      })
      : undefined,
    sessions: shouldLoadSessions ? listSessionsForUserSync(input.currentUser.id) : [],
  };
}

async function loadCurrentSsoWorkspaceDirectory(input: {
  currentUserId: string;
  workspaceId: string;
}) {
  const identity = readAuthIdentityForUserSync(input.currentUserId, "sso");
  if (!identity) {
    throw new Error("auth.sso_user_lookup_failed");
  }
  return await loadSsoWorkspaceDirectory({
    subject: identity.providerSubject,
    workspaceId: input.workspaceId,
  });
}

export class SettingsSectionForbiddenError extends Error {
  constructor(readonly section: SettingsSectionId) {
    super(`Settings section is not accessible: ${section}`);
  }
}

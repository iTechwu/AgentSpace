import {
  listSessionsForUserSync,
  readAuthIdentityForUserSync,
  type WorkspaceRole,
} from "@dofe-agent/db";
import { getWorkspacePermissionCenterSync } from "@dofe-agent/services";
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
  SettingsChannelAccessRequestItem,
  SettingsChannelInvitationItem,
  SettingsFeishuAvailableAgentItem,
  SettingsFeishuAvailableChannelItem,
  SettingsFeishuAvailableUserItem,
  SettingsFeishuIntegrationCreationGuide,
  SettingsFeishuIntegrationItem,
  SettingsPermissionCenterData,
  SettingsSessionItem,
  SettingsWorkspaceInvitationItem,
  SettingsWorkspaceMemberItem,
} from "@/features/settings/settings-types";

export interface SettingsPageData {
  isSsoManagedWorkspace: boolean;
  currentMembershipRole: WorkspaceRole;
  currentSessionId?: string;
  currentUserDisplayName: string;
  currentUserEmail: string;
  currentSsoUserId: string;
  currentUserId: string;
  currentWorkspaceName: string;
  currentWorkspaceSlug: string;
  currentWorkspaceJoinCode?: string;
  currentWorkspaceJoinCodeUpdatedAt?: string;
  initialSection: SettingsSectionId;
  invitations: SettingsWorkspaceInvitationItem[];
  channelAccessRequests: SettingsChannelAccessRequestItem[];
  channelInvitations: SettingsChannelInvitationItem[];
  feishuAvailableAgents: SettingsFeishuAvailableAgentItem[];
  feishuAvailableChannels: SettingsFeishuAvailableChannelItem[];
  feishuAvailableUsers: SettingsFeishuAvailableUserItem[];
  feishuIntegrationCreationGuide?: SettingsFeishuIntegrationCreationGuide;
  feishuIntegrations: SettingsFeishuIntegrationItem[];
  members: SettingsWorkspaceMemberItem[];
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
    joinCode?: string;
    joinCodeUpdatedAt?: string;
    name: string;
    slug: string;
  };
  role: WorkspaceRole;
  section?: SettingsSectionId;
}): Promise<SettingsPageData> {
  const requestedSection = input.section ?? DEFAULT_SETTINGS_SECTION;
  const workspaceId = input.currentWorkspace.id;

  const identity = readAuthIdentityForUserSync(input.currentUser.id, "sso");
  if (!identity) {
    throw new Error("auth.sso_user_lookup_failed");
  }
  const ssoDirectory = await loadSsoWorkspaceDirectory({
    subject: identity.providerSubject,
    workspaceId,
  });
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
    currentUserEmail: "",
    currentSsoUserId: "",
    currentUserId: input.currentUser.id,
    currentWorkspaceName: ssoDirectory.workspaceName,
    currentWorkspaceSlug: input.currentWorkspace.slug,
    currentWorkspaceJoinCode: undefined,
    currentWorkspaceJoinCodeUpdatedAt: undefined,
    initialSection: requestedSection,
    invitations: [],
    channelAccessRequests: [],
    channelInvitations: [],
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
    members: [],
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

export class SettingsSectionForbiddenError extends Error {
  constructor(readonly section: SettingsSectionId) {
    super(`Settings section is not accessible: ${section}`);
  }
}

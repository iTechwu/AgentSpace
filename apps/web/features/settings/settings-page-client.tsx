"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { type MouseEvent, useCallback, useEffect, useState, useTransition } from "react";
import type { WorkspaceRole } from "@agent-space/db";
import { buildWorkspacePath } from "@/features/auth/workspace-paths";
import { refreshWorkspaceModule } from "@/features/dashboard/workspace-module-refresh";
import { useWorkspaceModuleNavigation } from "@/features/dashboard/workspace-module-navigation";
import { SettingsSidebar } from "@/features/settings/components/settings-chrome";
import {
  SettingsPreferencesSection,
  SettingsSecuritySection,
  SettingsIntegrationsSection,
} from "@/features/settings/components/settings-section-content";
import { getSettingsSectionMeta } from "@/features/settings/settings-meta";
import {
  canAccessSettingsSection,
  DEFAULT_SETTINGS_SECTION,
  getSettingsSectionPath,
  type SettingsSectionId,
} from "@/features/settings/settings-sections";
import {
  useSidebarVisibility,
} from "@/features/dashboard/sidebar-visibility-provider";
import { useLanguage } from "@/features/i18n/language-provider";
import { PermissionsCenterSection } from "@/features/permissions/permissions-center-section";
import type {
  SettingsPermissionCenterData,
  SettingsSessionItem,
  SettingsFeishuAvailableAgentItem,
  SettingsFeishuAvailableChannelItem,
  SettingsFeishuAvailableUserItem,
  SettingsFeishuIntegrationCreationGuide,
  SettingsFeishuIntegrationItem,
} from "@/features/settings/settings-types";

export type {
  SettingsPermissionCenterData,
  SettingsSessionItem,
  SettingsChannelAccessRequestItem,
  SettingsChannelInvitationItem,
  SettingsFeishuAvailableChannelItem,
  SettingsFeishuAvailableUserItem,
  SettingsFeishuIntegrationCreationGuide,
  SettingsFeishuIntegrationItem,
  SettingsWorkspaceInvitationItem,
  SettingsWorkspaceMemberItem,
} from "@/features/settings/settings-types";

export function SettingsPageClient({
  activeSection,
  initialSection,
  currentMembershipRole = "member",
  currentSessionId,
  currentUserDisplayName = "",
  currentUserId,
  currentWorkspaceSlug = "",
  feishuAvailableAgents = [],
  feishuAvailableChannels = [],
  feishuAvailableUsers = [],
  feishuIntegrationCreationGuide,
  feishuIntegrations = [],
  permissions,
  sessions = [],
  onDataChanged,
}: {
  activeSection?: SettingsSectionId;
  initialSection?: SettingsSectionId;
  currentMembershipRole?: WorkspaceRole;
  currentSessionId?: string;
  currentUserDisplayName?: string;
  currentUserId?: string;
  currentWorkspaceSlug?: string;
  feishuAvailableAgents?: SettingsFeishuAvailableAgentItem[];
  feishuAvailableChannels?: SettingsFeishuAvailableChannelItem[];
  feishuAvailableUsers?: SettingsFeishuAvailableUserItem[];
  feishuIntegrationCreationGuide?: SettingsFeishuIntegrationCreationGuide;
  feishuIntegrations?: SettingsFeishuIntegrationItem[];
  permissions?: SettingsPermissionCenterData;
  sessions?: SettingsSessionItem[];
  onDataChanged?: () => void;
}) {
  const { language, setLanguage, tx } = useLanguage();
  const router = useRouter();
  const { navigateWorkspaceModule } = useWorkspaceModuleNavigation();
  const { visibility, setSectionVisibility } = useSidebarVisibility();
  const [isHydrated, setIsHydrated] = useState(false);
  const [isPending, startTransition] = useTransition();
  const [securityFeedback, setSecurityFeedback] = useState<string | null>(null);
  const [sessionFilter, setSessionFilter] = useState<"active" | "revoked" | "all">("active");

  const requestedSection = activeSection ?? initialSection ?? DEFAULT_SETTINGS_SECTION;
  const resolvedActiveSection = canAccessSettingsSection(currentMembershipRole, requestedSection)
    ? requestedSection
    : DEFAULT_SETTINGS_SECTION;
  const currentSectionMeta = getSettingsSectionMeta(resolvedActiveSection, tx);

  useEffect(() => {
    setIsHydrated(true);
  }, []);

  function workspaceHref(path: string): string {
    return currentWorkspaceSlug ? buildWorkspacePath(currentWorkspaceSlug, path) : path;
  }

  const handleSettingsNavigate = useCallback((event: MouseEvent<HTMLAnchorElement>) => {
    const href = event.currentTarget.href;
    if (!navigateWorkspaceModule(href)) {
      return;
    }

    event.preventDefault();
  }, [navigateWorkspaceModule]);
  const refreshSettingsData = useCallback(() => {
    refreshWorkspaceModule(onDataChanged, router);
  }, [onDataChanged, router]);

  return (
    <section className="page-shell settings-page" data-hydrated={isHydrated ? "true" : undefined}>
      <div className="settings-layout">
        <SettingsSidebar
          currentMembershipRole={currentMembershipRole}
          currentWorkspaceSlug={currentWorkspaceSlug}
          onNavigate={handleSettingsNavigate}
          resolvedActiveSection={resolvedActiveSection}
          tx={tx}
        />

        <div className="settings-content">
          {resolvedActiveSection !== DEFAULT_SETTINGS_SECTION ? (
            <Link
              className="settings-mobile-back"
              href={workspaceHref(getSettingsSectionPath(DEFAULT_SETTINGS_SECTION))}
              onClick={handleSettingsNavigate}
              prefetch={false}
            >
              {tx("返回偏好设置", "Back to preferences")}
            </Link>
          ) : null}

          {resolvedActiveSection === "preferences" ? (
            <SettingsPreferencesSection
              language={language}
              meta={currentSectionMeta}
              setLanguage={setLanguage}
              setSectionVisibility={setSectionVisibility}
              tx={tx}
              visibility={visibility}
            />
          ) : null}

          {resolvedActiveSection === "security" ? (
            <SettingsSecuritySection
              currentSessionId={currentSessionId}
              isPending={isPending}
              meta={currentSectionMeta}
              refreshSettingsData={refreshSettingsData}
              securityFeedback={securityFeedback}
              sessionFilter={sessionFilter}
              sessions={sessions}
              setSecurityFeedback={setSecurityFeedback}
              setSessionFilter={setSessionFilter}
              startTransition={startTransition}
              tx={tx}
            />
          ) : null}

          {resolvedActiveSection === "permissions" ? (
            <PermissionsCenterSection
              currentMembershipRole={currentMembershipRole}
              currentUserDisplayName={currentUserDisplayName}
              meta={currentSectionMeta}
              permissions={permissions}
              tx={tx}
            />
          ) : null}

          {resolvedActiveSection === "integrations" ? (
            <SettingsIntegrationsSection
              availableAgents={feishuAvailableAgents}
              availableChannels={feishuAvailableChannels}
              availableUsers={feishuAvailableUsers}
              currentMembershipRole={currentMembershipRole}
              currentUserId={currentUserId}
              feishuIntegrationCreationGuide={feishuIntegrationCreationGuide}
              feishuIntegrations={feishuIntegrations}
              isPending={isPending}
              meta={currentSectionMeta}
              refreshSettingsData={refreshSettingsData}
              startTransition={startTransition}
              tx={tx}
            />
          ) : null}

        </div>
      </div>
    </section>
  );
}

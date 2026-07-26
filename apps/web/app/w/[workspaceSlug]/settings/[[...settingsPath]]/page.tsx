import { notFound, redirect } from "next/navigation";
import { getCurrentSession } from "@/features/auth/server-auth";
import { getWorkspaceContextForIdentifier } from "@/features/auth/server-workspace";
import { buildWorkspacePath } from "@/features/auth/workspace-paths";
import { WorkspaceInitialModuleData } from "@/features/dashboard/workspace-initial-module-data";
import { loadWorkspaceModuleDataWithMeta } from "@/features/dashboard/workspace-module-loaders";
import {
  SettingsSectionForbiddenError,
} from "@/features/settings/settings-page-loader";
import { SettingsPageClient } from "@/features/settings/settings-page-client";
import {
  DEFAULT_SETTINGS_SECTION,
  getSettingsSectionPath,
  isSettingsDetailSectionId,
  type SettingsDetailSectionId,
} from "@/features/settings/settings-sections";

export const dynamic = "force-dynamic";

const SSO_PROFILE_URL = "https://sso.ixicai.cn/zh/settings/profile";
const SSO_TEAM_SETTINGS_URL = "https://sso.ixicai.cn/zh/settings/team";

export default async function WorkspaceSettingsPage({
  params,
  searchParams,
}: {
  params: Promise<{ workspaceSlug: string; settingsPath?: string[] }>;
  searchParams?: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { workspaceSlug, settingsPath } = await params;
  const resolvedSearchParams = (await searchParams) ?? {};
  const workspaceContext = await getWorkspaceContextForIdentifier(workspaceSlug);
  if (!workspaceContext) {
    redirect("/");
  }
  if (workspaceContext.accessScope === "channel") {
    redirect(buildWorkspacePath(workspaceContext.currentWorkspace.slug, "/im"));
  }

  const requestedLegacySection = settingsPath?.length === 1 ? settingsPath[0] : undefined;
  if (requestedLegacySection === "account") {
    redirect(SSO_PROFILE_URL);
  }
  if (requestedLegacySection === "workspace" || requestedLegacySection === "members" || requestedLegacySection === "access") {
    redirect(SSO_TEAM_SETTINGS_URL);
  }

  const currentSection = resolveSettingsPath(settingsPath);
  const legacySectionValue = typeof resolvedSearchParams.section === "string"
    ? resolvedSearchParams.section
    : undefined;
  if (!currentSection && legacySectionValue === "account") {
    redirect(SSO_PROFILE_URL);
  }
  if (!currentSection && isSsoManagedTeamSection(legacySectionValue)) {
    redirect(SSO_TEAM_SETTINGS_URL);
  }
  const legacySection = resolveLegacySettingsSection(legacySectionValue);

  if (!currentSection && legacySection) {
    redirect(buildWorkspacePath(
      workspaceContext.currentWorkspace.slug,
      appendSearchParams(
        getSettingsSectionPath(legacySection),
        omitSearchParam(resolvedSearchParams, "section"),
      ),
    ));
  }
  if (!currentSection) {
    redirect(buildWorkspacePath(
      workspaceContext.currentWorkspace.slug,
      appendSearchParams(
        getSettingsSectionPath(DEFAULT_SETTINGS_SECTION),
        omitSearchParam(resolvedSearchParams, "section"),
      ),
    ));
  }

  if (!currentSection) {
    notFound();
  }

  let result;
  try {
    result = await loadWorkspaceModuleDataWithMeta(
      "settings",
      workspaceContext.currentWorkspace.id,
      {
        id: workspaceContext.currentUser.id,
        displayName: workspaceContext.currentUser.displayName,
        email: workspaceContext.currentUser.email,
        role: workspaceContext.currentMembership.role,
        sessionId: (await getCurrentSession())?.id,
      },
      { settingsPath: [currentSection] },
    );
  } catch (error) {
    if (error instanceof SettingsSectionForbiddenError) {
      notFound();
    }
    throw error;
  }

  return (
    <WorkspaceInitialModuleData
      moduleData={result.data}
      serverDurationMs={result.meta.durationMs}
      workspaceId={workspaceContext.currentWorkspace.id}
    >
      <SettingsPageClient {...result.data.data} />
    </WorkspaceInitialModuleData>
  );
}

function resolveSettingsPath(settingsPath?: string[]): SettingsDetailSectionId | undefined {
  if (!settingsPath || settingsPath.length === 0) {
    return undefined;
  }
  if (settingsPath.length > 1) {
    notFound();
  }

  const [section] = settingsPath;
  if (!section || !isSettingsDetailSectionId(section)) {
    notFound();
  }

  return section;
}

function resolveLegacySettingsSection(value: string | undefined): SettingsDetailSectionId | undefined {
  return value && isSettingsDetailSectionId(value) ? value : undefined;
}

function isSsoManagedTeamSection(value: string | undefined): boolean {
  return value === "workspace" || value === "members" || value === "access";
}

function omitSearchParam(
  searchParams: Record<string, string | string[] | undefined>,
  keyToOmit: string,
): Record<string, string | string[] | undefined> {
  const nextSearchParams: Record<string, string | string[] | undefined> = {};

  for (const [key, value] of Object.entries(searchParams)) {
    if (key !== keyToOmit) {
      nextSearchParams[key] = value;
    }
  }

  return nextSearchParams;
}

function appendSearchParams(
  pathname: string,
  searchParams: Record<string, string | string[] | undefined>,
): string {
  const nextSearchParams = new URLSearchParams();

  for (const [key, value] of Object.entries(searchParams)) {
    if (typeof value === "string" && value.length > 0) {
      nextSearchParams.set(key, value);
      continue;
    }
    if (Array.isArray(value)) {
      for (const item of value) {
        if (item.length > 0) {
          nextSearchParams.append(key, item);
        }
      }
    }
  }

  const query = nextSearchParams.toString();
  return query ? `${pathname}?${query}` : pathname;
}

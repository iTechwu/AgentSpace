import { notFound } from "next/navigation";
import { redirectToCurrentWorkspacePath } from "@/features/auth/workspace-redirect";
import {
  DEFAULT_SETTINGS_SECTION,
  getSettingsSectionPath,
  isSettingsDetailSectionId,
} from "@/features/settings/settings-sections";

const LEGACY_WORKSPACE_PATHS = new Set([
  "agents",
  "approvals",
  "automations",
  "calendar",
  "contacts",
  "costs",
  "im",
  "inbox",
  "knowledge",
  "market",
  "org-chart",
  "performance",
  "settings",
  "skills",
  "tables",
  "task-board",
  "templates",
]);

export const dynamic = "force-dynamic";

export default async function LegacyWorkspaceRedirectPage({
  params,
  searchParams,
}: {
  params: Promise<{ legacyPath: string[] }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { legacyPath } = await params;
  const [firstSegment, secondSegment, ...restSegments] = legacyPath;

  if (!firstSegment || !LEGACY_WORKSPACE_PATHS.has(firstSegment)) {
    notFound();
  }

  if (firstSegment === "settings") {
    if (restSegments.length > 0) {
      notFound();
    }
    if (!secondSegment) {
      await redirectToCurrentWorkspacePath(getSettingsSectionPath(DEFAULT_SETTINGS_SECTION), searchParams);
    }
    if (!secondSegment || !isSettingsDetailSectionId(secondSegment)) {
      notFound();
    }

    await redirectToCurrentWorkspacePath(getSettingsSectionPath(secondSegment), searchParams);
  }

  if (legacyPath.length > 1) {
    notFound();
  }

  await redirectToCurrentWorkspacePath(firstSegment === "task-board" ? "/task/board" : `/${firstSegment}`, searchParams);
}

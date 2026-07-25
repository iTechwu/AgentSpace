import { redirect } from "next/navigation";
import { HumanContactsPageClient } from "@/features/contacts/human-contacts-page-client";
import { buildWorkspacePath } from "@/features/auth/workspace-paths";
import { WorkspaceInitialModuleData } from "@/features/dashboard/workspace-initial-module-data";
import { loadWorkspaceModuleDataWithMeta } from "@/features/dashboard/workspace-module-loaders";
import { getWorkspacePageContext } from "../_lib/workspace-page-context";

export const dynamic = "force-dynamic";

export default async function WorkspaceContactsPage({
  params,
  searchParams,
}: {
  params: Promise<{ workspaceSlug: string }>;
  searchParams?: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { workspaceSlug } = await params;
  const resolvedSearchParams = (await searchParams) ?? {};
  const workspaceContext = await getWorkspacePageContext(workspaceSlug);
  const focus = resolvedSearchParams.focus;
  const view = resolvedSearchParams.view;
  const tab = resolvedSearchParams.tab;
  const doc = resolvedSearchParams.doc;
  const shouldOpenDigitalContacts =
    (typeof view === "string" && (view === "direct" || view === "digital")) ||
    typeof focus === "string" ||
    typeof tab === "string" ||
    typeof doc === "string";

  if (shouldOpenDigitalContacts) {
    const nextSearch = new URLSearchParams();
    nextSearch.set("view", "direct");
    nextSearch.set("context", "contacts");
    if (typeof focus === "string" && focus.length > 0) {
      nextSearch.set("focus", focus);
    }
    if (typeof tab === "string" && tab.length > 0) {
      nextSearch.set("tab", tab);
    }
    if (typeof doc === "string" && doc.length > 0) {
      nextSearch.set("doc", doc);
    }
    redirect(buildWorkspacePath(workspaceContext.currentWorkspace.slug, `/im?${nextSearch.toString()}`));
  }

  const result = await loadWorkspaceModuleDataWithMeta(
    "contacts",
    workspaceContext.currentWorkspace.id,
    {
      id: workspaceContext.currentUser.id,
      displayName: workspaceContext.currentUser.displayName,
      email: workspaceContext.currentUser.email,
      role: workspaceContext.currentMembership.role,
    },
  );
  return (
    <WorkspaceInitialModuleData
      moduleData={result.data}
      serverDurationMs={result.meta.durationMs}
      workspaceId={workspaceContext.currentWorkspace.id}
    >
      <HumanContactsPageClient
        currentUserDisplayName={result.data.currentUserDisplayName}
        {...result.data.data}
      />
    </WorkspaceInitialModuleData>
  );
}

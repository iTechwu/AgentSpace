import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { ChannelsPageClient } from "@/features/channels/channels-page-client";
import { HumanContactsPageClient } from "@/features/contacts/human-contacts-page-client";
import { buildWorkspacePath } from "@/features/auth/workspace-paths";
import { WorkspaceInitialModuleData } from "@/features/dashboard/workspace-initial-module-data";
import { loadWorkspaceModuleDataWithMeta } from "@/features/dashboard/workspace-module-loaders";
import { getWorkspacePageContext } from "../_lib/workspace-page-context";

export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "联系人",
  description: "管理工作区的联系人与通讯录。",
};

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
  const isDigitalContactsView = view === "digital";
  const shouldCanonicalizeDigitalContacts =
    view === "direct" ||
    (!isDigitalContactsView &&
      (typeof focus === "string" ||
        typeof tab === "string" ||
        typeof doc === "string"));

  if (shouldCanonicalizeDigitalContacts) {
    const nextSearch = new URLSearchParams();
    nextSearch.set("view", "digital");
    if (typeof focus === "string" && focus.length > 0) {
      nextSearch.set("focus", focus);
    }
    if (typeof tab === "string" && tab.length > 0) {
      nextSearch.set("tab", tab);
    }
    if (typeof doc === "string" && doc.length > 0) {
      nextSearch.set("doc", doc);
    }
    redirect(buildWorkspacePath(workspaceContext.currentWorkspace.id, `/contacts?${nextSearch.toString()}`));
  }

  const moduleQuery = new URLSearchParams();
  if (isDigitalContactsView) {
    moduleQuery.set("view", "digital");
  }
  if (typeof focus === "string" && focus.length > 0) {
    moduleQuery.set("focus", focus);
  }
  if (typeof tab === "string" && tab.length > 0) {
    moduleQuery.set("tab", tab);
  }
  if (typeof doc === "string" && doc.length > 0) {
    moduleQuery.set("doc", doc);
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
    { query: moduleQuery },
  );
  return (
    <WorkspaceInitialModuleData
      moduleData={result.data}
      serverDurationMs={result.meta.durationMs}
      workspaceId={workspaceContext.currentWorkspace.id}
    >
      {result.data.view === "digital" ? (
        <ChannelsPageClient
          currentUserDisplayName={result.data.currentUserDisplayName}
          data={result.data.data}
          moduleSearchParams={moduleQuery.toString()}
        />
      ) : (
        <HumanContactsPageClient
          currentUserDisplayName={result.data.currentUserDisplayName}
          {...result.data.data}
        />
      )}
    </WorkspaceInitialModuleData>
  );
}

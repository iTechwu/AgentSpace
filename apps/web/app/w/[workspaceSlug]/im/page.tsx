import type { Metadata } from "next";
import { ChannelsPageClient } from "@/features/channels/channels-page-client";
import { WorkspaceInitialModuleData } from "@/features/dashboard/workspace-initial-module-data";
import { loadWorkspaceModuleDataWithMeta } from "@/features/dashboard/workspace-module-loaders";
import { getWorkspacePageContext } from "../_lib/workspace-page-context";

export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "消息",
  description: "与数字员工协作的会话工作台。",
};

export default async function WorkspaceMessagesPage({
  params,
  searchParams,
}: {
  params: Promise<{ workspaceSlug: string }>;
  searchParams?: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { workspaceSlug } = await params;
  const resolvedSearchParams = await searchParams;
  const workspaceContext = await getWorkspacePageContext(workspaceSlug, { allowChannelScope: true });
  const result = await loadWorkspaceModuleDataWithMeta(
    "im",
    workspaceContext.currentWorkspace.id,
    {
      id: workspaceContext.currentUser.id,
      displayName: workspaceContext.currentUser.displayName,
      email: workspaceContext.currentUser.email,
      role: workspaceContext.currentMembership.role,
    },
    {
      accessScope: workspaceContext.accessScope ?? "workspace",
      channelNames: workspaceContext.channelNames,
      query: readSearchParams(resolvedSearchParams),
    },
  );
  return (
    <WorkspaceInitialModuleData
      moduleData={result.data}
      serverDurationMs={result.meta.durationMs}
      workspaceId={workspaceContext.currentWorkspace.id}
    >
      <ChannelsPageClient
        currentUserDisplayName={result.data.currentUserDisplayName}
        data={result.data.data}
      />
    </WorkspaceInitialModuleData>
  );
}

function readSearchParams(input?: Record<string, string | string[] | undefined>): URLSearchParams {
  const searchParams = new URLSearchParams();
  if (!input) {
    return searchParams;
  }
  for (const [key, value] of Object.entries(input)) {
    if (Array.isArray(value)) {
      for (const item of value) {
        if (item !== undefined) {
          searchParams.append(key, item);
        }
      }
      continue;
    }
    if (value !== undefined) {
      searchParams.set(key, value);
    }
  }
  return searchParams;
}

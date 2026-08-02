import { notFound } from "next/navigation";
import { McpConnectionDetailPageClient } from "@/features/market/mcp-connection-detail-client";
import { loadMcpConnectionDetailPageData } from "@/features/market/mcp-connection-detail-loader";
import { getWorkspacePageContext } from "../../../_lib/workspace-page-context";

export const dynamic = "force-dynamic";

export default async function McpConnectionDetailPage({
  params,
}: {
  params: Promise<{ workspaceSlug: string; connectionId: string }>;
}) {
  const { workspaceSlug, connectionId } = await params;
  const workspaceContext = await getWorkspacePageContext(workspaceSlug);

  let data;
  try {
    data = loadMcpConnectionDetailPageData({
      workspaceId: workspaceContext.currentWorkspace.id,
      connectionId,
      canManage: workspaceContext.currentMembership.role === "owner" || workspaceContext.currentMembership.role === "admin",
    });
  } catch (error) {
    if (error instanceof Error && error.message === "mcp_connection.not_found") {
      notFound();
    }
    throw error;
  }

  return (
    <McpConnectionDetailPageClient
      data={data}
      workspaceSlug={workspaceSlug}
    />
  );
}

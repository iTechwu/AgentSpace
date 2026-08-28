import type { Metadata } from "next";
import { KnowledgePageClient } from "@/features/knowledge/knowledge-page-client";
import { renderWorkspaceModule } from "../_lib/render-workspace-module";

export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "知识库",
  description: "管理、检索工作区知识，让数字员工即问即答。",
};

export default async function WorkspaceKnowledgePage({
  params,
}: {
  params: Promise<{ workspaceSlug: string }>;
}) {
  const { workspaceSlug } = await params;
  return renderWorkspaceModule(workspaceSlug, "knowledge", (data) => (
    <KnowledgePageClient data={data.data} />
  ), { withViewer: true });
}

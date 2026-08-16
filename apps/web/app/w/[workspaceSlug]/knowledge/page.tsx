import { KnowledgePageClient } from "@/features/knowledge/knowledge-page-client";
import { renderWorkspaceModule } from "../_lib/render-workspace-module";

export const dynamic = "force-dynamic";

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

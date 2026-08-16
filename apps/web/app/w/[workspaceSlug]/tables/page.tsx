import { TablesPageClient } from "@/features/tables/tables-page-client";
import { renderWorkspaceModule } from "../_lib/render-workspace-module";

export const dynamic = "force-dynamic";

export default async function WorkspaceTablesPage({
  params,
}: {
  params: Promise<{ workspaceSlug: string }>;
}) {
  const { workspaceSlug } = await params;
  return renderWorkspaceModule(workspaceSlug, "tables", (data) => (
    <TablesPageClient data={data.data} />
  ));
}

import type { Metadata } from "next";
import { TablesPageClient } from "@/features/tables/tables-page-client";
import { renderWorkspaceModule } from "../_lib/render-workspace-module";

export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "多维表格",
  description: "使用多维表格管理结构化业务数据。",
};

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

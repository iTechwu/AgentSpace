import type { Metadata } from "next";
import { OrgChartPageClient } from "@/features/org-chart/org-chart-page-client";
import { renderWorkspaceModule } from "../_lib/render-workspace-module";

export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "架构图",
  description: "以组织架构视角查看数字员工与协作关系。",
};

export default async function WorkspaceOrgChartPage({
  params,
}: {
  params: Promise<{ workspaceSlug: string }>;
}) {
  const { workspaceSlug } = await params;
  return renderWorkspaceModule(workspaceSlug, "org-chart", (data) => (
    <OrgChartPageClient data={data.data} />
  ));
}

import type { Metadata } from "next";
import { PerformancePageClient } from "@/features/performance/performance-page-client";
import { renderWorkspaceModule } from "../_lib/render-workspace-module";

export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "绩效看板",
  description: "查看工作区的执行绩效与关键指标。",
};

export default async function WorkspacePerformancePage({
  params,
}: {
  params: Promise<{ workspaceSlug: string }>;
}) {
  const { workspaceSlug } = await params;
  return renderWorkspaceModule(workspaceSlug, "performance", (data) => (
    <PerformancePageClient data={data.data} />
  ));
}

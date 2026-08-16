import { PerformancePageClient } from "@/features/performance/performance-page-client";
import { renderWorkspaceModule } from "../_lib/render-workspace-module";

export const dynamic = "force-dynamic";

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

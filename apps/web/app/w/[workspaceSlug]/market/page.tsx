import { MarketPageClient } from "@/features/market/market-page-client";
import { renderWorkspaceModule } from "../_lib/render-workspace-module";

export const dynamic = "force-dynamic";

export default async function WorkspaceMarketPage({
  params,
}: {
  params: Promise<{ workspaceSlug: string }>;
}) {
  const { workspaceSlug } = await params;
  return renderWorkspaceModule(workspaceSlug, "market", (data) => (
    <MarketPageClient data={data.data} />
  ), { withViewer: true });
}

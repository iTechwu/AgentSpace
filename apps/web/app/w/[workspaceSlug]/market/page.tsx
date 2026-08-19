import type { Metadata } from "next";
import { MarketPageClient } from "@/features/market/market-page-client";
import { renderWorkspaceModule } from "../_lib/render-workspace-module";

export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "应用市场",
  description: "浏览并接入运行时应用与 MCP 连接。",
};

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

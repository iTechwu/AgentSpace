import type { Metadata } from "next";
import { CostsPageClient } from "@/features/costs/costs-page-client";
import { renderWorkspaceModule } from "../_lib/render-workspace-module";

export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "费用总览",
  description: "查看工作区的模型调用与运行成本。",
};

export default async function WorkspaceCostsPage({
  params,
}: {
  params: Promise<{ workspaceSlug: string }>;
}) {
  const { workspaceSlug } = await params;
  return renderWorkspaceModule(workspaceSlug, "costs", (data) => (
    <CostsPageClient budgets={data.budgets} costs={data.costs} />
  ));
}

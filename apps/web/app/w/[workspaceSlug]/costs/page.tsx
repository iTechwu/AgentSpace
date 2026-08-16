import { CostsPageClient } from "@/features/costs/costs-page-client";
import { renderWorkspaceModule } from "../_lib/render-workspace-module";

export const dynamic = "force-dynamic";

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

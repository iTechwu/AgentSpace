import { ApprovalsPageClient } from "@/features/approvals/approvals-page-client";
import { renderWorkspaceModule } from "../_lib/render-workspace-module";

export const dynamic = "force-dynamic";

export default async function WorkspaceApprovalsPage({
  params,
}: {
  params: Promise<{ workspaceSlug: string }>;
}) {
  const { workspaceSlug } = await params;
  return renderWorkspaceModule(workspaceSlug, "approvals", (data) => (
    <ApprovalsPageClient data={data.data} />
  ), { withViewer: true });
}

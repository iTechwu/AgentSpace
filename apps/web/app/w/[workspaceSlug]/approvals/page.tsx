import type { Metadata } from "next";
import { ApprovalsPageClient } from "@/features/approvals/approvals-page-client";
import { renderWorkspaceModule } from "../_lib/render-workspace-module";

export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "审批",
  description: "处理工作区数字员工提交的待审批事项。",
};

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

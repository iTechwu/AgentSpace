import { InboxPageClient } from "@/features/inbox/inbox-page-client";
import { renderWorkspaceModule } from "../_lib/render-workspace-module";

export const dynamic = "force-dynamic";

export default async function WorkspaceInboxPage({
  params,
}: {
  params: Promise<{ workspaceSlug: string }>;
}) {
  const { workspaceSlug } = await params;
  return renderWorkspaceModule(workspaceSlug, "inbox", (data) => (
    <InboxPageClient data={data.data} />
  ), { withViewer: true });
}

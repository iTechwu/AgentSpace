import { redirect } from "next/navigation";
import { buildWorkspacePath } from "@/features/auth/workspace-paths";
import { getWorkspacePageContext } from "../_lib/workspace-page-context";

export const dynamic = "force-dynamic";

/** Keep `/new` as a stable entry point while the conversation UI remains under `/im`. */
export default async function NewConversationPage({
  params,
}: {
  params: Promise<{ workspaceSlug: string }>;
}) {
  const { workspaceSlug } = await params;
  const workspaceContext = await getWorkspacePageContext(workspaceSlug, { allowChannelScope: true });
  redirect(buildWorkspacePath(workspaceContext.currentWorkspace.id, "/im?new=1"));
}

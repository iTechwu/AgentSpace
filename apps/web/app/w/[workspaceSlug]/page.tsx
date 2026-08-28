import { redirect } from "next/navigation";
import { buildWorkspacePath } from "@/features/auth/workspace-paths";
import { getWorkspacePageContext } from "./_lib/workspace-page-context";

export const dynamic = "force-dynamic";

export default async function WorkspaceRootPage({
  params,
}: {
  params: Promise<{ workspaceSlug: string }>;
}) {
  const { workspaceSlug } = await params;
  const workspaceContext = await getWorkspacePageContext(workspaceSlug, { allowChannelScope: true });
  redirect(buildWorkspacePath(workspaceContext.currentWorkspace.id, "/im"));
}

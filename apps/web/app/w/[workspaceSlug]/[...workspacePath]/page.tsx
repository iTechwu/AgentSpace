import { notFound, redirect } from "next/navigation";
import { buildWorkspacePath } from "@/features/auth/workspace-paths";
import { getWorkspacePageContext } from "../_lib/workspace-page-context";

export const dynamic = "force-dynamic";

export default async function WorkspaceFallbackPage({
  params,
}: {
  params: Promise<{ workspaceSlug: string; workspacePath: string[] }>;
}) {
  const { workspaceSlug, workspacePath } = await params;
  const workspaceContext = await getWorkspacePageContext(workspaceSlug, { allowChannelScope: true });
  if (workspacePath.length > 1) {
    notFound();
  }

  if (workspaceContext.accessScope === "channel" && workspacePath[0] !== "im") {
    redirect(buildWorkspacePath(workspaceContext.currentWorkspace.id, "/im"));
  }

  notFound();
}

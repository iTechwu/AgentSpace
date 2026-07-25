import { redirect } from "next/navigation";
import { getWorkspaceContextForIdentifier } from "@/features/auth/server-workspace";
import { buildWorkspacePath } from "@/features/auth/workspace-paths";
import { normalizeWorkspaceSlugParam } from "./workspace-slug";

export type WorkspacePageContext = NonNullable<Awaited<ReturnType<typeof getWorkspaceContextForIdentifier>>>;

export async function getWorkspacePageContext(
  workspaceSlug: string,
  options: { allowChannelScope?: boolean } = {},
): Promise<WorkspacePageContext> {
  const workspaceContext = await getWorkspaceContextForIdentifier(
    normalizeWorkspaceSlugParam(workspaceSlug),
  );
  if (!workspaceContext) {
    redirect("/");
  }
  if (workspaceContext.accessScope === "channel" && !options.allowChannelScope) {
    redirect(buildWorkspacePath(workspaceContext.currentWorkspace.slug, "/im"));
  }
  return workspaceContext;
}

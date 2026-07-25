import { NextResponse } from "next/server";
import { assertCanManageEmployeeForActorSync } from "@dofe-agent/services";
import { getCurrentWorkspaceContext } from "@/features/auth/server-workspace";
import { buildWorkspacePath } from "@/features/auth/workspace-paths";
import { createGoogleWorkspaceAuthorizationUrl } from "@/features/integrations/google-workspace";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: Request): Promise<NextResponse> {
  const workspaceContext = await getCurrentWorkspaceContext();
  if (!workspaceContext) {
    return NextResponse.redirect(new URL("/", request.url));
  }

  const url = new URL(request.url);
  const agentName = url.searchParams.get("agent")?.trim() || undefined;
  const redirectAfter =
    url.searchParams.get("redirectAfter")?.trim()
    || buildWorkspacePath(
      workspaceContext.currentWorkspace.slug,
      agentName ? `/agents?focus=${encodeURIComponent(`agent:${agentName}`)}` : "/im",
    );
  if (agentName) {
    assertCanManageEmployeeForActorSync({
      workspaceId: workspaceContext.currentWorkspace.id,
      employeeName: agentName,
      actorUserId: workspaceContext.currentUser.id,
    });
  }
  const authorizationUrl = await createGoogleWorkspaceAuthorizationUrl({
    workspaceId: workspaceContext.currentWorkspace.id,
    userId: workspaceContext.currentUser.id,
    agentName,
    redirectAfter,
  });

  return NextResponse.redirect(authorizationUrl);
}

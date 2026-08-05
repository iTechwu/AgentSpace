import { listOpenMontageChannelProjectionsSync } from "@dofe-agent/db";
import { canReadChannelForActorSync } from "@dofe-agent/services";
import { getWorkspaceAccessForIdentifier } from "@/features/auth/server-workspace";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(
  _request: Request,
  context: { params: Promise<{ workspaceId: string; channelName: string }> },
): Promise<Response> {
  const { workspaceId: workspaceIdentifier, channelName } = await context.params;
  const access = await getWorkspaceAccessForIdentifier(workspaceIdentifier);
  if (access.status === "unauthenticated") {
    return Response.json({ error: "Unauthorized." }, { status: 401 });
  }
  if (access.status !== "ok") {
    return Response.json({ error: "Forbidden." }, { status: 403 });
  }

  const workspaceId = access.context.currentWorkspace.id;
  const actor = {
    userId: access.context.currentUser.id,
    displayName: access.context.currentUser.displayName,
    role: access.context.currentMembership.role,
  };
  if (!canReadChannelForActorSync({ workspaceId, channelName, actor })) {
    return Response.json({ error: "Forbidden." }, { status: 403 });
  }

  return Response.json({
    jobs: listOpenMontageChannelProjectionsSync(workspaceId, channelName),
  });
}

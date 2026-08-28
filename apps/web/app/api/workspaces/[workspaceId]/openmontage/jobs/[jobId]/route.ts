import {
  readOpenMontageChatBindingSync,
  readOpenMontageJobProjectionSync,
} from "@dofe-agent/db";
import { getWorkspaceAccessForIdentifier } from "@/features/auth/server-workspace";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(
  _request: Request,
  context: { params: Promise<{ workspaceId: string; jobId: string }> },
): Promise<Response> {
  const { workspaceId: workspaceIdentifier, jobId } = await context.params;
  const access = await getWorkspaceAccessForIdentifier(workspaceIdentifier);
  if (access.status === "unauthenticated") {
    return Response.json({ error: "Unauthorized." }, { status: 401 });
  }
  if (access.status !== "ok") {
    return Response.json({ error: "OpenMontage Job not found." }, { status: 404 });
  }

  const workspaceId = access.context.currentWorkspace.id;
  const projection = readOpenMontageJobProjectionSync(workspaceId, jobId);
  if (!projection) {
    return Response.json({ error: "OpenMontage Job not found." }, { status: 404 });
  }

  if (access.context.accessScope === "channel") {
    const binding = readOpenMontageChatBindingSync(workspaceId, jobId);
    if (!binding || !access.context.channelNames?.includes(binding.channelName)) {
      return Response.json({ error: "OpenMontage Job not found." }, { status: 404 });
    }
  }

  return Response.json({ job: projection });
}

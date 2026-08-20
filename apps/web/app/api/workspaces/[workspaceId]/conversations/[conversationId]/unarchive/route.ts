import { NextResponse } from "next/server";
import { getCurrentWorkspaceContext } from "@/features/auth/server-workspace";
import { unarchiveConversationForUserSync } from "@dofe-agent/services/conversations";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** POST /api/workspaces/:workspaceId/conversations/:conversationId/unarchive（docs §5.6）。 */
export async function POST(
  _request: Request,
  context: { params: Promise<{ workspaceId: string; conversationId: string }> },
): Promise<NextResponse> {
  const workspaceContext = await getCurrentWorkspaceContext();
  if (!workspaceContext) {
    return NextResponse.json({ error: "Unauthorized." }, { status: 401 });
  }
  const { workspaceId, conversationId } = await context.params;
  if (workspaceId !== workspaceContext.currentWorkspace.id) {
    return NextResponse.json({ error: "Forbidden." }, { status: 403 });
  }
  try {
    const conversation = unarchiveConversationForUserSync({
      workspaceId,
      conversationId,
      actorUserId: workspaceContext.currentUser.id,
    });
    return NextResponse.json({ conversation });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Failed to unarchive conversation." },
      { status: 400 },
    );
  }
}

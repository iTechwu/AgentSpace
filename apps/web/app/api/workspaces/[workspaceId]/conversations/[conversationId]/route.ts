import { NextResponse } from "next/server";
import { getCurrentWorkspaceContext } from "@/features/auth/server-workspace";
import {
  readConversationForUserSync,
  updateConversationSummaryForUserSync,
} from "@dofe-agent/services/conversations";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * GET/PATCH /api/workspaces/:workspaceId/conversations/:conversationId
 * 读取单个 Conversation 与更新标题/摘要（docs/0820/session-split §5.5）。
 */
export async function GET(
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
    const conversation = readConversationForUserSync({
      workspaceId,
      conversationId,
      actorUserId: workspaceContext.currentUser.id,
    });
    return NextResponse.json({ conversation });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Conversation not found." },
      { status: 404 },
    );
  }
}

export async function PATCH(
  request: Request,
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
  const body = (await request.json().catch(() => null)) as Record<string, unknown> | null;
  if (!body || (typeof body.title !== "string" && typeof body.summary !== "string")) {
    return NextResponse.json({ error: "title or summary is required." }, { status: 400 });
  }
  try {
    const conversation = updateConversationSummaryForUserSync({
      workspaceId,
      conversationId,
      actorUserId: workspaceContext.currentUser.id,
      title: typeof body.title === "string" ? body.title : undefined,
      summary: typeof body.summary === "string" ? body.summary : undefined,
      summarySource: body.summarySource === "generated" ? "generated" : "user",
    });
    return NextResponse.json({ conversation });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Failed to update conversation." },
      { status: 400 },
    );
  }
}

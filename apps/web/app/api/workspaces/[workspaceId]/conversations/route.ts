import { NextResponse } from "next/server";
import { getCurrentWorkspaceContext } from "@/features/auth/server-workspace";
import { createConversationForUserSync } from "@dofe-agent/services/conversations";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * POST /api/workspaces/:workspaceId/conversations
 * 多会话拆分（docs/0820/session-split §5.1）：/new 的服务端入口。
 * Idempotency-Key 去重，重复创建返回同一 Conversation。
 */
export async function POST(
  request: Request,
  context: { params: Promise<{ workspaceId: string }> },
): Promise<NextResponse> {
  const workspaceContext = await getCurrentWorkspaceContext();
  if (!workspaceContext) {
    return NextResponse.json({ error: "Unauthorized." }, { status: 401 });
  }
  const { workspaceId } = await context.params;
  if (workspaceId !== workspaceContext.currentWorkspace.id) {
    return NextResponse.json({ error: "Forbidden." }, { status: 403 });
  }

  const body = (await request.json().catch(() => null)) as Record<string, unknown> | null;
  const employeeId = typeof body?.employeeId === "string" ? body.employeeId.trim() : "";
  if (!employeeId) {
    return NextResponse.json({ error: "employeeId is required." }, { status: 400 });
  }
  const kind = body?.kind === "group" ? "group" : "direct";
  const idempotencyKey = request.headers.get("idempotency-key")?.trim() || undefined;

  try {
    const result = createConversationForUserSync({
      workspaceId,
      employeeId,
      channelId: typeof body?.channelId === "string" ? body.channelId : undefined,
      createdByUserId: workspaceContext.currentUser.id,
      kind,
      idempotencyKey,
    });
    return NextResponse.json({
      conversation: {
        id: result.conversation.id,
        status: result.conversation.status,
        summary: result.conversation.summary ?? "新会话",
        title: result.conversation.title ?? null,
        employeeId,
        employeeName: result.employeeName,
        executionLaneId: result.lane?.id ?? null,
        createdAt: result.conversation.createdAt,
      },
    });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Failed to create conversation." },
      { status: 400 },
    );
  }
}

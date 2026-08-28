import { NextResponse } from "next/server";
import { getCurrentWorkspaceContext } from "@/features/auth/server-workspace";
import { listConversationsForEmployeeForUserSync } from "@dofe-agent/services/conversations";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * GET /api/workspaces/:workspaceId/employees/:employeeId/conversations
 * 历史会话列表按 employee 范围分页（docs/0820/session-split §5.2）。
 */
export async function GET(
  request: Request,
  context: { params: Promise<{ workspaceId: string; employeeId: string }> },
): Promise<NextResponse> {
  const workspaceContext = await getCurrentWorkspaceContext();
  if (!workspaceContext) {
    return NextResponse.json({ error: "Unauthorized." }, { status: 401 });
  }
  const { workspaceId, employeeId } = await context.params;
  if (workspaceId !== workspaceContext.currentWorkspace.id) {
    return NextResponse.json({ error: "Forbidden." }, { status: 403 });
  }

  const params = new URL(request.url).searchParams;
  const statusesRaw = params.get("status");
  const statuses = statusesRaw
    ? statusesRaw.split(",").map((item) => item.trim()).filter(Boolean)
    : undefined;
  const cursor = params.get("cursor") ?? undefined;
  const rawLimit = params.get("limit");
  const limit = rawLimit && /^\d+$/.test(rawLimit) ? Number(rawLimit) : undefined;

  try {
    const conversations = listConversationsForEmployeeForUserSync({
      workspaceId,
      employeeId,
      actorUserId: workspaceContext.currentUser.id,
      statuses: (statuses as Array<"draft" | "active" | "idle" | "failed" | "archived" | "abandoned"> | undefined),
      cursor,
      limit,
    });
    return NextResponse.json({
      conversations: conversations.map((conversation) => ({
        id: conversation.id,
        status: conversation.status,
        summary: conversation.summary ?? conversation.title ?? "新会话",
        title: conversation.title ?? null,
        lastActivityAt: conversation.lastActivityAt ?? conversation.updatedAt,
        createdAt: conversation.createdAt,
        archivedAt: conversation.archivedAt ?? null,
      })),
    });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Failed to list conversations." },
      { status: 400 },
    );
  }
}

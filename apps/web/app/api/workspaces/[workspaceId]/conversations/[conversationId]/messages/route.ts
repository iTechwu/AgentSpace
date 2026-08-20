import { NextResponse } from "next/server";
import { getCurrentWorkspaceContext } from "@/features/auth/server-workspace";
import { listConversationMessagesSync } from "@dofe-agent/db";
import { readConversationForUserSync } from "@dofe-agent/services/conversations";
import { readWorkspaceStateSync } from "@dofe-agent/services/workspace";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * GET /api/workspaces/:workspaceId/conversations/:conversationId/messages
 * 按 Conversation 读取消息（docs/0820/session-split §5.3）：channel 仅作授权与展示上下文，
 * conversationId 是唯一过滤主键。
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
    const state = readWorkspaceStateSync(workspaceId);
    const persisted = listConversationMessagesSync(conversation.id);
    const messages = persisted.length > 0
      ? persisted.map((message) => ({
          id: message.id,
          channel: message.channel,
          speaker: message.speaker,
          speakerUserId: message.speakerUserId,
          role: message.role,
          summary: message.summary,
          time: message.time,
          status: message.status,
          kind: message.kind,
          processType: message.processType,
          tool: message.tool,
          code: message.code,
          data: safeParseJson(message.dataJson),
        }))
      : state.messages
          .filter((message) => message.conversationId === conversation.id)
          .slice()
          .reverse()
          .map((message) => ({
        id: message.id,
        channel: message.channel,
        speaker: message.speaker,
        speakerUserId: message.speakerUserId,
        role: message.role,
        summary: message.summary,
        time: message.time,
        status: message.status ?? "completed",
        kind: message.kind,
        processType: message.processType,
        tool: message.tool,
        code: message.code,
        data: message.data,
        attachments: message.attachments,
        mentions: message.mentions,
        replyToMessageId: message.replyToMessageId,
        pinned: message.pinned,
        pinnedAt: message.pinnedAt,
      }));
    return NextResponse.json({ conversation, messages });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Conversation not found." },
      { status: 404 },
    );
  }
}

function safeParseJson(value: string): Record<string, string> | undefined {
  try {
    const parsed = JSON.parse(value) as unknown;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed as Record<string, string> : undefined;
  } catch {
    return undefined;
  }
}

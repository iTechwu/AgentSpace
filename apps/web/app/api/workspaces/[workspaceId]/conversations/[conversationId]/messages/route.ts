import { NextResponse } from "next/server";
import { getCurrentWorkspaceContext } from "@/features/auth/server-workspace";
import { persistFormAttachments } from "@/features/chat/attachment-actions";
import { listConversationParticipantsSync, readConversationSync, readStoredChannelSync, readStoredEmployeeByIdSync } from "@dofe-agent/db";
import { recordConversationMessageActivitySync, readConversationForUserSync, resolveConversationLaneForSendSync } from "@dofe-agent/services/conversations";
import { appendReferencedSkillDirective, mergeMessageAttachments, resolveReferencedAttachments, resolveResumeCommand } from "@/features/chat/message-composition";
import { sendContactMessageForHumanWithAttachmentsSync } from "@dofe-agent/services/channels";
import { sendChannelHumanMessageSync } from "@dofe-agent/services/messaging";
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
    // 工作区状态是消息真相（含附件/mentions/回复/置顶）；conversation_message 仅作 SQL 镜像，不用于读接口。
    const state = readWorkspaceStateSync(workspaceId);
    const messages = state.messages
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

/**
 * POST /api/workspaces/:workspaceId/conversations/:conversationId/messages
 * 独立发送消息 REST 端点（docs/0820/session-split §5.4）：multipart，服务端校验会话参与者与
 * employee 参与者，解析 Lane 后 enqueue，并刷新会话活动时间。Idempotency-Key 用于任务级去重。
 */
export async function POST(
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

  let formData: FormData;
  try {
    formData = await request.formData();
  } catch {
    return NextResponse.json({ error: "multipart/form-data is required." }, { status: 400 });
  }
  const contentValue = formData.get("content");
  const content = typeof contentValue === "string" ? contentValue : "";
  if (!content.trim()) {
    return NextResponse.json({ error: "content is required." }, { status: 400 });
  }
  const attachmentReferenceIds = [...new Set(
    formData.getAll("attachmentReferences").filter((value): value is string => typeof value === "string"),
  )];
  const skillReferenceIds = [...new Set(
    formData.getAll("skillReferences").filter((value): value is string => typeof value === "string"),
  )];
  const replyToMessageId = (formData.get("replyToMessageId") as string | null)?.trim() || undefined;

  try {
    const conversation = readConversationForUserSync({
      workspaceId,
      conversationId,
      actorUserId: workspaceContext.currentUser.id,
    });
    // /resume 是导航命令：REST 端点同样拒绝，不产生聊天消息（docs/0820 §5）。
    resolveResumeCommand(content);
    const uploadedAttachments = (await persistFormAttachments(formData, "attachments", workspaceId)) ?? [];
    const referencedAttachments = resolveReferencedAttachments({
      workspaceId,
      conversationId,
      attachmentIds: attachmentReferenceIds,
    });
    const attachments = mergeMessageAttachments(uploadedAttachments, referencedAttachments);
    const idempotencyKey = request.headers.get("idempotency-key")?.trim() || undefined;
    const displayName = workspaceContext.currentUser.displayName.trim() || "你";

    if (conversation.kind === "group") {
      const channelName = conversation.channelId;
      if (!channelName) {
        return NextResponse.json({ error: "Group conversation has no channel." }, { status: 400 });
      }
      const channel = readStoredChannelSync(channelName, workspaceId);
      const resolvedContent = appendReferencedSkillDirective({
        workspaceId,
        employeeNames: channel?.employeeNames ?? [],
        content: content.trim(),
        skillIds: skillReferenceIds,
      });
      sendChannelHumanMessageSync(
        channelName,
        displayName,
        resolvedContent,
        attachments,
        replyToMessageId,
        workspaceId,
        workspaceContext.currentUser.id,
        undefined,
        { conversationId, idempotencyKey },
      );
    } else {
      const employeeParticipant = listConversationParticipantsSync(conversationId)
        .find((participant) => participant.participantType === "employee" && participant.employeeId);
      const employeeId = employeeParticipant?.employeeId;
      if (!employeeId) {
        return NextResponse.json({ error: "Conversation has no employee participant." }, { status: 400 });
      }
      const employee = readStoredEmployeeByIdSync(employeeId, workspaceId);
      if (!employee) {
        return NextResponse.json({ error: "Employee not found." }, { status: 400 });
      }
      const lane = resolveConversationLaneForSendSync({
        workspaceId,
        conversationId,
        employeeId,
        actorUserId: workspaceContext.currentUser.id,
      });
      const resolvedContent = appendReferencedSkillDirective({
        workspaceId,
        employeeNames: [employee.name],
        content: content.trim(),
        skillIds: skillReferenceIds,
      });
      sendContactMessageForHumanWithAttachmentsSync(
        displayName,
        employee.name,
        resolvedContent,
        attachments,
        workspaceId,
        workspaceContext.currentUser.id,
        undefined,
        { conversationId, executionLaneId: lane.lane.id, idempotencyKey, replyToMessageId },
      );
    }

    recordConversationMessageActivitySync({
      workspaceId,
      conversationId,
      actorUserId: workspaceContext.currentUser.id,
      firstMessageText: content.trim(),
    });

    return NextResponse.json(
      { conversation: readConversationSync(conversationId), status: "accepted" },
      { status: 201 },
    );
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Failed to send message." },
      { status: 400 },
    );
  }
}

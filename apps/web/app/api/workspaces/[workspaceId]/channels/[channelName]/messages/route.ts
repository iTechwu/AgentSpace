import { listTaskMessagesForTasksSync } from "@dofe-agent/db";
import { canReadChannelForActorSync } from "@dofe-agent/services/channels";
import { readWorkspaceStateSnapshotSync } from "@dofe-agent/services/workspace";
import { getWorkspaceAccessForIdentifier } from "@/features/auth/server-workspace";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(
  request: Request,
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

  const workspaceContext = access.context;
  const workspaceId = workspaceContext.currentWorkspace.id;
  const actor = {
    userId: workspaceContext.currentUser.id,
    displayName: workspaceContext.currentUser.displayName,
    role: workspaceContext.currentMembership.role,
  };
  if (!canReadChannelForActorSync({ workspaceId, channelName, actor })) {
    return Response.json({ error: "Forbidden." }, { status: 403 });
  }

  const requestUrl = new URL(request.url);
  const taskId = requestUrl.searchParams.get("taskId")?.trim();
  const afterSeqValue = requestUrl.searchParams.get("afterSeq");
  const afterSeq = afterSeqValue === null ? 0 : Number(afterSeqValue);
  if (!taskId || !Number.isSafeInteger(afterSeq) || afterSeq < 0) {
    return Response.json({ error: "taskId and a non-negative afterSeq are required." }, { status: 400 });
  }

  const taskMessages = readWorkspaceStateSnapshotSync(workspaceId).messages.filter((message) =>
    message.channel === channelName && message.data?.source_task_queue_id === taskId,
  );
  if (taskMessages.length === 0) {
    return Response.json({ error: "Task does not belong to this channel." }, { status: 400 });
  }

  const rows = listTaskMessagesForTasksSync([taskId]).get(taskId) ?? [];
  const lastSeq = rows.at(-1)?.seq ?? 0;
  return Response.json({
    messages: taskMessages.map((message) => ({
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
    })),
    taskExecutions: { [taskId]: rows.filter((row) => row.seq > afterSeq) },
    lastSeqByTask: { [taskId]: lastSeq },
    snapshotVersion: 1,
  });
}

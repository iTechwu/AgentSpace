import {
  appendTaskMessageSync,
  markAgentRouterProviderSessionInvalidSync,
  recordAgentRouterEventSync,
  type QueuedTaskRecord,
} from "@dofe-agent/db";
import type { DaemonProvider, DaemonTaskMessageInput, ReportTaskMessagesRequest } from "@dofe-agent/domain";
import { parseTaskPayload } from "dofe-agent-daemon";
import { updatePendingAgentChannelReplySync } from "@dofe-agent/services";
import { readTaskForDaemon, requireDaemonAuth } from "../../../_lib/auth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(
  request: Request,
  context: { params: Promise<{ taskId: string }> },
): Promise<Response> {
  const auth = requireDaemonAuth(request);
  if (auth instanceof Response) {
    return auth;
  }

  const { taskId } = await context.params;
  const task = readTaskForDaemon(taskId, auth);
  if (task instanceof Response) {
    return task;
  }

  const body = (await request.json()) as Partial<ReportTaskMessagesRequest>;
  if (!Array.isArray(body.messages) || body.messages.length === 0) {
    return Response.json({ error: "messages[] is required." }, { status: 400 });
  }

  const appended = body.messages.map((message) => appendSingleMessage(task, message));
  const payload = parseTaskPayload(task);
  const channelName = payload.channelName ?? payload.channel;
  if (channelName) {
    for (const message of body.messages) {
      if (message.type !== "text_delta" || !message.content?.trim()) {
        continue;
      }
      updatePendingAgentChannelReplySync({
        channel: channelName,
        sourceTaskQueueId: task.id,
        pendingSpeaker: payload.assignee ?? task.agentId,
        delta: message.content,
      }, task.workspaceId);
    }
  }
  return Response.json({ messages: appended });
}

function appendSingleMessage(task: QueuedTaskRecord, message: DaemonTaskMessageInput) {
  if (message.type === "provider_session_invalid") {
    handleProviderSessionInvalid(task, message);
  }
  return appendTaskMessageSync({
    taskId: task.id,
    type: message.type === "provider_session_invalid" ? "status" : message.type,
    content: message.content,
    tool: message.tool,
    inputJson: message.inputJson,
    output: message.output,
  });
}

function handleProviderSessionInvalid(task: QueuedTaskRecord, message: DaemonTaskMessageInput): void {
  if (!task.routerSessionId) {
    return;
  }
  const data = message.inputJson ?? {};
  const provider = typeof data.provider === "string" ? data.provider as DaemonProvider : undefined;
  const sessionId = typeof data.sessionId === "string" ? data.sessionId : undefined;
  markAgentRouterProviderSessionInvalidSync({
    workspaceId: task.workspaceId,
    routerSessionId: task.routerSessionId,
    runtimeId: task.runtimeId,
    provider,
    providerSessionId: sessionId,
    lastError: message.content ?? "Provider session was invalid.",
  });
  recordAgentRouterEventSync({
    workspaceId: task.workspaceId,
    routerSessionId: task.routerSessionId,
    taskQueueId: task.id,
    type: "provider_session_invalid",
    actorType: "runtime",
    actorId: task.runtimeId,
    runtimeId: task.runtimeId,
    provider,
    summary: message.content,
    data: {
      providerSessionId: sessionId,
      code: typeof data.code === "string" ? data.code : "provider.session_invalid",
    },
  });
}

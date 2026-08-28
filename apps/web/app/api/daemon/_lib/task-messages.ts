import {
  appendTaskMessageSync,
  markAgentRouterProviderSessionInvalidSync,
  recordAgentRouterEventSync,
  type QueuedTaskRecord,
} from "@dofe-agent/db";
import type { DaemonProvider, DaemonTaskMessageInput } from "@dofe-agent/domain";
import { parseTaskPayload } from "dofe-agent-daemon";
import { recordAgentChannelProgressSync, updatePendingAgentChannelReplySync } from "@dofe-agent/services/messaging";

export function appendReportedTaskMessages(task: QueuedTaskRecord, messages: DaemonTaskMessageInput[]) {
  const appended = messages.map((message) => appendSingleMessage(task, message));
  const payload = parseTaskPayload(task);
  const channelName = payload.channelName ?? payload.channel;
  if (!channelName) return appended;

  for (const [index, message] of messages.entries()) {
    const persistedMessage = appended[index];
    const conversationId = task.conversationId ?? payload.conversationId;
    const pendingSpeaker = payload.assignee ?? task.agentId;
    if (message.type === "text" && message.content) {
      updatePendingAgentChannelReplySync({
        channel: channelName,
        sourceTaskQueueId: task.id,
        pendingSpeaker,
        delta: message.content,
        conversationId,
        lastSeq: persistedMessage?.seq,
      }, task.workspaceId);
    }
    const progressType = toProgressType(message.type);
    if (progressType) {
      recordAgentChannelProgressSync({
        channel: channelName,
        sourceTaskQueueId: task.id,
        speaker: pendingSpeaker,
        type: progressType,
        tool: message.tool,
        refId: message.refId,
        content: message.content,
        detail: progressDetail(message),
        conversationId,
        lastSeq: persistedMessage?.seq,
      }, task.workspaceId);
    }
  }
  return appended;
}

function progressDetail(message: DaemonTaskMessageInput): string | undefined {
  if (message.type === "tool_use" && message.inputJson && Object.keys(message.inputJson).length > 0) {
    return JSON.stringify(message.inputJson, null, 2);
  }
  return message.output ?? message.content;
}

function toProgressType(type: string): "thinking" | "tool_use" | "tool_result" | "status" | null {
  if (type === "thinking" || type === "tool_use" || type === "tool_result" || type === "status") return type;
  return type === "narration" ? "thinking" : null;
}

function appendSingleMessage(task: QueuedTaskRecord, message: DaemonTaskMessageInput) {
  if (message.type === "provider_session_invalid") handleProviderSessionInvalid(task, message);
  return appendTaskMessageSync({
    taskId: task.id,
    type: message.type === "provider_session_invalid" ? "status" : message.type,
    content: message.content,
    tool: message.tool,
    inputJson: message.inputJson,
    output: message.output,
    refId: message.refId,
  });
}

function handleProviderSessionInvalid(task: QueuedTaskRecord, message: DaemonTaskMessageInput): void {
  if (!task.routerSessionId) return;
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

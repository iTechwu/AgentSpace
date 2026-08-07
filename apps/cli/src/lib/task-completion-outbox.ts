import type { MessageAttachment } from "@dofe-agent/domain/workspace";
import {
  queueFeishuAgentStatusCardOutboxSync,
  queueFeishuChannelReplyOutboxSync,
  type FeishuAgentStatusCardStatus,
} from "@dofe-agent/services";

interface TaskCompletionOutboxInput {
  workspaceId: string;
  channelName: string;
  agentId?: string;
  text: string;
  attachments?: MessageAttachment[];
  dofeAgentMessageId?: string;
  sourceDofeAgentMessageId?: string;
  statusCard?: {
    status: FeishuAgentStatusCardStatus;
    agentNames: string[];
    message?: string;
    taskId?: string;
  };
}

interface TaskCompletionOutboxDependencies {
  queueStatusCard: (input: Parameters<typeof queueFeishuAgentStatusCardOutboxSync>[0]) => unknown[];
  queueReply: (input: Parameters<typeof queueFeishuChannelReplyOutboxSync>[0]) => unknown[];
}

const defaultDependencies: TaskCompletionOutboxDependencies = {
  queueStatusCard: queueFeishuAgentStatusCardOutboxSync,
  queueReply: queueFeishuChannelReplyOutboxSync,
};

export function enqueueTaskCompletionFeishuOutbox(
  input: TaskCompletionOutboxInput,
  dependencies: TaskCompletionOutboxDependencies = defaultDependencies,
): string[] {
  const statusCardItems = input.statusCard
    ? dependencies.queueStatusCard({
        workspaceId: input.workspaceId,
        channelName: input.channelName,
        agentId: input.agentId,
        status: input.statusCard.status,
        agentNames: input.statusCard.agentNames,
        message: input.statusCard.message,
        taskId: input.statusCard.taskId,
        dofeAgentMessageId: input.dofeAgentMessageId,
        sourceDofeAgentMessageId: input.sourceDofeAgentMessageId,
      })
    : [];
  const replyOutboxItems = dependencies.queueReply(input);
  const queuedCount = statusCardItems.length + replyOutboxItems.length;
  return queuedCount > 0 ? [`Feishu outbound queued: ${queuedCount} message(s).`] : [];
}

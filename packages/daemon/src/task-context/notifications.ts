// 3.5-4：自 task-context.ts 拆出——任务相关未读通知的筛选（只保留与当前
// 任务频道/任务/文档相关的通知）。
import type { QueuedTaskRecord } from "@dofe-agent/db";
import { listNotificationsForRecipientSync, type AgentDocumentContext, type WorkspaceNotificationRecord } from "@dofe-agent/services";
import type { ParsedTaskPayload } from "./payload.ts";

export function resolveAgentNotificationsForTask(input: {
  workspaceId: string;
  agentName: string;
  task: QueuedTaskRecord;
  payload: ParsedTaskPayload;
  agentDocumentContexts: AgentDocumentContext[];
}): WorkspaceNotificationRecord[] {
  const notifications = listNotificationsForRecipientSync({
    workspaceId: input.workspaceId,
    recipientType: "agent",
    recipientId: input.agentName,
    status: "unread",
    limit: 30,
  });
  const relatedChannels = new Set([
    input.payload.channelName,
    input.payload.channel,
    input.payload.sourceChannel,
  ].map(normalizeComparable).filter((value): value is string => Boolean(value)));
  const relatedTaskIds = new Set([
    input.task.id,
    input.payload.taskId,
    input.payload.sourceTaskQueueId,
  ].map(normalizeComparable).filter((value): value is string => Boolean(value)));
  const relatedDocumentIds = new Set([
    ...input.agentDocumentContexts.map((context) => context.document.id),
    ...(input.payload.handoffDocumentIds ?? []),
  ].map(normalizeComparable).filter((value): value is string => Boolean(value)));

  return notifications
    .filter((notification) => isNotificationRelatedToTask(notification, {
      relatedChannels,
      relatedTaskIds,
      relatedDocumentIds,
    }))
    .slice(0, 8);
}

function isNotificationRelatedToTask(
  notification: WorkspaceNotificationRecord,
  context: {
    relatedChannels: Set<string>;
    relatedTaskIds: Set<string>;
    relatedDocumentIds: Set<string>;
  },
): boolean {
  const channelName = normalizeComparable(notification.channelName);
  if (channelName && context.relatedChannels.has(channelName)) {
    return true;
  }
  const resourceId = normalizeComparable(notification.resourceId);
  if (!resourceId) {
    return false;
  }
  if (notification.resourceType === "task") {
    return context.relatedTaskIds.has(resourceId);
  }
  if (notification.resourceType === "document") {
    return context.relatedDocumentIds.has(resourceId);
  }
  return false;
}

function normalizeComparable(value: string | undefined): string | undefined {
  const normalized = value?.trim().toLowerCase();
  return normalized ? normalized : undefined;
}

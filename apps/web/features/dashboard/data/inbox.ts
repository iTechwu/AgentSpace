// dashboard 收件箱页数据装配（从 features/dashboard/data.ts 拆出，3.4/3.6 巨型文件项）。

import { isWorkspaceManagerRole } from "../dashboard-view-builders";
import type { AgentsPageData, DashboardCurrentUser, InboxItem, InboxPageData, TaskExecutionTimelineEntry } from "../data-types";
import { DEFAULT_WORKSPACE_ID, listTaskMessagesForTasksSync } from "@dofe-agent/db";
import type { WorkspaceRole } from "@dofe-agent/db";
import type { DofeAgentState, WorkspaceMessage } from "@dofe-agent/domain/workspace";
import { canReadChannelForActorSync } from "@dofe-agent/services/channels";
import { listEmployeeSkillIdsByAgentIdMap } from "@dofe-agent/services/employees";
import { listNotificationsForRecipientAsync, listNotificationsForRecipientSync } from "@dofe-agent/services/workspace";
import { listTaskExecutionEventsAsync } from "@dofe-agent/services/tasks";
import type { WorkspaceNotificationRecord } from "@dofe-agent/services/workspace";
import { formatAbsoluteDateTime, formatNotificationResourceType, formatNotificationStatus, toneForNotification } from "./agent-record.ts";
import { getAgentsPageData, mapTaskExecutionTimelineEntry, resolveAgentsPageDataOptions } from "./agents.ts";
import { listDaemonSnapshotsCached, listEmployeeRuntimeBindingsCached, listQueuedTasksCached, listRuntimeAppOperationsCached, listRuntimeInstalledAppsCached, readWorkspaceStateCached } from "./cached.ts";
import { buildActivityInboxItems, buildChannelInboxItems, buildTaskInboxItems } from "./inbox-items.ts";
import { buildRuntimeDisplayNameIndex } from "./runtime-views.ts";
import { buildNativeRuntimeRecords } from "./skills.ts";

export function getInboxPageData(
  workspaceId = DEFAULT_WORKSPACE_ID,
  currentUser?: DashboardCurrentUser,
): InboxPageData {
  const state = readWorkspaceStateCached(workspaceId);
  const messagesByChannelName = buildMessagesByChannelName(state.messages ?? []);
  const readableChannels = buildReadableChannelLookup(state, workspaceId, currentUser);
  const runtimeSnapshots = listDaemonSnapshotsCached(workspaceId);
  const bindings = listEmployeeRuntimeBindingsCached(workspaceId);
  const queuedTasks = listQueuedTasksCached(workspaceId);
  const installedApps = listRuntimeInstalledAppsCached(workspaceId);
  const runtimeAppOperations = listRuntimeAppOperationsCached(workspaceId, 200);
  const runtimeDisplayNames = buildRuntimeDisplayNameIndex(workspaceId);
  const runtimeRecords = buildNativeRuntimeRecords(state, runtimeSnapshots, bindings, queuedTasks, runtimeDisplayNames, installedApps, runtimeAppOperations);
  const runtimeIndex = new Map(runtimeRecords.map((runtime) => [runtime.runtimeId, runtime]));
  const runtimeTracesByTaskId = listTaskMessagesForTasksSync(queuedTasks.map((task) => task.id));
  const taskItems = buildTaskInboxItems(
    state,
    new Map(bindings.map((binding) => [binding.employeeName, binding])),
    runtimeIndex,
    queuedTasks,
    workspaceId,
    currentUser,
    readableChannels,
    messagesByChannelName,
    runtimeTracesByTaskId,
  );
  const notificationItems = buildNotificationInboxItems(state, workspaceId, currentUser);
  const channelItems = buildChannelInboxItems(
    state,
    runtimeIndex,
    queuedTasks,
    workspaceId,
    currentUser,
    readableChannels,
    messagesByChannelName,
    runtimeTracesByTaskId,
  );
  const activityItems = buildActivityInboxItems(state, workspaceId, currentUser, readableChannels);
  const items = [...notificationItems, ...taskItems, ...channelItems, ...activityItems];

  return {
    items,
    totalCount: items.length,
    unreadCount: items.filter((item) => item.unread).length,
    notificationCount: notificationItems.length,
    taskCount: taskItems.length,
    channelCount: channelItems.length,
    activityCount: activityItems.length,
  };
}
export async function getInboxPageDataAsync(
  workspaceId = DEFAULT_WORKSPACE_ID,
  currentUser?: DashboardCurrentUser,
): Promise<InboxPageData> {
  const syncData = getInboxPageData(workspaceId, currentUser);
  const dataWithAuthoritativeTimelines = replaceInboxExecutionTimelinesAsync(syncData, workspaceId);
  if (!currentUser?.id) {
    return dataWithAuthoritativeTimelines;
  }

  const state = readWorkspaceStateCached(workspaceId);
  const ownedAgentNames = state.activeEmployees
    .filter((employee) => employee.ownerUserId === currentUser.id)
    .map((employee) => employee.name);
  const [currentData, notificationGroups] = await Promise.all([
    dataWithAuthoritativeTimelines,
    Promise.all([
      listNotificationsForRecipientAsync({
        workspaceId,
        recipientType: "human",
        recipientId: currentUser.id,
        includeArchived: false,
        limit: 100,
      }),
      ...ownedAgentNames.map((agentName) => listNotificationsForRecipientAsync({
        workspaceId,
        recipientType: "agent",
        recipientId: agentName,
        includeArchived: false,
        limit: 50,
      })),
    ]),
  ]);
  const notifications = notificationGroups.flat();
  notifications.sort((left, right) => {
    const byTime = new Date(right.createdAt).getTime() - new Date(left.createdAt).getTime();
    return byTime || right.id.localeCompare(left.id);
  });
  const notificationItems = buildNotificationInboxItemsFromRecords(notifications);
  return replaceInboxNotificationItems(currentData, notificationItems);
}
export async function replaceInboxExecutionTimelinesAsync(
  current: InboxPageData,
  workspaceId: string,
): Promise<InboxPageData> {
  const queueIds = Array.from(new Set(current.items
    .map((item) => item.execution?.queueId.trim())
    .filter((queueId): queueId is string => Boolean(queueId))));
  if (queueIds.length === 0) {
    return current;
  }
  const events = (await Promise.all(chunkValues(queueIds, 50).map((taskIds) =>
    listTaskExecutionEventsAsync({
      workspaceId,
      taskIds,
      limitPerTask: 80,
      order: "asc",
    })))).flat();
  const timelines = new Map<string, TaskExecutionTimelineEntry[]>();
  for (const event of events) {
    const timeline = timelines.get(event.taskId) ?? [];
    if (timeline.length < 80) {
      timeline.push(mapTaskExecutionTimelineEntry(event));
      timelines.set(event.taskId, timeline);
    }
  }
  return {
    ...current,
    items: current.items.map((item) => {
      if (!item.execution?.queueId) {
        return item;
      }
      const timeline = timelines.get(item.execution.queueId);
      if (!timeline) {
        return item;
      }
      return {
        ...item,
        execution: {
          ...item.execution,
          currentEvent: timeline.at(-1),
          timeline,
        },
      };
    }),
  };
}
export function chunkValues<T>(values: T[], size: number): T[][] {
  const chunks: T[][] = [];
  for (let index = 0; index < values.length; index += size) {
    chunks.push(values.slice(index, index + size));
  }
  return chunks;
}
export function replaceInboxNotificationItems(
  current: InboxPageData,
  notificationItems: InboxItem[],
): InboxPageData {
  const items = [
    ...notificationItems,
    ...current.items.filter((item) => item.kind !== "notification"),
  ];
  return {
    ...current,
    items,
    totalCount: items.length,
    unreadCount: items.filter((item) => item.unread).length,
    notificationCount: notificationItems.length,
  };
}
export interface ReadableChannelLookup {
  canRead(channelName?: string | null): boolean;
}
export function buildReadableChannelLookup(
  state: DofeAgentState,
  workspaceId: string,
  currentUser?: DashboardCurrentUser,
): ReadableChannelLookup {
  if (!currentUser?.id) {
    return { canRead: () => true };
  }

  const isManager = isWorkspaceManagerRole(currentUser.role);
  const channelByName = new Map(
    state.channels.map((channel) => [normalizeChannelLookupKey(channel.name), channel]),
  );
  const readableChannelNames = new Set<string>();

  for (const channel of state.channels) {
    const key = normalizeChannelLookupKey(channel.name);
    if (isManager && channel.kind !== "direct") {
      readableChannelNames.add(key);
      continue;
    }
    if (
      canReadChannelForActorSync({
        workspaceId,
        channelName: channel.name,
        actor: {
          userId: currentUser.id,
          displayName: currentUser.displayName,
          role: currentUser.role,
        },
      })
    ) {
      readableChannelNames.add(key);
    }
  }

  return {
    canRead(channelName) {
      const key = normalizeChannelLookupKey(channelName ?? "");
      if (!key) {
        return true;
      }
      const channel = channelByName.get(key);
      if (isManager && channel?.kind !== "direct") {
        return true;
      }
      return readableChannelNames.has(key);
    },
  };
}
export function buildMessagesByChannelName(messages: WorkspaceMessage[]): Map<string, WorkspaceMessage[]> {
  const byChannel = new Map<string, WorkspaceMessage[]>();
  for (const message of messages) {
    const channelName = message.channel;
    if (!channelName) {
      continue;
    }
    const channelMessages = byChannel.get(channelName) ?? [];
    channelMessages.push(message);
    byChannel.set(channelName, channelMessages);
  }
  return byChannel;
}
export function normalizeChannelLookupKey(value: string): string {
  return value.trim().toLocaleLowerCase("zh-CN");
}
export function buildNotificationInboxItems(
  state: DofeAgentState,
  workspaceId: string,
  currentUser?: DashboardCurrentUser,
): InboxItem[] {
  if (!currentUser?.id) {
    return [];
  }

  const ownedAgentNames = state.activeEmployees
    .filter((employee) => employee.ownerUserId === currentUser.id)
    .map((employee) => employee.name);
  const notifications = [
    ...listNotificationsForRecipientSync({
      workspaceId,
      recipientType: "human",
      recipientId: currentUser.id,
      includeArchived: false,
      limit: 100,
    }),
    ...ownedAgentNames.flatMap((agentName) =>
      listNotificationsForRecipientSync({
        workspaceId,
        recipientType: "agent",
        recipientId: agentName,
        includeArchived: false,
        limit: 50,
      }),
    ),
  ].sort((left, right) => {
    const byTime = new Date(right.createdAt).getTime() - new Date(left.createdAt).getTime();
    return byTime || right.id.localeCompare(left.id);
  });

  return buildNotificationInboxItemsFromRecords(notifications);
}
export function buildNotificationInboxItemsFromRecords(
  notifications: WorkspaceNotificationRecord[],
): InboxItem[] {
  return notifications.map((notification) => ({
    id: `notification:${notification.id}`,
    kind: "notification",
    title: notification.title,
    subtitle: notification.recipientType === "agent" ? `AI员工 · ${notification.recipientId}` : "Notification",
    meta: notification.channelName ? `#${notification.channelName}` : formatNotificationResourceType(notification.resourceType),
    timestamp: formatAbsoluteDateTime(notification.createdAt),
    unread: notification.status === "unread",
    statusLabel: formatNotificationStatus(notification.status),
    statusTone: toneForNotification(notification),
    body: notification.body,
    actionHref: notification.actionHref,
    notification,
    channelName: notification.channelName,
    history: [
      {
        id: `notification-entry-${notification.id}`,
        role: "system",
        actor: notification.actorId ?? "agent.dofe",
        timestamp: formatAbsoluteDateTime(notification.createdAt),
        body: notification.body,
      },
    ],
  }));
}
export interface AgentsPageDataOptions {
  workspaceId?: string;
  currentUserId?: string;
  currentMembershipRole?: WorkspaceRole;
  skillIdsByAgentId?: Map<string, string[]>;
}
export async function getAgentsPageDataAsync(
  input: string | AgentsPageDataOptions = DEFAULT_WORKSPACE_ID,
): Promise<AgentsPageData> {
  const options = resolveAgentsPageDataOptions(input);
  const canManageAllAgents = !options.currentUserId
    || isWorkspaceManagerRole(options.currentMembershipRole);
  return getAgentsPageData({
    ...options,
    skillIdsByAgentId: canManageAllAgents
      ? await listEmployeeSkillIdsByAgentIdMap(options.workspaceId)
      : new Map(),
  });
}

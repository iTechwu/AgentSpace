// dashboard 收件箱条目构建器（从 features/dashboard/data.ts 拆出，3.4/3.6 巨型文件项）。

import { buildChannelListItem, buildMentionUnreadViewer, hasUnreadMentionForViewer, sameText } from "../dashboard-view-builders";
import type { ContainerRecord, DashboardCurrentUser, InboxItem } from "../data-types";
import { listQueuedTasksSync } from "@dofe-agent/db";
import type { TaskMessageRecord } from "@dofe-agent/db";
import type { ActiveEmployee, DofeAgentState, WorkspaceMessage } from "@dofe-agent/domain/workspace";
import { buildLegacyAgentIdForEmployeeName, resolveChannelHumanMemberNames } from "@dofe-agent/services";
import { formatAbsoluteDateTime, formatNativeQueueStatus, formatPriority, formatTaskStatus, toneForTask } from "./agent-record.ts";
import { buildRouterExecutionView, buildTaskExecutionTimeline, canSeeWorkspaceDiagnostics, limitLoadtestDashboardPayload, redactInboxExecutionForMember } from "./agents.ts";
import { INBOX_TASK_ITEM_LIMIT } from "./cached.ts";
import { buildMessagesByChannelName, buildReadableChannelLookup } from "./inbox.ts";
import type { ReadableChannelLookup } from "./inbox.ts";

export function buildTaskInboxItems(
  state: DofeAgentState,
  bindings: Map<string, { runtimeId: string }>,
  runtimeIndex: Map<string, ContainerRecord>,
  queuedTasks: ReturnType<typeof listQueuedTasksSync>,
  workspaceId: string,
  currentUser?: DashboardCurrentUser,
  readableChannels: ReadableChannelLookup = buildReadableChannelLookup(state, workspaceId, currentUser),
  messagesByChannelName: Map<string, WorkspaceMessage[]> = buildMessagesByChannelName(state.messages ?? []),
  runtimeTracesByTaskId: Map<string, TaskMessageRecord[]> = new Map(),
): InboxItem[] {
  const queueByIssueId = new Map(queuedTasks.map((task) => [task.issueId ?? "", task]));
  const employeeByName = new Map(state.activeEmployees.map((employee) => [employee.name, employee]));
  const canSeeAllAgents = canSeeWorkspaceDiagnostics(currentUser);
  const tasks = state.tasks.filter((task) => {
    if (!currentUser?.id) {
      return true;
    }
    if (!readableChannels.canRead(task.channel)) {
      return false;
    }
    if (canSeeAllAgents) {
      return true;
    }
    const employee = employeeByName.get(task.assignee);
    return Boolean(
      employee &&
      (
        employee.ownerUserId === currentUser.id ||
        (
          (employee.channelMemberAccess ?? "enabled") === "enabled" &&
          employee.channels.some((channelName) => sameText(channelName, task.channel))
        )
      ),
    );
  });

  return limitLoadtestDashboardPayload(tasks, INBOX_TASK_ITEM_LIMIT).map((task) => {
    const relatedMessages = (messagesByChannelName.get(task.channel) ?? [])
      .slice(0, 6)
      .reverse()
      .map((message, index) => ({
        id: `task-message-${task.id}-${index}`,
        role: message.role,
        actor: message.speaker,
        timestamp: formatAbsoluteDateTime(message.time),
        body: message.summary,
        attachments: message.attachments,
      }));
    const queued = queueByIssueId.get(task.id);
    const boundRuntimeId = bindings.get(task.assignee)?.runtimeId;
    const runtime = queued?.runtimeId ? runtimeIndex.get(queued.runtimeId) : boundRuntimeId ? runtimeIndex.get(boundRuntimeId) : undefined;
    const workDirAccess: "local" | "remote" | undefined =
      runtime?.daemonMode === "remote" ? "remote" : runtime?.daemonMode === "local" ? "local" : undefined;
    const workDirHostLabel = runtime?.deviceName;
    const runtimeTrace = queued ? runtimeTracesByTaskId.get(queued.id) ?? [] : [];
    const executionMessageCount = runtimeTrace.length;
    const timeline = queued ? buildTaskExecutionTimeline(queued.id, workspaceId) : [];
    const router = buildRouterExecutionView(queued);
    const history = relatedMessages.slice(-12);
    const queuedStatus = queued ? formatNativeQueueStatus(queued.status) : undefined;

    return {
      id: `task:${task.id}`,
      kind: "task",
      title: task.title,
      subtitle: `${task.assignee} · ${formatTaskStatus(task.status)}`,
      meta: `${task.channel} · ${formatPriority(task.priority)}${queuedStatus ? ` · ${queuedStatus}` : ""}`,
      timestamp: formatTaskStatus(task.status),
      unread: task.status !== "done",
      statusLabel: formatTaskStatus(task.status),
      statusTone: toneForTask(task.status),
      body: `任务已分派给 ${task.assignee}，当前群组为 ${task.channel}，优先级 ${formatPriority(task.priority)}。`,
      history,
      task,
      channelName: task.channel,
      execution: queued
        ? redactInboxExecutionForMember({
            queueId: queued.id,
            queueStatus: formatNativeQueueStatus(queued.status),
            runtimeId: queued.runtimeId,
            runtimeName: runtime?.name,
            provider: runtime?.provider,
            daemonMode: runtime?.daemonMode,
            serverUrl: runtime?.serverUrl,
            sessionId: queued.sessionId,
            router,
            workDir: queued.workDir,
            workDirAccess,
            workDirHostLabel,
            errorText: queued.errorText,
            messageCount: executionMessageCount,
            runtimeTrace,
            currentEvent: timeline.at(-1),
            timeline,
          }, currentUser)
        : boundRuntimeId
          ? redactInboxExecutionForMember({
              queueId: "",
              queueStatus: "not_queued",
              runtimeId: boundRuntimeId,
              runtimeName: runtime?.name,
              provider: runtime?.provider,
              messageCount: 0,
              runtimeTrace: [],
              timeline: [],
            }, currentUser)
          : undefined,
    };
  });
}
export function buildChannelInboxItems(
  state: DofeAgentState,
  runtimeIndex: Map<string, ContainerRecord>,
  queuedTasks: ReturnType<typeof listQueuedTasksSync>,
  workspaceId: string,
  currentUser?: DashboardCurrentUser,
  readableChannels: ReadableChannelLookup = buildReadableChannelLookup(state, workspaceId, currentUser),
  messagesByChannelName: Map<string, WorkspaceMessage[]> = buildMessagesByChannelName(state.messages ?? []),
  runtimeTracesByTaskId: Map<string, TaskMessageRecord[]> = new Map(),
): InboxItem[] {
  const items: InboxItem[] = [];
  const queuedTaskIndex = new Map(queuedTasks.map((queuedTask) => [queuedTask.id, queuedTask]));
  const employeeByName = new Map(state.activeEmployees.map((employee) => [employee.name, employee]));
  const canSeeAllAgents = canSeeWorkspaceDiagnostics(currentUser);
  const mentionUnreadViewer = buildMentionUnreadViewer(state, currentUser?.displayName, currentUser?.id);

  for (const channel of state.channels) {
    if (currentUser?.id && !readableChannels.canRead(channel.name)) {
      continue;
    }
    const channelMessages = messagesByChannelName.get(channel.name) ?? [];
    if (channelMessages.length === 0) {
      continue;
    }

    const latestMessage = channelMessages[0];
    const channelView = buildChannelListItem(channel, state);
    const isDirect = channelView.kind === "direct";
    const workspaceExecutions = (state.conversationExecutionWorkspaces ?? [])
      .filter((workspace) => canSeeAllAgents || employeeByName.get(workspace.agentId)?.ownerUserId === currentUser?.id)
      .filter((workspace) => workspace.channelName === channel.name)
      .sort((left, right) => new Date(right.updatedAt).getTime() - new Date(left.updatedAt).getTime());
    const latestExecutionWorkspace = workspaceExecutions[0];
    const queuedTask = latestExecutionWorkspace?.lastTaskQueueId
      ? queuedTaskIndex.get(latestExecutionWorkspace.lastTaskQueueId)
      : undefined;
    const runtime = queuedTask?.runtimeId ? runtimeIndex.get(queuedTask.runtimeId) : undefined;
    const runtimeTrace = queuedTask ? runtimeTracesByTaskId.get(queuedTask.id) ?? [] : [];
    const executionMessageCount = runtimeTrace.length;
    const timeline = queuedTask ? buildTaskExecutionTimeline(queuedTask.id, workspaceId) : [];
    const router = buildRouterExecutionView(queuedTask);

    items.push({
      id: `channel:${channel.name}`,
      kind: "channel",
      title: isDirect ? channelView.displayName ?? channel.name : `#${channel.name}`,
      subtitle: latestMessage.speaker,
      meta: isDirect ? channelView.displaySubtitle ?? "Direct" : `${resolveChannelHumanMemberNames(state, channel).length} humans / ${channel.employeeNames.length} agents`,
      channelKind: channelView.kind,
      timestamp: formatAbsoluteDateTime(latestMessage.time),
      unread: hasUnreadMentionForViewer(channelMessages, mentionUnreadViewer),
      statusLabel: latestMessage.role === "agent" ? "AI员工" : "Human",
      statusTone: latestMessage.role === "agent" ? "positive" : "neutral",
      body: latestMessage.summary,
      attachments: latestMessage.attachments,
      history: channelMessages.slice(0, 8).reverse().map((message, index) => ({
        id: `channel-entry-${channel.name}-${index}`,
        role: message.role,
        actor: message.speaker,
        timestamp: formatAbsoluteDateTime(message.time),
        body: message.summary,
        attachments: message.attachments,
      })),
      channelName: channel.name,
      execution: latestExecutionWorkspace
        ? redactInboxExecutionForMember({
            queueId: latestExecutionWorkspace.lastTaskQueueId ?? latestExecutionWorkspace.conversationKey,
            queueStatus: queuedTask ? formatNativeQueueStatus(queuedTask.status) : "not_queued",
            runtimeId: queuedTask?.runtimeId ?? "",
            runtimeName: runtime?.name,
            provider: runtime?.provider,
            daemonMode: runtime?.daemonMode,
            serverUrl: runtime?.serverUrl,
            sessionId: latestExecutionWorkspace.sessionId,
            router,
            workDir: latestExecutionWorkspace.workDir,
            workDirAccess:
              runtime?.daemonMode === "remote" ? "remote" : runtime?.daemonMode === "local" ? "local" : undefined,
            workDirHostLabel: runtime?.deviceName,
            errorText: latestExecutionWorkspace.lastError ?? queuedTask?.errorText,
            messageCount: executionMessageCount,
            runtimeTrace,
            currentEvent: timeline.at(-1),
            timeline,
          }, currentUser)
        : undefined,
    });
  }

  return items;
}
export function buildActivityInboxItems(
  state: DofeAgentState,
  workspaceId: string,
  currentUser?: DashboardCurrentUser,
  readableChannels: ReadableChannelLookup = buildReadableChannelLookup(state, workspaceId, currentUser),
): InboxItem[] {
  return state.ledger
    .filter((entry) => {
      const channelName = entry.data?.channel_name;
      if (!channelName || !currentUser?.id) {
        return true;
      }
      return readableChannels.canRead(channelName);
    })
    .slice(0, 8)
    .map((entry, index) => ({
    id: `activity:${index}`,
    kind: "activity",
    title: entry.title,
    subtitle: "Workspace log",
    meta: state.organizationName,
    timestamp: `更新 ${index + 1}`,
    unread: false,
    statusLabel: "System",
    statusTone: "neutral",
    body: entry.note,
    activity: entry,
    history: [
      {
        id: `activity-entry-${index}`,
        role: "system",
        actor: "agent.dofe",
        timestamp: `记录 ${index + 1}`,
        body: entry.note,
      },
    ],
  }));
}

/**
 * Agent-skill rows created after the employee-id migration use the stable
 * workspace employee id. Older rows retain the legacy name-derived id.
 */
export function resolveAssignedSkillIdsForEmployee(
  skillIdsByAgentId: Map<string, string[]>,
  employee: ActiveEmployee,
): string[] {
  return skillIdsByAgentId.get(employee.id)
    ?? skillIdsByAgentId.get(buildLegacyAgentIdForEmployeeName(employee.name))
    ?? [];
}

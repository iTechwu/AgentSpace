// dashboard 频道页数据装配（从 features/dashboard/data.ts 拆出，3.4/3.6 巨型文件项）。

import { TASK_QUEUE_DELAY_THRESHOLD_MS, buildChannelListItem, buildChannelWorkspaceArtifacts, buildFeishuChannelSummaryByChannelName, buildMentionUnreadViewer, hasUnreadMentionForViewer, isDirectChannelRecord, isWorkspaceManagerRole, listWorkspaceMemberUsersCached, normalizeChannelScope, resolveDirectChannelForContact, sameText } from "../dashboard-view-builders";
import type { ChannelDetailPageData, ChannelListItem, ChannelThreadData, ChannelsPageData } from "../data-types";
import { DEFAULT_WORKSPACE_ID, isRuntimeAtCapacitySync, listTaskMessagesForTasksSync } from "@dofe-agent/db";
import type { TaskMessageRecord, WorkspaceMemberUserRecord, WorkspaceRole } from "@dofe-agent/db";
import type { ActiveEmployee, ChannelRecord, DofeAgentState, WorkspaceMessage, WorkspaceSkill } from "@dofe-agent/domain/workspace";
import { getChannelAccessSummaryForActorSync, resolveChannelHumanMemberNames } from "@dofe-agent/services/channels";
import { listEmployeeSkillIdsByAgentIdMapSync } from "@dofe-agent/services/employees";
import { listEmployeeRuntimeBindingsCached, listQueuedTasksCached, listWorkspaceSkillsCached, readWorkspaceStateCached } from "./cached.ts";
import { resolveAssignedSkillIdsForEmployee } from "./inbox-items.ts";

export function getChannelsPageData(
  currentUserDisplayName?: string,
  workspaceId = DEFAULT_WORKSPACE_ID,
  currentUserId?: string,
  currentMembershipRole?: WorkspaceRole,
  options?: { channelNames?: string[]; detailChannelNames?: string[] },
): ChannelsPageData {
  const state = readWorkspaceStateCached(workspaceId);
  const queuedTasks = listQueuedTasksCached(workspaceId);
  const cancelledTaskIds = new Set(
    queuedTasks.filter((task) => task.status === "cancelled").map((task) => task.id),
  );
  const workspaceSkills = listWorkspaceSkillsCached(workspaceId);
  const workspaceSkillById = new Map(workspaceSkills.map((skill) => [skill.id, skill]));
  const skillIdsByAgentId = listEmployeeSkillIdsByAgentIdMapSync(workspaceId);
  const runtimeBindingByEmployeeName = new Map(
    listEmployeeRuntimeBindingsCached(workspaceId).map((binding) => [binding.employeeName, binding]),
  );
  const channelScope = normalizeChannelScope(options?.channelNames);
  const channelScoped = channelScope !== null;
  const workspaceMembers = channelScoped ? [] : listWorkspaceMemberUsersCached(workspaceId);
  const messagesByChannelName = new Map<string, WorkspaceMessage[]>();
  const firstMessageIndexByChannelName = new Map<string, number>();
  for (const [index, message] of (state.messages ?? []).entries()) {
    const channelName = message.channel;
    if (!channelName) {
      continue;
    }
    // A cancellation can race with the daemon's final progress event. Keep a
    // durable completed/error stop message, but never project a cancelled
    // task's pending reply or process bubble back into the conversation.
    const sourceTaskQueueId = message.data?.source_task_queue_id;
    if (
      message.status === "pending"
      && sourceTaskQueueId
      && cancelledTaskIds.has(sourceTaskQueueId)
    ) {
      continue;
    }
    if (
      message.code === "approval.created"
      && message.data?.source_id
      && cancelledTaskIds.has(message.data.source_id)
    ) {
      continue;
    }
    const messages = messagesByChannelName.get(channelName) ?? [];
    messages.push(message);
    messagesByChannelName.set(channelName, messages);
    if (!firstMessageIndexByChannelName.has(channelName)) {
      firstMessageIndexByChannelName.set(channelName, index);
    }
  }
  const groupChannels = (state.channels ?? []).filter((channel) => (
    !isDirectChannelRecord(channel)
    && (!channelScope || channelScope.has(channel.name))
  ));
  const isWorkspaceManager = !currentUserId || isWorkspaceManagerRole(currentMembershipRole);
  const groupChannelAccess = new Map(
    groupChannels.map((channel) => {
      const summary = isWorkspaceManager
        ? { channelName: channel.name, state: "accessible" as const }
        : currentUserId
        ? getChannelAccessSummaryForActorSync({
            workspaceId,
            channelName: channel.name,
            actor: {
              userId: currentUserId,
              displayName: currentUserDisplayName,
              role: currentMembershipRole,
            },
          })
        : { channelName: channel.name, state: "accessible" as const };
      return [channel.name, summary];
    }),
  );
  const canSeeAllAgents = isWorkspaceManager;
  const canManageChannels = isWorkspaceManager;
  const feishuChannelSummaryByChannelName = buildFeishuChannelSummaryByChannelName({
    workspaceId,
    canView: isWorkspaceManager,
    viewer: currentUserId && currentMembershipRole
      ? {
        role: currentMembershipRole,
        userId: currentUserId,
      }
      : undefined,
  });
  const mentionUnreadViewer = buildMentionUnreadViewer(state, currentUserDisplayName, currentUserId);
  const visibleEmployees = channelScoped
    ? (state.activeEmployees ?? []).filter((employee) =>
        groupChannels.some((channel) => channel.employeeNames.some((name) => sameText(name, employee.name))),
      )
    : canSeeAllAgents
    ? (state.activeEmployees ?? [])
    : (state.activeEmployees ?? []).filter((employee) => employee.ownerUserId === currentUserId);
  const channelMemberCandidates = channelScoped
    ? []
    : [
        ...workspaceMembers.map((member) => ({
          id: member.userId,
          label: member.displayName,
          kind: "human" as const,
          meta: member.primaryEmail ?? member.role,
          email: member.primaryEmail,
        })),
        ...visibleEmployees.map((employee) => ({
          id: employee.name,
          label: employee.remarkName?.trim() || employee.name,
          kind: "agent" as const,
          meta: employee.name,
        })),
      ].sort((left, right) => left.label.localeCompare(right.label, "zh-CN", { sensitivity: "base" }));
  const directContacts = channelScoped ? [] : visibleEmployees.map((employee) => {
    const directChannel = resolveDirectChannelForContact(
      state,
      currentUserDisplayName,
      employee.name,
      workspaceId,
      currentUserId,
      currentMembershipRole,
    );
    const directChannelView = directChannel ? buildChannelListItem(directChannel, state) : null;
    const directChannelMessages = directChannel
      ? messagesByChannelName.get(directChannel.name) ?? []
      : [];
    const latestMessage = directChannelMessages[0];
    const latestMessageIndex = directChannel ? firstMessageIndexByChannelName.get(directChannel.name) ?? -1 : -1;

    return {
      channel: {
        id: `contact:${employee.name}`,
        name: directChannel?.name ?? employee.name,
        channelName: directChannel?.name,
        contactId: employee.name,
        agentEmployeeId: employee.id,
        kind: "direct" as const,
        displayName: employee.remarkName?.trim() || employee.name,
        displaySubtitle: employee.name,
        avatarLabel: "✦",
        memberLabel: directChannelView?.memberLabel ?? buildSyntheticDirectMemberLabel(state, currentUserDisplayName),
        memberCount: directChannelView?.memberCount ?? buildSyntheticDirectMemberCount(state, currentUserDisplayName),
        canManage: false,
        lastMessage: latestMessage?.summary,
        updatedAt: latestMessage?.time,
        unread: hasUnreadMentionForViewer(directChannelMessages, mentionUnreadViewer),
      } satisfies ChannelListItem,
      latestMessageIndex,
      messages: directChannel
        ? directChannelMessages
            .slice()
            .reverse()
        : [],
    };
  });
  const accessibleGroupChannels = groupChannels.filter((channel) => groupChannelAccess.get(channel.name)?.state === "accessible");
  const visibleChannels = [
    ...accessibleGroupChannels,
    ...directContacts.map(({ channel }) => channel),
  ];
  const visibleChannelNames = new Set(visibleChannels.map((channel) => channel.name));
  const detailChannelScope = normalizeChannelScope(options?.detailChannelNames);
  const detailChannelNames = detailChannelScope
    ? new Set([...visibleChannelNames].filter((channelName) => detailChannelScope.has(channelName)))
    : visibleChannelNames;
  const workspaceArtifacts = buildChannelWorkspaceArtifacts(
    state,
    queuedTasks,
    currentUserDisplayName,
    detailChannelNames,
    workspaceId,
    currentUserId,
    currentMembershipRole,
  );

  const threads = [
    ...accessibleGroupChannels.map((channel) => ({
      channelName: channel.name,
      messages: detailChannelNames.has(channel.name)
        ? (messagesByChannelName.get(channel.name) ?? [])
            .slice()
            .reverse()
        : [],
    })),
    ...directContacts.map(({ channel, messages }) => ({
      channelName: channel.channelName ?? channel.id,
      messages: channel.channelName && detailChannelNames.has(channel.channelName) ? messages : [],
    })),
  ];

  const queuedTaskById = new Map(queuedTasks.map((task) => [task.id, task]));
  // 容量投影：对 queued 任务，若其 runtime 已达容量上限，状态投影为 capacity_wait（docs §3.2/§5）。
  const capacityWaitRuntimeIds = new Set<string>();
  for (const task of queuedTasks) {
    if (task.status === "queued" && !capacityWaitRuntimeIds.has(task.runtimeId) && isRuntimeAtCapacitySync(task.runtimeId)) {
      capacityWaitRuntimeIds.add(task.runtimeId);
    }
  }
  const threadsWithQueueState: ChannelThreadData[] = threads.map((thread) => ({
    ...thread,
    messages: thread.messages.map((message) => {
      const taskId = message.data?.source_task_queue_id;
      const task = taskId ? queuedTaskById.get(taskId) : undefined;
      if (!task || message.status !== "pending" || !["queued", "claimed", "running"].includes(task.status)) {
        return message;
      }
      const queuedAt = Date.parse(task.queuedAt);
      const delayed = task.status === "queued"
        && Number.isFinite(queuedAt)
        && Date.now() - queuedAt >= TASK_QUEUE_DELAY_THRESHOLD_MS;
      const projectedStatus = task.status === "queued" && capacityWaitRuntimeIds.has(task.runtimeId)
        ? "capacity_wait"
        : task.status;
      return {
        ...message,
        data: {
          ...(message.data ?? {}),
          task_queue_status: projectedStatus,
          task_queued_at: task.queuedAt,
          task_queue_delayed: delayed ? "true" : "false",
        },
      };
    }),
  }));

  // Attach the complete structured execution stream (task_message rows) for every
  // task referenced by a loaded thread. The detail scope already limits this to
  // the channels being rendered, so an arbitrary task-count cap would silently
  // hide older runtime traces from the message inbox.
  const threadExecutionTaskIds = threadsWithQueueState.map((thread) => {
    const taskIds = new Set<string>();
    for (const message of thread.messages) {
      const taskId = message.data?.source_task_queue_id;
      if (taskId) {
        taskIds.add(taskId);
      }
    }
    return [...taskIds];
  });
  const taskMessagesByTaskId = listTaskMessagesForTasksSync([...new Set(threadExecutionTaskIds.flat())]);
  const threadsWithExecutions: ChannelThreadData[] = threadsWithQueueState.map((thread, index) => {
    const taskExecutions: Record<string, TaskMessageRecord[]> = {};
    for (const taskId of threadExecutionTaskIds[index]) {
      const taskMessages = taskMessagesByTaskId.get(taskId);
      if (taskMessages && taskMessages.length > 0) {
        taskExecutions[taskId] = taskMessages;
      }
    }
    return Object.keys(taskExecutions).length > 0 ? { ...thread, taskExecutions } : thread;
  });

  const channels = [
    ...groupChannels.map((channel) => {
      const access = groupChannelAccess.get(channel.name);
      const channelMessages = messagesByChannelName.get(channel.name) ?? [];
      const latestMessage = channelMessages[0];
      const latestMessageIndex = firstMessageIndexByChannelName.get(channel.name) ?? -1;
      return {
        channel: {
          ...buildChannelListItem(channel, state),
          canManage: canManageChannels,
          accessState: access?.state ?? "accessible",
          accessRequestId: access?.requestId,
          feishu: feishuChannelSummaryByChannelName.get(channel.name),
          lastMessage: access?.state === "accessible" ? latestMessage?.summary : undefined,
          updatedAt: access?.state === "accessible" ? latestMessage?.time : undefined,
          unread: access?.state === "accessible" ? hasUnreadMentionForViewer(channelMessages, mentionUnreadViewer) : false,
        } satisfies ChannelListItem,
        latestMessageIndex: access?.state === "accessible" ? latestMessageIndex : -1,
      };
    }),
    ...directContacts.map(({ channel, latestMessageIndex }) => ({
      channel,
      latestMessageIndex,
    })),
  ]
    .sort((left, right) => {
      const leftHasMessages = left.latestMessageIndex >= 0;
      const rightHasMessages = right.latestMessageIndex >= 0;
      if (leftHasMessages && rightHasMessages) {
        return left.latestMessageIndex - right.latestMessageIndex;
      }
      if (leftHasMessages) {
        return -1;
      }
      if (rightHasMessages) {
        return 1;
      }
      return (left.channel.displayName ?? left.channel.name).localeCompare(
        right.channel.displayName ?? right.channel.name,
        "zh-CN",
        { sensitivity: "base" },
      );
    })
    .map(({ channel }) => channel);
  const mentionableEmployees =
    channelScoped || canSeeAllAgents
      ? visibleEmployees
      : buildMemberMentionableEmployees(state, visibleEmployees, accessibleGroupChannels);

  return {
    workspaceId,
    channels,
    threads: threadsWithExecutions,
    documents: workspaceArtifacts.documents,
    documentRuns: workspaceArtifacts.documentRuns,
    documentConflicts: workspaceArtifacts.documentConflicts,
    channelFiles: workspaceArtifacts.channelFiles,
    mentionCandidates: [
      ...mentionableEmployees.map((employee) => ({
        id: employee.name,
        label: employee.remarkName?.trim() || employee.name,
        subtitle: employee.name,
        channels: [...employee.channels],
        kind: "agent" as const,
      })),
      ...buildHumanMentionCandidates(state, accessibleGroupChannels, workspaceMembers),
    ]
      .sort((left, right) => left.label.localeCompare(right.label, "zh-CN", { sensitivity: "base" })),
    channelMemberCandidates,
    composerAgents: visibleEmployees.map((employee) => ({
      id: employee.name,
      label: employee.remarkName?.trim() || employee.name,
      provider: runtimeBindingByEmployeeName.get(employee.name)?.provider,
      executionPolicy: employee.executionPolicy,
      skills: resolveAssignedSkillIdsForEmployee(skillIdsByAgentId, employee)
        .map((skillId) => workspaceSkillById.get(skillId))
        .filter((skill): skill is WorkspaceSkill => Boolean(skill))
        .map((skill) => ({ id: skill.id, name: skill.name, description: skill.description })),
    })),
    composerSkills: workspaceSkills.map((skill) => ({
      id: skill.id,
      name: skill.name,
      description: skill.description,
    })),
    totalChannels: channels.length,
    detailScope: detailChannelScope ? [...detailChannelNames] : undefined,
  };
}
export function getChannelListPageData(
  currentUserDisplayName?: string,
  workspaceId = DEFAULT_WORKSPACE_ID,
  currentUserId?: string,
  currentMembershipRole?: WorkspaceRole,
  options?: { channelNames?: string[]; initialDetailChannelNames?: string[] },
): ChannelsPageData {
  return getChannelsPageData(
    currentUserDisplayName,
    workspaceId,
    currentUserId,
    currentMembershipRole,
    {
      channelNames: options?.channelNames,
      detailChannelNames: options?.initialDetailChannelNames ?? [],
    },
  );
}
export function getChannelDetailData(
  input: {
    channelName: string;
    currentUserDisplayName?: string;
    workspaceId?: string;
    currentUserId?: string;
    currentMembershipRole?: WorkspaceRole;
  },
): ChannelDetailPageData {
  const channelName = input.channelName.trim();
  const data = getChannelsPageData(
    input.currentUserDisplayName,
    input.workspaceId ?? DEFAULT_WORKSPACE_ID,
    input.currentUserId,
    input.currentMembershipRole,
    { detailChannelNames: [channelName] },
  );

  return {
    threads: data.threads.filter(
      (thread) =>
        thread.channelName === channelName ||
        thread.messages.some((message) => message.channel === channelName),
    ),
    documents: data.documents,
    documentRuns: data.documentRuns,
    documentConflicts: data.documentConflicts,
    channelFiles: data.channelFiles,
    detailScope: data.detailScope,
  };
}
export function buildMemberMentionableEmployees(
  state: DofeAgentState,
  ownedEmployees: ActiveEmployee[],
  accessibleGroupChannels: ChannelRecord[],
): ActiveEmployee[] {
  const accessibleChannelAgentNames = new Set(
    accessibleGroupChannels.flatMap((channel) => channel.employeeNames),
  );
  const rows = new Map<string, ActiveEmployee>();
  for (const employee of ownedEmployees) {
    rows.set(employee.name, employee);
  }
  for (const employee of state.activeEmployees ?? []) {
    if (
      (employee.channelMemberAccess ?? "enabled") !== "enabled" ||
      !accessibleChannelAgentNames.has(employee.name)
    ) {
      continue;
    }
    rows.set(employee.name, employee);
  }
  return Array.from(rows.values());
}
export function buildHumanMentionCandidates(
  state: DofeAgentState,
  channels: ChannelRecord[],
  workspaceMembers: WorkspaceMemberUserRecord[],
): ChannelsPageData["mentionCandidates"] {
  const rows = new Map<string, {
    id: string;
    label: string;
    subtitle: string;
    channels: Set<string>;
    kind: "human";
  }>();

  for (const channel of channels) {
    for (const memberName of resolveChannelHumanMemberNames(state, channel)) {
      const label = memberName.trim();
      if (!label) {
        continue;
      }
      const key = label.toLocaleLowerCase("zh-CN");
      const workspaceMember = workspaceMembers.find((member) => sameText(member.displayName, label));
      const legacyMember = state.humanMembers.find((member) => sameText(member.name, label));
      const existing = rows.get(key);
      if (existing) {
        existing.channels.add(channel.name);
        continue;
      }
      rows.set(key, {
        id: workspaceMember ? `human:${workspaceMember.userId}` : `human:${label}`,
        label,
        subtitle: workspaceMember?.primaryEmail ?? legacyMember?.role ?? "Member",
        channels: new Set([channel.name]),
        kind: "human",
      });
    }
  }

  return Array.from(rows.values()).map((row) => ({
    id: row.id,
    label: row.label,
    subtitle: row.subtitle,
    channels: Array.from(row.channels),
    kind: row.kind,
  }));
}
export function buildSyntheticDirectHumanMemberCount(
  state: DofeAgentState,
  currentUserDisplayName: string | undefined,
): number {
  if (currentUserDisplayName?.trim()) {
    return 1;
  }
  return state.humanMembers.length > 0 ? 1 : 0;
}
export function buildSyntheticDirectMemberCount(
  state: DofeAgentState,
  currentUserDisplayName: string | undefined,
): number {
  return buildSyntheticDirectHumanMemberCount(state, currentUserDisplayName) + 1;
}
export function buildSyntheticDirectMemberLabel(
  state: DofeAgentState,
  currentUserDisplayName: string | undefined,
): string {
  return `${buildSyntheticDirectHumanMemberCount(state, currentUserDisplayName)} humans / 1 agents`;
}

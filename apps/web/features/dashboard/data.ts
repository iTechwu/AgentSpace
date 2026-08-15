// Workspace dashboard 各页面/模块的 server 侧数据装配入口（对外稳定导入点）。
// 类型定义见 ./data-types.ts，共享视图构建 helper 见 ./dashboard-view-builders.ts，
// 两者均为本模块的单向下游；本文件保留各域 loader 与私有 helper。
import {
  basename,
} from "node:path";
import {
  cache,
} from "react";
import {
  buildLegacyAgentIdForEmployeeName,
  canReadChannelForActorSync,
  getChannelAccessSummaryForActorSync,
  getCostDashboardDataAsync,
  getCostDashboardDataSync,
  getPerformanceDashboardData,
  inferAttachmentKind,
  isSystemSkillName,
  listAgentAccessRequestsForActorSync,
  listAgentForkInvitationsForActorSync,
  listAgentForkInvitationsForSourceAgentSync,
  listBudgetsWithSpentSync,
  listDocumentAgentAccessSync,
  listDocumentPermissionRequestsSync,
  listEmployeeSkillIdsByAgentIdMapSync,
  listTaskExecutionEventsAsync,
  listKnowledgeAssignmentPoliciesSync,
  listKnowledgeAssignmentsSync,
  listManagedRuntimesForWorkspaceSync,
  listNotificationsForRecipientSync,
  listNotificationsForRecipientAsync,
  listWorkspaceSkillsSync,
  normalizeCliHubReadiness,
  normalizeRuntimeProviderHealth,
  projectLegacySchedulesForCutover,
  readAgentSkillRequirementSummarySync,
  readWorkflowCutoverModeSync,
  readWorkspaceAttachmentBytesSync,
  readWorkspaceStateSnapshotSync,
  reapStuckParseTasksSync,
  resolveAgentRuntimeMode,
  resolveAttachmentMediaType,
  resolveChannelHumanMemberNames,
} from "@dofe-agent/services";
import type {
  AgentAccessRequestRecord,
  AgentForkInvitationRecord,
  AgentSkillRequirementSummary,
  CostDashboardData,
  FeishuChatMemberSnapshot,
  PerformanceDashboardData,
  WorkspaceNotificationRecord,
} from "@dofe-agent/services";
import {
  DEFAULT_WORKSPACE_ID,
  countUsersSync,
  listAgentRouterProviderSessionsSync,
  listAgentTaskAttemptsSync,
  listCapabilityRequestsSync,
  listDaemonApiTokensSync,
  listDaemonSnapshotsSync,
  listEmployeeRuntimeBindingsSync,
  listMcpCatalogItemsSync,
  listMcpConnectionsSync,
  listProviderAccountsSync,
  listQueuedTasksSync,
  listRuntimeAppOperationsSync,
  listRuntimeGrantsSync,
  listRuntimeInstalledAppsSync,
  listRuntimeProvisionRequestsSync,
  listStoredSkillImportEventsSync,
  listTaskExecutionEventsSync,
  listTaskMessagesForTaskSync,
  listTaskMessagesForTasksSync,
  listWorkflowDefinitionsSync,
  listWorkspaceMemberUsersSync,
  listWorkspaceRuntimeDisplayNamesSync,
  readAgentRouterSessionSync,
  readWorkflowTriggerForWorkflowSync,
} from "@dofe-agent/db";
import type {
  BudgetAction,
  BudgetPeriod,
  BudgetScope,
  TaskExecutionEventRecord,
  TaskExecutionEventType,
  TaskMessageRecord,
  WorkspaceMemberUserRecord,
  WorkspaceRole,
} from "@dofe-agent/db";
import type {
  ActiveEmployee,
  AutomationRule,
  ChannelDocument,
  ChannelDocumentVersion,
  ChannelRecord,
  DataTable,
  DofeAgentState,
  KnowledgeAssignmentMode,
  KnowledgePage,
  LedgerItem,
  MessageAttachment,
  ScheduledTask,
  TaskRecord,
  TaskStatus,
  Template,
  WorkspaceMessage,
  WorkspaceSkill,
} from "@dofe-agent/domain/workspace";
import {
  formatDaemonProviderLabel,
  isDaemonProvider,
} from "@dofe-agent/domain";
import type {
  ChannelDocumentAccessRole,
  ChannelDocumentBlock,
  ChannelDocumentChangeSet,
  ChannelDocumentConflict,
  ChannelDocumentPresence,
  ChannelDocumentRun,
  ChannelDocumentRunStep,
  RuntimeProviderHealth,
} from "@dofe-agent/domain";
import {
  formatCompactTimestamp,
} from "@/shared/lib/time-format";
import {
  buildFeishuAgentBotSetupReference,
  listFeishuIntegrationSettingsItems,
} from "@/features/integrations/feishu/feishu-settings-data";
import type {
  FeishuAgentBotSetupReference,
  FeishuIntegrationSettingsItem,
} from "@/features/integrations/feishu/feishu-types";
import {
  listRunnableWorkflowsSync,
} from "@/features/workflows/workflow-data";
import type {
  RunnableWorkflowSummary,
} from "@/features/workflows/workflow-data";

export {
  getApprovalsPageData,
  getPendingApprovalCount,
  type ApprovalItem,
  type ApprovalItemKind,
  type ApprovalItemStatus,
  type ApprovalQueueActor,
  type ApprovalsPageData,
} from "@/features/approvals/approval-queue-data";

import {
  CHANNEL_DOCUMENT_SYNC_EVENT_TTL_MS,
  TASK_QUEUE_DELAY_THRESHOLD_MS,
  buildChannelListItem,
  buildChannelWorkspaceArtifacts,
  buildFeishuChannelSummaryByChannelName,
  buildKnowledgeDocumentPageRecords,
  buildMentionUnreadViewer,
  buildSuggestedConflictDraftBlocks,
  formatWorkspaceRoleLabel,
  getVisibleWorkspaceChannelNames,
  hasUnreadMentionForViewer,
  isDirectChannelRecord,
  isRetryableChangeSetOperations,
  isWorkspaceManagerRole,
  listWorkspaceMemberUsersCached,
  normalizeChannelScope,
  parseChannelDocumentChangeSetOperations,
  resolveDirectChannelForContact,
  safeReadTaskTitle,
  sameText,
  serializeConflictDraftBlocks,
  summarizeChangeSetOperations,
} from "./dashboard-view-builders";
import type {
  AgentKnowledgePageRecord,
  AgentWorkAreaRecord,
  AgentsPageData,
  ChannelDetailPageData,
  ChannelDocumentChangeSetRecord,
  ChannelDocumentConflictRecord,
  ChannelDocumentRunRecord,
  ChannelDocumentSyncEventRecord,
  ChannelListItem,
  ChannelThreadData,
  ChannelsPageData,
  ContainerRecord,
  DaemonSnapshotView,
  DaemonTokenView,
  DashboardCurrentUser,
  DigitalEmployeeShowcaseAgentRecord,
  InboxItem,
  InboxPageData,
  KnowledgeAgentOption,
  KnowledgeAssignedAgentRecord,
  KnowledgeAssignmentStats,
  KnowledgeDocumentPageRecord,
  KnowledgePageRecord,
  ManagementRecordBase,
  ProviderAccountView,
  RouterExecutionView,
  RuntimeGrantMember,
  RuntimeMcpConnectionView,
  RuntimeProvisionRequestView,
  SkillsPageData,
  TaskExecutionTimelineAction,
  TaskExecutionTimelineCategory,
  TaskExecutionTimelineEntry,
  WorkspaceAgentAccessRequestView,
  WorkspaceAgentDocumentAccessRecord,
  WorkspaceAgentDocumentAccessSummaryRecord,
  WorkspaceAgentForkInvitationView,
  WorkspaceAgentKnowledgeRecord,
  WorkspaceAgentRecord,
  WorkspaceAgentStatus,
} from "./data-types";
export * from "./data-types";

const readWorkspaceStateCached = cache((workspaceId: string) => readWorkspaceStateSnapshotSync(workspaceId));
const listWorkspaceSkillsCached = cache((workspaceId: string) => listWorkspaceSkillsSync(workspaceId));
const listKnowledgeAssignmentPoliciesCached = cache((workspaceId: string) => listKnowledgeAssignmentPoliciesSync(workspaceId));
const listKnowledgeAssignmentsCached = cache((workspaceId: string) => listKnowledgeAssignmentsSync(workspaceId));
const listDaemonSnapshotsCached = cache((workspaceId: string) => listDaemonSnapshotsSync(workspaceId));
const listEmployeeRuntimeBindingsCached = cache((workspaceId: string) => listEmployeeRuntimeBindingsSync(workspaceId));
const listQueuedTasksCached = cache((workspaceId: string) => listQueuedTasksSync({ workspaceId }));
const readAgentRouterSessionCached = cache((routerSessionId: string) => readAgentRouterSessionSync(routerSessionId));
const listAgentTaskAttemptsCached = cache((workspaceId: string, taskQueueId: string) =>
  listAgentTaskAttemptsSync({ workspaceId, taskQueueId, limit: 20 })
);
const listAgentRouterProviderSessionsCached = cache((workspaceId: string, routerSessionId: string) =>
  listAgentRouterProviderSessionsSync({ workspaceId, routerSessionId })
);
const listRuntimeInstalledAppsCached = cache((workspaceId: string) => listRuntimeInstalledAppsSync({ workspaceId }));
const listRuntimeAppOperationsCached = cache((workspaceId: string, limit: number) => listRuntimeAppOperationsSync({ workspaceId, limit }));
const listMcpConnectionsCached = cache((workspaceId: string) => listMcpConnectionsSync({ workspaceId, limit: 500 }));
const listMcpCatalogItemsCached = cache((workspaceId: string) => listMcpCatalogItemsSync({ workspaceId, limit: 500 }));
const listTaskExecutionEventsCached = cache((workspaceId: string, taskId: string, limit: number) =>
  listTaskExecutionEventsSync({ workspaceId, taskId, limit, order: "asc" })
);
const listRuntimeGrantsCached = cache((workspaceId: string) => listRuntimeGrantsSync(workspaceId));
const listWorkspaceRuntimeDisplayNamesCached = cache((workspaceId: string) =>
  listWorkspaceRuntimeDisplayNamesSync(workspaceId)
);
const listDaemonApiTokensCached = cache((workspaceId: string) => listDaemonApiTokensSync(workspaceId));
const listProviderAccountsCached = cache((workspaceId: string) => listProviderAccountsSync(workspaceId));
const listRuntimeProvisionRequestsCached = cache((workspaceId: string) => listRuntimeProvisionRequestsSync(workspaceId));
const listStoredSkillImportEventsCached = cache((workspaceId: string, limit: number) => listStoredSkillImportEventsSync(workspaceId, limit));
const getCostDashboardDataCached = cache((period: BudgetPeriod, workspaceId: string) => getCostDashboardDataSync(period, workspaceId));
const getAuthoritativeCostDashboardDataCached = cache((period: BudgetPeriod, workspaceId: string) => getCostDashboardDataAsync(period, workspaceId));
const listBudgetsWithSpentCached = cache((workspaceId: string) => listBudgetsWithSpentSync(workspaceId));
const getPerformanceDashboardDataCached = cache((workspaceId: string) => getPerformanceDashboardData(workspaceId));
const INBOX_TASK_ITEM_LIMIT = 60;
const TASK_BOARD_TASK_LIMIT = 180;
const AGENT_TASK_PREVIEW_LIMIT = 12;
const AGENT_KNOWLEDGE_PREVIEW_LIMIT = 20;
const AGENT_ASSIGNABLE_KNOWLEDGE_LIMIT = 120;
const KNOWLEDGE_PAGE_PREVIEW_LIMIT = 120;

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
      return {
        ...message,
        data: {
          ...(message.data ?? {}),
          task_queue_status: task.status,
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

function buildMemberMentionableEmployees(
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

function buildHumanMentionCandidates(
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

function buildSyntheticDirectHumanMemberCount(
  state: DofeAgentState,
  currentUserDisplayName: string | undefined,
): number {
  if (currentUserDisplayName?.trim()) {
    return 1;
  }
  return state.humanMembers.length > 0 ? 1 : 0;
}

function buildSyntheticDirectMemberCount(
  state: DofeAgentState,
  currentUserDisplayName: string | undefined,
): number {
  return buildSyntheticDirectHumanMemberCount(state, currentUserDisplayName) + 1;
}

function buildSyntheticDirectMemberLabel(
  state: DofeAgentState,
  currentUserDisplayName: string | undefined,
): string {
  return `${buildSyntheticDirectHumanMemberCount(state, currentUserDisplayName)} humans / 1 agents`;
}

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

async function replaceInboxExecutionTimelinesAsync(
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

function chunkValues<T>(values: T[], size: number): T[][] {
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

interface ReadableChannelLookup {
  canRead(channelName?: string | null): boolean;
}

function buildReadableChannelLookup(
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

function buildMessagesByChannelName(messages: WorkspaceMessage[]): Map<string, WorkspaceMessage[]> {
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

function normalizeChannelLookupKey(value: string): string {
  return value.trim().toLocaleLowerCase("zh-CN");
}

function buildNotificationInboxItems(
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

function buildNotificationInboxItemsFromRecords(
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

interface AgentsPageDataOptions {
  workspaceId?: string;
  currentUserId?: string;
  currentMembershipRole?: WorkspaceRole;
}

export function getAgentsPageData(input: string | AgentsPageDataOptions = DEFAULT_WORKSPACE_ID): AgentsPageData {
  const options = resolveAgentsPageDataOptions(input);
  const workspaceId = options.workspaceId;
  const currentUserId = options.currentUserId;
  const currentMembershipRole = options.currentMembershipRole;
  const canManageAllAgents = !currentUserId || isWorkspaceManagerRole(currentMembershipRole);
  const canManageRuntimes = canManageAllAgents;
  const isRemoteMode = resolveAgentRuntimeMode() === "remote";
  const canConnectRuntimes = canManageRuntimes && !isRemoteMode;
  const state = readWorkspaceStateCached(workspaceId);
  const workspaceSkills = listWorkspaceSkillsCached(workspaceId);
  const workspaceSkillSummaries = shouldUseLoadtestDashboardPayloadLimits()
    ? workspaceSkills.map(summarizeWorkspaceSkillForAgentPage)
    : workspaceSkills;
  const workspaceSkillIndex = new Map(workspaceSkillSummaries.map((skill) => [skill.id, skill]));
  const skillIdsByAgentId = listEmployeeSkillIdsByAgentIdMapSync(workspaceId);
  const knowledgePolicies = listKnowledgeAssignmentPoliciesCached(workspaceId);
  const knowledgeAssignments = listKnowledgeAssignmentsCached(workspaceId);
  const knowledgePolicyIndex = new Map(knowledgePolicies.map((policy) => [policy.knowledgePageId, policy]));
  const runtimeSnapshots = listDaemonSnapshotsCached(workspaceId);
  const bindings = listEmployeeRuntimeBindingsCached(workspaceId);
  const queuedTasks = listQueuedTasksCached(workspaceId);
  const installedApps = listRuntimeInstalledAppsCached(workspaceId);
  const runtimeAppOperations = listRuntimeAppOperationsCached(workspaceId, 200);
  const mcpConnections = listMcpConnectionsCached(workspaceId);
  const mcpCatalogItems = listMcpCatalogItemsCached(workspaceId);
  const runtimeDisplayNames = buildRuntimeDisplayNameIndex(workspaceId);
  const workspaceMembers = listWorkspaceMemberUsersCached(workspaceId).map(mapWorkspaceMemberForRuntimeGrant);
  const memberByUserId = new Map(workspaceMembers.map((member) => [member.userId, member]));
  const employeeDisplayNameByName = new Map(
    state.activeEmployees.map((employee) => [employee.name, employee.remarkName?.trim() || employee.name]),
  );
  const documentAccessByEmployeeName = buildWorkspaceAgentDocumentAccessSummaries(workspaceId, state);
  const feishuAgentBotByAgentId = new Map(
    canManageAllAgents
      ? listFeishuIntegrationSettingsItems({
        workspaceId,
        viewer: currentUserId && currentMembershipRole
          ? {
            role: currentMembershipRole,
            userId: currentUserId,
          }
          : undefined,
      })
        .filter((integration) => integration.agentId)
        .map((integration) => [integration.agentId!, integration])
      : [],
  );
  const feishuAgentBotSetupReference = canManageAllAgents
    ? buildFeishuAgentBotSetupReference()
    : undefined;
  const activeRuntimeGrants = listRuntimeGrantsCached(workspaceId).filter((grant) => grant.status === "active");
  const grantsByRuntimeId = new Map<string, RuntimeGrantMember[]>();
  for (const grant of activeRuntimeGrants) {
    const member = memberByUserId.get(grant.userId);
    if (!member) {
      continue;
    }
    const next = grantsByRuntimeId.get(grant.runtimeId) ?? [];
    next.push(member);
    grantsByRuntimeId.set(grant.runtimeId, next);
  }
  const allContainers = buildNativeRuntimeRecords(
    state,
    runtimeSnapshots,
    bindings,
    queuedTasks,
    runtimeDisplayNames,
    installedApps,
    runtimeAppOperations,
    mcpConnections,
    mcpCatalogItems,
  )
    .map((container) => ({
      ...container,
      grantedMembers: grantsByRuntimeId.get(container.runtimeId) ?? [],
      canManageGrants: canManageRuntimes,
    }))
    .sort(compareContainers);
  const activeContainers = allContainers.filter((container) => container.status === "linked");
  const selectableContainers = isRemoteMode ? [] : activeContainers;
  const visibleContainers = canManageRuntimes ? selectableContainers : [];
  const containerIndex = new Map(allContainers.map((container) => [container.runtimeId, container]));
  const bindingIndex = new Map(bindings.map((binding) => [binding.employeeName, binding]));
  const allWorkspaceAgentRecords = state.activeEmployees
    .map((employee) =>
      buildWorkspaceAgentRecord(
        employee,
        state,
        workspaceId,
        workspaceSkillIndex,
        skillIdsByAgentId,
        bindingIndex.get(employee.name),
        containerIndex,
        queuedTasks,
        buildWorkspaceAgentKnowledgeRecord(employee, state.knowledgePages, knowledgePolicyIndex, knowledgeAssignments),
        documentAccessByEmployeeName.get(employee.name) ?? createEmptyAgentDocumentAccessSummary(),
      ),
    )
    .map((agent) => ({
      ...agent,
      ownerDisplayName: agent.ownerUserId ? memberByUserId.get(agent.ownerUserId)?.displayName : undefined,
      forkedFrom: parseAgentForkOrigin(agent.origin),
      feishuAgentBot: feishuAgentBotByAgentId.get(agent.internalName),
      feishuAgentBotSetupReference,
      canManageFeishuAgentBot: canManageAllAgents,
      canManage: canManageAllAgents,
      canManageChannelMemberAccess: canManageAllAgents,
      // Permission-restricted view (spec §3.3): non-managers see only aggregate
      // readiness status, never variable names, blockers, values, or who last
      // updated. They get "可用 / 需管理员处理", not the key inventory.
      skillRequirements: canManageAllAgents
        ? agent.skillRequirements
        : redactSkillRequirementsForViewer(agent.skillRequirements),
    }))
    .sort(compareAgents);
  const workspaceAgents = allWorkspaceAgentRecords
    .filter(() => canManageAllAgents)
    .map((agent) => {
      const forkInvitations = currentUserId && agent.canManage
        ? listAgentForkInvitationsForSourceAgentSync({
            workspaceId,
            sourceAgentName: agent.internalName,
            actorUserId: currentUserId,
            statuses: ["pending"],
          }).map((invitation) => buildAgentForkInvitationView(invitation, {
            memberByUserId,
            employeeDisplayNameByName,
            currentUserDisplayName: memberByUserId.get(invitation.targetUserId)?.displayName,
          }))
        : [];
      return {
        ...agent,
        forkInvitations,
      };
    })
    .sort(compareAgents);
  const agentsBoundToActiveContainers = workspaceAgents.filter(
    (agent) => agent.boundContainerId && visibleContainers.some((container) => container.runtimeId === agent.boundContainerId),
  );
  const containerOptions: AgentsPageData["containerOptions"] = visibleContainers.map((container) => ({
    id: container.runtimeId,
    label: container.displayName ?? container.name,
    provider: container.provider,
    status: container.status === "linked" ? "online" as const : "offline" as const,
    providerHealth: container.providerHealth,
    serverName: canManageRuntimes ? container.deviceName : container.name,
    daemonKey: canManageRuntimes ? container.daemonKey : "",
    mode: container.daemonMode,
  }));
  const managedRuntimeOptionIds = new Set(containerOptions.map((option) => option.id));
  if (canManageRuntimes && currentUserId && isRemoteMode) {
    for (const managedRuntime of listManagedRuntimesForWorkspaceSync({ workspaceId, actorUserId: currentUserId })) {
      if (managedRuntimeOptionIds.has(managedRuntime.id)) {
        continue;
      }
      containerOptions.push({
        id: managedRuntime.id,
        label: managedRuntime.name,
        provider: managedRuntime.provider,
        status: managedRuntime.status === "online" ? "online" as const : "offline" as const,
        providerHealth: normalizeRuntimeProviderHealth({
          runtimeStatus: managedRuntime.status,
          runtimeMetadata: {},
        }),
        serverName: "Managed",
        daemonKey: "",
        mode: "remote" as const,
        managed: true,
        provisioningState: managedRuntime.provisioningState,
        bindable: managedRuntime.provisioningState === "managed" && managedRuntime.status === "online",
        defaultModel: managedRuntime.defaultModel,
        protocols: managedRuntime.protocols,
        assignedEmployeeCount: managedRuntime.assignedEmployeeCount,
        allowNewEmployeeSharing: managedRuntime.allowNewEmployeeSharing,
      });
      managedRuntimeOptionIds.add(managedRuntime.id);
    }
  }
  const pendingForkInvitations = currentUserId
    ? listAgentForkInvitationsForActorSync({
        workspaceId,
        actorUserId: currentUserId,
        statuses: ["pending"],
      })
        .filter((invitation) => invitation.targetUserId === currentUserId)
        .map((invitation) => buildAgentForkInvitationView(invitation, {
          memberByUserId,
          employeeDisplayNameByName,
          currentUserDisplayName: memberByUserId.get(currentUserId)?.displayName,
        }))
    : [];
  const agentAccessRequests = currentUserId
    ? listAgentAccessRequestsForActorSync({
        workspaceId,
        actorUserId: currentUserId,
        statuses: ["pending", "approved", "rejected", "cancelled"],
      })
    : [];
  const showcaseAgents = buildDigitalEmployeeShowcaseAgents({
    agents: allWorkspaceAgentRecords,
    state,
    memberByUserId,
    currentUserId,
    currentMembershipRole,
    accessRequests: agentAccessRequests,
    pendingForkInvitations,
  });

  return {
    containers: visibleContainers,
    agents: workspaceAgents,
    showcaseAgents,
    daemonSnapshots: canManageRuntimes ? listDaemonSnapshotViews(workspaceId) : [],
    daemonTokens: canManageRuntimes ? listDaemonTokenViews(workspaceId, memberByUserId) : [],
    providerAccounts: canManageRuntimes ? listProviderAccountViews(workspaceId) : [],
    runtimeProvisionRequests: canManageRuntimes ? listRuntimeProvisionRequestViews(workspaceId) : [],
    workspaceSkills: workspaceSkillSummaries,
    channels: state.channels.map((channel) => ({
      name: channel.name,
      memberLabel: `${resolveChannelHumanMemberNames(state, channel).length} 人类 / ${channel.employeeNames.length} agent`,
    })),
    workspaceMembers,
    pendingForkInvitations,
    containerOptions,
    currentUserId,
    currentMembershipRole,
    canConnectRuntimes,
    canManageRuntimes,
    canManageAllAgents,
    canCreateAgent: canManageAllAgents,
    totalAgents: workspaceAgents.length,
    containerCount: visibleContainers.length,
    boundAgentCount: agentsBoundToActiveContainers.length,
    unboundAgentCount: workspaceAgents.length - agentsBoundToActiveContainers.length,
    activeTaskCount: state.tasks.filter((task) => task.status !== "done").length,
    activeWorkAreaCount: workspaceAgents.reduce((sum, agent) => sum + agent.workAreas.length, 0),
  };
}

function resolveAgentsPageDataOptions(input: string | AgentsPageDataOptions): Required<Pick<AgentsPageDataOptions, "workspaceId">> & Omit<AgentsPageDataOptions, "workspaceId"> {
  if (typeof input === "string") {
    return { workspaceId: input };
  }
  return {
    workspaceId: input.workspaceId ?? DEFAULT_WORKSPACE_ID,
    currentUserId: input.currentUserId,
    currentMembershipRole: input.currentMembershipRole,
  };
}

function summarizeWorkspaceSkillForAgentPage(skill: WorkspaceSkill): WorkspaceSkill {
  return {
    ...skill,
    files: skill.files.map((file) => ({
      ...file,
      content: "",
    })),
  };
}

function limitLoadtestDashboardPayload<T>(items: T[], limit: number): T[] {
  return shouldUseLoadtestDashboardPayloadLimits() ? items.slice(0, limit) : items;
}

function shouldUseLoadtestDashboardPayloadLimits(): boolean {
  const configured = process.env.DOFE_AGENT_DASHBOARD_PAYLOAD_LIMITS_ENABLED?.trim().toLowerCase();
  if (configured) {
    return configured !== "0" && configured !== "false";
  }
  return process.env.LOADTEST_MODE === "local";
}

function canSeeWorkspaceDiagnostics(currentUser?: DashboardCurrentUser): boolean {
  return !currentUser?.id || isWorkspaceManagerRole(currentUser.role);
}

function redactInboxExecutionForMember(
  execution: NonNullable<InboxItem["execution"]>,
  currentUser?: DashboardCurrentUser,
): NonNullable<InboxItem["execution"]> {
  if (canSeeWorkspaceDiagnostics(currentUser)) {
    return execution;
  }
  return {
    ...execution,
    serverUrl: undefined,
    sessionId: undefined,
    workDir: undefined,
    workDirHostLabel: undefined,
  };
}

function buildTaskExecutionTimeline(
  taskId: string,
  workspaceId: string,
  limit = 80,
): TaskExecutionTimelineEntry[] {
  return listTaskExecutionEventsCached(workspaceId, taskId, limit).map(mapTaskExecutionTimelineEntry);
}

function buildRouterExecutionView(
  queuedTask: ReturnType<typeof listQueuedTasksSync>[number] | undefined,
): RouterExecutionView | undefined {
  if (!queuedTask?.routerSessionId) {
    return undefined;
  }
  const session = readAgentRouterSessionCached(queuedTask.routerSessionId);
  if (!session) {
    return undefined;
  }
  const attempts = listAgentTaskAttemptsCached(queuedTask.workspaceId, queuedTask.id);
  const providerSessions = listAgentRouterProviderSessionsCached(queuedTask.workspaceId, session.id);
  const latestAttempt = attempts.at(-1);
  const latestMetadata = latestAttempt ? safeParseJson(latestAttempt.metadataJson) : {};
  const fallbackReason = readString(latestMetadata.fallbackReason);
  const continuationMode =
    fallbackReason
      ? "fallback"
      : latestAttempt?.providerSessionId
        ? "same_provider_resume"
        : "cold_rebuild";

  return {
    routerSessionId: session.id,
    conversationKey: session.conversationKey,
    sourceType: session.sourceType,
    continuationMode,
    attempts: attempts.map((attempt) => {
      const metadata = safeParseJson(attempt.metadataJson);
      return {
        id: attempt.id,
        runtimeId: attempt.runtimeId,
        provider: attempt.provider,
        providerSessionId: attempt.providerSessionId,
        status: attempt.status,
        startedAt: attempt.startedAt,
        finishedAt: attempt.finishedAt,
        errorText: attempt.errorText,
        handoffSnapshotId: attempt.handoffSnapshotId,
        routingMode: readString(metadata.routingMode),
        fallbackReason: readString(metadata.fallbackReason),
      };
    }),
    providerSessions: providerSessions.map((providerSession) => ({
      id: providerSession.id,
      runtimeId: providerSession.runtimeId,
      provider: providerSession.provider,
      providerSessionId: providerSession.providerSessionId,
      status: providerSession.status,
      lastUsedAt: providerSession.lastUsedAt,
      lastError: providerSession.lastError,
    })),
  };
}

function mapTaskExecutionTimelineEntry(event: TaskExecutionEventRecord): TaskExecutionTimelineEntry {
  const data = safeParseJson(event.dataJson);
  return {
    id: event.id,
    type: event.type,
    category: categoryForExecutionEvent(event.type),
    title: event.title,
    summary: event.summary,
    severity: event.severity,
    status: event.status,
    createdAt: event.createdAt,
    targetHref: readSafeRelativeHref(data.targetHref),
    nextActions: resolveExecutionEventActions(event, data),
  };
}

function categoryForExecutionEvent(type: TaskExecutionEventType): TaskExecutionTimelineCategory {
  if (type === "tool_started" || type === "tool_finished") {
    return "tool";
  }
  if (type === "artifact_detected" || type === "artifact_collected") {
    return "artifact";
  }
  if (type === "approval_requested") {
    return "approval";
  }
  if (type === "blocked" || type === "failed" || type === "cancelled") {
    return "error";
  }
  if (type === "handoff_created") {
    return "handoff";
  }
  return "status";
}

function resolveExecutionEventActions(
  event: TaskExecutionEventRecord,
  data: Record<string, unknown>,
): TaskExecutionTimelineAction[] | undefined {
  if (event.type !== "blocked" && event.type !== "failed" && event.type !== "cancelled") {
    return undefined;
  }
  const joined = `${event.summary ?? ""} ${readString(data.errorCode) ?? ""} ${readString(data.errorCategory) ?? ""}`.toLowerCase();
  if (/\b(auth|permission|credential|profile|forbidden|unauthorized|denied)\b/.test(joined)) {
    return ["grant_permission", "retry", "handoff"];
  }
  if (event.type === "blocked") {
    return ["mark_blocked", "handoff", "retry"];
  }
  if (event.type === "cancelled") {
    return ["retry", "handoff"];
  }
  return ["retry", "rollback", "handoff"];
}

function readSafeRelativeHref(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  return value.startsWith("/") ? value : undefined;
}

function readString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value : undefined;
}

function mapWorkspaceMemberForRuntimeGrant(member: WorkspaceMemberUserRecord): RuntimeGrantMember {
  return {
    userId: member.userId,
    displayName: member.displayName,
    primaryEmail: member.primaryEmail,
    role: member.role,
  };
}

function parseAgentForkOrigin(origin: string): WorkspaceAgentRecord["forkedFrom"] {
  const match = /^agent-fork:(.*):([^:]+)$/.exec(origin);
  if (!match) {
    return undefined;
  }
  return {
    sourceAgentName: match[1] ?? "",
    invitationId: match[2] ?? "",
  };
}

function buildAgentForkInvitationView(
  invitation: AgentForkInvitationRecord,
  context: {
    memberByUserId: Map<string, RuntimeGrantMember>;
    employeeDisplayNameByName: Map<string, string>;
    currentUserDisplayName?: string;
  },
): WorkspaceAgentForkInvitationView {
  const sourceAgentDisplayName =
    invitation.snapshot?.profile?.remarkName?.trim()
    || context.employeeDisplayNameByName.get(invitation.sourceAgentName)
    || invitation.sourceAgentName;
  const targetDisplayName = context.memberByUserId.get(invitation.targetUserId)?.displayName;
  return {
    id: invitation.id,
    sourceAgentName: invitation.sourceAgentName,
    sourceAgentDisplayName,
    targetUserId: invitation.targetUserId,
    targetDisplayName,
    createdByUserId: invitation.createdByUserId,
    createdByDisplayName: context.memberByUserId.get(invitation.createdByUserId)?.displayName,
    status: invitation.status,
    createdAt: invitation.createdAt,
    updatedAt: invitation.updatedAt,
    acceptedAgentName: invitation.acceptedAgentName,
    acceptedRuntimeId: invitation.acceptedRuntimeId,
    contextNote: invitation.options.contextNote ?? invitation.snapshot?.contextNote,
    copyProfile: invitation.options.copyProfile,
    copyInstructions: invitation.options.copyInstructions,
    copySkills: invitation.options.copySkills,
    copyKnowledgeAssignments: invitation.options.copyKnowledgeAssignments,
    copiedSkillCount: invitation.snapshot?.skillIds.length ?? 0,
    copiedKnowledgePageCount: invitation.snapshot?.knowledgePageIds.length ?? 0,
    suggestedAgentName: suggestForkAgentName(
      sourceAgentDisplayName,
      context.currentUserDisplayName ?? targetDisplayName,
    ),
  };
}

function buildDigitalEmployeeShowcaseAgents(input: {
  agents: WorkspaceAgentRecord[];
  state: DofeAgentState;
  memberByUserId: Map<string, RuntimeGrantMember>;
  currentUserId?: string;
  currentMembershipRole?: WorkspaceRole;
  accessRequests: AgentAccessRequestRecord[];
  pendingForkInvitations: WorkspaceAgentForkInvitationView[];
}): DigitalEmployeeShowcaseAgentRecord[] {
  const isManager = isWorkspaceManagerRole(input.currentMembershipRole);
  const employeeByName = new Map(input.state.activeEmployees.map((employee) => [employee.name, employee]));
  const requestsBySourceAgent = new Map<string, WorkspaceAgentAccessRequestView[]>();
  for (const request of input.accessRequests) {
    const sourceAgent = input.agents.find((agent) => agent.internalName === request.sourceAgentName);
    const view = buildAgentAccessRequestView(request, {
      memberByUserId: input.memberByUserId,
      canDecide: Boolean(
        input.currentUserId &&
        request.status === "pending" &&
        (isManager || sourceAgent?.ownerUserId === input.currentUserId),
      ),
    });
    const list = requestsBySourceAgent.get(request.sourceAgentName) ?? [];
    list.push(view);
    requestsBySourceAgent.set(request.sourceAgentName, list);
  }
  for (const [sourceAgentName, requests] of requestsBySourceAgent) {
    requestsBySourceAgent.set(
      sourceAgentName,
      requests.sort((left, right) => new Date(right.updatedAt).getTime() - new Date(left.updatedAt).getTime()),
    );
  }
  const pendingInvitationBySourceName = new Map(
    input.pendingForkInvitations.map((invitation) => [invitation.sourceAgentName, invitation]),
  );

  return input.agents.map((agent) => {
    const employee = employeeByName.get(agent.internalName);
    const accessRequests = requestsBySourceAgent.get(agent.internalName) ?? [];
    const requesterRequests = input.currentUserId
      ? accessRequests.filter((request) => request.requesterUserId === input.currentUserId)
      : [];
    const pendingRequest = requesterRequests.find((request) => request.status === "pending");
    const latestRequest = requesterRequests[0];
    const reviewableRequests = accessRequests.filter((request) => request.canDecide && request.status === "pending");
    const commonChannels = resolveShowcaseCommonChannels({
      state: input.state,
      agentChannels: agent.channels,
      currentUserId: input.currentUserId,
      currentMembershipRole: input.currentMembershipRole,
      memberByUserId: input.memberByUserId,
    });
    const publicChannels = resolveShowcasePublicAgentChannels(input.state, agent.channels);
    const skillCount = agent.skills.length;
    const knowledgeCount = (agent.knowledge?.directCount ?? 0) + (agent.knowledge?.inheritedCount ?? 0);
    const skillHighlights = agent.skills.slice(0, 3).map((skill) => ({
      name: skill.name,
      summary: skill.description,
    }));
    const knowledgeHighlights = buildShowcaseKnowledgeHighlights(agent.knowledge);
    const readiness = buildShowcaseReadiness(agent);
    const lastActivityAt = resolveShowcaseLastActivityAt(agent);
    const requestableActions = buildShowcaseRequestableActions({
      agent,
      commonChannels,
      pendingRequest,
      pendingForkInvitation: pendingInvitationBySourceName.get(agent.internalName),
    });
    const usageHints = buildShowcaseUsageHints({
      commonChannels,
      skillCount,
      knowledgeCount,
      readiness,
      requestableActions,
      channelMemberAccess: agent.channelMemberAccess,
    });
    const ownerDisplayName = agent.ownerUserId ? input.memberByUserId.get(agent.ownerUserId)?.displayName : undefined;
    const managedByLabel = ownerDisplayName ?? "Workspace managed";
    return {
      id: `showcase:${agent.internalName}`,
      kind: "digital_employee_showcase_agent",
      name: agent.name,
      subtitle: agent.internalName,
      description: agent.summary || agent.fit || employee?.role || "Workspace digital employee",
      status: agent.status,
      statusLabel: agent.statusLabel,
      tags: [
        agent.channelMemberAccess === "enabled" ? "channel_use_enabled" : "request_only",
        `${skillCount} skills`,
        `${knowledgeCount} knowledge`,
        ...commonChannels.slice(0, 2).map((channelName) => `#${channelName}`),
      ],
      internalName: agent.internalName,
      role: employee?.role ?? agent.subtitle,
      summary: agent.summary,
      fit: agent.fit,
      traits: employee?.traits ?? [],
      ownerUserId: agent.ownerUserId,
      ownerDisplayName,
      managedByLabel,
      canManage: agent.canManage,
      isOwnedByCurrentUser: Boolean(input.currentUserId && agent.ownerUserId === input.currentUserId),
      channelMemberAccess: agent.channelMemberAccess,
      channels: publicChannels,
      commonChannels,
      skillCount,
      knowledgeCount,
      skillHighlights,
      knowledgeHighlights,
      readiness,
      usageHints,
      lastActivityAt,
      requestableActions,
      forkedFrom: agent.forkedFrom,
      pendingRequest,
      latestRequest,
      pendingForkInvitation: pendingInvitationBySourceName.get(agent.internalName),
      reviewableRequests,
    } satisfies DigitalEmployeeShowcaseAgentRecord;
  }).sort(compareAgents);
}

function buildAgentAccessRequestView(
  request: AgentAccessRequestRecord,
  context: {
    memberByUserId: Map<string, RuntimeGrantMember>;
    canDecide: boolean;
  },
): WorkspaceAgentAccessRequestView {
  return {
    id: request.id,
    sourceAgentName: request.sourceAgentName,
    requesterUserId: request.requesterUserId,
    requesterDisplayName: context.memberByUserId.get(request.requesterUserId)?.displayName,
    requestType: request.requestType,
    targetChannelName: request.targetChannelName,
    status: request.status,
    reason: request.reason,
    resolverUserId: request.resolverUserId,
    resolverDisplayName: request.resolverUserId ? context.memberByUserId.get(request.resolverUserId)?.displayName : undefined,
    resolvedAt: request.resolvedAt,
    createdAt: request.createdAt,
    updatedAt: request.updatedAt,
    forkInvitationId: request.forkInvitationId,
    canDecide: context.canDecide,
  };
}

function resolveShowcaseCommonChannels(input: {
  state: DofeAgentState;
  agentChannels: string[];
  currentUserId?: string;
  currentMembershipRole?: WorkspaceRole;
  memberByUserId: Map<string, RuntimeGrantMember>;
}): string[] {
  const publicAgentChannels = resolveShowcasePublicAgentChannels(input.state, input.agentChannels);
  if (isWorkspaceManagerRole(input.currentMembershipRole)) {
    return publicAgentChannels;
  }
  if (!input.currentUserId) {
    return [];
  }
  const currentDisplayName = input.memberByUserId.get(input.currentUserId)?.displayName;
  if (!currentDisplayName) {
    return [];
  }
  return publicAgentChannels.filter((channelName) => {
    const channel = input.state.channels.find((item) => sameText(item.name, channelName));
    return Boolean(channel && resolveChannelHumanMemberNames(input.state, channel).some((memberName) => sameText(memberName, currentDisplayName)));
  });
}

function resolveShowcasePublicAgentChannels(state: DofeAgentState, agentChannels: string[]): string[] {
  return agentChannels.filter((channelName) => {
    const channel = state.channels.find((item) => sameText(item.name, channelName));
    return channel?.kind !== "direct";
  });
}

function buildShowcaseKnowledgeHighlights(
  knowledge?: WorkspaceAgentKnowledgeRecord,
): DigitalEmployeeShowcaseAgentRecord["knowledgeHighlights"] {
  if (!knowledge) {
    return [];
  }
  return [
    ...knowledge.directPages.map((page) => ({ title: page.title, source: "direct" as const })),
    ...knowledge.inheritedPages.map((page) => ({ title: page.title, source: "inherited" as const })),
  ].slice(0, 3);
}

function buildShowcaseReadiness(
  agent: WorkspaceAgentRecord,
): DigitalEmployeeShowcaseAgentRecord["readiness"] {
  if (agent.boundProviderHealth?.providerUsable === "unusable") {
    return {
      status: "provider_unusable",
      label: "Provider 不可用",
      reason: agent.boundProviderHealth.lastProviderErrorCode ?? agent.boundProviderHealth.providerHealthReason,
    };
  }
  if (agent.boundContainerStatus === "offline") {
    return {
      status: "runtime_offline",
      label: "执行引擎离线",
      reason: agent.boundContainerName,
    };
  }
  if (!agent.boundContainerId) {
    return {
      status: "needs_runtime",
      label: "未绑定执行引擎",
      reason: "复制后需绑定你可用的执行引擎",
    };
  }
  if (agent.boundContainerStatus === "online" || agent.status === "linked" || agent.status === "busy") {
    return {
      status: "ready",
      label: "可用",
      reason: agent.boundProvider ? `${agent.boundProvider} · ${agent.boundContainerName ?? "runtime"}` : agent.boundContainerName,
    };
  }
  return {
    status: "unknown",
    label: "状态未知",
  };
}

function resolveShowcaseLastActivityAt(agent: WorkspaceAgentRecord): string | undefined {
  const candidates = [
    ...agent.workAreas.map((area) => area.updatedAt),
    ...agent.recentMessages.map((message) => message.time),
  ].filter((value): value is string => Boolean(value));
  return candidates.sort((left, right) => new Date(right).getTime() - new Date(left).getTime())[0];
}

function buildShowcaseRequestableActions(input: {
  agent: WorkspaceAgentRecord;
  commonChannels: string[];
  pendingRequest?: WorkspaceAgentAccessRequestView;
  pendingForkInvitation?: WorkspaceAgentForkInvitationView;
}): Array<"fork_copy" | "channel_use"> {
  if (input.agent.canManage || input.pendingRequest || input.pendingForkInvitation) {
    return [];
  }
  const actions: Array<"fork_copy" | "channel_use"> = ["fork_copy"];
  if (input.agent.channelMemberAccess !== "enabled" && input.commonChannels.length > 0) {
    actions.push("channel_use");
  }
  return actions;
}

function buildShowcaseUsageHints(input: {
  commonChannels: string[];
  skillCount: number;
  knowledgeCount: number;
  readiness: DigitalEmployeeShowcaseAgentRecord["readiness"];
  requestableActions: Array<"fork_copy" | "channel_use">;
  channelMemberAccess: "enabled" | "disabled";
}): string[] {
  const hints: string[] = [];
  if (input.commonChannels.length > 0 && input.channelMemberAccess === "enabled") {
    hints.push(`可在共同频道调用：${input.commonChannels.slice(0, 2).join("、")}`);
  } else if (input.requestableActions.includes("channel_use")) {
    hints.push(`可申请在共同频道使用：${input.commonChannels.slice(0, 2).join("、")}`);
  }
  if (input.skillCount > 0) {
    hints.push(`${input.skillCount} 个技能`);
  }
  if (input.knowledgeCount > 0) {
    hints.push(`${input.knowledgeCount} 份知识`);
  }
  if (input.readiness.status === "needs_runtime") {
    hints.push("复制后需绑定执行引擎");
  }
  return hints.slice(0, 4);
}

function suggestForkAgentName(sourceAgentDisplayName: string, targetDisplayName?: string): string {
  const source = sourceAgentDisplayName.trim() || "AI员工";
  const target = targetDisplayName?.trim();
  if (target) {
    return `${target} ${source}`.slice(0, 80);
  }
  return `${source} copy`.slice(0, 80);
}

function buildWorkspaceAgentDocumentAccessSummaries(
  workspaceId: string,
  state: DofeAgentState,
): Map<string, WorkspaceAgentDocumentAccessSummaryRecord> {
  const documentById = new Map(state.channelDocuments.map((document) => [document.id, document]));
  const summaries = new Map<string, WorkspaceAgentDocumentAccessSummaryRecord>();
  const ensureSummary = (employeeName: string): WorkspaceAgentDocumentAccessSummaryRecord => {
    const existing = summaries.get(employeeName);
    if (existing) {
      return existing;
    }
    const created = createEmptyAgentDocumentAccessSummary();
    summaries.set(employeeName, created);
    return created;
  };

  for (const access of listDocumentAgentAccessSync({ workspaceId })) {
    if (access.revokedAt) {
      continue;
    }
    const document = documentById.get(access.documentId);
    const summary = ensureSummary(access.subjectId);
    summary.grants.push({
      id: access.id,
      documentId: access.documentId,
      documentTitle: document?.title ?? access.documentId,
      channelName: document?.channelName ?? "",
      role: access.role,
      source: "explicit_grant",
      storageMode: document?.storageMode ?? "native",
      externalProvider: document?.externalProvider,
      externalFileId: document?.externalFileId,
      externalUrl: document?.externalUrl,
      updatedAt: access.updatedAt,
    });
  }

  for (const request of listDocumentPermissionRequestsSync({ workspaceId })) {
    const document = request.documentId ? documentById.get(request.documentId) : undefined;
    const summary = ensureSummary(request.requestedByAgentName);
    summary.requests.push({
      id: request.id,
      status: request.status,
      requestedRole: request.requestedRole,
      targetLabel: document?.title ?? request.externalUrl ?? request.externalFileId ?? request.documentId ?? request.id,
      documentId: request.documentId,
      documentTitle: document?.title,
      externalProvider: request.externalProvider,
      externalFileId: request.externalFileId,
      externalUrl: request.externalUrl,
      requestedForChannelName: request.requestedForChannelName,
      reason: request.reason,
      decisionNote: request.decisionNote,
      createdAt: request.createdAt,
      decidedAt: request.decidedAt,
    });
  }

  for (const summary of summaries.values()) {
    summary.grants.sort((left, right) => roleRankForAgentDocumentAccess(left.role) - roleRankForAgentDocumentAccess(right.role) || left.documentTitle.localeCompare(right.documentTitle, "zh-CN", { sensitivity: "base" }));
    summary.requests.sort((left, right) => new Date(right.decidedAt ?? right.createdAt).getTime() - new Date(left.decidedAt ?? left.createdAt).getTime());
    summary.readableCount = summary.grants.length;
    summary.editableCount = summary.grants.filter((grant) => grant.role === "editor" || grant.role === "forwarder").length;
    summary.forwardableCount = summary.grants.filter((grant) => grant.role === "forwarder").length;
    summary.externalCount = summary.grants.filter((grant) => grant.storageMode === "external").length;
    summary.pendingRequestCount = summary.requests.filter((request) => request.status === "pending").length;
    summary.rejectedRequestCount = summary.requests.filter((request) => request.status === "rejected").length;
  }

  return summaries;
}

function createEmptyAgentDocumentAccessSummary(): WorkspaceAgentDocumentAccessSummaryRecord {
  return {
    readableCount: 0,
    editableCount: 0,
    forwardableCount: 0,
    externalCount: 0,
    pendingRequestCount: 0,
    rejectedRequestCount: 0,
    grants: [],
    requests: [],
  };
}

function roleRankForAgentDocumentAccess(role: WorkspaceAgentDocumentAccessRecord["role"]): number {
  if (role === "forwarder") {
    return 0;
  }
  if (role === "editor") {
    return 1;
  }
  return 2;
}

export function listDaemonSnapshotViews(workspaceId = DEFAULT_WORKSPACE_ID): DaemonSnapshotView[] {
  const runtimeDisplayNames = buildRuntimeDisplayNameIndex(workspaceId);
  const providerAccounts = new Map(listProviderAccountsCached(workspaceId).map((account) => [account.id, account]));
  return listDaemonSnapshotsCached(workspaceId).map((snapshot) => {
    const daemonMetadata = safeParseJson(snapshot.daemon.metadataJson);
    const runtimeName = typeof daemonMetadata.runtimeName === "string" && daemonMetadata.runtimeName.trim()
      ? daemonMetadata.runtimeName.trim()
      : undefined;
    return {
      daemonKey: snapshot.daemon.daemonKey,
      deviceName: snapshot.daemon.deviceName,
      status: snapshot.daemon.status,
      lastHeartbeatAt: snapshot.daemon.lastHeartbeatAt,
      mode: daemonMetadata.mode === "remote" ? "remote" : "local",
      serverUrl: typeof daemonMetadata.serverUrl === "string" ? daemonMetadata.serverUrl : undefined,
      runtimeName,
      runtimes: snapshot.runtimes.map((runtime) => ({
        id: runtime.id,
        provider: runtime.provider,
        providerAccountId: runtime.providerAccountId,
        providerAccountName: runtime.providerAccountId ? providerAccounts.get(runtime.providerAccountId)?.name : undefined,
        name: runtime.name,
        displayName: runtimeDisplayNames.get(runtime.id),
        status: runtime.status,
        providerHealth: normalizeRuntimeProviderHealth({
          runtimeStatus: runtime.status,
          runtimeMetadata: safeParseJson(runtime.metadataJson),
          lastError: runtime.lastError,
        }),
        lastHeartbeatAt: runtime.lastHeartbeatAt,
        version: runtime.version,
      })),
    };
  });
}

function buildRuntimeDisplayNameIndex(workspaceId: string): Map<string, string> {
  return new Map(
    listWorkspaceRuntimeDisplayNamesCached(workspaceId)
      .map((record) => [record.runtimeId, record.displayName.trim()] as const)
      .filter((entry) => entry[1].length > 0),
  );
}

export function listDaemonTokenViews(
  workspaceId = DEFAULT_WORKSPACE_ID,
  memberByUserId = new Map<string, RuntimeGrantMember>(),
): DaemonTokenView[] {
  return listDaemonApiTokensCached(workspaceId).map((token) => ({
    id: token.id,
    label: token.label,
    status: token.status,
    createdBy: memberByUserId.get(token.createdBy)?.displayName ?? token.createdBy,
    lastUsedAt: token.lastUsedAt,
    createdAt: token.createdAt,
    revokedAt: token.revokedAt,
  }));
}

export function listProviderAccountViews(workspaceId = DEFAULT_WORKSPACE_ID): ProviderAccountView[] {
  return listProviderAccountsCached(workspaceId).map((account) => ({
    id: account.id,
    provider: account.provider,
    name: account.name,
    billingAccountId: account.billingAccountId,
    allowedModels: account.allowedModels,
    status: account.status,
  }));
}

export function listRuntimeProvisionRequestViews(workspaceId = DEFAULT_WORKSPACE_ID): RuntimeProvisionRequestView[] {
  const accountNames = new Map(listProviderAccountsCached(workspaceId).map((account) => [account.id, account.name]));
  return listRuntimeProvisionRequestsCached(workspaceId).map((request) => ({
    id: request.id,
    provider: request.provider,
    providerAccountId: request.providerAccountId,
    providerAccountName: accountNames.get(request.providerAccountId) ?? request.providerAccountId,
    runtimeName: request.runtimeName,
    targetServer: request.targetServer,
    status: request.status,
    createdAt: request.createdAt,
  }));
}

export function getSkillsPageData(workspaceId = DEFAULT_WORKSPACE_ID, currentMembershipRole?: WorkspaceRole): SkillsPageData {
  const state = readWorkspaceStateCached(workspaceId);
  const workspaceSkills = listWorkspaceSkillsCached(workspaceId);
  const skillIdsByAgentId = listEmployeeSkillIdsByAgentIdMapSync(workspaceId);
  const assignedSkillCount = Array.from(skillIdsByAgentId.values()).reduce((sum, skillIds) => sum + skillIds.length, 0);
  const recentImports = listStoredSkillImportEventsCached(workspaceId, 12).map((event) => ({
    id: event.id,
    skillId: event.skillId,
    skillName: event.skillName,
    sourceType: event.sourceType,
    sourceUrl: event.sourceUrl,
    importMode: event.importMode,
    importedAt: event.importedAt,
    warnings: readSkillImportWarnings(event.metadataJson),
  }));

  return {
    skills: workspaceSkills.map((skill) => ({
      ...skill,
      isBuiltin: isSystemSkillName(skill.name),
    })),
    totalSkills: workspaceSkills.length,
    assignedSkillCount,
    currentMembershipRole,
    recentImports,
    agents: state.activeEmployees.map((employee) => ({
      id: buildLegacyAgentIdForEmployeeName(employee.name),
      name: employee.remarkName?.trim() || employee.name,
      internalName: employee.name,
      skillIds: resolveAssignedSkillIdsForEmployee(skillIdsByAgentId, employee),
    })),
  };
}

function readSkillImportWarnings(metadataJson: string): string[] {
  try {
    const parsed = JSON.parse(metadataJson) as { warnings?: unknown };
    return Array.isArray(parsed.warnings)
      ? parsed.warnings.filter((warning): warning is string => typeof warning === "string")
      : [];
  } catch {
    return [];
  }
}

function buildNativeRuntimeRecords(
  state: DofeAgentState,
  runtimeSnapshots: ReturnType<typeof listDaemonSnapshotsSync>,
  bindings: ReturnType<typeof listEmployeeRuntimeBindingsSync>,
  queuedTasks: ReturnType<typeof listQueuedTasksSync>,
  runtimeDisplayNames: Map<string, string>,
  installedApps: ReturnType<typeof listRuntimeInstalledAppsSync> = [],
  runtimeAppOperations: ReturnType<typeof listRuntimeAppOperationsSync> = [],
  mcpConnections: ReturnType<typeof listMcpConnectionsSync> = [],
  mcpCatalogItems: ReturnType<typeof listMcpCatalogItemsSync> = [],
): ContainerRecord[] {
  const boundEmployeesByRuntime = new Map<string, string[]>();
  for (const binding of bindings) {
    const next = boundEmployeesByRuntime.get(binding.runtimeId) ?? [];
    next.push(binding.employeeName);
    boundEmployeesByRuntime.set(binding.runtimeId, next);
  }

  const workspaceTaskById = new Map(state.tasks.map((task) => [task.id, task]));
  const queuedTasksByRuntime = new Map<string, ReturnType<typeof listQueuedTasksSync>>();
  for (const queuedTask of queuedTasks) {
    const next = queuedTasksByRuntime.get(queuedTask.runtimeId) ?? [];
    next.push(queuedTask);
    queuedTasksByRuntime.set(queuedTask.runtimeId, next);
  }
  const installedAppsByRuntime = new Map<string, ReturnType<typeof listRuntimeInstalledAppsSync>>();
  for (const app of installedApps) {
    const next = installedAppsByRuntime.get(app.runtimeId) ?? [];
    next.push(app);
    installedAppsByRuntime.set(app.runtimeId, next);
  }
  const appOperationsByRuntime = new Map<string, ReturnType<typeof listRuntimeAppOperationsSync>>();
  for (const operation of runtimeAppOperations) {
    const next = appOperationsByRuntime.get(operation.runtimeId) ?? [];
    next.push(operation);
    appOperationsByRuntime.set(operation.runtimeId, next);
  }
  const mcpCatalogById = new Map(mcpCatalogItems.map((item) => [item.id, item]));
  const mcpConnectionsByRuntime = new Map<string, RuntimeMcpConnectionView[]>();
  for (const connection of mcpConnections) {
    const catalog = mcpCatalogById.get(connection.catalogItemId);
    const next = mcpConnectionsByRuntime.get(connection.runtimeId) ?? [];
    next.push({
      id: connection.id,
      catalogItemId: connection.catalogItemId,
      catalogDisplayName: catalog?.displayName ?? connection.id,
      transport: catalog?.transport ?? "streamable_http",
      status: connection.status,
      approvedToolCount: parseStringArray(connection.approvedToolsJson).length,
      lastVerifiedAt: connection.lastVerifiedAt,
      updatedAt: connection.updatedAt,
    });
    mcpConnectionsByRuntime.set(connection.runtimeId, next);
  }

  return runtimeSnapshots.flatMap((snapshot) =>
    snapshot.runtimes.map((runtime) =>
      buildNativeRuntimeRecord(
        snapshot.daemon,
        runtime,
        runtimeDisplayNames.get(runtime.id),
        boundEmployeesByRuntime.get(runtime.id) ?? [],
        queuedTasksByRuntime.get(runtime.id) ?? [],
        installedAppsByRuntime.get(runtime.id) ?? [],
        appOperationsByRuntime.get(runtime.id) ?? [],
        mcpConnectionsByRuntime.get(runtime.id) ?? [],
        workspaceTaskById,
      ),
    ),
  );
}

function parseStringArray(value: string | undefined): string[] {
  try {
    const parsed = JSON.parse(value ?? "[]") as unknown;
    return Array.isArray(parsed) ? parsed.filter((item): item is string => typeof item === "string") : [];
  } catch {
    return [];
  }
}

function buildTaskInboxItems(
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

function buildChannelInboxItems(
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

function buildActivityInboxItems(
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
function resolveAssignedSkillIdsForEmployee(
  skillIdsByAgentId: Map<string, string[]>,
  employee: ActiveEmployee,
): string[] {
  return skillIdsByAgentId.get(employee.id)
    ?? skillIdsByAgentId.get(buildLegacyAgentIdForEmployeeName(employee.name))
    ?? [];
}

function buildWorkspaceAgentRecord(
  employee: ActiveEmployee,
  state: DofeAgentState,
  workspaceId: string,
  workspaceSkillIndex: Map<string, WorkspaceSkill>,
  skillIdsByAgentId: Map<string, string[]>,
  binding:
    | {
        runtimeId: string;
        runtimeName: string;
        provider: string;
        boundAt: string;
      }
    | undefined,
  runtimeIndex: Map<string, ContainerRecord>,
  queuedTasks: ReturnType<typeof listQueuedTasksSync>,
  knowledge: WorkspaceAgentKnowledgeRecord,
  documentAccess: WorkspaceAgentDocumentAccessSummaryRecord,
): WorkspaceAgentRecord {
  const assignedSkillIds = resolveAssignedSkillIdsForEmployee(skillIdsByAgentId, employee);
  const assignedSkills = assignedSkillIds
    .map((skillId) => workspaceSkillIndex.get(skillId))
    .filter((skill): skill is WorkspaceSkill => Boolean(skill));
  const runtimeProvider = binding?.provider && isDaemonProvider(binding.provider)
    ? binding.provider
    : undefined;
  const runtime = binding?.runtimeId ? runtimeIndex.get(binding.runtimeId) : undefined;
  const runtimeOnline = runtime ? runtime.status === "linked" : undefined;
  const runtimeCapabilities = runtime
    ? [
        "dofe-agent-output",
        ...runtime.installedApps
          .filter((app) => app.status === "installed" && app.enabled && app.entryPoint?.trim())
          .map((app) => `clihub:${app.source}:${app.name}`),
      ]
    : undefined;
  const skillRequirements = Object.fromEntries(assignedSkills.map((skill) => [
    skill.id,
    readAgentSkillRequirementSummarySync({
      workspaceId,
      employeeName: employee.name,
      skillId: skill.id,
      runtimeProvider,
      runtimeCapabilities,
      runtimeOnline,
    }),
  ]));
  const tasks = state.tasks.filter((task) => task.assignee === employee.name);
  const taskPreview = limitLoadtestDashboardPayload(tasks, AGENT_TASK_PREVIEW_LIMIT);
  const recentMessages = state.messages.filter((message) => isMessageRelevantToAgent(message, employee.name, tasks)).slice(0, 6);
  const workspaceTaskIndex = new Map(state.tasks.map((task) => [task.id, task]));
  const workAreaMap = new Map<string, AgentWorkAreaRecord>();
  const workAreaUpdatedAt = new Map<string, number>();
  const relevantQueuedTasks = queuedTasks
    .filter((queuedTask) => queuedTask.agentId === employee.name)
    .sort((left, right) => new Date(right.updatedAt).getTime() - new Date(left.updatedAt).getTime());
  const queuedTaskIndex = new Map(relevantQueuedTasks.map((queuedTask) => [queuedTask.id, queuedTask]));

  for (const workspace of (state.conversationExecutionWorkspaces ?? []).filter((workspace) => workspace.agentId === employee.name)) {
    const queuedTask = workspace.lastTaskQueueId ? queuedTaskIndex.get(workspace.lastTaskQueueId) : undefined;
    const task = queuedTask?.issueId ? workspaceTaskIndex.get(queuedTask.issueId) : undefined;

    workAreaMap.set(workspace.conversationKey, {
      id: workspace.conversationKey,
      queueId: workspace.lastTaskQueueId ?? workspace.conversationKey,
      title: workspace.contactId ?? task?.title ?? workspace.channelName,
      channel: workspace.channelName,
      queueStatus: queuedTask ? formatNativeQueueStatus(queuedTask.status) : "not_queued",
      taskStatus: task ? formatTaskStatus(task.status) : undefined,
      updatedAt: formatAbsoluteDateTime(workspace.updatedAt),
      startedAt: queuedTask?.startedAt,
      finishedAt: queuedTask?.finishedAt,
      sessionId: workspace.sessionId,
      router: buildRouterExecutionView(queuedTask),
      workDir: workspace.workDir,
      workDirAccess: runtime?.daemonMode === "remote" ? "remote" : runtime?.daemonMode === "local" ? "local" : undefined,
      workDirHostLabel: runtime?.deviceName,
      errorText: workspace.lastError ?? queuedTask?.errorText,
    });
    workAreaUpdatedAt.set(
      workspace.conversationKey,
      latestTimestampMs(workspace.updatedAt, queuedTask?.updatedAt),
    );
  }

  for (const queuedTask of relevantQueuedTasks) {
    const task = queuedTask.issueId ? workspaceTaskIndex.get(queuedTask.issueId) : undefined;
    const payload = safeParseQueuePayloadWithMetadata(queuedTask.inputJson);
    const workAreaKey =
      payload.channelName
        ? `channel:${payload.channelName}`
        : payload.contactId
          ? `contact:${payload.contactId}`
          : task?.channel
            ? `channel:${task.channel}`
            : queuedTask.workDir ?? queuedTask.id;

    const queuedUpdatedAt = Date.parse(queuedTask.updatedAt);
    const existingUpdatedAt = workAreaUpdatedAt.get(workAreaKey) ?? Number.NEGATIVE_INFINITY;
    const existingWorkArea = workAreaMap.get(workAreaKey);
    const sameTimestampTerminalWins = existingWorkArea
      && queuedUpdatedAt === existingUpdatedAt
      && isTerminalQueueStatus(queuedTask.status)
      && isActiveQueueStatus(existingWorkArea.queueStatus);
    if (
      existingWorkArea
      && !isLaterTimestamp(queuedUpdatedAt, existingUpdatedAt)
      && !sameTimestampTerminalWins
    ) {
      continue;
    }

    workAreaMap.set(workAreaKey, {
      id: queuedTask.id,
      queueId: queuedTask.id,
      title: task?.title ?? safeReadTaskTitle(queuedTask.inputJson) ?? queuedTask.id,
      channel: payload.channelName ?? task?.channel,
      queueStatus: formatNativeQueueStatus(queuedTask.status),
      taskStatus: task ? formatTaskStatus(task.status) : undefined,
      updatedAt: formatAbsoluteDateTime(queuedTask.updatedAt),
      startedAt: queuedTask.startedAt,
      finishedAt: queuedTask.finishedAt,
      sessionId: queuedTask.sessionId,
      router: buildRouterExecutionView(queuedTask),
      workDir: queuedTask.workDir,
      workDirAccess: runtime?.daemonMode === "remote" ? "remote" : runtime?.daemonMode === "local" ? "local" : undefined,
      workDirHostLabel: runtime?.deviceName,
      errorText: queuedTask.errorText,
    });
    workAreaUpdatedAt.set(workAreaKey, queuedUpdatedAt);
  }

  const workAreas = Array.from(workAreaMap.values());

  const status = statusForWorkspaceAgent(tasks, workAreas, runtime?.status);

  return {
    id: buildLegacyAgentIdForEmployeeName(employee.name),
    employeeId: employee.id,
    kind: "agent",
    name: employee.remarkName?.trim() || employee.name,
    subtitle: employee.name,
    description: employee.summary,
    status,
    statusLabel: labelForAgentStatus(status),
    tags: [
      employee.origin,
      assignedSkills.length > 0 ? `${assignedSkills.length} skills` : "no_skills",
      employee.channels.length > 0 ? `${employee.channels.length} channels` : "unassigned_channels",
      tasks.length > 0 ? `${tasks.length} tasks` : "no_tasks",
    ],
    internalName: employee.name,
    ownerUserId: employee.ownerUserId,
    canManage: true,
    canManageChannelMemberAccess: true,
    channelMemberAccess: employee.channelMemberAccess ?? (employee.ownerUserId ? "disabled" : "enabled"),
    origin: employee.origin,
    fit: employee.fit,
    summary: employee.summary,
    skills: assignedSkills,
    skillRequirements,
    channels: employee.channels,
    tasks: taskPreview,
    recentMessages,
    boundContainerId: binding?.runtimeId,
    boundContainerName: runtime?.name ?? binding?.runtimeName,
    boundContainerStatus: runtime ? (runtime.status === "linked" ? "online" : "offline") : undefined,
    boundProvider: binding?.provider,
    boundProviderHealth: runtime?.providerHealth,
    boundAt: binding?.boundAt,
    runtimeCapabilities: runtime ? {
      cliApps: runtime.installedApps.filter((app) => app.status === "installed" && app.enabled),
      mcpServices: (runtime.mcpConnections ?? []).filter((connection) => connection.status === "ready"),
    } : undefined,
    defaultModel: employee.defaultModel,
    executionPolicy: employee.executionPolicy,
    workAreas,
    instructions: employee.instructions,
    knowledge,
    documentAccess,
  };
}

/**
 * Returns a viewer-safe skill-requirements map for non-managers (spec §3.3).
 * Keeps only the aggregate readiness signal (status + counts + dependency
 * status) so a viewer can tell "可用 / 需管理员处理". Drops everything that
 * carries a variable name, value, blocker detail, or actor identity.
 */
export function redactSkillRequirementsForViewer(
  skillRequirements: Record<string, AgentSkillRequirementSummary>,
): Record<string, AgentSkillRequirementSummary> {
  return Object.fromEntries(Object.entries(skillRequirements).map(([skillId, summary]) => [
    skillId,
    {
      skillId: summary.skillId,
      status: summary.status,
      statusDetail: summary.statusDetail,
      requiredCount: summary.requiredCount,
      configuredCount: summary.configuredCount,
      blockers: [],
      environment: [],
      runtimeOnline: summary.runtimeOnline,
      dependencyInstallStatus: summary.dependencyInstallStatus,
    } satisfies AgentSkillRequirementSummary,
  ]));
}

function buildNativeRuntimeRecord(
  daemon: {
    daemonKey: string;
    deviceName: string;
    status: "online" | "offline";
    metadataJson: string;
    lastHeartbeatAt?: string;
  },
  runtime: {
    id: string;
    provider: string;
    name: string;
    version: string;
    status: "online" | "offline";
    deviceInfo: string;
    metadataJson: string;
    lastHeartbeatAt?: string;
    lastError?: string;
  },
  displayName: string | undefined,
  boundEmployees: string[],
  queuedTasks: ReturnType<typeof listQueuedTasksSync>,
  installedApps: ReturnType<typeof listRuntimeInstalledAppsSync>,
  runtimeAppOperations: ReturnType<typeof listRuntimeAppOperationsSync>,
  mcpConnections: RuntimeMcpConnectionView[],
  workspaceTaskById: Map<string, TaskRecord>,
): ContainerRecord {
  const runtimeMetadata = safeParseJson(runtime.metadataJson);
  const daemonMetadata = safeParseJson(daemon.metadataJson);
  const daemonMode = resolveDaemonMode(runtimeMetadata, daemonMetadata);
  const executionWorkDirAccess: "local" | "remote" = daemonMode === "remote" ? "remote" : "local";
  const serverUrl = typeof daemonMetadata.serverUrl === "string" ? daemonMetadata.serverUrl : undefined;
  const status: WorkspaceAgentStatus = runtime.status === "online" ? "linked" : "error";
  const providerHealth = normalizeRuntimeProviderHealth({
    runtimeStatus: runtime.status,
    runtimeMetadata,
    lastError: runtime.lastError,
  });
  const providerLabel = formatDaemonProviderLabel(runtime.provider);
  const trimmedDisplayName = displayName?.trim();
  const queueCounts = {
    queued: queuedTasks.filter((task) => task.status === "queued" || task.status === "claimed").length,
    running: queuedTasks.filter((task) => task.status === "running").length,
    failed: queuedTasks.filter((task) => task.status === "failed").length,
    completed: queuedTasks.filter((task) => task.status === "completed").length,
  };
  const recentExecutions = queuedTasks
    .slice()
    .sort((left, right) => new Date(right.updatedAt).getTime() - new Date(left.updatedAt).getTime())
    .slice(0, 8)
    .map((queuedTask) => {
      const task = queuedTask.issueId ? workspaceTaskById.get(queuedTask.issueId) : undefined;
      const payload = safeParseQueuePayloadWithMetadata(queuedTask.inputJson);
      const taskMessages = listTaskMessagesForTaskSync(queuedTask.id).map((message) => ({
        id: message.id,
        type: message.type,
        content: message.content ?? message.output ?? message.type,
        createdAt: message.createdAt,
        status: (message.type === "error" ? "error" : "completed") as "error" | "completed",
      }));
      const timeline = buildTaskExecutionTimeline(queuedTask.id, queuedTask.workspaceId, 8);
      const router = buildRouterExecutionView(queuedTask);
      return {
        queueId: queuedTask.id,
        taskId: queuedTask.issueId,
        title: task?.title ?? safeReadTaskTitle(queuedTask.inputJson) ?? queuedTask.id,
        assignee: task?.assignee ?? queuedTask.agentId,
        channel: task?.channel ?? payload.channelName,
        queueStatus: formatNativeQueueStatus(queuedTask.status),
        taskStatus: task ? formatTaskStatus(task.status) : undefined,
        messageCount: taskMessages.length,
        startedAt: queuedTask.startedAt,
        finishedAt: queuedTask.finishedAt,
        sessionId: queuedTask.sessionId,
        router,
        workDir: queuedTask.workDir,
        workDirAccess: executionWorkDirAccess,
        workDirHostLabel: runtime.deviceInfo || daemon.deviceName,
        errorText: queuedTask.errorText,
        taskMessages,
        timeline,
      };
    });
  const cliHubReadiness = normalizeCliHubReadiness(daemonMetadata.cliHubReadiness);
  const installedAppViews = installedApps.map((app) => ({
    source: app.source,
    name: app.name,
    displayName: app.displayName,
    version: app.version,
    entryPoint: app.entryPoint,
    status: app.status,
    enabled: app.enabled,
    lastError: app.lastError,
    updatedAt: app.updatedAt,
  }));
  const recentAppOperations = runtimeAppOperations
    .slice()
    .sort((left, right) => new Date(right.createdAt).getTime() - new Date(left.createdAt).getTime())
    .slice(0, 8)
    .map((operation) => ({
      id: operation.id,
      appSource: operation.appSource,
      appName: operation.appName,
      operation: operation.operation,
      status: operation.status,
      createdAt: operation.createdAt,
      errorMessage: operation.errorMessage,
    }));

  return {
    id: `runtime:${runtime.id}`,
    kind: "container",
    name: runtime.name,
    subtitle: `${providerLabel} · ${runtime.deviceInfo || daemon.deviceName}`,
    description:
      runtime.status === "online" && providerHealth.providerUsable === "unusable"
        ? `Provider unavailable: ${providerHealth.providerHealthReason ?? providerHealth.lastProviderErrorMessage ?? "health check failed"}`
        : runtime.status === "online"
        ? "The container is online and can host independent work areas for multiple agents."
        : runtime.lastError || "The container is currently offline.",
    status,
    statusLabel: labelForAgentStatus(status),
    tags: [
      daemon.deviceName,
      runtime.version || "version_unavailable",
      runtime.lastHeartbeatAt ?? daemon.lastHeartbeatAt ?? "heartbeat_unavailable",
    ],
    runtimeId: runtime.id,
    provider: runtime.provider,
    displayName: trimmedDisplayName || undefined,
    daemonKey: daemon.daemonKey,
    deviceName: runtime.deviceInfo || daemon.deviceName,
    runtimeStatus: runtime.status,
    providerHealth,
    daemonMode,
    serverUrl,
    version: runtime.version || undefined,
    lastHeartbeatAt: runtime.lastHeartbeatAt ?? daemon.lastHeartbeatAt,
    executablePath:
      typeof runtimeMetadata.executablePath === "string" ? runtimeMetadata.executablePath : undefined,
    daemonPid: typeof daemonMetadata.pid === "string" ? daemonMetadata.pid : undefined,
    cliHubReadiness,
    installedApps: installedAppViews,
    mcpConnections,
    recentAppOperations,
    grantedMembers: [],
    canManageGrants: false,
    boundEmployees,
    agentCount: boundEmployees.length,
    queueCounts,
    recentExecutions,
  };
}

function compareContainers(left: ContainerRecord, right: ContainerRecord): number {
  const leftPriority = priorityForAgentStatus(left.status);
  const rightPriority = priorityForAgentStatus(right.status);
  if (leftPriority !== rightPriority) {
    return leftPriority - rightPriority;
  }
  return left.name.localeCompare(right.name, "zh-CN", { sensitivity: "base" });
}

function compareAgents(left: ManagementRecordBase, right: ManagementRecordBase): number {
  const leftPriority = priorityForAgentStatus(left.status);
  const rightPriority = priorityForAgentStatus(right.status);
  if (leftPriority !== rightPriority) {
    return leftPriority - rightPriority;
  }
  return left.name.localeCompare(right.name, "zh-CN", { sensitivity: "base" });
}

function safeParseJson(value: string): Record<string, unknown> {
  if (!value.trim()) {
    return {};
  }

  try {
    const parsed = JSON.parse(value) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return {};
    }
    return parsed as Record<string, unknown>;
  } catch {
    return {};
  }
}

function resolveDaemonMode(
  runtimeMetadata: Record<string, unknown>,
  daemonMetadata: Record<string, unknown>,
): "local" | "remote" {
  const runtimeMode = runtimeMetadata.mode;
  if (runtimeMode === "local" || runtimeMode === "remote") {
    return runtimeMode;
  }
  const daemonMode = daemonMetadata.mode;
  if (daemonMode === "local" || daemonMode === "remote") {
    return daemonMode;
  }
  return "local";
}

function toneForTask(status: TaskStatus): InboxItem["statusTone"] {
  if (status === "done") {
    return "positive";
  }
  if (status === "blocked") {
    return "danger";
  }
  if (status === "in_progress") {
    return "warning";
  }
  return "neutral";
}

function toneForNotification(notification: WorkspaceNotificationRecord): InboxItem["statusTone"] {
  if (notification.severity === "critical") {
    return "danger";
  }
  if (notification.severity === "warning") {
    return "warning";
  }
  if (notification.severity === "success") {
    return "positive";
  }
  return "neutral";
}

function formatNotificationStatus(status: WorkspaceNotificationRecord["status"]): string {
  if (status === "unread") {
    return "Unread";
  }
  if (status === "archived") {
    return "Archived";
  }
  return "Read";
}

function formatNotificationResourceType(resourceType: WorkspaceNotificationRecord["resourceType"]): string {
  if (resourceType === "workspace_member") {
    return "Workspace member";
  }
  return resourceType.charAt(0).toUpperCase() + resourceType.slice(1);
}

function statusForWorkspaceAgent(
  tasks: TaskRecord[],
  workAreas: AgentWorkAreaRecord[],
  containerStatus?: WorkspaceAgentStatus,
): WorkspaceAgentStatus {
  if (containerStatus === "error") {
    return "error";
  }
  if (tasks.some((task) => task.status === "blocked")) {
    return "blocked";
  }
  if (workAreas.some((area) => isActiveQueueStatus(area.queueStatus))) {
    return "busy";
  }
  if (tasks.some((task) => task.status === "in_progress")) {
    return "busy";
  }
  return "online";
}

function latestTimestampMs(...values: Array<string | undefined>): number {
  const timestamps = values
    .map((value) => (value ? Date.parse(value) : Number.NaN))
    .filter((value) => Number.isFinite(value));
  return timestamps.length > 0 ? Math.max(...timestamps) : Number.NEGATIVE_INFINITY;
}

function isLaterTimestamp(candidate: number, current: number): boolean {
  if (!Number.isFinite(candidate)) return false;
  if (!Number.isFinite(current)) return true;
  return candidate > current;
}

function isActiveQueueStatus(status: string): boolean {
  return status === "queued"
    || status === "claimed"
    || status === "running"
    || status === "preparing_commit";
}

function isTerminalQueueStatus(status: string): boolean {
  return status === "completed" || status === "failed" || status === "cancelled" || status === "committed";
}

function formatTaskStatus(status: TaskStatus): string {
  return status;
}

function formatPriority(priority: TaskRecord["priority"]): string {
  return priority;
}

function labelForAgentStatus(status: WorkspaceAgentStatus): string {
  return status;
}

function priorityForAgentStatus(status: WorkspaceAgentStatus): number {
  if (status === "error") {
    return 0;
  }
  if (status === "blocked") {
    return 1;
  }
  if (status === "busy") {
    return 2;
  }
  if (status === "linked") {
    return 3;
  }
  return 4;
}

function formatAbsoluteDateTime(value: string): string {
  return formatCompactTimestamp(value, { emptyFallback: value });
}

function formatNativeQueueStatus(status: string): string {
  return status;
}

function safeParseQueuePayloadWithMetadata(inputJson: string): {
  contactId?: string;
  channelName?: string;
  mentionedAgentIds?: string[];
} {
  try {
    const parsed = JSON.parse(inputJson) as Record<string, unknown>;
    return {
      contactId: typeof parsed.contactId === "string" ? parsed.contactId : undefined,
      channelName: typeof parsed.channelName === "string" ? parsed.channelName : undefined,
      mentionedAgentIds: Array.isArray(parsed.mentionedAgentIds)
        ? parsed.mentionedAgentIds.filter((item): item is string => typeof item === "string")
        : undefined,
    };
  } catch {
    return {};
  }
}

function isMessageRelevantToAgent(message: WorkspaceMessage, agentName: string, tasks: TaskRecord[]): boolean {
  if (sameText(message.speaker, agentName) || message.speaker.includes(agentName)) {
    return true;
  }

  if (message.mentions?.some((mention) =>
    mention.mentionType === "agent" && (sameText(mention.agentId, agentName) || sameText(mention.label, agentName))
  )) {
    return true;
  }

  for (const task of tasks) {
    if (task.title.length > 0 && message.summary.includes(task.title)) {
      return true;
    }
  }

  return false;
}

export type TaskBoardGroupBy = "status" | "assignee" | "priority" | "channel";

export interface TaskBoardColumn {
  key: string;
  label: string;
  tasks: TaskRecord[];
}

export interface TaskBoardPageData {
  tasks: TaskRecord[];
  columns: TaskBoardColumn[];
  agents: Array<{ id: string; name: string }>;
  channels: Array<{ name: string }>;
  runnableWorkflows: RunnableWorkflowSummary[];
  totalCount: number;
  todoCount: number;
  inProgressCount: number;
  doneCount: number;
}

export function getTaskBoardPageData(
  groupBy: TaskBoardGroupBy = "status",
  workspaceId = DEFAULT_WORKSPACE_ID,
  currentUser?: DashboardCurrentUser,
): TaskBoardPageData {
  const state = readWorkspaceStateCached(workspaceId);
  const canSeeAllAgents = canSeeWorkspaceDiagnostics(currentUser);
  const readableChannels = buildReadableChannelLookup(state, workspaceId, currentUser);
  const visibleChannels = currentUser?.id
    ? state.channels.filter((channel) => readableChannels.canRead(channel.name))
    : state.channels;
  const visibleChannelNames = new Set(visibleChannels.map((channel) => channel.name));
  const visibleChannelAgentNames = new Set(visibleChannels.flatMap((channel) => channel.employeeNames));
  const visibleAgents = canSeeAllAgents
    ? state.activeEmployees
    : state.activeEmployees.filter((employee) =>
        employee.ownerUserId === currentUser?.id ||
        (
          (employee.channelMemberAccess ?? "enabled") === "enabled" &&
          visibleChannelAgentNames.has(employee.name)
        ),
      );
  const visibleAgentNames = new Set(visibleAgents.map((employee) => employee.name));
  const tasks = state.tasks
    .filter((task) => canSeeAllAgents || visibleAgentNames.has(task.assignee))
    .filter((task) => !currentUser?.id || visibleChannelNames.has(task.channel))
    .sort((a, b) => (a.sortOrder ?? 0) - (b.sortOrder ?? 0));
  const taskPreview = limitLoadtestDashboardPayload(tasks, TASK_BOARD_TASK_LIMIT);

  const columns = buildTaskBoardColumns(taskPreview, groupBy, state);

  return {
    tasks: taskPreview,
    columns,
    agents: visibleAgents.map((employee) => ({
      id: employee.name,
      name: employee.remarkName?.trim() || employee.name,
    })),
    channels: visibleChannels.map((channel) => ({ name: channel.name })),
    runnableWorkflows: listRunnableWorkflowsSync(workspaceId),
    totalCount: tasks.length,
    todoCount: tasks.filter((t) => t.status === "todo").length,
    inProgressCount: tasks.filter((t) => t.status === "in_progress").length,
    doneCount: tasks.filter((t) => t.status === "done").length,
  };
}

function buildTaskBoardColumns(
  tasks: TaskRecord[],
  groupBy: TaskBoardGroupBy,
  state: DofeAgentState,
): TaskBoardColumn[] {
  if (groupBy === "status") {
    const statuses: TaskStatus[] = ["todo", "in_progress", "blocked", "done"];
    const labels: Record<TaskStatus, string> = {
      todo: "Todo",
      in_progress: "In Progress",
      blocked: "Blocked",
      done: "Done",
    };
    return statuses.map((status) => ({
      key: status,
      label: labels[status],
      tasks: tasks.filter((t) => t.status === status),
    }));
  }

  if (groupBy === "assignee") {
    const assignees = [...new Set(tasks.map((t) => t.assignee))];
    const employeeIndex = new Map(
      state.activeEmployees.map((e) => [e.name, e]),
    );
    return assignees.map((assignee) => ({
      key: assignee,
      label: employeeIndex.get(assignee)?.remarkName?.trim() || assignee,
      tasks: tasks.filter((t) => t.assignee === assignee),
    }));
  }

  if (groupBy === "priority") {
    const priorities: Array<TaskRecord["priority"]> = ["high", "medium", "low"];
    return priorities.map((priority) => ({
      key: priority,
      label: priority.charAt(0).toUpperCase() + priority.slice(1),
      tasks: tasks.filter((t) => t.priority === priority),
    }));
  }

  // groupBy === "channel"
  const channelNames = [...new Set(tasks.map((t) => t.channel))];
  return channelNames.map((channelName) => ({
    key: channelName,
    label: `#${channelName}`,
    tasks: tasks.filter((t) => t.channel === channelName),
  }));
}

export function readAuthenticatedUserCountSync(): number {
  return countUsersSync();
}

// ── Org Chart ──

export interface OrgChartNode {
  id: string;
  name: string;
  displayName: string;
  role: string;
  type: "human" | "agent";
  channels: string[];
  status: "online" | "offline";
}

export interface OrgChartPageData {
  humans: OrgChartNode[];
  agents: OrgChartNode[];
  channels: Array<{ name: string; agentNames: string[] }>;
  totalHumans: number;
  totalAgents: number;
}

export function getOrgChartPageData(workspaceId = DEFAULT_WORKSPACE_ID): OrgChartPageData {
  const state = readWorkspaceStateCached(workspaceId);
  const workspaceMembers = listWorkspaceMemberUsersCached(workspaceId);
  const bindings = listEmployeeRuntimeBindingsCached(workspaceId);
  const boundNames = new Set(bindings.map((b) => b.employeeName));

  const humans: OrgChartNode[] = workspaceMembers.map((member) => ({
    id: member.userId,
    name: member.displayName,
    displayName: member.displayName,
    role: formatWorkspaceRoleLabel(member.role),
    type: "human" as const,
    channels: state.channels
      .filter((ch) => resolveChannelHumanMemberNames(state, ch).some((name) => sameText(name, member.displayName)))
      .map((ch) => ch.name),
    status: "online" as const,
  }));

  const agents: OrgChartNode[] = state.activeEmployees.map((e) => ({
    id: e.name,
    name: e.name,
    displayName: e.remarkName?.trim() || e.name,
    role: e.role,
    type: "agent" as const,
    channels: e.channels,
    status: boundNames.has(e.name) ? ("online" as const) : ("offline" as const),
  }));

  const channels = state.channels.map((ch) => ({
    name: ch.name,
    agentNames: ch.employeeNames,
  }));

  return {
    humans,
    agents,
    channels,
    totalHumans: humans.length,
    totalAgents: agents.length,
  };
}

// ── Costs ──

export type CostPageData = CostDashboardData;

export function getCostPageData(
  period: "monthly" | "total" = "monthly",
  workspaceId = DEFAULT_WORKSPACE_ID,
): CostPageData {
  return getCostDashboardDataCached(period, workspaceId);
}

export async function getCostPageDataAsync(
  period: "monthly" | "total" = "monthly",
  workspaceId = DEFAULT_WORKSPACE_ID,
): Promise<CostPageData> {
  return getAuthoritativeCostDashboardDataCached(period, workspaceId);
}

// ── Budgets ──

export interface BudgetPageItem {
  id: string;
  scope: BudgetScope;
  scopeId: string;
  limitUsd: number;
  period: BudgetPeriod;
  action: BudgetAction;
  warningThreshold: number;
  enabled: boolean;
  spentUsd: number;
  percentUsed: number;
}

export interface BudgetPageData {
  budgets: BudgetPageItem[];
  agents: Array<{ id: string; name: string }>;
  channels: Array<{ name: string }>;
}

export function getBudgetPageData(workspaceId = DEFAULT_WORKSPACE_ID): BudgetPageData {
  const state = readWorkspaceStateCached(workspaceId);
  const budgets = listBudgetsWithSpentCached(workspaceId);

  return {
    budgets: budgets.map((b) => ({
      id: b.id,
      scope: b.scope,
      scopeId: b.scopeId,
      limitUsd: b.limitUsd,
      period: b.period,
      action: b.action,
      warningThreshold: b.warningThreshold,
      enabled: b.enabled,
      spentUsd: b.spentUsd,
      percentUsed: b.percentUsed,
    })),
    agents: state.activeEmployees.map((e) => ({
      id: e.name,
      name: e.remarkName?.trim() || e.name,
    })),
    channels: state.channels.map((ch) => ({ name: ch.name })),
  };
}

// ── Knowledge ──

export interface KnowledgePageData {
  workspaceId: string;
  pages: KnowledgePageRecord[];
  totalCount: number;
  rootCount: number;
  agentOptions: KnowledgeAgentOption[];
  assignmentStats: KnowledgeAssignmentStats;
  materials: Array<{ id: string; source: string; preview?: string }>;
  documentPages: KnowledgeDocumentPageRecord[];
  documentCount: number;
  linkedDocumentCount: number;
  parseTasks: KnowledgeParseTask[];
}

export interface KnowledgeParseTask {
  id: string;
  fileName: string;
  status: "pending" | "approved" | "running" | "completed" | "failed" | "cancelled" | "rejected";
  intent: "auto_deposit" | "document_only";
  mediaType: string;
  sizeBytes: number;
  attachmentId: string;
  linkedKnowledgePageId?: string;
  lastErrorCode?: string;
  lastErrorMessage?: string;
  warnings: string[];
  createdAt: string;
  updatedAt: string;
}

export function getKnowledgePageData(
  currentUserDisplayName?: string,
  workspaceId = DEFAULT_WORKSPACE_ID,
  currentUserId?: string,
  currentMembershipRole?: WorkspaceRole,
): KnowledgePageData {
  const state = readWorkspaceStateCached(workspaceId);
  const knowledgePolicies = listKnowledgeAssignmentPoliciesCached(workspaceId);
  const knowledgeAssignments = listKnowledgeAssignmentsCached(workspaceId);
  const knowledgePolicyIndex = new Map(knowledgePolicies.map((policy) => [policy.knowledgePageId, policy]));
  const agentOptions = buildKnowledgeAgentOptions(state);
  const knowledgePageRecords = buildKnowledgePageRecords(
    state.knowledgePages,
    agentOptions,
    knowledgePolicyIndex,
    knowledgeAssignments,
  );
  const queuedTasks = listQueuedTasksCached(workspaceId);
  const visibleChannelNames = getVisibleWorkspaceChannelNames(state, currentUserDisplayName);
  const workspaceArtifacts = buildChannelWorkspaceArtifacts(
    state,
    queuedTasks,
    currentUserDisplayName,
    visibleChannelNames,
    workspaceId,
  );
  const documentPages = buildKnowledgeDocumentPageRecords(
    workspaceArtifacts.documents,
    workspaceArtifacts.channelFiles,
    state.knowledgePages,
  );
  const knowledgePagePreview = limitLoadtestDashboardPayload(knowledgePageRecords, KNOWLEDGE_PAGE_PREVIEW_LIMIT);
  const parseTasks = buildKnowledgeParseTasks(currentUserDisplayName, workspaceId, currentUserId, currentMembershipRole);

  return {
    workspaceId,
    pages: knowledgePagePreview,
    totalCount: state.knowledgePages.length,
    rootCount: state.knowledgePages.filter((page) => page.parentId === null).length,
    agentOptions,
    assignmentStats: buildKnowledgeAssignmentStats(knowledgePageRecords, state.knowledgePages),
    materials: state.materials.map((m) => ({
      id: m.id ?? "",
      source: m.source,
      preview: m.preview,
    })),
    documentPages,
    documentCount: documentPages.length,
    linkedDocumentCount: documentPages.filter((document) => document.linkedKnowledgePages.length > 0).length,
    parseTasks,
  };
}

function buildKnowledgeParseTasks(
  currentUserDisplayName: string | undefined,
  workspaceId: string,
  currentUserId: string | undefined,
  currentMembershipRole: WorkspaceRole | undefined,
): KnowledgeParseTask[] {
  // 先回收卡住的解析任务（进程崩溃/重启后 fire-and-forget 解析留下的永久 running 行），
  // 再读取，避免 UI 把已死的任务渲染成永久转圈。
  reapStuckParseTasksSync(workspaceId);
  const requests = listCapabilityRequestsSync({
    workspaceId,
    packageKind: "service",
    limit: 50,
  }).filter((request) => request.requestedAction === "parse");
  const isManager = isWorkspaceManagerRole(currentMembershipRole);
  return requests
    .filter((request) => {
      // 管理员全可见；匿名（无 userId，如搜索/测试）全可见兜底；
      // 普通成员只看自己提交的任务（按真实 userId 匹配，而非 displayName）。
      if (isManager || !currentUserId) return true;
      return request.requestedByUserId === currentUserId;
    })
    .map((request) => {
      let metadata: Record<string, unknown> = {};
      try {
        const parsed: unknown = JSON.parse(request.metadataJson);
        if (parsed && typeof parsed === "object") {
          metadata = parsed as Record<string, unknown>;
        }
      } catch {
        metadata = {};
      }
      const intent = metadata.intent === "document_only" ? "document_only" : "auto_deposit";
      const warnings = Array.isArray(metadata.warnings)
        ? (metadata.warnings as unknown[]).filter((value): value is string => typeof value === "string")
        : [];
      const sizeBytes = typeof metadata.sizeBytes === "number" ? metadata.sizeBytes : 0;
      return {
        id: request.id,
        fileName: request.packageDisplayName,
        status: request.status,
        intent,
        mediaType: typeof metadata.mediaType === "string" ? metadata.mediaType : "",
        sizeBytes,
        attachmentId: typeof metadata.attachmentId === "string" ? metadata.attachmentId : "",
        linkedKnowledgePageId: request.linkedKnowledgePageId,
        lastErrorCode: request.lastErrorCode,
        lastErrorMessage: request.lastErrorMessage,
        warnings,
        createdAt: request.createdAt,
        updatedAt: request.updatedAt,
      } satisfies KnowledgeParseTask;
    });
}

function buildKnowledgeAgentOptions(state: DofeAgentState): KnowledgeAgentOption[] {
  return state.activeEmployees.map((employee) => ({
    id: buildLegacyAgentIdForEmployeeName(employee.name),
    employeeName: employee.name,
    name: employee.remarkName?.trim() || employee.name,
    subtitle: employee.name,
    status: "linked",
  }));
}

function buildKnowledgePageRecords(
  pages: KnowledgePage[],
  agentOptions: KnowledgeAgentOption[],
  policyIndex: Map<string, ReturnType<typeof listKnowledgeAssignmentPoliciesSync>[number]>,
  assignments: ReturnType<typeof listKnowledgeAssignmentsSync>,
): KnowledgePageRecord[] {
  const agentByEmployeeName = new Map(agentOptions.map((agent) => [agent.employeeName, agent]));
  const assignmentsByPageId = new Map<string, ReturnType<typeof listKnowledgeAssignmentsSync>>();
  for (const assignment of assignments) {
    const next = assignmentsByPageId.get(assignment.knowledgePageId) ?? [];
    next.push(assignment);
    assignmentsByPageId.set(assignment.knowledgePageId, next);
  }

  return pages.map((page) => {
    const policy = policyIndex.get(page.id);
    const assignmentMode = policy?.assignmentMode ?? page.assignmentMode ?? "all_agents";
    const pageAssignments = assignmentsByPageId.get(page.id) ?? [];
    const assignedAgents = pageAssignments.flatMap((assignment) => {
      const agent = agentByEmployeeName.get(assignment.employeeName);
      if (!agent) {
        return [];
      }
      return [{
        ...agent,
        assignedAt: assignment.createdAt,
        assignedBy: assignment.createdBy,
      } satisfies KnowledgeAssignedAgentRecord];
    });
    const effectiveAgentCount = assignmentMode === "all_agents" ? agentOptions.length : assignedAgents.length;

    return {
      ...page,
      assignmentMode,
      assignmentUpdatedAt: policy?.updatedAt ?? page.assignmentUpdatedAt,
      assignmentUpdatedBy: policy?.updatedBy ?? page.assignmentUpdatedBy,
      assignedAgents,
      assignedAgentIds: assignedAgents.map((agent) => agent.id),
      assignedEmployeeNames: assignedAgents.map((agent) => agent.employeeName),
      assignedAgentCount: assignedAgents.length,
      effectiveAgentCount,
      assignmentSummary:
        assignmentMode === "all_agents"
          ? `${effectiveAgentCount} agents`
          : assignedAgents.length > 0
            ? assignedAgents.map((agent) => agent.name).join(", ")
            : "No agents assigned",
    };
  });
}

function buildKnowledgeAssignmentStats(
  records: KnowledgePageRecord[],
  sourcePages: KnowledgePage[],
): KnowledgeAssignmentStats {
  return {
    allAgentsPageCount: records.filter((page) => page.assignmentMode === "all_agents").length,
    selectedAgentsPageCount: records.filter((page) => page.assignmentMode === "selected_agents").length,
    unconfiguredPageCount: sourcePages.filter((page) => !page.assignmentMode).length,
  };
}

function buildWorkspaceAgentKnowledgeRecord(
  employee: ActiveEmployee,
  pages: KnowledgePage[],
  policyIndex: Map<string, ReturnType<typeof listKnowledgeAssignmentPoliciesSync>[number]>,
  assignments: ReturnType<typeof listKnowledgeAssignmentsSync>,
): WorkspaceAgentKnowledgeRecord {
  const directPageIds = assignments
    .filter((assignment) => assignment.employeeName === employee.name)
    .map((assignment) => assignment.knowledgePageId);
  const directPageIdSet = new Set(directPageIds);
  const inheritedPages: AgentKnowledgePageRecord[] = [];
  const directPages: AgentKnowledgePageRecord[] = [];
  const assignablePages: AgentKnowledgePageRecord[] = [];

  for (const page of pages) {
    const assignmentMode = policyIndex.get(page.id)?.assignmentMode ?? page.assignmentMode ?? "all_agents";
    const record = buildAgentKnowledgePageRecord(page, assignmentMode);
    if (assignmentMode === "all_agents") {
      inheritedPages.push(record);
      continue;
    }
    if (directPageIdSet.has(page.id)) {
      directPages.push(record);
      continue;
    }
    assignablePages.push(record);
  }

  return {
    directPageIds,
    inheritedPages: limitLoadtestDashboardPayload(inheritedPages, AGENT_KNOWLEDGE_PREVIEW_LIMIT),
    directPages: limitLoadtestDashboardPayload(directPages, AGENT_KNOWLEDGE_PREVIEW_LIMIT),
    assignablePages: limitLoadtestDashboardPayload(assignablePages, AGENT_ASSIGNABLE_KNOWLEDGE_LIMIT),
    totalAvailableCount: inheritedPages.length + directPages.length,
    directCount: directPages.length,
    inheritedCount: inheritedPages.length,
  };
}

function buildAgentKnowledgePageRecord(
  page: KnowledgePage,
  assignmentMode: KnowledgeAssignmentMode,
): AgentKnowledgePageRecord {
  return {
    id: page.id,
    title: page.title,
    tags: page.tags,
    updatedAt: page.updatedAt,
    assignmentMode,
    sourceLabel: page.sourceChannelDocumentId
      ? "Shared document"
      : page.sourceAttachmentId
        ? "Shared attachment"
        : undefined,
  };
}

// ── Performance ──

export function getPerformancePageData(workspaceId = DEFAULT_WORKSPACE_ID): Promise<PerformanceDashboardData> {
  return getPerformanceDashboardDataCached(workspaceId);
}

// ── Data Tables (#25) ──

export interface DataTablesPageData {
  tables: DataTable[];
  totalCount: number;
  activeCount: number;
  channels: Array<{ name: string }>;
  agents: Array<{ id: string; name: string }>;
}

export function getDataTablesPageData(workspaceId = DEFAULT_WORKSPACE_ID): DataTablesPageData {
  const state = readWorkspaceStateCached(workspaceId);
  const tables = state.dataTables ?? [];

  return {
    tables,
    totalCount: tables.length,
    activeCount: tables.filter((t) => t.status === "active").length,
    channels: state.channels.map((ch) => ({ name: ch.name })),
    agents: state.activeEmployees.map((e) => ({
      id: e.name,
      name: e.remarkName?.trim() || e.name,
    })),
  };
}

// ── Automations (#27) ──

export interface AutomationsPageData {
  rules: AutomationRule[];
  documentRuns: ChannelDocumentRunRecord[];
  autoContinuationRuns: AutoContinuationRunRecord[];
  totalCount: number;
  enabledCount: number;
  documentRunCount: number;
  autoContinuationRunCount: number;
  channels: Array<{ name: string }>;
  agents: Array<{ id: string; name: string }>;
}

export interface AutoContinuationRunRecord {
  id: string;
  channelName: string;
  agentId: string;
  contactId?: string;
  status: "active" | "expired" | "stopped";
  startedAt: string;
  until: string;
  instruction: string;
  iteration: number;
  lastContinuedAt?: string;
  updatedAt: string;
  lastTaskQueueId?: string;
  lastTaskStatus?: string;
}

export function getAutomationsPageData(workspaceId = DEFAULT_WORKSPACE_ID): AutomationsPageData {
  const state = readWorkspaceStateCached(workspaceId);
  const queuedTaskById = new Map(listQueuedTasksCached(workspaceId).map((task) => [task.id, task]));
  const rules = state.automationRules ?? [];
  const documentRuns = (state.channelDocumentRuns ?? [])
    .slice()
    .sort((left, right) => new Date(right.updatedAt).getTime() - new Date(left.updatedAt).getTime())
    .map((run) => ({
      id: run.id,
      channelName: run.channelName,
      sourceMessageId: run.sourceMessageId,
      sourceSummary: run.sourceSummary,
      mode: run.mode,
      status: run.status,
      createdAt: run.createdAt,
      updatedAt: run.updatedAt,
      steps: (state.channelDocumentRunSteps ?? [])
        .filter((step) => step.runId === run.id)
        .sort((left, right) => new Date(left.createdAt).getTime() - new Date(right.createdAt).getTime())
        .map((step) => ({
          id: step.id,
          agentId: step.agentId,
          agentLabel: step.agentLabel,
          instruction: step.instruction,
          status: step.status,
          handoffKind: step.handoffKind,
          documentId: step.documentId,
          documentVersionId: step.documentVersionId,
          lastError: step.lastError,
          lastWarning: step.lastWarning,
        })),
    }) satisfies ChannelDocumentRunRecord);
  const autoContinuationRuns = (state.conversationExecutionWorkspaces ?? [])
    .filter((workspace) => Boolean(workspace.autoContinuation))
    .slice()
    .sort((left, right) => new Date(right.updatedAt).getTime() - new Date(left.updatedAt).getTime())
    .map((workspace) => ({
      id: `${workspace.channelName}:${workspace.agentId}:${workspace.contactId ?? ""}:${workspace.autoContinuation!.startedAt}`,
      channelName: workspace.channelName,
      agentId: workspace.agentId,
      contactId: workspace.contactId,
      status: workspace.autoContinuation!.status,
      startedAt: workspace.autoContinuation!.startedAt,
      until: workspace.autoContinuation!.until,
      instruction: workspace.autoContinuation!.instruction,
      iteration: workspace.autoContinuation!.iteration,
      lastContinuedAt: workspace.autoContinuation!.lastContinuedAt,
      updatedAt: workspace.updatedAt,
      lastTaskQueueId: workspace.lastTaskQueueId,
      lastTaskStatus: workspace.lastTaskQueueId ? queuedTaskById.get(workspace.lastTaskQueueId)?.status : undefined,
    }) satisfies AutoContinuationRunRecord);

  return {
    rules,
    documentRuns,
    autoContinuationRuns,
    totalCount: rules.length + 2,
    enabledCount: rules.filter((r) => r.enabled).length + 2,
    documentRunCount: documentRuns.length,
    autoContinuationRunCount: autoContinuationRuns.length,
    channels: state.channels.map((ch) => ({ name: ch.name })),
    agents: state.activeEmployees.map((e) => ({
      id: e.name,
      name: e.remarkName?.trim() || e.name,
    })),
  };
}

// ── Calendar / Schedules (#28) ──

export interface CalendarPageData {
  scheduledTasks: Array<ScheduledTask & {
    sourceKind?: "legacy" | "workflow";
    migrationStatus?: "legacy" | "needs_migration" | "migrated";
    legacySourceId?: string;
    workflowId?: string;
  }>;
  totalCount: number;
  activeCount: number;
  channels: Array<{ name: string }>;
  agents: Array<{ id: string; name: string }>;
}

export function getCalendarPageData(workspaceId = DEFAULT_WORKSPACE_ID): CalendarPageData {
  const state = readWorkspaceStateCached(workspaceId);
  const mode = readWorkflowCutoverModeSync(workspaceId);
  const workflows = mode === "legacy_only" ? [] : listWorkflowDefinitionsSync(workspaceId);
  const scheduledWorkflows = workflows.filter((workflow) => workflow.legacySourceType === "scheduled_task");
  const scheduledTasks = projectLegacySchedulesForCutover({
    mode,
    legacyTasks: state.scheduledTasks ?? [],
    workflows: scheduledWorkflows,
    triggers: scheduledWorkflows.flatMap((workflow) => {
      const trigger = readWorkflowTriggerForWorkflowSync(workflow.id, workspaceId);
      return trigger ? [trigger] : [];
    }),
  });

  return {
    scheduledTasks,
    totalCount: scheduledTasks.length,
    activeCount: scheduledTasks.filter((t) => t.status === "active").length,
    channels: state.channels.map((ch) => ({ name: ch.name })),
    agents: state.activeEmployees.map((e) => ({
      id: e.name,
      name: e.remarkName?.trim() || e.name,
    })),
  };
}

// ── Templates (#29) ──

export interface TemplatesPageData {
  templates: Template[];
  totalCount: number;
  builtInCount: number;
  customCount: number;
}

export function getTemplatesPageData(workspaceId = DEFAULT_WORKSPACE_ID): TemplatesPageData {
  const state = readWorkspaceStateCached(workspaceId);
  const templates = state.templates ?? [];

  return {
    templates,
    totalCount: templates.length,
    builtInCount: templates.filter((t) => t.builtIn).length,
    customCount: templates.filter((t) => !t.builtIn).length,
  };
}

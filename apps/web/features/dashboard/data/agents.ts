// dashboard AI 员工页数据装配与展示视图（从 features/dashboard/data.ts 拆出，3.4/3.6 巨型文件项）。

import { isWorkspaceManagerRole, listWorkspaceMemberUsersCached, sameText } from "../dashboard-view-builders";
import type { AgentsPageData, DashboardCurrentUser, DigitalEmployeeShowcaseAgentRecord, InboxItem, RouterExecutionView, RuntimeGrantMember, TaskExecutionTimelineAction, TaskExecutionTimelineCategory, TaskExecutionTimelineEntry, WorkspaceAgentAccessRequestView, WorkspaceAgentDocumentAccessRecord, WorkspaceAgentDocumentAccessSummaryRecord, WorkspaceAgentForkInvitationView, WorkspaceAgentKnowledgeRecord, WorkspaceAgentRecord } from "../data-types";
import { buildFeishuAgentBotSetupReference, listFeishuIntegrationSettingsItems } from "@/features/integrations/feishu/feishu-settings-data";
import { DEFAULT_WORKSPACE_ID, listQueuedTasksSync } from "@dofe-agent/db";
import type { TaskExecutionEventRecord, TaskExecutionEventType, WorkspaceMemberUserRecord, WorkspaceRole } from "@dofe-agent/db";
import type { DofeAgentState, WorkspaceSkill } from "@dofe-agent/domain/workspace";
import { listAgentAccessRequestsForActorSync, listAgentForkInvitationsForActorSync, listAgentForkInvitationsForSourceAgentSync, listDocumentAgentAccessSync, listDocumentPermissionRequestsSync } from "@dofe-agent/services/operations";
import { listEmployeeSkillIdsByAgentIdMapSync } from "@dofe-agent/services/employees";
import { listManagedRuntimesForWorkspaceSync, normalizeRuntimeProviderHealth, resolveAgentRuntimeMode } from "@dofe-agent/services/runtime";
import { resolveChannelHumanMemberNames } from "@dofe-agent/services/channels";
import type { AgentAccessRequestRecord, AgentForkInvitationRecord } from "@dofe-agent/services/operations";
import { buildWorkspaceAgentRecord, compareAgents, compareContainers, redactSkillRequirementsForViewer, safeParseJson } from "./agent-record.ts";
import { listAgentRouterProviderSessionsCached, listAgentTaskAttemptsCached, listDaemonSnapshotsCached, listEmployeeRuntimeBindingsCached, listKnowledgeAssignmentPoliciesCached, listKnowledgeAssignmentsCached, listMcpCatalogItemsCached, listMcpConnectionsCached, listQueuedTasksCached, listRuntimeAppOperationsCached, listRuntimeGrantsCached, listRuntimeInstalledAppsCached, listTaskExecutionEventsCached, listWorkspaceSkillsCached, readAgentRouterSessionCached, readWorkspaceStateCached } from "./cached.ts";
import { buildWorkspaceAgentKnowledgeRecord } from "./knowledge.ts";
import { buildRuntimeDisplayNameIndex, listDaemonSnapshotViews, listDaemonTokenViews, listProviderAccountViews, listRuntimeProvisionRequestViews } from "./runtime-views.ts";
import { buildNativeRuntimeRecords } from "./skills.ts";
import type { AgentsPageDataOptions } from "./inbox.ts";

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
  const skillIdsByAgentId = options.skillIdsByAgentId ?? listEmployeeSkillIdsByAgentIdMapSync(workspaceId);
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
        providerHealth: managedRuntime.providerHealth ?? normalizeRuntimeProviderHealth({
          runtimeStatus: managedRuntime.status,
          runtimeMetadata: {},
        }),
        serverName: "Managed",
        daemonKey: "",
        mode: "remote" as const,
        managed: true,
        provisioningState: managedRuntime.provisioningState,
        bindable: managedRuntime.provisioningState === "managed"
          && managedRuntime.status === "online"
          && managedRuntime.providerHealth?.providerUsable !== "unusable",
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
    workspaceId,
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
export function resolveAgentsPageDataOptions(input: string | AgentsPageDataOptions): Required<Pick<AgentsPageDataOptions, "workspaceId">> & Omit<AgentsPageDataOptions, "workspaceId"> {
  if (typeof input === "string") {
    return { workspaceId: input };
  }
  return {
    workspaceId: input.workspaceId ?? DEFAULT_WORKSPACE_ID,
    currentUserId: input.currentUserId,
    currentMembershipRole: input.currentMembershipRole,
    skillIdsByAgentId: input.skillIdsByAgentId,
  };
}
export function summarizeWorkspaceSkillForAgentPage(skill: WorkspaceSkill): WorkspaceSkill {
  return {
    ...skill,
    files: skill.files.map((file) => ({
      ...file,
      content: "",
    })),
  };
}
export function limitLoadtestDashboardPayload<T>(items: T[], limit: number): T[] {
  return shouldUseLoadtestDashboardPayloadLimits() ? items.slice(0, limit) : items;
}
export function shouldUseLoadtestDashboardPayloadLimits(): boolean {
  const configured = process.env.DOFE_AGENT_DASHBOARD_PAYLOAD_LIMITS_ENABLED?.trim().toLowerCase();
  if (configured) {
    return configured !== "0" && configured !== "false";
  }
  return process.env.LOADTEST_MODE === "local";
}
export function canSeeWorkspaceDiagnostics(currentUser?: DashboardCurrentUser): boolean {
  return !currentUser?.id || isWorkspaceManagerRole(currentUser.role);
}
export function redactInboxExecutionForMember(
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
export function buildTaskExecutionTimeline(
  taskId: string,
  workspaceId: string,
  limit = 80,
): TaskExecutionTimelineEntry[] {
  return listTaskExecutionEventsCached(workspaceId, taskId, limit).map(mapTaskExecutionTimelineEntry);
}
export function buildRouterExecutionView(
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
export function mapTaskExecutionTimelineEntry(event: TaskExecutionEventRecord): TaskExecutionTimelineEntry {
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
export function categoryForExecutionEvent(type: TaskExecutionEventType): TaskExecutionTimelineCategory {
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
export function resolveExecutionEventActions(
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
export function readSafeRelativeHref(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  return value.startsWith("/") ? value : undefined;
}
export function readString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value : undefined;
}
export function mapWorkspaceMemberForRuntimeGrant(member: WorkspaceMemberUserRecord): RuntimeGrantMember {
  return {
    userId: member.userId,
    displayName: member.displayName,
    primaryEmail: member.primaryEmail,
    role: member.role,
  };
}
export function parseAgentForkOrigin(origin: string): WorkspaceAgentRecord["forkedFrom"] {
  const match = /^agent-fork:(.*):([^:]+)$/.exec(origin);
  if (!match) {
    return undefined;
  }
  return {
    sourceAgentName: match[1] ?? "",
    invitationId: match[2] ?? "",
  };
}
export function buildAgentForkInvitationView(
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
export function buildDigitalEmployeeShowcaseAgents(input: {
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
export function buildAgentAccessRequestView(
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
export function resolveShowcaseCommonChannels(input: {
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
export function resolveShowcasePublicAgentChannels(state: DofeAgentState, agentChannels: string[]): string[] {
  return agentChannels.filter((channelName) => {
    const channel = state.channels.find((item) => sameText(item.name, channelName));
    return channel?.kind !== "direct";
  });
}
export function buildShowcaseKnowledgeHighlights(
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
export function buildShowcaseReadiness(
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
export function resolveShowcaseLastActivityAt(agent: WorkspaceAgentRecord): string | undefined {
  const candidates = [
    ...agent.workAreas.map((area) => area.updatedAt),
    ...agent.recentMessages.map((message) => message.time),
  ].filter((value): value is string => Boolean(value));
  return candidates.sort((left, right) => new Date(right).getTime() - new Date(left).getTime())[0];
}
export function buildShowcaseRequestableActions(input: {
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
export function buildShowcaseUsageHints(input: {
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
export function suggestForkAgentName(sourceAgentDisplayName: string, targetDisplayName?: string): string {
  const source = sourceAgentDisplayName.trim() || "AI员工";
  const target = targetDisplayName?.trim();
  if (target) {
    return `${target} ${source}`.slice(0, 80);
  }
  return `${source} copy`.slice(0, 80);
}
export function buildWorkspaceAgentDocumentAccessSummaries(
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
export function createEmptyAgentDocumentAccessSummary(): WorkspaceAgentDocumentAccessSummaryRecord {
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
export function roleRankForAgentDocumentAccess(role: WorkspaceAgentDocumentAccessRecord["role"]): number {
  if (role === "forwarder") {
    return 0;
  }
  if (role === "editor") {
    return 1;
  }
  return 2;
}
